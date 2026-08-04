import * as vscode from 'vscode';
import {
    create_authority_store,
    create_file_state_store,
    type AuthorityFileStateStore,
    type FileStatePersistenceMedium,
} from './state';
import { PhysicalResourceLockManager, physical_lock_root } from './physical-resource-lock';

const MEMENTO_STATE_KEY = 'tableViewer.fileState';

export type PhysicalEditProtocolStatus = 'armed' | 'unarmed' | 'invalid';

export interface PhysicalEditActivationBoundary {
    readonly store: AuthorityFileStateStore;
    readonly viewOnly: boolean;
    readonly markerStatus: PhysicalEditProtocolStatus;
    enter_view_only(): Promise<void>;
    drain(): Promise<void>;
}

export class PhysicalEditProtocolMarker {
    readonly #manager: PhysicalResourceLockManager | undefined;

    constructor(root = physical_lock_root()) {
        this.#manager = root
            ? new PhysicalResourceLockManager({ lockRoot: root })
            : undefined;
    }

    async status(): Promise<PhysicalEditProtocolStatus> {
        if (!this.#manager) return 'invalid';
        try {
            const inspection = this.#manager.inspect_activation_marker();
            if (inspection.status === 'invalid') return 'invalid';
            return inspection.status === 'active' ? 'armed' : 'unarmed';
        } catch {
            // An unreadable, replaced, or otherwise unverifiable marker is a
            // fail-closed state. Activation must still register the viewer so the
            // user can inspect files and receive recovery guidance.
            return 'invalid';
        }
    }

    async install(): Promise<void> {
        if (!this.#manager) {
            throw new Error('This platform has no supported physical-edit coordination root.');
        }
        this.#manager.install_activation_marker({
            allOtherTableViewerProcessesClosed: true,
            allOtherEditingProductsUpdated: true,
            currentProcessFencedFlushedAndViewOnly: true,
        });
    }
}

function ephemeral_store(
    sourceEnvelope: unknown,
    maxStoredFiles: () => number,
): AuthorityFileStateStore {
    let envelope = sourceEnvelope;
    const medium: FileStatePersistenceMedium = {
        runtime_key: {},
        read: () => envelope,
        write: async (next) => { envelope = next; },
    };
    return create_authority_store(medium, maxStoredFiles);
}

function switching_store(
    durable: AuthorityFileStateStore,
    ephemeral: () => AuthorityFileStateStore,
    use_ephemeral: () => boolean,
    track: <T>(work: Promise<T>) => Promise<T>,
): AuthorityFileStateStore {
    return new Proxy(durable, {
        get(target, property, receiver) {
            const selected = use_ephemeral() ? ephemeral() : target;
            const value = Reflect.get(selected, property, receiver);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => track(Promise.resolve(value.apply(selected, args)));
        },
    });
}

export async function create_physical_edit_activation_boundary(
    context: vscode.ExtensionContext,
    marker = new PhysicalEditProtocolMarker(),
): Promise<PhysicalEditActivationBoundary> {
    const status = await marker.status();
    let phase: 'durable' | 'viewOnly' = status === 'unarmed'
        ? 'durable'
        : 'viewOnly';
    const pending = new Set<Promise<unknown>>();
    const track = <T>(work: Promise<T>): Promise<T> => {
        pending.add(work);
        void work.finally(() => pending.delete(work)).catch(() => {});
        return work;
    };
    const maxStoredFiles = () => Math.max(
        1,
        vscode.workspace.getConfiguration('tableViewer').get<number>('maxStoredFiles', 10000),
    );
    let ephemeral = phase === 'viewOnly'
        ? ephemeral_store(context.globalState.get<unknown>(MEMENTO_STATE_KEY, {}), maxStoredFiles)
        : undefined;
    const store = switching_store(
        create_file_state_store(context, maxStoredFiles),
        () => {
            if (!ephemeral) throw new Error('The view-only state projection is unavailable.');
            return ephemeral;
        },
        () => phase === 'viewOnly',
        track,
    );
    const drain = async () => {
        while (pending.size > 0) await Promise.allSettled([...pending]);
    };
    return {
        store,
        get viewOnly() { return phase === 'viewOnly'; },
        markerStatus: status,
        async enter_view_only() {
            if (phase === 'viewOnly') return;
            // The caller fences edit admission before beginning this transition.
            // Keep selecting the durable backend until every admitted write has
            // settled; changing storage earlier would redirect renderer-only edits
            // discovered by the close handshake into ephemeral state. Keep the loop
            // here rather than awaiting drain(): when there is no pending work, the
            // phase change must not yield through an otherwise unnecessary microtask.
            while (pending.size > 0) await Promise.allSettled([...pending]);
            // Capture the final drained Memento envelope only when the disposable
            // view-only projection becomes authoritative for this activation. No await
            // may separate this seed from the phase switch.
            ephemeral = ephemeral_store(
                context.globalState.get<unknown>(MEMENTO_STATE_KEY, {}),
                maxStoredFiles,
            );
            phase = 'viewOnly';
        },
        drain,
    };
}

const NEVER_ABORTED_SIGNAL = new AbortController().signal;

async function await_setup_ui<T>(open: () => Thenable<T>, signal: AbortSignal): Promise<T | undefined> {
    if (signal.aborted) return undefined;
    const ui = Promise.resolve(open());
    let abort!: () => void;
    const cancelled = new Promise<undefined>((resolve) => {
        abort = () => resolve(undefined);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
    try {
        return await Promise.race([ui, cancelled]);
    } finally {
        signal.removeEventListener('abort', abort);
    }
}

export async function run_physical_edit_protocol_setup(
    marker: PhysicalEditProtocolMarker,
    boundary: PhysicalEditActivationBoundary,
    stop_viewers: () => void | Promise<void>,
    isActive: () => boolean = () => true,
    signal: AbortSignal = NEVER_ABORTED_SIGNAL,
): Promise<boolean> {
    if (!isActive()) return false;
    if (vscode.env.remoteName) {
        await await_setup_ui(() => vscode.window.showErrorMessage(
            'Arm the Table Viewer physical-edit protocol from a local VS Code window. Remote extension hosts cannot attest or coordinate the local machine-wide boundary.',
        ), signal);
        return false;
    }

    const drain_into_view_only = async () => {
        // stop_viewers synchronously fences new edit admission before its first await,
        // then keeps each panel and transport alive until renderer-only edits have
        // reached the controller and its durable-backend acknowledgement has settled.
        // Memento must remain selected throughout that handshake.
        await stop_viewers();
        if (!isActive()) return;
        await boundary.drain();
        if (!isActive()) return;
        // Only a successful viewer flush and durable drain may redirect later state
        // calls to the ephemeral view-only backend.
        await boundary.enter_view_only();
    };

    const status = await marker.status();
    if (!isActive()) return false;
    if (status === 'invalid') {
        await drain_into_view_only();
        if (!isActive()) return false;
        await await_setup_ui(() => vscode.window.showErrorMessage(
            'Table Viewer could not verify the physical-edit protocol marker. The viewer remains available in view-only mode. Close all Table Viewer products, update them to lock-aware versions, then repair or remove the tampered/unreadable coordination marker before trying to arm the protocol again.',
        ), signal);
        return false;
    }

    if (status === 'armed') {
        await drain_into_view_only();
        if (!isActive()) return false;
        await await_setup_ui(() => vscode.window.showInformationMessage(
            'The Table Viewer physical-edit protocol is already armed. This Memento-based release remains view-only until the SQLite cutover.',
        ), signal);
        return true;
    }

    const attestation = 'I Attest All Other Products Are Closed and Updated';
    const accepted = await await_setup_ui(() => vscode.window.showWarningMessage(
        'Arm the Table Viewer physical-edit protocol only after closing every other Table Viewer desktop app and every other VS Code window (including remote windows), and updating every other installed Table Viewer product that may edit files to a lock-aware version. This current VS Code process will be fenced, flushed, and switched to view-only before it installs the marker; it does not need to close. Until the marker is armed, this release keeps eligible native-local CSV editing on its legacy Memento path. Arming the marker makes this extension view-only until its SQLite cutover. Reopening an old or downgraded editor invalidates coordinated-edit guarantees.',
        { modal: true },
        attestation,
    ), signal);
    if (!isActive() || accepted !== attestation) return false;

    await drain_into_view_only();
    if (!isActive()) return false;
    await marker.install();
    if (!isActive()) return false;
    await await_setup_ui(() => vscode.window.showInformationMessage(
        'The physical-edit protocol is armed. Reload this VS Code window. Table Viewer will remain view-only until the SQLite cutover; do not reopen an old or downgraded Table Viewer editor.',
    ), signal);
    return true;
}
