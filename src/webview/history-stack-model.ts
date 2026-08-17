import type { CellHyperlink } from '../cell-content';
import { deep_clone_and_freeze, is_deeply_frozen } from '../immutable';
import {
    worksheet_target_key,
    worksheet_target_matches,
    type CellHighlightColor,
    type WorksheetTarget,
} from '../types';
import type {
    CellHistoryDelta,
    CellOverlayState,
    HistoryDirection,
    HistoryValue,
} from './history-cell-state-model';

/**
 * A cell highlight moving under one gesture.
 *
 * `null` is the absence of a highlight, not a colour: highlights live in
 * `SheetCellHighlightState.cells` keyed by `"sourceRow:sourceColumn"`, and
 * clearing one deletes the key. Undo of a clear has to put the key back with
 * its old colour, so both sides are recorded.
 */
export interface HighlightHistoryDelta {
    readonly worksheet: WorksheetTarget;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly before: CellHighlightColor | null;
    readonly after: CellHighlightColor | null;
}

export type HistoryChange =
    | { readonly kind: 'cell'; readonly delta: CellHistoryDelta }
    | { readonly kind: 'highlight'; readonly delta: HighlightHistoryDelta };

/**
 * One user gesture, undone and redone as a unit.
 *
 * A gesture is the grain the user thinks in — one paste, one fill, one
 * "Discard all" — so a paste over a thousand cells is one entry, not a
 * thousand. `label` names it in the menu ("Undo Paste").
 *
 * `changes` is in APPLICATION order. Replay must not use it directly: a gesture
 * can contain two deltas for one cell (a paste whose target overlaps its own
 * source), and undoing A->B then B->C has to run C->B before B->A or the first
 * compare-and-swap finds C where it expected B and refuses. Ask
 * `action_replay_changes` for the order a direction needs.
 */
export interface HistoryAction {
    readonly label: string;
    readonly changes: readonly HistoryChange[];
}

/** A recorded action plus the costs the bounds are enforced against. */
export interface HistoryEntry {
    readonly action: HistoryAction;
    /** Distinct cells the action touches, counting a cell once per change. */
    readonly cellCount: number;
    /** Estimated retained bytes. Approximate by construction — see `estimate_*`. */
    readonly byteCost: number;
}

/**
 * Why undo cannot reach further back.
 *
 * A barrier is installed when an action was too large to record: the gesture
 * stays applied (refusing a user's edit to protect a history buffer would be
 * the wrong trade) but nothing before it survives, so pressing undo has to say
 * why rather than silently do nothing.
 */
export interface HistoryBarrier {
    readonly reason: 'action-too-large';
    /** The gesture that forced it, for the message. */
    readonly label: string;
}

export interface HistoryStackState {
    /** Oldest first; the last element is the next thing undo would apply. */
    readonly undoStack: readonly HistoryEntry[];
    /** Most recently undone last; the last element is the next thing redo would apply. */
    readonly redoStack: readonly HistoryEntry[];
    readonly barrier: HistoryBarrier | undefined;
}

export interface HistoryBounds {
    readonly maxActions: number;
    readonly maxCells: number;
    readonly softMaxBytes: number;
    readonly hardMaxBytes: number;
}

/**
 * Session history is a convenience, not a document, so its bounds are set by
 * what a window can afford to hold rather than by what a user might ask for.
 *
 * A gesture on this grid can legitimately touch a great many cells — a paste
 * into a select-all on a million-row file is the case that sets these numbers —
 * and every touched cell retains both sides of its content. So the count bound
 * exists to stop a long editing session accreting without limit, and the byte
 * bounds exist to stop one enormous gesture doing it in a single step.
 *
 * The soft bound evicts; the hard bound refuses to record at all. The gap
 * between them is what lets a single oversized-but-not-absurd gesture stay
 * undoable after everything older has been evicted for it: a user who pastes
 * 200MiB of text and immediately wants it back is the exact case undo is for.
 * Past the hard bound the retained copy is a bigger liability than the lost
 * affordance, and `HistoryBarrier` reports the loss instead of hiding it.
 */
export const DEFAULT_HISTORY_BOUNDS: HistoryBounds = {
    maxActions: 100,
    maxCells: 1_000_000,
    softMaxBytes: 128 * 1024 * 1024,
    hardMaxBytes: 256 * 1024 * 1024,
};

export function empty_history_stack(): HistoryStackState {
    return { undoStack: [], redoStack: [], barrier: undefined };
}

/** Fixed per-change allowance for the object graph around the payload. */
const CHANGE_OVERHEAD_BYTES = 256;
/** Fixed per-run allowance, on top of the run's own text. */
const RUN_OVERHEAD_BYTES = 64;

function estimate_string_bytes(text: string): number {
    // UTF-16 code units, which is what a retained JS string actually costs.
    return text.length * 2;
}

function estimate_value_bytes(value: HistoryValue): number {
    let total = estimate_string_bytes(value.text);
    for (const run of value.runs?.runs ?? []) {
        total += RUN_OVERHEAD_BYTES + estimate_string_bytes(run.text);
    }
    return total;
}

function estimate_hyperlink_bytes(link: CellHyperlink | null): number {
    if (link === null) return 0;
    const destination = link.kind === 'external' ? link.target : link.location;
    return estimate_string_bytes(destination) + estimate_string_bytes(link.tooltip ?? '');
}

function estimate_overlay_bytes(overlay: CellOverlayState): number {
    if (overlay.kind === 'absent') return 0;
    const value = overlay.value.kind === 'present'
        ? estimate_value_bytes(overlay.value.value) + estimate_value_bytes(overlay.value.base)
        : estimate_value_bytes(overlay.value.anchor);
    const link = overlay.hyperlink.kind === 'present'
        ? estimate_hyperlink_bytes(overlay.hyperlink.value)
            + estimate_hyperlink_bytes(overlay.hyperlink.base)
        : 0;
    return value + link;
}

/**
 * A delta's retained cost, measured over everything it actually holds.
 *
 * The overlay snapshots are not second copies of the transition content, so
 * they have to be measured rather than approximated from it. A link-only edit
 * on a cell holding a very long string moves a few dozen bytes of hyperlink
 * while retaining that whole string twice as the untouched dimension's anchor;
 * a recommit against a base that moved underneath retains two long bases behind
 * an unchanged short value. Charging only the transitions would let either slip
 * past the hard bound by orders of magnitude.
 */
function estimate_cell_delta_bytes(delta: CellHistoryDelta): number {
    let total = CHANGE_OVERHEAD_BYTES;
    if (delta.value !== undefined) {
        total += estimate_value_bytes(delta.value.expected.content)
            + estimate_value_bytes(delta.value.desired.content);
    }
    if (delta.hyperlink !== undefined) {
        total += estimate_hyperlink_bytes(delta.hyperlink.expected.content)
            + estimate_hyperlink_bytes(delta.hyperlink.desired.content);
    }
    return total
        + estimate_overlay_bytes(delta.beforeOverlay)
        + estimate_overlay_bytes(delta.afterOverlay);
}

function estimate_change_bytes(change: HistoryChange): number {
    return change.kind === 'cell'
        ? estimate_cell_delta_bytes(change.delta)
        : CHANGE_OVERHEAD_BYTES;
}

function change_cell_key(change: HistoryChange): string {
    const { worksheet, sourceRow, sourceColumn } = change.delta;
    // `worksheet_target_key` prefers identity over index for the same reason
    // replay does: an external reorder reassigns indices, and two sheets must
    // never collapse into one counted cell. A cell's value and its highlight
    // are separate changes, so the kind is part of the key.
    return `${change.kind} ${worksheet_target_key(worksheet)} ${sourceRow}:${sourceColumn}`;
}

/** Measures an action's costs. Both are estimates the bounds are applied to. */
export function measure_history_action(action: HistoryAction): HistoryEntry {
    const owned = own_history_action(action);
    const cells = new Set<string>();
    let byteCost = 0;
    for (const change of owned.changes) {
        cells.add(change_cell_key(change));
        byteCost += estimate_change_bytes(change);
    }
    return { action: owned, cellCount: cells.size, byteCost };
}

export interface RecordedOutcome {
    readonly kind: 'recorded';
    readonly state: HistoryStackState;
    /** Older entries dropped to make room. */
    readonly evicted: number;
}

export interface RefusedOutcome {
    readonly kind: 'refused';
    /** History cleared, with a barrier installed. The gesture stays applied. */
    readonly state: HistoryStackState;
    readonly reason: 'action-too-large';
    readonly byteCost: number;
    readonly hardMaxBytes: number;
}

/** An action that moved nothing. Recording it would make undo a no-op keypress. */
export interface EmptyOutcome {
    readonly kind: 'empty';
    readonly state: HistoryStackState;
}

export type RecordOutcome = RecordedOutcome | RefusedOutcome | EmptyOutcome;

function totals(entries: readonly HistoryEntry[]): { cells: number; bytes: number } {
    let cells = 0;
    let bytes = 0;
    for (const entry of entries) {
        cells += entry.cellCount;
        bytes += entry.byteCost;
    }
    return { cells, bytes };
}

/**
 * Drops oldest-first until the stack fits, never dropping the last entry.
 *
 * The newest survives a sole overshoot on purpose: an action that alone exceeds
 * a soft bound is exactly the one a user is most likely to want back, and it
 * has already passed the hard bound to get here.
 */
function evict_to_fit(
    entries: readonly HistoryEntry[],
    bounds: HistoryBounds,
): { readonly kept: readonly HistoryEntry[]; readonly evicted: number } {
    let start = 0;
    let running = totals(entries);
    while (
        entries.length - start > 1
        && (entries.length - start > bounds.maxActions
            || running.cells > bounds.maxCells
            || running.bytes > bounds.softMaxBytes)
    ) {
        const dropped = entries[start];
        running = { cells: running.cells - dropped.cellCount, bytes: running.bytes - dropped.byteCost };
        start += 1;
    }
    return { kept: start === 0 ? entries : entries.slice(start), evicted: start };
}

/**
 * Records a gesture, evicting or refusing as the bounds require.
 *
 * Recording clears the redo stack: the user has branched, and the undone
 * gestures ahead of them describe content that no longer exists.
 */
export function record_history_action(
    state: HistoryStackState,
    action: HistoryAction,
    bounds: HistoryBounds = DEFAULT_HISTORY_BOUNDS,
): RecordOutcome {
    if (action.changes.length === 0) return { kind: 'empty', state };

    const entry = measure_history_action(action);
    if (entry.byteCost > bounds.hardMaxBytes) {
        return {
            kind: 'refused',
            state: {
                undoStack: [],
                redoStack: [],
                barrier: { reason: 'action-too-large', label: action.label },
            },
            reason: 'action-too-large',
            byteCost: entry.byteCost,
            hardMaxBytes: bounds.hardMaxBytes,
        };
    }

    const { kept, evicted } = evict_to_fit([...state.undoStack, entry], bounds);
    return {
        kind: 'recorded',
        state: { undoStack: kept, redoStack: [], barrier: state.barrier },
        evicted,
    };
}

function stack_for(state: HistoryStackState, direction: HistoryDirection): readonly HistoryEntry[] {
    return direction === 'undo' ? state.undoStack : state.redoStack;
}

export interface AvailableMove {
    readonly kind: 'available';
    readonly entry: HistoryEntry;
}

/** Nothing to move, and no barrier explains it — the user is simply at the end. */
export interface ExhaustedMove {
    readonly kind: 'exhausted';
}

/** Undo has run back into a barrier; the caller reports why rather than no-op. */
export interface BlockedMove {
    readonly kind: 'blocked';
    readonly barrier: HistoryBarrier;
}

export type PeekResult = AvailableMove | ExhaustedMove | BlockedMove;

/**
 * What a move would apply, without committing to it.
 *
 * Replay is asynchronous and refusable — it re-acquires an edit session and
 * compares against disk — so the entry has to be readable before it is
 * consumed. The caller commits with `commit_history_move` only once replay has
 * landed, and simply keeps the old state when it has not.
 */
export function peek_history(state: HistoryStackState, direction: HistoryDirection): PeekResult {
    const stack = stack_for(state, direction);
    const entry = stack[stack.length - 1];
    if (entry !== undefined) return { kind: 'available', entry };
    if (direction === 'undo' && state.barrier !== undefined) {
        return { kind: 'blocked', barrier: state.barrier };
    }
    return { kind: 'exhausted' };
}

/**
 * Moves the entry that was replayed to the other stack.
 *
 * `entry` is the one `peek_history` handed out, and it must still be on top or
 * nothing moves. Popping whichever entry is on top now would be wrong in both
 * directions: replay is asynchronous, so the stack can have been recorded onto
 * or moved in the meantime, and a commit that ran twice would otherwise move a
 * second, never-replayed gesture onto the redo stack — where redo would then
 * apply content the user never undid.
 */
export function commit_history_move(
    state: HistoryStackState,
    direction: HistoryDirection,
    entry: HistoryEntry,
): HistoryStackState {
    const from = stack_for(state, direction);
    if (from[from.length - 1] !== entry) return state;
    const rest = from.slice(0, -1);
    const to = [...stack_for(state, direction === 'undo' ? 'redo' : 'undo'), entry];
    return direction === 'undo'
        ? { undoStack: rest, redoStack: to, barrier: state.barrier }
        : { undoStack: to, redoStack: rest, barrier: state.barrier };
}

/**
 * Discards all history, keeping any barrier.
 *
 * Used when the document underneath history stops being the one it describes —
 * a workbook replaced by a different file, a sheet set reordered beyond
 * re-identification. The barrier survives because the reason undo cannot reach
 * further back has not stopped being true.
 */
export function clear_history(state: HistoryStackState): HistoryStackState {
    return { undoStack: [], redoStack: [], barrier: state.barrier };
}

export interface HistoryUsage {
    readonly actions: number;
    readonly cells: number;
    readonly bytes: number;
}

/** Usage across both stacks: an undone action is still retained. */
export function history_usage(state: HistoryStackState): HistoryUsage {
    const entries = [...state.undoStack, ...state.redoStack];
    const { cells, bytes } = totals(entries);
    return { actions: entries.length, cells, bytes };
}

/**
 * The worksheet a move should bring into view.
 *
 * History is workbook-wide and chronological, so the gesture being undone may
 * belong to a sheet the user is not looking at; undo switches to it rather than
 * silently changing a sheet off-screen. A gesture spanning sheets (only
 * "Discard all" can) reports the first, which is where the cursor lands.
 */
export function action_focus_worksheet(action: HistoryAction): WorksheetTarget | undefined {
    return action.changes[0]?.delta.worksheet;
}

/** Whether every change in the action belongs to one worksheet. */
export function action_is_single_worksheet(action: HistoryAction): boolean {
    const first = action_focus_worksheet(action);
    if (first === undefined) return true;
    return action.changes.every((change) => worksheet_target_matches(change.delta.worksheet, first));
}

/**
 * The action history will retain, isolated from the caller.
 *
 * History owning its own copy is not optional: `cellCount` and `byteCost` are
 * measured once, so a caller that mutated a recorded action afterwards would
 * change what replay does while the bounds still described the old graph.
 *
 * Ownership is taken at the shallowest level that needs it. The payload — the
 * delta, which is where all the retained content is — is normally already frozen
 * all the way down, because `build_cell_history_delta` returns a
 * `deep_clone_and_freeze`d value; only the `{kind, delta}` wrapper a caller
 * built around it is new. Cloning the whole change to own that wrapper would
 * copy every string in the payload a second time, and at this size that is the
 * difference between recording a supported million-cell gesture and running out
 * of memory deciding to refuse it.
 *
 * `is_deeply_frozen` is what makes the reuse safe. A shallow `Object.isFrozen`
 * would pass a frozen wrapper around mutable innards, and retaining that leaves
 * the caller able to retarget a replay or invalidate a measured cost.
 */
function own_history_action(action: HistoryAction): HistoryAction {
    let reusable = is_deeply_frozen(action.label) && Object.isFrozen(action.changes);
    const changes = action.changes.map((change) => {
        const owned = own_history_change(change);
        if (owned !== change) reusable = false;
        return owned;
    });
    return reusable && Object.isFrozen(action)
        ? action
        : Object.freeze({ label: action.label, changes: Object.freeze(changes) });
}

function own_history_change(change: HistoryChange): HistoryChange {
    if (is_deeply_frozen(change)) return change;
    if (is_deeply_frozen(change.delta)) {
        // Only the wrapper is the caller's. Freezing a copy of it retains the
        // payload by reference instead of duplicating it.
        return Object.freeze({ kind: change.kind, delta: change.delta } as HistoryChange);
    }
    return deep_clone_and_freeze(change);
}

/** Builds a frozen action, so a caller reusing its builders cannot mutate history. */
export function history_action(label: string, changes: readonly HistoryChange[]): HistoryAction {
    return own_history_action({ label, changes });
}

/**
 * The changes a direction should replay, in the order it must replay them.
 *
 * Undo walks a gesture backwards. Within one gesture that only matters for a
 * cell touched twice — a paste overlapping its own source gives A->B then
 * B->C — but there it is the difference between restoring A and refusing the
 * whole replay, because the compare-and-swap on the A->B delta expects to find
 * B and the cell holds C until the later delta has been undone.
 */
export function action_replay_changes(
    action: HistoryAction,
    direction: HistoryDirection,
): readonly HistoryChange[] {
    return direction === 'undo' ? [...action.changes].reverse() : action.changes;
}
