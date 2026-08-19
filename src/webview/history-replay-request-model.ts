/**
 * How a replay is shaped for the wire, and what a host answer means.
 *
 * The pure half of the replay coordinator: given an entry, a direction and the
 * overlays a cell currently holds, decide exactly what to ask the host for; given
 * a preparation and a plan, decide exactly what to commit; and translate the
 * host's refusal vocabulary into the caller's. No reservation, no promises, no
 * posting — those belong to the coordinator, which is the only thing that needs a
 * state machine.
 *
 * Split out because these are the rules that decide what a lease authorizes:
 * dense ordinals, exact coverage of the prepared set, and the focus region. They
 * are worth exercising directly rather than only through an asynchronous state
 * machine, and they will change for reasons that have nothing to do with
 * transport.
 */

import {
    history_replay_cell_input,
    prepared_cell_ordinals,
} from './history-replay-wire-model';
import { cell_address, type ReplayPlan } from './history-replay-model';
import {
    action_has_cell_changes,
    action_replay_changes,
    type HistoryEntry,
} from './history-stack-model';
import type {
    CellOverlayState,
    HistoryDirection,
    HistoryDirtyEntry,
} from './history-cell-state-model';
import type {
    CommitHistoryReplayRequest,
    HistoryReplayCellInput,
    HistoryReplayCommitRefused,
    HistoryReplayFocus,
    HistoryReplayHighlightInput,
    HistoryReplayPrepared,
    HistoryReplayPrepareRefused,
    PrepareHistoryReplayRequest,
} from '../history-replay-protocol';
import type { CsvDirtyEntry, WorksheetTarget } from '../types';

/**
 * Why a replay did not happen.
 *
 * `conflict` and `document-changed` are ordinary outcomes rather than errors: the
 * document moved while the replay was in flight, and the history is left exactly
 * where it was so the user can try again.
 */
export type ReplayRefusalReason =
    | 'busy'
    | 'nothing-to-replay'
    | 'blocked'
    | 'conflict'
    | 'document-changed'
    | 'unavailable'
    | 'malformed';

/** What building a prepare request needs from the live webview. */
export interface ReplayRequestSources {
    /** A cell's overlay as the edit session holds it right now. */
    readonly read_overlay: (
        worksheet: WorksheetTarget,
        source_row: number,
        source_column: number,
    ) => CellOverlayState | undefined;
    /** Correlation ids. Injected so tests are deterministic. */
    readonly next_id: (prefix: string) => string;
}

/**
 * Whether replaying this action needs an edit session held.
 *
 * A cell change writes pending-edit state, which is session-owned: replaying one
 * without a session would have nothing to authorize the write against. A
 * highlight change does not — highlights are durable workbook state, governed by
 * file authority and digest currency, and changeable outside edit mode entirely.
 *
 * The one renderer-side statement of that rule, and it lives here rather than
 * with the stack because it is replay policy over a structural fact the stack
 * reports ({@link action_has_cell_changes}) — the same rule the host reaches
 * independently from the sanitized request's own `cells.length`. Two derivations
 * of one rule, deliberately: the host must never take the renderer's word for
 * it, or a claim of "highlights only" would be a way to write pending edits with
 * no session behind them.
 */
export function action_requires_edit_session(action: HistoryEntry['action']): boolean {
    return action_has_cell_changes(action);
}

/**
 * Assemble the prepare request for one entry.
 *
 * `undefined` when a cell's current overlay cannot be read. Ordinals are dense
 * and assigned here, in replay order, because they are the only names a commit
 * gets to use.
 */
export function build_prepare_request(
    entry: HistoryEntry,
    direction: HistoryDirection,
    sources: ReplayRequestSources,
): PrepareHistoryReplayRequest | undefined {
    const cells: HistoryReplayCellInput[] = [];
    const highlights: HistoryReplayHighlightInput[] = [];
    // One ordinal per ADDRESS, not per change: a paste overlapping its own source
    // touches a cell twice, and both deltas compare-and-swap against one cell.
    const cell_ordinals = new Map<string, number>();
    let focus: HistoryReplayFocus | undefined;

    for (const change of action_replay_changes(entry.action, direction)) {
        const { worksheet, sourceRow, sourceColumn } = change.delta;
        focus = extend_focus(focus, worksheet, sourceRow, sourceColumn);
        if (change.kind === 'highlight') {
            // `expected` is what the cell must hold NOW for the replay to be
            // authorized, `desired` what it becomes — so they are opposite sides
            // of the recorded transition. Undo restores `before`, which means it
            // expects to find `after`.
            highlights.push({
                ordinal: highlights.length,
                worksheet,
                sourceRow,
                sourceColumn,
                expected: direction === 'undo' ? change.delta.after : change.delta.before,
                desired: direction === 'undo' ? change.delta.before : change.delta.after,
            });
            continue;
        }
        const address = cell_address(worksheet, sourceRow, sourceColumn);
        if (cell_ordinals.has(address)) continue;
        const overlay = sources.read_overlay(worksheet, sourceRow, sourceColumn);
        if (overlay === undefined) return undefined;
        cell_ordinals.set(address, cells.length);
        cells.push(history_replay_cell_input(
            cells.length,
            worksheet,
            sourceRow,
            sourceColumn,
            overlay,
        ));
    }
    // A highlight-only action has no cells, and is replayable: highlights are
    // durable workbook state, not session-owned pending edits. What no request can
    // be is empty of both — there would be nothing for the host to verify or apply.
    if (focus === undefined || (cells.length === 0 && highlights.length === 0)) {
        return undefined;
    }
    return {
        requestId: sources.next_id('replay-prepare'),
        replayId: sources.next_id('replay'),
        cells: Object.freeze(cells),
        highlights: Object.freeze(highlights),
        focus,
    };
}

/**
 * The region a replay lands in, on the action's FIRST worksheet.
 *
 * A workbook-wide action can span sheets, and a cursor can only be in one place,
 * so the focus follows the first sheet the replay touches and ignores cells
 * elsewhere. Extending across sheets would produce a rectangle that exists on
 * neither.
 */
function extend_focus(
    focus: HistoryReplayFocus | undefined,
    worksheet: WorksheetTarget,
    source_row: number,
    source_column: number,
): HistoryReplayFocus {
    if (focus === undefined) {
        return {
            worksheet,
            sourceRowStart: source_row,
            sourceRowEnd: source_row,
            sourceColumnStart: source_column,
            sourceColumnEnd: source_column,
        };
    }
    if (cell_address(focus.worksheet, 0, 0) !== cell_address(worksheet, 0, 0)) return focus;
    return {
        worksheet: focus.worksheet,
        sourceRowStart: Math.min(focus.sourceRowStart, source_row),
        sourceRowEnd: Math.max(focus.sourceRowEnd, source_row),
        sourceColumnStart: Math.min(focus.sourceColumnStart, source_column),
        sourceColumnEnd: Math.max(focus.sourceColumnEnd, source_column),
    };
}

/**
 * Turn a plan into a commit, naming every write by the ordinal preparation gave
 * it.
 *
 * `undefined` when a planned write has no prepared ordinal, which cannot happen
 * for a plan built from this preparation's own snapshot — the reader and the
 * planner key cells through one function — and is checked because the failure it
 * would otherwise cause is a mutation at an unverified address.
 *
 * Every prepared cell gets a write, including one the plan leaves alone: the host
 * requires the proposal to cover exactly the prepared set, since a partial
 * proposal is a different gesture from the one the lease authorizes.
 */
export function build_commit_request(
    prepared: HistoryReplayPrepared,
    plan: ReplayPlan,
    mutation_id: string,
    prepared_highlight_count: number,
): CommitHistoryReplayRequest | undefined {
    const by_address = prepared_cell_ordinals(prepared);
    const planned = new Map<number, CommitHistoryReplayRequest['cells'][number]>();
    for (const write of plan.writes) {
        const cell = by_address.get(
            cell_address(write.worksheet, write.sourceRow, write.sourceColumn),
        );
        if (cell === undefined) return undefined;
        const entry = wire_entry_for_destination(write.entry);
        // A destination the durable schema cannot hold. Refused here rather than
        // sent and rejected: the host would answer `malformed`, which reads as a
        // renderer bug, and history must be left exactly where it is either way.
        if (entry === undefined) return undefined;
        planned.set(cell.ordinal, { ordinal: cell.ordinal, entry });
    }
    const cells: CommitHistoryReplayRequest['cells'][number][] = [];
    for (const cell of prepared.cells) {
        const write = planned.get(cell.ordinal);
        if (write !== undefined) {
            cells.push(write);
            continue;
        }
        // A prepared cell the plan does not write keeps whatever it holds, which
        // on the wire is what its own overlay projects to.
        const entry = entry_for_unwritten_cell(cell.overlay);
        if (entry === undefined) return undefined;
        cells.push({ ordinal: cell.ordinal, entry });
    }
    // The plan carries the action's highlight deltas through untouched and in
    // replay order, which is the order preparation assigned ordinals in, so the
    // two lists must be the same length. They cannot differ for a plan built from
    // this preparation, and a mismatch would mean writing a highlight the host
    // verified nothing about.
    if (plan.highlights.length !== prepared_highlight_count) return undefined;
    const highlight_ordinals = Array.from(
        { length: prepared_highlight_count },
        (_, index) => index,
    );
    return {
        requestId: prepared.requestId,
        replayId: prepared.replayId,
        leaseId: prepared.leaseId,
        mutationId: mutation_id,
        cells: Object.freeze(cells),
        // One write per PREPARED highlight, named by the ordinal preparation
        // assigned. Not indices into `plan.highlights`: the plan carries the same
        // deltas in the same order, but a commit that named its own positions
        // would be addressing the host's array by a coincidence rather than by
        // the correspondence the lease is built on — and the host requires the
        // proposal to cover exactly the prepared set.
        highlights: Object.freeze(highlight_ordinals.map((ordinal) => ({ ordinal }))),
    };
}

/**
 * The entry a cell the plan leaves untouched should keep.
 *
 * Its own current overlay, projected — so the write is a no-op the host's
 * compare-and-swap accepts, rather than a change.
 */
function entry_for_unwritten_cell(
    overlay: HistoryReplayPrepared['cells'][number]['overlay'],
): CommitHistoryReplayRequest['cells'][number]['entry'] | undefined {
    if (overlay.kind === 'absent') return null;
    const dimension = overlay.value;
    const value = dimension.kind === 'untouched' ? dimension.anchor : dimension.value;
    const base = dimension.kind === 'untouched' ? dimension.anchor : dimension.base;
    const link = overlay.hyperlink;
    return wire_entry_for_destination({
        value: value.text,
        base: base.text,
        ...(dimension.kind === 'present' && dimension.basePending
            ? { base_pending: true }
            : {}),
        ...(value.runs !== undefined ? { valueRuns: value.runs } : {}),
        ...(base.runs !== undefined ? { baseRuns: base.runs } : {}),
        ...(link.kind === 'present' ? { link: link.value, baseLink: link.base } : {}),
    });
}

/**
 * The wire form of one cell's destination, or `undefined` if there is none.
 *
 * `null` removes the slot. An entry whose base has NOT been observed is sent as a
 * bare string, the legacy slot form and the only durable shape that records that
 * fact — an entry has no field for it, so sending one would tell a later save the
 * placeholder base was real. That form holds only plain text with no hyperlink,
 * which is exactly the shape the flag can occur in: it originates in one place,
 * hydrating a bare durable string, and every other site only carries it forward.
 * A richer base-pending entry has no representation, and is refused rather than
 * written with the pending bit quietly dropped.
 */
function wire_entry_for_destination(
    entry: HistoryDirtyEntry | undefined,
): CommitHistoryReplayRequest['cells'][number]['entry'] | undefined {
    if (entry === undefined) return null;
    if (entry.base_pending !== true) return entry;
    const plain = entry.valueRuns === undefined
        && entry.baseRuns === undefined
        && entry.base === ''
        && entry.link === undefined
        && entry.baseLink === undefined;
    return plain ? entry.value : undefined;
}

/**
 * The store entry a host-accepted write installs: the inverse of
 * `wire_entry_for_destination`.
 *
 * A legacy bare string becomes the entry the store's own hydration would have
 * produced for it — an unobserved base, flagged pending — because that is the
 * fact the string form carries. Reading it as `{value, base: ''}` without the
 * flag would tell conflict detection the base was observed and empty, so the
 * next save would compare the user's edit against a base nobody ever saw.
 */
export function replayed_store_entry(
    entry: string | CsvDirtyEntry | null,
): HistoryDirtyEntry | undefined {
    if (entry === null) return undefined;
    if (typeof entry !== 'string') return entry;
    return { value: entry, base: '', base_pending: true };
}

export function prepare_refusal_reason(
    reason: HistoryReplayPrepareRefused['reason'],
): ReplayRefusalReason {
    switch (reason) {
        case 'busy': return 'busy';
        case 'conflict': return 'conflict';
        case 'malformed': return 'malformed';
        case 'unavailable':
        case 'edit-session-unavailable':
            return 'unavailable';
        case 'document-changed':
            return 'document-changed';
    }
}

export function commit_refusal_reason(
    reason: HistoryReplayCommitRefused['reason'],
): ReplayRefusalReason {
    switch (reason) {
        case 'conflict': return 'conflict';
        case 'malformed':
        case 'proposal-mismatch':
            return 'malformed';
        case 'unavailable': return 'unavailable';
        case 'expired':
        case 'document-changed':
            // The same fact to the caller: the state this replay was planned
            // against is gone, and a fresh preparation is the only way forward.
            return 'document-changed';
    }
}
