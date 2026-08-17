import type { CellHyperlink } from '../cell-content';
import { deep_clone_and_freeze } from '../immutable';
import {
    worksheet_target_key,
    worksheet_target_matches,
    type CellHighlightColor,
    type WorksheetTarget,
} from '../types';
import type { CellHistoryDelta, HistoryDirection, HistoryValue } from './history-cell-state-model';

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
 * thousand. `label` names it in the menu ("Undo Paste"); `changes` is in
 * application order, which replay preserves so two deltas on the same cell
 * (possible within a paste that overlaps itself) settle where the gesture left
 * them.
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
    // The overlay snapshots retain their own copies of the same content.
    return total * 2;
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
    const cells = new Set<string>();
    let byteCost = 0;
    for (const change of action.changes) {
        cells.add(change_cell_key(change));
        byteCost += estimate_change_bytes(change);
    }
    return { action, cellCount: cells.size, byteCost };
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
 * Moves the top entry to the other stack. A no-op when that stack is empty, so
 * a caller that peeked and replayed cannot corrupt the stack by committing
 * twice.
 */
export function commit_history_move(
    state: HistoryStackState,
    direction: HistoryDirection,
): HistoryStackState {
    const from = stack_for(state, direction);
    const entry = from[from.length - 1];
    if (entry === undefined) return state;
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

/** Builds a frozen action, so a caller reusing its builders cannot mutate history. */
export function history_action(label: string, changes: readonly HistoryChange[]): HistoryAction {
    return deep_clone_and_freeze({ label, changes });
}
