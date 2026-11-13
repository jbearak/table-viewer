import {
    copy_dirty_entry,
    type CsvDirtyEntry,
    type SheetPendingEditCells,
    type WorksheetPendingChanges,
    worksheet_target_key,
} from '../types';
import { pending_changes_carry_layout, pending_rows } from '../pending-changes';

/**
 * Host bridge: a narrow abstraction over the channel the webview uses to talk
 * to its host. In VS Code this wraps `acquireVsCodeApi()`. Other hosts (e.g.
 * an Electron preload script) can install their own implementation by
 * assigning `globalThis.__tableViewerHostBridge` before the webview bundle
 * loads.
 *
 * The message shapes (`HostMessage` / `WebviewMessage` in ../types) are
 * host-agnostic and unchanged by this indirection.
 */

export interface HostBridge {
    /** Send a message from the webview to the host. */
    postMessage(msg: unknown): void;
}

/** Shape of the API returned by VS Code's `acquireVsCodeApi()`. */
interface VsCodeApi {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function create_host_bridge(): HostBridge {
    // A non-VS Code host (e.g. Electron preload via contextBridge) may
    // pre-install a bridge on the global object.
    const injected = (globalThis as { __tableViewerHostBridge?: HostBridge })
        .__tableViewerHostBridge;
    if (injected) {
        return injected;
    }
    const api = acquireVsCodeApi();
    return {
        postMessage: (msg) => api.postMessage(msg),
    };
}

export const host_bridge: HostBridge = create_host_bridge();

export interface PendingEditDurabilitySnapshot {
    readonly highestProducedSequence: number;
}

interface PendingEditPublication {
    readonly payload: string;
    readonly sheetIndex: number;
    readonly sequence: number;
    readonly structural: boolean;
    /** Carried layout fields, which only the structural shape can clear. */
    readonly layout?: boolean;
    readonly sourceGeneration?: number;
}

interface PendingEditSessionChannel {
    nextSequence: number;
    // Dedupe per sheet: two sheets with byte-identical maps are distinct
    // slots' content and must not suppress each other's posts. Keyed by sheet
    // stable worksheet ID when available, then by name for legacy workbooks,
    // because an external reorder moves sheets under the indices. An
    // unacknowledged publication also retains its
    // coordinates: if the host rejected a now-stale index/name pair, the same
    // payload must be allowed through at the sheet's new index. The index is
    // only the key of last resort for the untagged single-sheet CSV path.
    latestPublicationBySheet: Map<string, PendingEditPublication>;
    unacknowledgedSequences: Set<number>;
    /**
     * Structural publications a newer one superseded before the host
     * acknowledged them, per sheet, oldest first. The host may still write
     * them, and a refresh carrying one is an echo of the renderer's own past,
     * not a change the host made; acknowledgement of a later sequence proves
     * every earlier write landed, and prunes them.
     */
    supersededStructuralBySheet: Map<string, { readonly sequence: number; readonly payload: string }[]>;
}

/**
 * Unacknowledged structural publications past which App admits no new edit
 * gesture until the host catches up. Superseded ones are never dropped
 * before acknowledgement (a refresh may still echo any of them), so this
 * backpressure is what bounds their memory against a stalled host.
 */
export const MAX_UNACKNOWLEDGED_STRUCTURAL_PUBLICATIONS = 256;

const pending_edit_channels = new Map<string, PendingEditSessionChannel>();

function pending_edit_payload(edits: SheetPendingEditCells | null): string {
    if (edits === null) return 'null';
    const canonical: SheetPendingEditCells = {};
    for (const key of Object.keys(edits).sort()) {
        const entry = edits[key];
        // Runs are part of durability identity: a formatting-only change has
        // equal value/base strings, and canonicalizing them away would dedupe
        // the post that carries the new formatting. Field order is pinned by
        // the shared entry constructor (runs were normalized at commit), so JSON equality
        // is semantic equality here just as it is for the string sides.
        canonical[key] = typeof entry === 'string'
            ? entry
            : copy_dirty_entry(entry);
    }
    return JSON.stringify(canonical);
}

function pending_changes_payload(changes: WorksheetPendingChanges): string {
    const cells: SheetPendingEditCells = {};
    for (const key of Object.keys(changes.cells).sort()) {
        cells[key] = copy_dirty_entry(changes.cells[key]);
    }
    return JSON.stringify({
        sheetIndex: changes.sheetIndex,
        ...(changes.sheetName !== undefined ? { sheetName: changes.sheetName } : {}),
        ...(changes.worksheetId !== undefined ? { worksheetId: changes.worksheetId } : {}),
        cells,
        // Array order is semantic. Never sort these for dedupe.
        formatTemplates: changes.formatTemplates,
        appendedRows: pending_rows(changes),
        tailRemovals: changes.tailRemovals,
        ...(changes.appendBasis === undefined ? {} : { appendBasis: changes.appendBasis }),
        conflicts: changes.conflicts,
        ...(changes.rowLayout === undefined ? {} : { rowLayout: changes.rowLayout }),
        ...(changes.columnLayout === undefined ? {} : { columnLayout: changes.columnLayout }),
        ...(changes.pendingColumns === undefined ? {} : { pendingColumns: changes.pendingColumns }),
        ...(changes.structuralBasis === undefined
            ? {}
            : { structuralBasis: changes.structuralBasis }),
    });
}

/**
 * Whether the structural channel must publish. Orphaned templates and a retained
 * basis count so a publication can explicitly clear or acknowledge them. Layout
 * fields count too: the legacy cell-only shape cannot carry them.
 */
function has_structural_publication_state(changes: WorksheetPendingChanges): boolean {
    return pending_rows(changes).length > 0
        || pending_changes_carry_layout(changes)
        || changes.tailRemovals.length > 0
        || changes.formatTemplates.length > 0
        || changes.conflicts.length > 0
        || changes.appendBasis !== undefined;
}

function pending_changes_channel_payload(changes: WorksheetPendingChanges): string {
    return has_structural_publication_state(changes)
        ? pending_changes_payload(changes)
        : pending_edit_payload(changes.cells);
}

function pending_edit_channel(session_id: string): PendingEditSessionChannel {
    let channel = pending_edit_channels.get(session_id);
    if (!channel) {
        channel = {
            nextSequence: 1,
            latestPublicationBySheet: new Map(),
            unacknowledgedSequences: new Set(),
            supersededStructuralBySheet: new Map(),
        };
        pending_edit_channels.set(session_id, channel);
    }
    return channel;
}

/** Webview-lifetime sequence owner, so GridShell remounts cannot reuse a sequence. */
export interface PendingEditFlushResult {
    readonly editSessionId?: string;
    readonly highestProducedSequence: number;
}

type PendingEditFlushResponder = () => PendingEditFlushResult | Promise<PendingEditFlushResult>;

let pending_edit_flush_responder: PendingEditFlushResponder = () => ({
    highestProducedSequence: 0,
});

/**
 * Installs the document-lifetime close/reload responder. The module-level default
 * answers sequence zero before App has an edit session, so a host that closes
 * immediately after `ready` can never wait on a GridShell that did not mount.
 */
export function install_pending_edit_flush_responder(
    responder: PendingEditFlushResponder,
): () => void {
    pending_edit_flush_responder = responder;
    return () => {
        if (pending_edit_flush_responder === responder) {
            pending_edit_flush_responder = () => ({ highestProducedSequence: 0 });
        }
    };
}

function latest_pending_edit_publication(
    edit_session_id: string,
    sheet_index: number,
    sheet_name: string | undefined,
    worksheet_id: string | undefined,
): PendingEditPublication | undefined {
    return pending_edit_channels.get(edit_session_id)?.latestPublicationBySheet.get(
        worksheet_target_key({
            sheetIndex: sheet_index,
            sheetName: sheet_name,
            worksheetId: worksheet_id,
        }),
    );
}

export const pending_edit_durability = {
    publish(
        editSessionId: string,
        edits: Record<string, CsvDirtyEntry> | null,
        sheetIndex: number,
        sheetName: string | undefined,
        force = false,
        worksheetId?: string,
    ): number {
        const channel = pending_edit_channel(editSessionId);
        // DirtyEntry carries renderer-only `base_pending` while a legacy value's
        // source page is unavailable. Snapshot normalization deliberately strips
        // that flag, so durability identity is the wire-level value/base map.
        const payload = pending_edit_payload(edits);
        const dedupe_key = worksheet_target_key({
            sheetIndex,
            sheetName,
            worksheetId,
        });
        const latest = channel.latestPublicationBySheet.get(dedupe_key);
        if (
            !force
            && latest?.payload === payload
            && (
                !channel.unacknowledgedSequences.has(latest.sequence)
                || latest.sheetIndex === sheetIndex
            )
        ) {
            return channel.nextSequence - 1;
        }
        const sequence = channel.nextSequence++;
        if (latest) channel.unacknowledgedSequences.delete(latest.sequence);
        channel.latestPublicationBySheet.set(dedupe_key, {
            payload,
            sheetIndex,
            sequence,
            structural: false,
        });
        channel.unacknowledgedSequences.add(sequence);
        host_bridge.postMessage({
            type: 'pendingEditsChanged',
            editSessionId,
            edits,
            sequence,
            sheetIndex,
            ...(sheetName !== undefined ? { sheetName } : {}),
            ...(worksheetId !== undefined ? { worksheetId } : {}),
        });
        return sequence;
    },
    snapshot(editSessionId: string): PendingEditDurabilitySnapshot {
        const channel = pending_edit_channel(editSessionId);
        return {
            highestProducedSequence: channel.nextSequence - 1,
        };
    },
    has_publication(
        editSessionId: string,
        sheetIndex: number,
        sheetName: string | undefined,
        worksheetId?: string,
    ): boolean {
        return latest_pending_edit_publication(
            editSessionId,
            sheetIndex,
            sheetName,
            worksheetId,
        ) !== undefined;
    },
    has_unacknowledged_payload(
        editSessionId: string,
        sheetIndex: number,
        sheetName: string | undefined,
        worksheetId?: string,
    ): boolean {
        const channel = pending_edit_channels.get(editSessionId);
        const publication = latest_pending_edit_publication(
            editSessionId,
            sheetIndex,
            sheetName,
            worksheetId,
        );
        return publication !== undefined
            && channel !== undefined
            && channel.unacknowledgedSequences.has(publication.sequence);
    },
    unacknowledged_payload_matches(
        editSessionId: string,
        authoritativeEdits: SheetPendingEditCells | null,
        currentEdits: SheetPendingEditCells | null,
        sheetIndex: number,
        sheetName: string | undefined,
        worksheetId?: string,
    ): boolean {
        const channel = pending_edit_channels.get(editSessionId);
        const publication = latest_pending_edit_publication(
            editSessionId,
            sheetIndex,
            sheetName,
            worksheetId,
        );
        return publication !== undefined
            && channel !== undefined
            && channel.unacknowledgedSequences.has(publication.sequence)
            && publication.payload === pending_edit_payload(authoritativeEdits)
            && publication.payload === pending_edit_payload(currentEdits);
    },
    acknowledge(editSessionId: string, sequence: number): void {
        const channel = pending_edit_channels.get(editSessionId);
        if (!channel || sequence > channel.nextSequence - 1) return;
        channel.unacknowledgedSequences.delete(sequence);
        // The host writes publications in sequence order, so every
        // superseded one at or before this sequence has landed: no later
        // refresh can carry it as the host's current truth.
        for (const [key, superseded] of channel.supersededStructuralBySheet) {
            const remaining = superseded.filter((entry) => entry.sequence > sequence);
            if (remaining.length === 0) channel.supersededStructuralBySheet.delete(key);
            else channel.supersededStructuralBySheet.set(key, remaining);
        }
    },
    retire(editSessionId: string): void {
        pending_edit_channels.delete(editSessionId);
    },
};

/** Full Pending Changes publisher. It intentionally shares the legacy channel. */
export const pending_changes_durability = {
    publish(
        editSessionId: string,
        changes: WorksheetPendingChanges,
        sourceGeneration: number,
        force = false,
    ): number {
        const channel = pending_edit_channel(editSessionId);
        const dedupe_key = worksheet_target_key(changes);
        const latest = channel.latestPublicationBySheet.get(dedupe_key);
        const layout = pending_changes_carry_layout(changes);
        // The legacy cell-only shape keeps the host's stored layout fields, so
        // the publication that drops a published layout must be structural,
        // and its retained payload the complete snapshot a refresh merges with.
        const structural = has_structural_publication_state(changes)
            || latest?.layout === true;
        const payload = structural
            ? pending_changes_payload(changes)
            : pending_edit_payload(changes.cells);
        // A session begins holding exactly what its grant handed over, so an
        // empty map with nothing published before it says only what the host
        // already knows. Posting it anyway costs a durable write and the
        // snapshot refresh that follows one, on every session — and sessions
        // are acquired per editing gesture. That refresh is also unacknowledged
        // for a moment, which is long enough for the host to refuse the undo
        // that acquired the session as racing a document change.
        if (
            !force
            && latest === undefined
            && !structural
            && Object.keys(changes.cells).length === 0
        ) return channel.nextSequence - 1;
        if (
            !force
            && latest?.payload === payload
            && latest.sourceGeneration === (structural ? sourceGeneration : undefined)
            && (
                !channel.unacknowledgedSequences.has(latest.sequence)
                || latest.sheetIndex === changes.sheetIndex
            )
        ) return channel.nextSequence - 1;
        const sequence = channel.nextSequence++;
        if (latest?.structural && channel.unacknowledgedSequences.has(latest.sequence)) {
            const superseded = channel.supersededStructuralBySheet.get(dedupe_key) ?? [];
            superseded.push({ sequence: latest.sequence, payload: latest.payload });
            channel.supersededStructuralBySheet.set(dedupe_key, superseded);
        }
        if (latest) channel.unacknowledgedSequences.delete(latest.sequence);
        channel.latestPublicationBySheet.set(dedupe_key, {
            payload,
            sheetIndex: changes.sheetIndex,
            sequence,
            structural,
            ...(layout ? { layout } : {}),
            ...(structural ? { sourceGeneration } : {}),
        });
        channel.unacknowledgedSequences.add(sequence);
        host_bridge.postMessage(structural ? {
            type: 'pendingChangesChanged',
            editSessionId,
            changes,
            sequence,
            sourceGeneration,
        } : {
            type: 'pendingEditsChanged',
            editSessionId,
            edits: changes.cells,
            sequence,
            sheetIndex: changes.sheetIndex,
            ...(changes.sheetName !== undefined ? { sheetName: changes.sheetName } : {}),
            ...(changes.worksheetId !== undefined
                ? { worksheetId: changes.worksheetId }
                : {}),
        });
        return sequence;
    },
    snapshot: pending_edit_durability.snapshot,
    has_publication: pending_edit_durability.has_publication,
    has_unacknowledged_payload: pending_edit_durability.has_unacknowledged_payload,
    has_unacknowledged_structural_payload(
        editSessionId: string,
        sheetIndex: number,
        sheetName: string | undefined,
        worksheetId?: string,
    ): boolean {
        const channel = pending_edit_channels.get(editSessionId);
        const publication = latest_pending_edit_publication(
            editSessionId,
            sheetIndex,
            sheetName,
            worksheetId,
        );
        return publication?.structural === true
            && channel !== undefined
            && channel.unacknowledgedSequences.has(publication.sequence);
    },
    unacknowledged_structural_payload(
        editSessionId: string,
        sheetIndex: number,
        sheetName: string | undefined,
        worksheetId?: string,
    ): WorksheetPendingChanges | undefined {
        const channel = pending_edit_channels.get(editSessionId);
        const publication = latest_pending_edit_publication(
            editSessionId,
            sheetIndex,
            sheetName,
            worksheetId,
        );
        if (publication?.structural !== true
            || channel === undefined
            || !channel.unacknowledgedSequences.has(publication.sequence)) return undefined;
        // `payload` was produced locally from a validated WorksheetPendingChanges
        // value. Parsing that private canonical snapshot gives refresh merging an
        // immutable publication base without retaining mutable caller objects.
        return JSON.parse(publication.payload) as WorksheetPendingChanges;
    },
    /**
     * Structural publications for the sheet that a newer one superseded
     * before the host acknowledged them, oldest first: what a refresh may
     * still echo from the renderer's own past.
     */
    superseded_structural_payloads(
        editSessionId: string,
        sheetIndex: number,
        sheetName: string | undefined,
        worksheetId?: string,
    ): readonly WorksheetPendingChanges[] {
        const superseded = pending_edit_channels.get(editSessionId)?.supersededStructuralBySheet.get(
            worksheet_target_key({ sheetIndex, sheetName, worksheetId }),
        );
        return (superseded ?? []).map((entry) => JSON.parse(entry.payload) as WorksheetPendingChanges);
    },
    /**
     * Whether the session has as many unacknowledged structural publications
     * as App lets accumulate: the superseded ones and each sheet's latest.
     */
    structural_backlog_full(editSessionId: string): boolean {
        const channel = pending_edit_channels.get(editSessionId);
        if (channel === undefined) return false;
        let backlog = 0;
        for (const superseded of channel.supersededStructuralBySheet.values()) backlog += superseded.length;
        for (const publication of channel.latestPublicationBySheet.values()) {
            if (publication.structural && channel.unacknowledgedSequences.has(publication.sequence)) backlog += 1;
        }
        return backlog >= MAX_UNACKNOWLEDGED_STRUCTURAL_PUBLICATIONS;
    },
    unacknowledged_structural_payload_matches(
        editSessionId: string,
        authoritativeChanges: WorksheetPendingChanges,
        currentChanges: WorksheetPendingChanges,
    ): boolean {
        const channel = pending_edit_channels.get(editSessionId);
        const publication = latest_pending_edit_publication(
            editSessionId,
            currentChanges.sheetIndex,
            currentChanges.sheetName,
            currentChanges.worksheetId,
        );
        return publication !== undefined
            && publication.structural
            && channel !== undefined
            && channel.unacknowledgedSequences.has(publication.sequence)
            && publication.payload === pending_changes_channel_payload(authoritativeChanges)
            && publication.payload === pending_changes_channel_payload(currentChanges);
    },
    acknowledge: pending_edit_durability.acknowledge,
    retire: pending_edit_durability.retire,
};

type PendingEditMessageGlobal = typeof globalThis & {
    __tableViewerPendingEditMessageDispatch?: (event: MessageEvent) => void;
    __tableViewerPendingEditMessageListenerWindow?: Window;
};

const pending_edit_message_global = globalThis as PendingEditMessageGlobal;
pending_edit_message_global.__tableViewerPendingEditMessageDispatch = (event: MessageEvent) => {
    const message = event.data;
    if (
        (message?.type === 'requestPendingEditsFlush'
            || message?.type === 'requestPendingChangesFlush')
        && typeof message.requestId === 'string'
    ) {
        const request_id = message.requestId;
        // Start the responder in a promise callback so both a synchronous throw
        // and an asynchronous rejection produce the same explicit, correlated
        // failure response. The reason stays inside the renderer: the host only
        // needs to know that the durability boundary was not established.
        void Promise.resolve()
            .then(() => pending_edit_flush_responder())
            .then(
                (result) => host_bridge.postMessage({
                    type: message.type === 'requestPendingChangesFlush'
                        ? 'pendingChangesFlush'
                        : 'pendingEditsFlush',
                    requestId: request_id,
                    editSessionId: result.editSessionId,
                    highestProducedSequence: result.highestProducedSequence,
                }),
                () => host_bridge.postMessage({
                    type: message.type === 'requestPendingChangesFlush'
                        ? 'pendingChangesFlushFailed'
                        : 'pendingEditsFlushFailed',
                    requestId: request_id,
                }),
            )
            // A failed host transport cannot be reported over that same
            // transport, but must not become an unhandled renderer rejection.
            .catch(() => {});
        return;
    }
    if (
        (message?.type !== 'pendingEditsAcknowledged'
            && message?.type !== 'pendingChangesAcknowledged')
        || typeof message.editSessionId !== 'string'
        || !Number.isSafeInteger(message.sequence)
    ) return;
    pending_changes_durability.acknowledge(message.editSessionId, message.sequence);
};

if (typeof window !== 'undefined'
    && pending_edit_message_global.__tableViewerPendingEditMessageListenerWindow !== window) {
    window.addEventListener('message', (event: MessageEvent) => {
        pending_edit_message_global.__tableViewerPendingEditMessageDispatch?.(event);
    });
    pending_edit_message_global.__tableViewerPendingEditMessageListenerWindow = window;
}
