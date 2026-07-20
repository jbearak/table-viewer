import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { XlsxDataSource } from './data-source/xlsx-source';
import { XlsDataSource } from './data-source/xls-source';
import { CsvDataSource } from './data-source/csv-source';
import { ExcelHeaderDataSource } from './data-source/excel-header-source';
import type {
    DataSource,
    RenderedCell,
} from './data-source/interface';
import { ViewerPanelCore, adopt_source_into_core, type PanelLike } from './panel-core';
import { PanelSession, type PanelAdoption } from './panel-session';
import {
    get_csv_max_rows, get_default_orientation, get_delimiter, get_max_file_size_mib,
} from './viewer-config';
import { assert_safe_file_size, MAX_CSV_ROWS } from './spreadsheet-safety';
import { serialize_csv } from './serialize-csv';
import type {
    AuthorityFileStateStore,
    FileStateSnapshot,
} from './state';
import { compare_authority, same_authority } from './authority-order';
import {
    discard_authority,
    finalize_authority,
    stage_authority,
} from './state-authority';
import {
    normalize_host_state,
    plan_excel_candidate_state,
} from './excel-header-plan';
import {
    acquire_file_coordinator,
    type ExcelHeaderOperationReceipt,
    type FileAuthoritySnapshot,
    type FileRefreshEvent,
    type FileRefreshSubscriberResult,
    type PhysicalAuthorityCommitReceipt,
} from './file-coordinator';
import { vscode_file_refresh_watcher_factory } from './vscode-file-refresh-watcher';
import { reconcile_finalization } from './finalization-reconciliation';
import { SourceCandidate } from './source-candidate';
import {
    sanitize_excel_header_overrides,
    transform_has_entries,
    transform_schema_for_sheet,
    type PerFileState,
    type SheetTransformState,
    type WebviewMessage,
} from './types';
import { sanitize_transform_state } from './webview/sheet-state';
import { sanitize_column_visibility_state } from './webview/column-projection';
import {
    apply_layout_state_patch,
    derive_layout_state_patch,
} from './layout-state-patch';
import {
    complete_normalized_per_file_state,
    type NormalizedPerFileState,
    type WorkbookSnapshotIdentity,
} from './viewer-snapshot';

/** The host surface the controller needs: the core's `PanelLike` (postMessage)
 *  plus inbound messages. Both vscode.WebviewPanel and the unit-test mock panel
 *  satisfy it; html is set by the host before attaching. */
export interface ViewerHostPanel extends PanelLike {
    webview: PanelLike['webview'] & {
        onDidReceiveMessage(handler: (msg: WebviewMessage) => unknown): vscode.Disposable;
    };
}

export interface ViewerProfile {
    /** Build a DataSource from freshly-read bytes. Throws are surfaced as errors. */
    build_source(
        raw: Uint8Array,
        file_path: string,
        state: PerFileState,
    ): Promise<DataSource>;
    /** Enables csvEditingSupported + saveCsv/pendingEdits/showSaveDialog handling. */
    editing: boolean;
    /** Sets previewMode on the meta envelope (read-only synced preview). */
    previewMode?: boolean;
    /** Called after each (re)load adopts a source — preview refreshes its line map. */
    on_source_adopted?(source: DataSource): void;
    /** Handle a message the controller does not own (preview: visibleRowChanged).
     *  Return true if handled. */
    on_message?(msg: WebviewMessage): boolean | Promise<boolean>;
}

type CsvEditFilePhase =
    | { type: 'free' }
    | { type: 'owned'; token: symbol }
    | { type: 'cleanupPending'; operation: symbol }
    | { type: 'uncertain'; operation: symbol };

type CsvEditStateSubscriber = (snapshot?: Readonly<FileStateSnapshot>) => void;

interface CsvEditFileState {
    attachments: number;
    phase: CsvEditFilePhase;
    /** State revisions at or below this boundary predate a completed edit clear. */
    clearedStateRevision?: number;
    recovery?: Promise<boolean>;
    readonly subscribers: Set<CsvEditStateSubscriber>;
}

// Edit ownership and post-write cleanup uncertainty are file-scoped. In
// particular, releasing one panel after a successful write must not allow a
// sibling panel to reclaim durable edits that have not yet been cleared.
const csv_edit_file_states = new Map<string, CsvEditFileState>();
const RELOAD_RETRY_COUNT = 3;
const RELOAD_RETRY_MS = 50;
const READY_STATE_RETRY_COUNT = 3;
const READY_STATE_RETRY_MS = 50;
const EDIT_CLEANUP_RECOVERY_MS = 250;

function content_digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

type PhysicalAuthorityCommitResult =
    | { type: 'committed'; receipt: PhysicalAuthorityCommitReceipt }
    | { type: 'stale' }
    | { type: 'rejected' }
    | { type: 'advanced' };

interface PanelLoadRequest {
    readonly seq: number;
    readonly refreshEvent?: FileRefreshEvent;
}

function same_snapshot_identity(
    left: Extract<WebviewMessage, { type: 'stateChanged' }>['snapshotIdentity'],
    right: Extract<WebviewMessage, { type: 'stateChanged' }>['snapshotIdentity'],
): boolean {
    return left.deliveryId === right.deliveryId
        && left.authority.fileId === right.authority.fileId
        && left.authority.revision === right.authority.revision
        && left.stateRevision === right.stateRevision
        && left.sourceBasis.physicalRevision === right.sourceBasis.physicalRevision
        && left.sourceBasis.projectionRevision === right.sourceBasis.projectionRevision;
}

function sheet_state_arrays_equal(
    left: readonly unknown[] | undefined,
    right: readonly unknown[] | undefined,
): boolean {
    const count = Math.max(left?.length ?? 0, right?.length ?? 0);
    for (let index = 0; index < count; index += 1) {
        if (JSON.stringify(left?.[index]) !== JSON.stringify(right?.[index])) {
            return false;
        }
    }
    return true;
}

function same_file_authority_basis(
    left: FileAuthoritySnapshot,
    right: FileAuthoritySnapshot,
): boolean {
    return left.fileKey === right.fileKey && same_authority(left, right);
}

function same_semantic_authority_basis(
    left: FileAuthoritySnapshot,
    right: FileAuthoritySnapshot,
): boolean {
    return left.fileKey === right.fileKey
        && left.authorityRevision === right.authorityRevision
        && left.physicalRevision === right.physicalRevision
        && left.projectionRevision === right.projectionRevision
        && left.physicalDigest === right.physicalDigest;
}

function excel_profile(): ViewerProfile {
    return {
        editing: false,
        async build_source(raw, file_path, state) {
            const physical = file_path.toLowerCase().endsWith('.xlsx')
                ? await XlsxDataSource.create(raw)
                : await XlsDataSource.create(Buffer.from(raw));
            return new ExcelHeaderDataSource(
                physical,
                sanitize_excel_header_overrides(state.excelFirstRowHeaders),
            );
        },
    };
}

/** Build the editable CSV/TSV DataSource shared by the table and preview hosts. */
export function build_csv_source(raw: Uint8Array, file_path: string): Promise<CsvDataSource> {
    const max_rows = Math.min(get_csv_max_rows(), MAX_CSV_ROWS);
    // CSV/TSV files conventionally carry column names in their first row, so the
    // grid promotes it to the column header rather than showing letters.
    return CsvDataSource.create(raw, get_delimiter(file_path), max_rows, {
        firstRowIsHeader: true,
    });
}

export function csv_table_profile(): ViewerProfile {
    return {
        editing: true,
        build_source: build_csv_source,
    };
}

/** Profile for a uri, by extension: csv/tsv → editable table; else Excel viewer. */
export function profile_for(uri: vscode.Uri): ViewerProfile {
    const ext = uri.fsPath.toLowerCase();
    return ext.endsWith('.csv') || ext.endsWith('.tsv')
        ? csv_table_profile()
        : excel_profile();
}

/**
 * Wire a webview panel to a file: initial load on `ready`, live reload via a
 * directory watcher with a monotonic guard, paginated row serving (via the
 * core), and — for editing profiles — save/conflict/pending-edit handling.
 * Returns a Disposable that tears everything down. The host sets webview html
 * and options before calling this.
 */
export function attach_viewer(
    panel: ViewerHostPanel,
    uri: vscode.Uri,
    state_store: AuthorityFileStateStore,
    profile: ViewerProfile,
): vscode.Disposable {
    const file_path = uri.fsPath;
    const disposables: vscode.Disposable[] = [];
    const durable_state_store = state_store;
    const file_coordinator = acquire_file_coordinator(uri, durable_state_store);
    const state_path = file_coordinator.statePath;
    const file_key = file_coordinator.authority().fileKey;
    let file_edit_state = profile.editing
        ? csv_edit_file_states.get(file_key)
        : undefined;
    if (profile.editing && !file_edit_state) {
        file_edit_state = {
            attachments: 0,
            phase: { type: 'free' },
            subscribers: new Set(),
        };
        csv_edit_file_states.set(file_key, file_edit_state);
    }
    if (file_edit_state) file_edit_state.attachments += 1;

    // Borrowed aliases are updated only at the same synchronous boundary as the
    // session adoption. PanelSession remains the sole source/core lifecycle owner.
    let core: ViewerPanelCore | undefined;
    let source: DataSource | undefined;
    let source_authority = file_coordinator.authority();
    const transform_authorities = new Map<string, number>();
    let load_seq = 0;
    let latest_refresh_event: FileRefreshEvent | undefined;
    let disposed = false;
    let save_command_pending = false;
    let save_write_pending = false;
    let pending_edit_writes: Promise<void> = Promise.resolve();
    let layout_write_tail: Promise<void> = Promise.resolve();
    let layout_basis: {
        identity: WorkbookSnapshotIdentity;
        state: NormalizedPerFileState;
    } | undefined;
    let reload_retry_attempts = 0;
    let reload_retry_timer: ReturnType<typeof setTimeout> | undefined;
    let refresh_retry_wait: {
        timer: ReturnType<typeof setTimeout>;
        resolve: (proceed: boolean) => void;
    } | undefined;
    const ready_state_retry_waits = new Set<{
        timer: ReturnType<typeof setTimeout>;
        resolve: (proceed: boolean) => void;
    }>();
    const edit_cleanup_waiters = new Map<symbol, {
        timer: ReturnType<typeof setTimeout>;
        resolve: (recovered: boolean) => void;
    }>();
    let current_edit_cleanup_waiter: symbol | undefined;
    const edit_session_token = Symbol(file_key);
    let next_edit_session_epoch = 1;
    let active_edit_session_id: string | undefined;
    const excel_header_subscriber_token = Symbol(file_key);
    const header_receipt_queue: ExcelHeaderOperationReceipt[] = [];
    let header_receipt_processing = false;
    let header_refresh_scheduled = false;
    const released_sources = new WeakSet<DataSource>();
    const released_cores = new WeakSet<ViewerPanelCore>();

    const session = new PanelSession({
        postMessage: (message) => panel.webview.postMessage(message),
        onNeedsResyncSource: () => { void refresh_panel_source(true); },
        onCurrentAdoptionAcknowledged: (adoption) => {
            if (disposed || session.current_adoption() !== adoption) return;
            const digest = adoption.source === 'commitReceipt'
                ? adoption.receipt.resultingBasis.physicalDigest
                : adoption.authority.physicalDigest;
            for (const [index, warning] of (adoption.warnings ?? []).entries()) {
                const basis = digest
                    ?? (adoption.source === 'commitReceipt'
                        ? adoption.receipt.resultingBasis.physicalRevision
                        : adoption.authority.physicalRevision);
                if (file_coordinator.mark_warning_seen(`${basis}:${index}:${warning}`)) {
                    void vscode.window.showWarningMessage(warning);
                }
            }
        },
        onAdoptionReleased: (adoption) => {
            const current = session.current_adoption();
            let first_error: unknown;
            if (
                current?.resources.core !== adoption.resources.core
                && !released_cores.has(adoption.resources.core)
            ) {
                released_cores.add(adoption.resources.core);
                try {
                    adoption.resources.core.dispose();
                } catch (error) {
                    first_error = error;
                }
            }
            if (
                current?.resources.source !== adoption.resources.source
                && !released_sources.has(adoption.resources.source)
            ) {
                released_sources.add(adoption.resources.source);
                try {
                    adoption.resources.source.close();
                } catch (error) {
                    first_error ??= error;
                }
            }
            if (first_error !== undefined) throw first_error;
        },
    });

    const abort_setup = (error: unknown): never => {
        disposed = true;
        const cleanup = (action: () => void) => {
            try {
                action();
            } catch {
                // Preserve the setup failure while completing best-effort teardown.
            }
        };
        cleanup(() => session.dispose());
        for (const disposable of [...disposables].reverse()) {
            cleanup(() => disposable.dispose());
        }
        cleanup(() => file_coordinator.dispose());
        if (file_edit_state) {
            file_edit_state.attachments = Math.max(0, file_edit_state.attachments - 1);
            if (
                file_edit_state.attachments === 0
                && file_edit_state.phase.type === 'free'
            ) csv_edit_file_states.delete(file_key);
        }
        throw error;
    };

    if (file_edit_state) {
        const edit_state_subscriber: CsvEditStateSubscriber = (snapshot) => {
            if (disposed) return;
            if (snapshot) update_session_state_material(snapshot, false);
            session.recapture_current_projection({ deliver: true });
        };
        file_edit_state.subscribers.add(edit_state_subscriber);
        disposables.push({
            dispose() {
                file_edit_state?.subscribers.delete(edit_state_subscriber);
            },
        });
    }

    // Subscribe before the panel can become ready. Coordinator events may build
    // and install a panel-local source pre-ready; PanelSession defers delivery.
    const refresh_subscription = (() => {
        try {
            return file_coordinator.subscribe_refresh(
                refresh_from_event,
                vscode_file_refresh_watcher_factory,
            );
        } catch (error) {
            return abort_setup(error);
        }
    })();
    disposables.push(refresh_subscription);

    function edit_phase(): CsvEditFilePhase {
        return file_edit_state?.phase ?? { type: 'free' };
    }

    function edit_cleanup_blocked(): boolean {
        const phase = edit_phase();
        return phase.type === 'cleanupPending' || phase.type === 'uncertain';
    }

    function editing_available_for_panel(): boolean {
        const phase = edit_phase();
        return phase.type === 'free'
            || (phase.type === 'owned' && phase.token === edit_session_token);
    }

    function notify_edit_state(snapshot?: Readonly<FileStateSnapshot>): void {
        if (!file_edit_state) return;
        for (const subscriber of [...file_edit_state.subscribers]) {
            try {
                subscriber(snapshot);
            } catch (error) {
                console.error('Failed to update CSV edit availability', error);
            }
        }
    }

    function owns_edit_session(): boolean {
        const phase = edit_phase();
        return phase.type === 'owned' && phase.token === edit_session_token;
    }

    function try_claim_edit_session(notify = true): boolean {
        if (!file_edit_state) return false;
        const phase = file_edit_state.phase;
        if (phase.type === 'owned') {
            if (phase.token !== edit_session_token) return false;
            active_edit_session_id ??= `${file_key}:${next_edit_session_epoch++}`;
            return true;
        }
        if (phase.type !== 'free') return false;
        active_edit_session_id = `${file_key}:${next_edit_session_epoch++}`;
        file_edit_state.phase = { type: 'owned', token: edit_session_token };
        if (notify) notify_edit_state();
        return true;
    }

    function release_edit_session(): void {
        if (save_write_pending) return;
        if (file_edit_state && owns_edit_session()) {
            active_edit_session_id = undefined;
            file_edit_state.phase = { type: 'free' };
            notify_edit_state();
        }
    }

    function begin_edit_cleanup(): symbol | undefined {
        if (!file_edit_state || !owns_edit_session()) return undefined;
        const operation = Symbol(file_key);
        active_edit_session_id = undefined;
        file_edit_state.phase = { type: 'cleanupPending', operation };
        return operation;
    }

    function finish_edit_cleanup(
        operation: symbol,
        success: boolean,
        cleared_snapshot?: Readonly<FileStateSnapshot>,
    ): void {
        if (!file_edit_state) return;
        const phase = file_edit_state.phase;
        if (
            (phase.type !== 'cleanupPending' && phase.type !== 'uncertain')
            || phase.operation !== operation
        ) return;
        file_edit_state.phase = success
            ? { type: 'free' }
            : { type: 'uncertain', operation };
        if (success && cleared_snapshot !== undefined) {
            file_edit_state.clearedStateRevision = Math.max(
                file_edit_state.clearedStateRevision ?? -1,
                cleared_snapshot.revision,
            );
        }
        notify_edit_state(cleared_snapshot);
        if (success && file_edit_state.attachments === 0) {
            csv_edit_file_states.delete(file_key);
        }
    }

    /** Project durable state for this panel without mutating shared authority. */
    function project_state_for_panel(
        snapshot: Readonly<FileStateSnapshot>,
        allow_claim = false,
    ): FileStateSnapshot {
        const state = snapshot.state as PerFileState;
        if (!state.pendingEdits) {
            return { revision: snapshot.revision, state };
        }
        const predates_completed_clear = file_edit_state?.clearedStateRevision !== undefined
            && snapshot.revision <= file_edit_state.clearedStateRevision;
        if (
            !predates_completed_clear
            && !edit_cleanup_blocked()
            && profile.editing
            && (owns_edit_session() || (allow_claim && try_claim_edit_session(false)))
        ) {
            return { revision: snapshot.revision, state };
        }
        const { pendingEdits: _drop, ...rest } = state;
        return { revision: snapshot.revision, state: rest };
    }

    function update_session_state_material(
        snapshot: Readonly<FileStateSnapshot>,
        allow_claim = false,
    ): void {
        session.update_state_snapshot(project_state_for_panel(snapshot, allow_claim));
    }

    async function refresh_session_state_material(
        allow_claim = false,
    ): Promise<FileStateSnapshot> {
        const snapshot = await read_file_state();
        update_session_state_material(snapshot, allow_claim);
        return snapshot;
    }

    async function read_file_state(touch = true): Promise<FileStateSnapshot> {
        await file_coordinator.state_ready();
        const snapshot = await state_store.read(state_path);
        if (touch) await state_store.touch(state_path);
        return snapshot;
    }

    async function update_file_state(
        updater: (current: PerFileState) => PerFileState,
        sheet_names = source?.meta().sheets.map((sheet) => sheet.name) ?? [],
        validate?: () => boolean,
    ): Promise<FileStateSnapshot | undefined> {
        let snapshot = await read_file_state();
        for (;;) {
            const current = normalize_host_state(snapshot.state, sheet_names);
            const next = updater(current);
            if (next === current) return undefined;
            const result = await state_store.compare_and_set(
                state_path,
                snapshot.revision,
                next,
                validate,
            );
            if (result.type === 'committed') {
                if (!disposed) update_session_state_material(result.snapshot);
                return result.snapshot;
            }
            snapshot = result.snapshot;
        }
    }

    type StateChangedMessage = Extract<WebviewMessage, { type: 'stateChanged' }>;

    function layout_write_is_current(
        message: StateChangedMessage,
        expected_authority: number,
    ): boolean {
        const acknowledged_identity = session.acknowledged_identity();
        return !disposed
            && core !== undefined
            && file_coordinator.state_write_is_current(expected_authority)
            && source_authority.authorityRevision === expected_authority
            && message.snapshotIdentity.authority.revision === expected_authority
            && message.sourceGeneration === core.source_generation
            && acknowledged_identity !== undefined
            && same_snapshot_identity(message.snapshotIdentity, acknowledged_identity);
    }

    function enqueue_layout_write(operation: () => Promise<void>): Promise<void> {
        const write = layout_write_tail.catch(() => {}).then(operation);
        layout_write_tail = write.catch(() => {});
        return write;
    }

    async function persist_layout_state(
        message: StateChangedMessage,
        expected_authority: number,
    ): Promise<void> {
        if (!layout_write_is_current(message, expected_authority) || !source) return;
        const sheet_names = source.meta().sheets.map((sheet) => sheet.name);
        if (
            !layout_basis
            || !same_snapshot_identity(layout_basis.identity, message.snapshotIdentity)
        ) {
            const acknowledged_state = session.acknowledged_state_snapshot(
                message.snapshotIdentity,
            );
            if (!acknowledged_state) return;
            layout_basis = {
                identity: structuredClone(message.snapshotIdentity),
                state: complete_normalized_per_file_state(
                    acknowledged_state,
                    sheet_names,
                ),
            };
        }
        const basis = layout_basis;
        const incoming = complete_normalized_per_file_state(message.state, sheet_names);
        const patch = derive_layout_state_patch(basis.state, incoming);
        const next_basis = complete_normalized_per_file_state(
            apply_layout_state_patch(basis.state, patch),
            sheet_names,
        );
        let reconciled = false;
        await update_file_state((current) => {
            if (!layout_write_is_current(message, expected_authority)) return current;
            reconciled = true;
            const sheets = source?.meta().sheets;
            if (!sheets) return current;
            const current_transforms = current.transforms;
            const current_visibility = current.columnVisibility;
            const transforms = sheets.map((sheet, index) =>
                sanitize_transform_state(
                    current_transforms?.[index],
                    sheet.columnCount,
                    transform_schema_for_sheet(sheet),
                ));
            const column_visibility = sheets.map((sheet, index) =>
                sanitize_column_visibility_state(
                    current_visibility?.[index],
                    sheet.columnCount,
                    transform_schema_for_sheet(sheet),
                ));
            const transforms_changed = !sheet_state_arrays_equal(
                transforms,
                current_transforms,
            );
            const visibility_changed = !sheet_state_arrays_equal(
                column_visibility,
                current_visibility,
            );
            const host_state = transforms_changed || visibility_changed
                ? {
                    ...current,
                    ...(transforms_changed ? { transforms } : {}),
                    ...(visibility_changed
                        ? { columnVisibility: column_visibility }
                        : {}),
                }
                : current;
            return apply_layout_state_patch(host_state, patch);
        }, sheet_names, () => layout_write_is_current(message, expected_authority));
        if (
            reconciled
            && layout_basis === basis
            && layout_write_is_current(message, expected_authority)
        ) {
            basis.state = next_basis;
        }
    }

    type EditStateWriteResult =
        | { type: 'committed'; snapshot: FileStateSnapshot }
        | { type: 'unchanged' }
        | { type: 'aborted' };

    async function update_edit_session_state(
        edit_session_id: string,
        updater: (current: PerFileState) => PerFileState,
    ): Promise<EditStateWriteResult> {
        const is_current = () => (
            !disposed
            && edit_message_is_current(edit_session_id)
            && edit_phase().type === 'owned'
        );
        let snapshot = await read_file_state();
        for (;;) {
            if (!is_current()) return { type: 'aborted' };
            const current = normalize_host_state(
                snapshot.state,
                source?.meta().sheets.map((sheet) => sheet.name) ?? [],
            );
            const next = updater(current);
            if (next === current) return { type: 'unchanged' };
            const result = await state_store.compare_and_set(
                state_path,
                snapshot.revision,
                next,
                is_current,
            );
            if (result.type === 'committed') {
                if (is_current()) update_session_state_material(result.snapshot);
                return { type: 'committed', snapshot: result.snapshot };
            }
            if (!is_current()) return { type: 'aborted' };
            snapshot = result.snapshot;
        }
    }

    async function persist_transform_commit(
        message: Extract<WebviewMessage, { type: 'setTransform' }>,
        state: SheetTransformState,
    ): Promise<void> {
        // Restores merely recompute host-owned preferences. Only explicit user
        // actions can replace those preferences, and the core awaits this write
        // before posting its terminal acknowledgement.
        if (message.intent === 'restore') return;
        const expected_authority = transform_authorities.get(message.requestId);
        if (expected_authority === undefined) return;
        const committed = await update_file_state((current) => {
            const sheet = source?.meta().sheets[message.sheetIndex];
                if (
                    disposed
                    || !core
                    || !file_coordinator.state_write_is_current(expected_authority)
                    || source_authority.authorityRevision !== expected_authority
                    || message.sourceGeneration !== core.source_generation
                    || !sheet
                    || (transform_has_entries(state)
                        && state.schema !== transform_schema_for_sheet(sheet))
                ) {
                    return current;
                }
                const transforms = [...(current.transforms ?? [])];
                transforms[message.sheetIndex] = transform_has_entries(state)
                    ? {
                        ...state,
                        sort: state.sort.map((key) => ({ ...key })),
                        filters: state.filters.map((entry) => ({ ...entry })),
                    }
                    : undefined;
            return { ...current, transforms };
        }, undefined, () => (
            !disposed
            && file_coordinator.state_write_is_current(expected_authority)
            && source_authority.authorityRevision === expected_authority
            && message.sourceGeneration === core?.source_generation
        ));
        if (!committed) {
            throw new Error('The source changed before this sort/filter could be saved.');
        }
    }

    function same_refresh_event(
        left: FileRefreshEvent | undefined,
        right: FileRefreshEvent | undefined,
    ): boolean {
        return left === undefined
            ? right === undefined
            : right !== undefined
                && left.refreshRevision === right.refreshRevision
                && left.episode === right.episode;
    }

    function load_is_current(
        seq: number,
        refresh_event?: FileRefreshEvent,
    ): boolean {
        return !disposed
            && seq === load_seq
            && (refresh_event === undefined
                || same_refresh_event(refresh_event, latest_refresh_event));
    }

    function supersede_panel_load(): number {
        reset_reload_retry();
        cancel_refresh_retry_wait();
        return ++load_seq;
    }

    async function build_source(): Promise<SourceCandidate> {
        const state = (await read_file_state()).state as PerFileState;
        const stat = await vscode.workspace.fs.stat(uri);
        const max_mib = get_max_file_size_mib();
        assert_safe_file_size(stat.size, max_mib);
        const raw = await vscode.workspace.fs.readFile(uri);
        assert_safe_file_size(raw.byteLength, max_mib);
        const observation = {
            fingerprint: `${stat.mtime}:${stat.size}`,
            digest: content_digest(raw),
        };
        return new SourceCandidate(
            await profile.build_source(raw, file_path, state),
            observation,
        );
    }

    async function built_source_is_current(
        seq: number,
        candidate: SourceCandidate,
        refresh_event?: FileRefreshEvent,
    ): Promise<boolean> {
        if (!load_is_current(seq, refresh_event)) return false;
        const { fingerprint, digest } = candidate.observation;
        const stat = await vscode.workspace.fs.stat(uri);
        if (
            !load_is_current(seq, refresh_event)
            || `${stat.mtime}:${stat.size}` !== fingerprint
        ) {
            return false;
        }
        const raw = await vscode.workspace.fs.readFile(uri);
        const verified_stat = await vscode.workspace.fs.stat(uri);
        return load_is_current(seq, refresh_event)
            && `${verified_stat.mtime}:${verified_stat.size}` === fingerprint
            && content_digest(raw) === digest;
    }

    async function commit_physical_candidate(
        candidate: SourceCandidate,
        seq: number,
        expected_authority_revision: number,
        already_verified = false,
        refresh_event?: FileRefreshEvent,
    ): Promise<PhysicalAuthorityCommitResult> {
        if (
            !already_verified
            && !await built_source_is_current(seq, candidate, refresh_event)
        ) return { type: 'stale' };
        const { digest } = candidate.observation;
        const started = file_coordinator.begin_physical(
            expected_authority_revision,
            digest,
        );
        if (started.type === 'rejected') return { type: 'rejected' };
        const { token } = started;
        const ds = candidate.borrow();
        const planning_input = ds instanceof ExcelHeaderDataSource
            ? ds.planning_input()
            : undefined;
        const sheet_names = planning_input?.sheets.map((sheet) => sheet.name) ?? [];
        try {
            for (;;) {
                if (
                    !load_is_current(seq, refresh_event)
                    || !file_coordinator.operation_is_current(token)
                ) return { type: 'stale' };
                const state_snapshot = await read_file_state(false);
                const plan = planning_input
                    ? plan_excel_candidate_state(
                        normalize_host_state(state_snapshot.state, sheet_names),
                        planning_input,
                    )
                    : undefined;
                const staged = await stage_authority(
                    durable_state_store,
                    state_path,
                    {
                        id: token.id,
                        kind: 'physical',
                        ordinal: token.ordinal,
                        expectedStateRevision: state_snapshot.revision,
                        expectedCommitSequence: file_coordinator.authority().commitSequence,
                        nextState: plan?.changed ? plan.state : undefined,
                        physicalDigest: digest,
                    },
                );
                if (staged.type === 'conflict') {
                    const current_authority = file_coordinator.authority();
                    const relation = compare_authority(staged.authority, current_authority);
                    if (relation === 'equal') continue;
                    if (relation === 'dominates') {
                        const observation_turn = await file_coordinator.request_commit_turn(token);
                        if (observation_turn.type === 'granted') {
                            if (same_authority(
                                file_coordinator.authority(),
                                current_authority,
                            )) {
                                file_coordinator.observe_advanced_authority(
                                    token,
                                    observation_turn.turn,
                                    staged.authority,
                                );
                            } else {
                                file_coordinator.release_commit_turn(observation_turn.turn);
                            }
                        }
                        return { type: 'advanced' };
                    }
                    return { type: 'rejected' };
                }
                const requested = await file_coordinator.request_commit_turn(token);
                if (requested.type === 'rejected') return { type: 'rejected' };
                const finalizationBasis = file_coordinator.authority();
                const descriptor = {
                    transactionId: token.id,
                    kind: 'physical' as const,
                    basis: finalizationBasis,
                    expectedStateRevision: state_snapshot.revision,
                    previousState: state_snapshot.state,
                    nextState: plan?.changed ? plan.state : undefined,
                    physicalDigest: digest,
                };
                file_coordinator.start_finalization(requested.turn);
                let finalized: Awaited<ReturnType<typeof finalize_authority>>;
                try {
                    finalized = await finalize_authority(
                        durable_state_store,
                        state_path,
                        token.id,
                    );
                } catch (error) {
                    let reconciled;
                    try {
                        reconciled = await reconcile_finalization(
                            durable_state_store,
                            state_path,
                            descriptor,
                        );
                    } catch {
                        file_coordinator.release_commit_turn(requested.turn);
                        throw error;
                    }
                    if (reconciled.type === 'committed') {
                        return {
                            type: 'committed',
                            receipt: file_coordinator.finalize_authority_commit(
                                token,
                                requested.turn,
                                reconciled,
                                finalizationBasis,
                            ),
                        };
                    }
                    if (reconciled.type === 'advanced') {
                        const relation = compare_authority(
                            reconciled.authority,
                            file_coordinator.authority(),
                        );
                        if (relation === 'dominates') {
                            file_coordinator.observe_advanced_authority(
                                token,
                                requested.turn,
                                reconciled.authority,
                            );
                            return { type: 'advanced' };
                        }
                        file_coordinator.release_commit_turn(requested.turn);
                        return { type: 'rejected' };
                    }
                    file_coordinator.release_commit_turn(requested.turn);
                    void discard_authority(durable_state_store, state_path, token.id);
                    throw error;
                }
                if (finalized.type === 'conflict') {
                    const relation = compare_authority(
                        finalized.authority,
                        finalizationBasis,
                    );
                    if (relation === 'dominates') {
                        file_coordinator.observe_advanced_authority(
                            token,
                            requested.turn,
                            finalized.authority,
                        );
                        return { type: 'advanced' };
                    }
                    file_coordinator.release_commit_turn(requested.turn);
                    if (relation === 'equal') continue;
                    return { type: 'rejected' };
                }
                let inspected;
                try {
                    inspected = await durable_state_store.inspect_authority_transaction(
                        state_path,
                        token.id,
                    );
                } catch {
                    file_coordinator.observe_advanced_authority(
                        token,
                        requested.turn,
                        finalized.authority,
                    );
                    return { type: 'advanced' };
                }
                const inspected_relation = compare_authority(
                    inspected.authority,
                    finalized.authority,
                );
                if (inspected_relation === 'dominates') {
                    file_coordinator.observe_advanced_authority(
                        token,
                        requested.turn,
                        inspected.authority,
                    );
                    return { type: 'advanced' };
                }
                if (inspected_relation !== 'equal') {
                    file_coordinator.observe_advanced_authority(
                        token,
                        requested.turn,
                        finalized.authority,
                    );
                    return { type: 'advanced' };
                }
                return {
                    type: 'committed',
                    receipt: file_coordinator.finalize_authority_commit(
                        token,
                        requested.turn,
                        finalized,
                        finalizationBasis,
                    ),
                };
            }
        } finally {
            file_coordinator.cancel(token);
            void discard_authority(durable_state_store, state_path, token.id);
        }
    }

    function adopt_committed_candidate(
        candidate: SourceCandidate,
        committed: Extract<PhysicalAuthorityCommitResult, { type: 'committed' }>,
        seq: number,
        reason: 'ready' | 'fileReload' | 'recovery' = 'fileReload',
        projected_state?: FileStateSnapshot,
        refresh_event?: FileRefreshEvent,
    ): DataSource | undefined {
        // A durable commit can finish after a newer panel-local load starts. Keep
        // ownership with the candidate unless this exact load is still current at
        // the synchronous installation boundary.
        if (!load_is_current(seq, refresh_event)) return undefined;
        const inspected = candidate.borrow();
        if (inspected instanceof ExcelHeaderDataSource) {
            const committed_state = normalize_host_state(
                committed.receipt.stateSnapshot.state,
                inspected.meta().sheets.map((sheet) => sheet.name),
            );
            inspected.replace_overrides(sanitize_excel_header_overrides(
                committed_state.excelFirstRowHeaders,
            ));
        }
        let adopted: DataSource | undefined;
        const transferred = candidate.transfer_to((next, confirm_transfer) => {
            if (!load_is_current(seq, refresh_event)) return;
            const result = adopt_source_into_core(
                core,
                panel,
                undefined,
                next,
                { onTransformCommit: persist_transform_commit },
                (installed) => {
                    const material = installed.snapshot_material();
                    const adoption_state = project_state_for_panel(
                        projected_state ?? committed.receipt.stateSnapshot,
                        true,
                    );
                    const adoption: PanelAdoption = {
                        source: 'commitReceipt',
                        canonicalFileId: file_key,
                        resources: { source: next, core: installed },
                        receipt: committed.receipt,
                        core: material.core,
                        diagnostics: material.diagnostics,
                        warnings: Object.freeze([...(next.warnings ?? [])]),
                        reason,
                        project: () => ({
                            configuration: {
                                defaultTabOrientation: get_default_orientation(),
                                previewMode: profile.previewMode === true,
                            },
                            capabilities: {
                                csvEditingSupported: profile.editing,
                                csvEditable: profile.editing
                                    && editing_available_for_panel()
                                    && !next.truncationMessage,
                                ...(owns_edit_session() && active_edit_session_id
                                    ? { csvEditSessionId: active_edit_session_id }
                                    : {}),
                            },
                            stateSnapshot: adoption_state,
                        }),
                    };
                    core = installed;
                    source = next;
                    source_authority = committed.receipt.resultingBasis;
                    session.replace_adoption(adoption, () => {
                        confirm_transfer();
                        adopted = next;
                    });
                },
            );
            if (result.type === 'refused') return;
        });
        if (!transferred || !adopted || disposed) return undefined;
        profile.on_source_adopted?.(adopted);
        return adopted;
    }

    function schedule_header_refresh(): void {
        if (disposed || header_refresh_scheduled) return;
        header_refresh_scheduled = true;
        queueMicrotask(() => {
            if (disposed) {
                header_refresh_scheduled = false;
                return;
            }
            void refresh_panel_source(true).finally(() => {
                header_refresh_scheduled = false;
            });
        });
    }

    function process_excel_header_receipts(): void {
        if (disposed || header_receipt_processing) return;
        header_receipt_processing = true;
        try {
            header_receipt_queue.sort((left, right) => (
                left.operationOrdinal - right.operationOrdinal
            ));
            while (header_receipt_queue.length > 0 && !disposed) {
                const receipt = header_receipt_queue.shift()!;
                const is_origin = receipt.originToken === excel_header_subscriber_token;
                try {
                    if (same_file_authority_basis(
                        source_authority,
                        receipt.resultingBasis,
                    )) {
                        if (is_origin) {
                            session.retain_command_result({
                                type: 'excelFirstRowHeader',
                                requestId: receipt.requestId,
                                outcome: 'applied',
                            });
                        }
                        continue;
                    }
                    if (
                        compare_authority(receipt.resultingBasis, source_authority)
                            === 'dominated'
                    ) {
                        if (is_origin) {
                            session.retain_command_result({
                                type: 'excelFirstRowHeader',
                                requestId: receipt.requestId,
                                outcome: 'recovered',
                                error: 'A newer workbook projection was already active.',
                            });
                        }
                        continue;
                    }
                    const exact_basis = same_file_authority_basis(
                        source_authority,
                        receipt.previousBasis,
                    ) || (
                        same_semantic_authority_basis(
                            source_authority,
                            receipt.previousBasis,
                        )
                        && compare_authority(
                            receipt.previousBasis,
                            source_authority,
                        ) === 'dominates'
                    );
                    const current_adoption = session.current_adoption();
                    if (
                        exact_basis
                        && core
                        && source instanceof ExcelHeaderDataSource
                        && current_adoption?.resources.source === source
                        && current_adoption.resources.core === core
                        && source.set_override(receipt.sheetName, receipt.override)
                    ) {
                        const projection_adoption = adopt_source_into_core(
                            core,
                            panel,
                            source,
                            source,
                        );
                        if (projection_adoption.type !== 'refused') {
                            core = projection_adoption.core;
                            source_authority = receipt.resultingBasis;
                            if (is_origin) {
                                session.retain_command_result({
                                    type: 'excelFirstRowHeader',
                                    requestId: receipt.requestId,
                                    outcome: 'applied',
                                }, { deliver: false });
                            }
                            const material = core.snapshot_material();
                            session.replace_adoption({
                                source: 'commitReceipt',
                                canonicalFileId: file_key,
                                resources: { source, core },
                                receipt,
                                core: material.core,
                                diagnostics: material.diagnostics,
                                warnings: Object.freeze([...(source.warnings ?? [])]),
                                reason: 'excelHeader',
                                project: () => ({
                                    configuration: {
                                        defaultTabOrientation: get_default_orientation(),
                                        previewMode: profile.previewMode === true,
                                    },
                                    capabilities: {
                                        csvEditingSupported: profile.editing,
                                        csvEditable: profile.editing
                                            && editing_available_for_panel()
                                            && !source!.truncationMessage,
                                        ...(owns_edit_session() && active_edit_session_id
                                            ? { csvEditSessionId: active_edit_session_id }
                                            : {}),
                                    },
                                    stateSnapshot: project_state_for_panel(
                                        receipt.stateSnapshot,
                                        true,
                                    ),
                                }),
                            });
                            continue;
                        }
                    }
                    if (is_origin) {
                        session.retain_command_result({
                            type: 'excelFirstRowHeader',
                            requestId: receipt.requestId,
                            outcome: 'recovered',
                            error: 'The header setting was saved after rebuilding the workbook view.',
                        }, { deliver: false });
                    }
                    schedule_header_refresh();
                } catch (error) {
                    console.error('Failed to apply an Excel header receipt', error);
                    if (is_origin) {
                        session.retain_command_result({
                            type: 'excelFirstRowHeader',
                            requestId: receipt.requestId,
                            outcome: 'recovered',
                            error: 'The header setting was saved after rebuilding the workbook view.',
                        }, { deliver: false });
                    }
                    schedule_header_refresh();
                }
            }
        } finally {
            header_receipt_processing = false;
            if (header_receipt_queue.length > 0 && !disposed) {
                queueMicrotask(process_excel_header_receipts);
            }
        }
    }

    function enqueue_excel_header_receipt(receipt: ExcelHeaderOperationReceipt): void {
        if (disposed) return;
        header_receipt_queue.push(receipt);
        queueMicrotask(process_excel_header_receipts);
    }

    try {
        disposables.push(file_coordinator.subscribe_excel_headers(
            enqueue_excel_header_receipt,
        ));
    } catch (error) {
        return abort_setup(error);
    }

    // CSV pending-edit persistence deliberately remains on FileStateStore's CAS
    // queue in this phase. Edit-session ownership is separate from file authority;
    // physical/projection/layout writes use the coordinator serialization above.
    async function clear_pending_edits(): Promise<FileStateSnapshot> {
        const committed = await update_file_state((current) => {
            if (!current.pendingEdits) return current;
            const { pendingEdits: _drop, ...rest } = current;
            return rest;
        });
        return committed ?? refresh_session_state_material(false);
    }

    function recover_uncertain_edit_cleanup(): Promise<boolean> {
        if (!file_edit_state) return Promise.resolve(false);
        const phase = file_edit_state.phase;
        if (phase.type !== 'uncertain') {
            return Promise.resolve(phase.type === 'free');
        }
        if (!file_edit_state.recovery) {
            const operation = phase.operation;
            const recovery = (async () => {
                try {
                    const snapshot = await clear_pending_edits();
                    // Recovery only restores file availability. A live request waiter
                    // must subsequently win the ordinary free -> owned transition.
                    finish_edit_cleanup(operation, true, snapshot);
                    if (!disposed) update_session_state_material(snapshot, false);
                    return true;
                } catch (error) {
                    console.error('Failed to recover CSV pending-edit cleanup', error);
                    return false;
                }
            })();
            file_edit_state.recovery = recovery;
            void recovery.finally(() => {
                if (file_edit_state?.recovery === recovery) {
                    file_edit_state.recovery = undefined;
                }
            });
        }
        return file_edit_state.recovery;
    }

    function wait_for_edit_cleanup_recovery(waiter: symbol): Promise<boolean> {
        const recovery = recover_uncertain_edit_cleanup();
        return new Promise((resolve) => {
            const settle = (recovered: boolean) => {
                const current = edit_cleanup_waiters.get(waiter);
                if (!current) return;
                clearTimeout(current.timer);
                edit_cleanup_waiters.delete(waiter);
                resolve(recovered);
            };
            const timer = setTimeout(
                () => settle(false),
                EDIT_CLEANUP_RECOVERY_MS,
            );
            edit_cleanup_waiters.set(waiter, { timer, resolve: settle });
            void recovery.then((recovered) => settle(
                recovered && !disposed && edit_cleanup_waiters.has(waiter),
            ));
        });
    }

    function cancel_edit_cleanup_waiter(waiter: symbol): void {
        edit_cleanup_waiters.get(waiter)?.resolve(false);
    }

    function cancel_edit_cleanup_waiters(): void {
        for (const pending of [...edit_cleanup_waiters.values()]) {
            pending.resolve(false);
        }
        current_edit_cleanup_waiter = undefined;
    }

    function cancel_refresh_retry_wait(): void {
        if (!refresh_retry_wait) return;
        const wait = refresh_retry_wait;
        refresh_retry_wait = undefined;
        clearTimeout(wait.timer);
        wait.resolve(false);
    }

    function wait_for_refresh_retry(request: PanelLoadRequest): Promise<boolean> {
        if (!load_is_current(request.seq, request.refreshEvent)) {
            return Promise.resolve(false);
        }
        cancel_refresh_retry_wait();
        return new Promise((resolve) => {
            const wait = {
                timer: undefined as unknown as ReturnType<typeof setTimeout>,
                resolve,
            };
            wait.timer = setTimeout(() => {
                if (refresh_retry_wait === wait) refresh_retry_wait = undefined;
                resolve(load_is_current(request.seq, request.refreshEvent));
            }, RELOAD_RETRY_MS);
            refresh_retry_wait = wait;
        });
    }

    function inactive_refresh_result(): FileRefreshSubscriberResult {
        return disposed ? { type: 'disposed' } : { type: 'superseded' };
    }

    function report_refresh_failure(
        error: unknown,
        initial: boolean,
        post_save = false,
    ): void {
        if (initial) {
            void vscode.window.showErrorMessage(
                error instanceof Error ? error.message : String(error));
            return;
        }
        console.error('Failed to reload table viewer data', error);
        const message = `Failed to reload: ${error instanceof Error ? error.message : String(error)}`;
        if (post_save) {
            void vscode.window.showWarningMessage(
                `The file was saved, but Table Viewer could not refresh the table view. ${message}`);
        } else {
            void vscode.window.showErrorMessage(message);
        }
    }

    async function run_physical_refresh(
        request: PanelLoadRequest,
        force: boolean,
        reason: 'ready' | 'fileReload' | 'recovery',
        initial = false,
    ): Promise<FileRefreshSubscriberResult> {
        let attempts = 0;
        let last_error: unknown = new Error('The file changed while it was being refreshed.');
        for (;;) {
            if (!load_is_current(request.seq, request.refreshEvent)) {
                return inactive_refresh_result();
            }
            let candidate: SourceCandidate | undefined;
            try {
                const expected_authority = file_coordinator.authority().authorityRevision;
                candidate = await build_source();
                if (!load_is_current(request.seq, request.refreshEvent)) {
                    return inactive_refresh_result();
                }
                if (!await built_source_is_current(
                    request.seq,
                    candidate,
                    request.refreshEvent,
                )) {
                    if (!load_is_current(request.seq, request.refreshEvent)) {
                        return inactive_refresh_result();
                    }
                    last_error = new Error('The file changed while it was being refreshed.');
                } else if (
                    !force
                    && candidate.observation.digest
                        === session.acknowledged_physical_digest()
                ) {
                    const deduplicated = await commit_physical_candidate(
                        candidate,
                        request.seq,
                        expected_authority,
                        true,
                        request.refreshEvent,
                    );
                    if (!load_is_current(request.seq, request.refreshEvent)) {
                        return inactive_refresh_result();
                    }
                    if (deduplicated.type === 'committed') {
                        source_authority = deduplicated.receipt.resultingBasis;
                        update_session_state_material(
                            deduplicated.receipt.stateSnapshot,
                            true,
                        );
                        return { type: 'completed' };
                    }
                    last_error = new Error('The file authority changed while it was refreshed.');
                } else {
                    const committed = await commit_physical_candidate(
                        candidate,
                        request.seq,
                        expected_authority,
                        true,
                        request.refreshEvent,
                    );
                    if (!load_is_current(request.seq, request.refreshEvent)) {
                        return inactive_refresh_result();
                    }
                    if (committed.type === 'committed') {
                        const adopted = adopt_committed_candidate(
                            candidate,
                            committed,
                            request.seq,
                            reason,
                            profile.editing ? await read_file_state() : undefined,
                            request.refreshEvent,
                        );
                        if (!load_is_current(request.seq, request.refreshEvent)) {
                            return inactive_refresh_result();
                        }
                        if (adopted) return { type: 'completed' };
                    }
                    last_error = new Error('The file authority changed while it was refreshed.');
                }
            } catch (error) {
                if (!load_is_current(request.seq, request.refreshEvent)) {
                    return inactive_refresh_result();
                }
                last_error = error;
            } finally {
                candidate?.dispose();
            }
            if (attempts >= RELOAD_RETRY_COUNT) {
                if (!load_is_current(request.seq, request.refreshEvent)) {
                    return inactive_refresh_result();
                }
                report_refresh_failure(
                    last_error,
                    initial,
                    request.refreshEvent?.reason === 'postSave',
                );
                return { type: 'failed', error: last_error };
            }
            attempts += 1;
            if (!await wait_for_refresh_retry(request)) {
                return inactive_refresh_result();
            }
        }
    }

    async function run_local_refresh_attempt(
        request: PanelLoadRequest,
        force: boolean,
        reason: 'ready' | 'fileReload' | 'recovery',
        initial: boolean,
    ): Promise<boolean> {
        if (!load_is_current(request.seq)) return false;
        let candidate: SourceCandidate | undefined;
        try {
            const expected_authority = file_coordinator.authority().authorityRevision;
            candidate = await build_source();
            if (!await built_source_is_current(request.seq, candidate)) {
                schedule_local_refresh_retry(request, force, reason, initial);
                return false;
            }
            if (
                !force
                && candidate.observation.digest
                    === session.acknowledged_physical_digest()
            ) {
                const deduplicated = await commit_physical_candidate(
                    candidate, request.seq, expected_authority, true,
                );
                if (deduplicated.type === 'committed' && load_is_current(request.seq)) {
                    source_authority = deduplicated.receipt.resultingBasis;
                    update_session_state_material(deduplicated.receipt.stateSnapshot, true);
                    reset_reload_retry();
                    return true;
                }
                schedule_local_refresh_retry(request, force, reason, initial);
                return false;
            }
            const committed = await commit_physical_candidate(
                candidate, request.seq, expected_authority, true,
            );
            if (committed.type !== 'committed') {
                schedule_local_refresh_retry(request, force, reason, initial);
                return false;
            }
            const adopted = adopt_committed_candidate(
                candidate,
                committed,
                request.seq,
                reason,
                profile.editing ? await read_file_state() : undefined,
            );
            if (!adopted) return false;
            reset_reload_retry();
            return true;
        } catch (error) {
            if (!load_is_current(request.seq)) return false;
            if (!schedule_local_refresh_retry(request, force, reason, initial)) {
                report_refresh_failure(error, initial);
            }
            return false;
        } finally {
            candidate?.dispose();
        }
    }

    function refresh_panel_source(
        force: boolean,
        reason: 'ready' | 'fileReload' | 'recovery' = force ? 'recovery' : 'fileReload',
        initial = false,
    ): Promise<boolean> {
        if (disposed) return Promise.resolve(false);
        const request = { seq: supersede_panel_load() };
        return run_local_refresh_attempt(request, force, reason, initial);
    }

    function refresh_from_event(
        event: FileRefreshEvent,
    ): Promise<FileRefreshSubscriberResult> {
        if (disposed) return Promise.resolve({ type: 'disposed' });
        latest_refresh_event = event;
        session.wake_delivery();
        const request = {
            seq: supersede_panel_load(),
            refreshEvent: event,
        };
        const projection_recovery = event.reason === 'projectionRecovery';
        return run_physical_refresh(
            request,
            projection_recovery,
            projection_recovery ? 'recovery' : 'fileReload',
        );
    }

    async function send_initial_data(): Promise<void> {
        await refresh_panel_source(true, 'ready', true);
    }

    function reset_reload_retry(): void {
        reload_retry_attempts = 0;
        if (reload_retry_timer !== undefined) {
            clearTimeout(reload_retry_timer);
            reload_retry_timer = undefined;
        }
    }

    function schedule_local_refresh_retry(
        request: PanelLoadRequest,
        force: boolean,
        reason: 'ready' | 'fileReload' | 'recovery',
        initial: boolean,
    ): boolean {
        if (
            !load_is_current(request.seq)
            || reload_retry_attempts >= RELOAD_RETRY_COUNT
        ) {
            return false;
        }
        reload_retry_attempts += 1;
        if (reload_retry_timer !== undefined) clearTimeout(reload_retry_timer);
        reload_retry_timer = setTimeout(() => {
            reload_retry_timer = undefined;
            if (load_is_current(request.seq)) {
                void run_local_refresh_attempt(request, force, reason, initial);
            }
        }, RELOAD_RETRY_MS);
        return true;
    }

    function wait_for_ready_state_retry(ms: number): Promise<boolean> {
        if (disposed) return Promise.resolve(false);
        return new Promise((resolve) => {
            const wait = {
                timer: undefined as unknown as ReturnType<typeof setTimeout>,
                resolve,
            };
            wait.timer = setTimeout(() => {
                ready_state_retry_waits.delete(wait);
                resolve(true);
            }, ms);
            ready_state_retry_waits.add(wait);
        });
    }

    function cancel_ready_state_retry_waits(): void {
        for (const wait of [...ready_state_retry_waits]) {
            clearTimeout(wait.timer);
            ready_state_retry_waits.delete(wait);
            wait.resolve(false);
        }
    }

    async function read_state_for_ready_epoch(
        receiver_epoch: number,
    ): Promise<FileStateSnapshot | undefined> {
        for (let attempt = 0; attempt <= READY_STATE_RETRY_COUNT; attempt += 1) {
            if (
                disposed
                || !session.ready_epoch_is_current(receiver_epoch)
            ) return undefined;
            try {
                return await read_file_state();
            } catch (error) {
                if (
                    disposed
                    || !session.ready_epoch_is_current(receiver_epoch)
                ) return undefined;
                if (attempt === READY_STATE_RETRY_COUNT) {
                    console.error(
                        'Failed to refresh table viewer state before ready; using retained state',
                        error,
                    );
                    return undefined;
                }
                const proceed = await wait_for_ready_state_retry(
                    READY_STATE_RETRY_MS * (2 ** attempt),
                );
                if (
                    !proceed
                    || disposed
                    || !session.ready_epoch_is_current(receiver_epoch)
                ) return undefined;
            }
        }
        return undefined;
    }

    function edit_message_is_current(edit_session_id: string | undefined): boolean {
        return owns_edit_session()
            && active_edit_session_id !== undefined
            && edit_session_id === active_edit_session_id;
    }

    async function handle_save(
        edits: Record<string, string>,
        edit_session_id: string,
    ): Promise<void> {
        if (!edit_message_is_current(edit_session_id) || save_command_pending) {
            void panel.webview.postMessage({ type: 'saveResult', success: false });
            return;
        }
        // Fence all later pending-edit messages synchronously, then settle every
        // accepted pre-boundary persistence write before validating/serializing.
        save_command_pending = true;
        let content: string;
        let post_save_reservation: { cancel(): void } | undefined;
        try {
            await pending_edit_writes;
            const current_adoption = session.current_adoption();
            const expected_digest = session.acknowledged_physical_digest();
            const src = source;
            if (
                edit_cleanup_blocked()
                || !profile.editing
                || !owns_edit_session()
                || !src
                || !!src.truncationMessage
                || expected_digest === undefined
                || !session.acknowledged_current()
                || current_adoption?.resources.source !== src
                || current_adoption.resources.core !== core
                || source_authority.authorityRevision
                    !== file_coordinator.authority().authorityRevision
            ) {
                save_command_pending = false;
                vscode.window.showWarningMessage(
                    'The table view is still refreshing. Please try saving again.');
                void panel.webview.postMessage({ type: 'saveResult', success: false });
                return;
            }

            const acknowledged_source = src;
            const SAVE_WINDOW = 10_000;
            const row_count = acknowledged_source.meta().sheets[0].rowCount;
            function* row_windows(): Generator<(RenderedCell | null)[]> {
                for (let start = 0; start < row_count; start += SAVE_WINDOW) {
                    const { rows } = acknowledged_source.read_rows(0, start, SAVE_WINDOW);
                    for (const row of rows) yield row;
                }
            }
            // Serialize only from the exact source/core adoption acknowledged by
            // this panel. serialize_csv restores the promoted CSV header line.
            content = serialize_csv(
                row_windows(), get_delimiter(file_path), edits,
                acknowledged_source.originalColumnCounts,
                acknowledged_source.lineEnding,
                acknowledged_source.headerLine);

            const current_stat = await vscode.workspace.fs.stat(uri);
            const max_mib = get_max_file_size_mib();
            assert_safe_file_size(current_stat.size, max_mib);
            const current_raw = await vscode.workspace.fs.readFile(uri);
            assert_safe_file_size(current_raw.byteLength, max_mib);
            const verified_stat = await vscode.workspace.fs.stat(uri);
            const snapshot_changed = current_stat.mtime !== verified_stat.mtime
                || current_stat.size !== verified_stat.size;
            if (
                snapshot_changed
                || content_digest(current_raw) !== expected_digest
                || !owns_edit_session()
                || !session.acknowledged_current()
                || session.current_adoption() !== current_adoption
                || current_adoption.resources.source !== src
                || current_adoption.resources.core !== core
                || source_authority.authorityRevision
                    !== file_coordinator.authority().authorityRevision
            ) {
                vscode.window.showWarningMessage(
                    'File was modified externally. Please review the changes and try again.');
                // A conflict performs only panel-local forced recovery. The external
                // editor's watcher event independently refreshes every attachment;
                // no write occurred, so this must not create a postSave episode.
                await refresh_panel_source(true, 'recovery');
                save_command_pending = false;
                void panel.webview.postMessage({ type: 'saveResult', success: false });
                return;
            }

            // Hold a synchronously queued own-write watcher batch until the
            // successful postSave request can absorb it into one canonical episode.
            post_save_reservation = refresh_subscription.reserve_post_save();
            save_write_pending = true;
            // Known limitation: an external writer can still win the interval after
            // the final check and before/during writeFile. Phase 5.3 deliberately
            // does not claim that watcher coordination closes this pre-write TOCTOU.
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        } catch (error) {
            save_command_pending = false;
            save_write_pending = false;
            post_save_reservation?.cancel();
            if (disposed) {
                release_edit_session();
                if (
                    file_edit_state
                    && file_edit_state.attachments === 0
                    && file_edit_state.phase.type === 'free'
                ) {
                    csv_edit_file_states.delete(file_key);
                }
            }
            vscode.window.showErrorMessage(
                `Failed to save: ${error instanceof Error ? error.message : String(error)}`);
            void panel.webview.postMessage({ type: 'saveResult', success: false });
            return;
        }

        save_write_pending = false;
        // writeFile completed: atomically block all file attachments from claiming
        // or projecting durable edits before reporting the irrevocable disk success.
        let cleanup_operation = begin_edit_cleanup();
        if (!cleanup_operation) {
            // The write still succeeded. This can only indicate an internal ownership
            // invariant failure, so conservatively block the file and still attempt
            // the durable cleanup.
            cleanup_operation = Symbol(file_key);
            if (file_edit_state) {
                file_edit_state.phase = {
                    type: 'cleanupPending',
                    operation: cleanup_operation,
                };
            }
            console.error('CSV save lost edit ownership after writeFile');
        }
        // Exactly one terminal result is posted immediately, while GridShell is
        // still mounted to clear its save-in-flight state. Neither durable-state
        // cleanup nor the requesting panel's parser can emit a later failure.
        void panel.webview.postMessage({ type: 'saveResult', success: true });
        void panel.webview.postMessage({
            type: 'editSessionRevoked',
            reason: 'saved',
        });
        notify_edit_state();

        void refresh_subscription.request('postSave').then((refresh) => {
            if (refresh.type === 'disposed') {
                console.warn('CSV save refresh was skipped because the panel was disposed');
            }
        }).catch((error) => {
            console.error('Post-save refresh request failed (file was written)', error);
            void vscode.window.showWarningMessage(
                'The file was saved, but Table Viewer could not refresh the table view.');
        });

        void clear_pending_edits().then((snapshot) => {
            finish_edit_cleanup(cleanup_operation, true, snapshot);
            if (!disposed) update_session_state_material(snapshot, false);
        }).catch((error) => {
            finish_edit_cleanup(cleanup_operation, false);
            console.error('CSV save succeeded but pending-edit cleanup failed', error);
            void vscode.window.showWarningMessage(
                'The file was saved, but Table Viewer could not clear its saved edit state. Editing remains disabled for this file.');
        });
    }

    try {
        disposables.push(panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
        if (disposed) return;
        if (
            msg.type !== 'ready'
            && msg.type !== 'snapshotApplied'
            && msg.type !== 'showWarning'
        ) {
            session.wake_delivery();
        }
        switch (msg.type) {
            case 'ready': {
                const begun = session.begin_ready();
                if (begun.hasSource) {
                    const state_snapshot = await read_state_for_ready_epoch(
                        begun.receiverEpoch,
                    );
                    if (
                        disposed
                        || !session.ready_epoch_is_current(begun.receiverEpoch)
                    ) return;
                    if (state_snapshot) {
                        update_session_state_material(state_snapshot, true);
                    }
                }
                const ready = session.complete_ready(begun.receiverEpoch);
                if (ready.type === 'needsInitialSource') await send_initial_data();
                return;
            }
            case 'snapshotApplied':
                session.handle_snapshot_applied(msg.identity, msg.disposition);
                return;
            case 'stateChanged': {
                const expected_authority = source_authority.authorityRevision;
                const message = structuredClone(msg);
                await enqueue_layout_write(
                    () => persist_layout_state(message, expected_authority),
                );
                return;
            }
            case 'setExcelFirstRowHeader': {
                const fail = (error: string) => {
                    session.retain_command_result({
                        type: 'excelFirstRowHeader',
                        requestId: msg.requestId,
                        outcome: 'rejected',
                        error,
                    });
                };
                if (
                    disposed
                    || !(source instanceof ExcelHeaderDataSource)
                    || !core
                ) {
                    fail('First-row headers are only available for Excel worksheets.');
                    return;
                }
                if (
                    !session.acknowledged_current()
                    || source_authority.authorityRevision
                        !== file_coordinator.authority().authorityRevision
                    || msg.generation !== core.generation
                    || msg.sourceGeneration !== core.source_generation
                ) {
                    fail('The worksheet changed before the header request arrived.');
                    return;
                }
                const sheet = source.meta().sheets[msg.sheetIndex];
                if (!sheet || sheet.name !== msg.sheetName) {
                    fail('The selected worksheet no longer matches this request.');
                    return;
                }
                const header = sheet.excelFirstRowHeader;
                if (!header) {
                    fail('First-row headers are only available for Excel worksheets.');
                    return;
                }
                if (msg.enabled && !header.available) {
                    fail('This worksheet has no first row to use as column names.');
                    return;
                }

                const command_source = source;
                const expected_physical_revision = source_authority.physicalRevision;
                const expected_physical_digest = source_authority.physicalDigest;
                const result = await file_coordinator.commit_excel_header({
                    requestId: msg.requestId,
                    sheetIndex: msg.sheetIndex,
                    sheetName: msg.sheetName,
                    override: msg.enabled ? 'on' : 'off',
                    originToken: excel_header_subscriber_token,
                    expectedPhysicalRevision: expected_physical_revision,
                    expectedPhysicalDigest: expected_physical_digest,
                    planningInput: command_source.planning_input(),
                    stateStore: durable_state_store,
                });
                if (result.type === 'indeterminate' && !disposed) {
                    session.retain_command_result({
                        type: 'excelFirstRowHeader',
                        requestId: msg.requestId,
                        outcome: 'recovered',
                        error: result.error,
                    });
                } else if (result.type === 'rejected' && !disposed) {
                    fail(result.error);
                }
                return;
            }
            case 'setColumnVisibility': {
                const expected_authority = source_authority.authorityRevision;
                await update_file_state((current) => {
                        if (
                            !source
                            || !core
                            || !file_coordinator.state_write_is_current(expected_authority)
                            || source_authority.authorityRevision !== expected_authority
                            || msg.sourceGeneration !== core.source_generation
                        ) {
                            return current;
                        }
                        const sheet = source.meta().sheets[msg.sheetIndex];
                        if (!sheet || sheet.name !== msg.sheetName) return current;
                        const columnVisibility = [...(current.columnVisibility ?? [])];
                        columnVisibility[msg.sheetIndex] = sanitize_column_visibility_state(
                            msg.state,
                            sheet.columnCount,
                            transform_schema_for_sheet(sheet),
                        );
                    return { ...current, columnVisibility };
                }, undefined, () => (
                    file_coordinator.state_write_is_current(expected_authority)
                    && source_authority.authorityRevision === expected_authority
                    && msg.sourceGeneration === core?.source_generation
                ));
                return;
            }
            case 'requestEditSession': {
                const recovery_waiter = edit_phase().type === 'uncertain'
                    ? Symbol(file_key)
                    : undefined;
                if (recovery_waiter && current_edit_cleanup_waiter) {
                    cancel_edit_cleanup_waiter(current_edit_cleanup_waiter);
                }
                if (recovery_waiter) current_edit_cleanup_waiter = recovery_waiter;
                const recovered = recovery_waiter
                    ? await wait_for_edit_cleanup_recovery(recovery_waiter)
                    : true;
                const recovery_authorized = !recovery_waiter
                    || (
                        recovered
                        && current_edit_cleanup_waiter === recovery_waiter
                    );
                if (current_edit_cleanup_waiter === recovery_waiter) {
                    current_edit_cleanup_waiter = undefined;
                }
                if (disposed) return;
                const phase = edit_phase();
                const cleanup_blocked = phase.type === 'cleanupPending'
                    || phase.type === 'uncertain';
                const can_edit = recovery_authorized
                    && !disposed
                    && profile.editing
                    && !cleanup_blocked
                    && !!source
                    && !source.truncationMessage
                    && !(core?.has_transform_work ?? false);
                const denied_by_owner = can_edit
                    && phase.type === 'owned'
                    && phase.token !== edit_session_token;
                const denied_by_transform = profile.editing
                    && !!source
                    && !source.truncationMessage
                    && (core?.has_transform_work ?? false);
                if (can_edit && !denied_by_owner) save_command_pending = false;
                const granted = can_edit && !denied_by_owner && try_claim_edit_session();
                const edit_state = granted ? await read_file_state() : undefined;
                if (edit_state) update_session_state_material(edit_state);
                const pendingEdits = granted
                    ? (edit_state?.state as PerFileState | undefined)?.pendingEdits
                    : undefined;
                panel.webview.postMessage({
                    type: 'editSessionResult',
                    granted,
                    ...(granted && active_edit_session_id
                        ? { editSessionId: active_edit_session_id }
                        : {}),
                    ...(pendingEdits ? { pendingEdits } : {}),
                });
                if (cleanup_blocked) {
                    vscode.window.showWarningMessage(
                        'Editing is temporarily unavailable while saved edit state is being cleared.');
                } else if (denied_by_owner) {
                    vscode.window.showWarningMessage(
                        'This file is already being edited in another Table Viewer tab.');
                } else if (denied_by_transform) {
                    vscode.window.showWarningMessage(
                        'Clear sorting and filters before entering edit mode.');
                }
                return;
            }
            case 'setTransform':
                if (profile.editing && owns_edit_session()) {
                    await core?.reject_transform(
                        msg,
                        'Exit edit mode before sorting or filtering.',
                    );
                    return;
                }
                transform_authorities.set(
                    msg.requestId,
                    source_authority.authorityRevision,
                );
                try {
                    await core?.handle_message(msg);
                } finally {
                    transform_authorities.delete(msg.requestId);
                }
                return;
            case 'releaseEditSession':
                if (profile.editing) {
                    release_edit_session();
                    await refresh_session_state_material(false);
                }
                return;
            case 'discardEditSession':
                if (profile.editing && owns_edit_session()) {
                    const operation = begin_edit_cleanup();
                    if (!operation) return;
                    notify_edit_state();
                    try {
                        const snapshot = await clear_pending_edits();
                        finish_edit_cleanup(operation, true, snapshot);
                        if (!disposed) update_session_state_material(snapshot, false);
                    } catch (error) {
                        finish_edit_cleanup(operation, false);
                        console.error('Failed to clear discarded CSV edits', error);
                        void vscode.window.showWarningMessage(
                            'Table Viewer could not clear the discarded edit state. Editing remains disabled for this file.');
                    }
                }
                return;
            case 'showWarning':
                vscode.window.showWarningMessage(msg.message);
                return;
            case 'saveCsv':
                if (profile.editing && edit_message_is_current(msg.editSessionId)) {
                    await handle_save(msg.edits, msg.editSessionId);
                } else if (profile.editing) {
                    panel.webview.postMessage({ type: 'saveResult', success: false });
                }
                return;
            case 'pendingEditsChanged': {
                if (!profile.editing || save_command_pending) return;
                if (!edit_message_is_current(msg.editSessionId)) return;
                const edit_session_id = msg.editSessionId;
                const write = pending_edit_writes.catch(() => {}).then(async () => {
                    if (!edit_message_is_current(edit_session_id)) return;
                    if (msg.edits) {
                        const edits = msg.edits;
                        await update_edit_session_state(edit_session_id, (current) => ({
                            ...current,
                            pendingEdits: edits,
                        }));
                    } else {
                        await update_edit_session_state(edit_session_id, (current) => {
                            if (!current.pendingEdits) return current;
                            const { pendingEdits: _drop, ...rest } = current;
                            return rest;
                        });
                    }
                });
                pending_edit_writes = write;
                await write;
                return;
            }
            case 'showSaveDialog': {
                if (!profile.editing || !owns_edit_session()) return;
                const choice = await vscode.window.showWarningMessage(
                    'You have unsaved changes.', { modal: true }, 'Save', 'Discard');
                panel.webview.postMessage({
                    type: 'saveDialogResult',
                    choice: choice === 'Save' ? 'save' : choice === 'Discard' ? 'discard' : 'cancel',
                });
                return;
            }
            default:
                if (
                    msg.type === 'visibleRowChanged'
                    && !session.acknowledged_current()
                ) return;
                if (profile.on_message && await profile.on_message(msg)) return;
                await core?.handle_message(msg);
        }
        }));
    } catch (error) {
        return abort_setup(error);
    }

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            load_seq++;
            reset_reload_retry();
            cancel_refresh_retry_wait();
            cancel_ready_state_retry_waits();
            cancel_edit_cleanup_waiters();
            header_receipt_queue.length = 0;
            let first_error: unknown;
            const cleanup = (action: () => void) => {
                try {
                    action();
                } catch (error) {
                    first_error ??= error;
                }
            };
            cleanup(release_edit_session);
            cleanup(() => session.dispose());
            core = undefined;
            source = undefined;
            for (const d of disposables) cleanup(() => d.dispose());
            cleanup(() => file_coordinator.dispose());
            if (file_edit_state) {
                file_edit_state.attachments = Math.max(0, file_edit_state.attachments - 1);
                if (
                    file_edit_state.attachments === 0
                    && file_edit_state.phase.type === 'free'
                ) {
                    csv_edit_file_states.delete(file_key);
                }
            }
            if (first_error !== undefined) throw first_error;
        },
    };
}
