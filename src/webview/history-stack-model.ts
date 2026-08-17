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
    /**
     * Which entry this is, for the life of the session. Stable across moves.
     *
     * Object identity cannot serve, because a moved entry is a new object; and
     * the action cannot, because a user can repeat a gesture.
     */
    readonly id: object;
    /**
     * How many times this entry has moved between the stacks.
     *
     * A commit names the move it belongs to, not just the entry, because entry
     * identity has an ABA hole: undo B then redo B puts B back where it started,
     * and a delayed duplicate of the first undo's commit would otherwise read as
     * a fresh move — leaving history claiming B is undone while its content is
     * redone. Comparing counts also says WHICH way the commit is stale: a lower
     * count is a move that already happened, a higher one cannot have.
     */
    readonly moves: number;
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

/**
 * Charges each payload object once per delta.
 *
 * A delta's transitions and its overlay snapshots SHARE their payloads:
 * `build_cell_history_delta` puts the same `HistoryValue` object in
 * `value.desired.content` and in `afterOverlay.value.value`, and
 * `structuredClone` preserves the alias, so the string exists once in memory.
 * Charging both views would roughly double a paste's measured cost and refuse
 * gestures that fit the hard bound — losing the user's undo to protect memory
 * that was never allocated.
 */
function payload_charger(): {
    value: (value: HistoryValue) => number;
    link: (link: CellHyperlink | null) => number;
} {
    const counted = new WeakSet<object>();
    const once = <T extends object>(payload: T | null, cost: (payload: T) => number): number => {
        if (payload === null || counted.has(payload)) return 0;
        counted.add(payload);
        return cost(payload);
    };
    return {
        value: (value) => once(value, (payload) => {
            let total = estimate_string_bytes(payload.text);
            for (const run of payload.runs?.runs ?? []) {
                total += RUN_OVERHEAD_BYTES + estimate_string_bytes(run.text);
            }
            return total;
        }),
        link: (link) => once(link, (payload) => {
            const destination = payload.kind === 'external' ? payload.target : payload.location;
            return estimate_string_bytes(destination) + estimate_string_bytes(payload.tooltip ?? '');
        }),
    };
}

function estimate_overlay_bytes(
    overlay: CellOverlayState,
    charge: ReturnType<typeof payload_charger>,
): number {
    if (overlay.kind === 'absent') return 0;
    const value = overlay.value.kind === 'present'
        ? charge.value(overlay.value.value) + charge.value(overlay.value.base)
        : charge.value(overlay.value.anchor);
    const link = overlay.hyperlink.kind === 'present'
        ? charge.link(overlay.hyperlink.value) + charge.link(overlay.hyperlink.base)
        : 0;
    return value + link;
}

/**
 * A delta's retained cost, measured over everything it actually holds.
 *
 * The overlays have to be walked, not approximated from the transitions: a
 * link-only edit on a cell holding a very long string moves a few dozen bytes of
 * hyperlink while retaining that whole string as the untouched dimension's
 * anchor, and a recommit against a base that moved underneath retains two long
 * bases behind an unchanged short value. Either would slip past the hard bound
 * by orders of magnitude if only the transitions were charged. What the overlays
 * share with the transitions is charged once — see `payload_charger`.
 */
function estimate_cell_delta_bytes(delta: CellHistoryDelta): number {
    const charge = payload_charger();
    let total = CHANGE_OVERHEAD_BYTES;
    if (delta.value !== undefined) {
        total += charge.value(delta.value.expected.content)
            + charge.value(delta.value.desired.content);
    }
    if (delta.hyperlink !== undefined) {
        total += charge.link(delta.hyperlink.expected.content)
            + charge.link(delta.hyperlink.desired.content);
    }
    return total
        + estimate_overlay_bytes(delta.beforeOverlay, charge)
        + estimate_overlay_bytes(delta.afterOverlay, charge);
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

interface HistoryCosts {
    readonly cellCount: number;
    readonly byteCost: number;
}

/**
 * An action's costs, read without retaining it.
 *
 * Measuring precedes ownership so that an action too large to record is refused
 * before anything is copied for it. Cloning a gesture that exceeds the hard
 * bound would allocate a second copy of the very graph the bound exists to keep
 * out of memory, while the old history is still live — running out of memory on
 * the way to deciding not to keep it.
 */
function measure_costs(changes: readonly HistoryChange[]): HistoryCosts {
    const cells = new Set<string>();
    let byteCost = 0;
    for (const change of changes) {
        cells.add(change_cell_key(change));
        byteCost += estimate_change_bytes(change);
    }
    return { cellCount: cells.size, byteCost };
}

/** Measures an action's costs and takes ownership of it. Both costs are estimates. */
export function measure_history_action(action: HistoryAction): HistoryEntry {
    const owned = own_action(action);
    return { action: owned, ...measure_costs(owned.changes), id: {}, moves: 0 };
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
    // Canonicalized first, so everything below reads the graph history will
    // retain rather than whatever the caller's object answers next.
    const owned = own_action(action);
    if (owned.changes.length === 0) return { kind: 'empty', state };

    // Measured after canonicalization but before the payloads are copied: a
    // refusal must not first duplicate the very graph the bound exists to keep
    // out of memory, and `own_action` retains those payloads by reference.
    const costs = measure_costs(owned.changes);
    if (costs.byteCost > bounds.hardMaxBytes) {
        return {
            kind: 'refused',
            state: {
                undoStack: [],
                redoStack: [],
                barrier: { reason: 'action-too-large', label: owned.label },
            },
            reason: 'action-too-large',
            byteCost: costs.byteCost,
            hardMaxBytes: bounds.hardMaxBytes,
        };
    }

    const entry: HistoryEntry = { action: owned, ...costs, id: {}, moves: 0 };
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

/** The replayed entry moved to the other stack, as asked. */
export interface MovedCommit {
    readonly kind: 'moved';
    readonly state: HistoryStackState;
}

/**
 * The entry is already on the destination stack: this exact commit ran before.
 * The state is returned untouched — committing twice must not carry a second,
 * never-replayed gesture across, where redo would apply content the user never
 * undid.
 */
export interface AlreadyCommitted {
    readonly kind: 'already-committed';
    readonly state: HistoryStackState;
}

/**
 * The replay landed, but the entry is no longer in a position to move: something
 * was recorded, another move committed, or history was cleared while this replay
 * was in flight.
 *
 * The entry is dropped rather than moved. Its content HAS been replayed, so
 * leaving it on the source stack would claim a change is applied that is not —
 * and putting it on the destination stack would place it out of order in a
 * history whose whole premise is one workbook-wide chronology, or resurrect an
 * entry that a barrier or a clear deliberately discarded. Everything else stays
 * movable, guarded as always by the compare-and-swap; only this one gesture
 * leaves the history, which is why the caller is told rather than left to infer
 * it from an unchanged state.
 */
export interface DroppedCommit {
    readonly kind: 'dropped';
    readonly state: HistoryStackState;
}

export type CommitOutcome = MovedCommit | AlreadyCommitted | DroppedCommit;

/**
 * Records that a replayed entry has landed.
 *
 * `entry` is the one `peek_history` handed out. Replay is asynchronous, so by the
 * time it lands the stack may have been recorded onto, moved, or cleared; the
 * entry's position is therefore checked rather than assumed, and the three
 * outcomes say which case this was instead of quietly doing nothing.
 *
 * Absence from the source stack is not by itself proof the commit already ran.
 * Recording clears the redo stack, so a redo that was in flight when the user
 * made a fresh edit finds its entry gone from both stacks even though nothing
 * ever committed it — and calling that `already-committed` would leave a
 * reapplied change with no record, where the next undo would skip it and unwind
 * an older gesture instead.
 */
export function commit_history_move(
    state: HistoryStackState,
    direction: HistoryDirection,
    entry: HistoryEntry,
): CommitOutcome {
    const other: HistoryDirection = direction === 'undo' ? 'redo' : 'undo';
    const destination = stack_for(state, other);
    const from = stack_for(state, direction);

    const current = [...destination, ...from].find((candidate) => candidate.id === entry.id);
    // Anywhere in history with the move already counted: this commit, or a later
    // one that superseded it, has run.
    if (current !== undefined && current.moves > entry.moves) {
        return { kind: 'already-committed', state };
    }

    const position = from.findIndex((candidate) => candidate.id === entry.id);
    if (position === -1) return { kind: 'dropped', state };
    if (position !== from.length - 1) {
        const kept = [...from.slice(0, position), ...from.slice(position + 1)];
        return {
            kind: 'dropped',
            state: with_stacks(state, direction, kept, destination),
        };
    }
    const moved: HistoryEntry = { ...from[position], moves: entry.moves + 1 };
    return {
        kind: 'moved',
        state: with_stacks(state, direction, from.slice(0, -1), [...destination, moved]),
    };
}

function with_stacks(
    state: HistoryStackState,
    direction: HistoryDirection,
    from: readonly HistoryEntry[],
    to: readonly HistoryEntry[],
): HistoryStackState {
    return direction === 'undo'
        ? { undoStack: from, redoStack: to, barrier: state.barrier }
        : { undoStack: to, redoStack: from, barrier: state.barrier };
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

/**
 * Whether every change in the action belongs to one worksheet.
 *
 * Matched symmetrically, as `viewer-controller` does when reconciling a target
 * against a message: `worksheet_target_matches` treats its first argument as
 * authoritative, so an id-less target compared against an identified one falls
 * back to the name while the reverse comparison insists on the id. Application
 * order must not decide whether a gesture spans sheets.
 */
export function action_is_single_worksheet(action: HistoryAction): boolean {
    const first = action_focus_worksheet(action);
    if (first === undefined) return true;
    return action.changes.every(({ delta }) => (
        worksheet_target_matches(delta.worksheet, first)
        || worksheet_target_matches(first, delta.worksheet)
    ));
}

/**
 * The action history will retain, isolated from the caller.
 *
 * Every action is CANONICALIZED rather than inspected and conditionally reused.
 * The declared fields are read exactly once into a fresh frozen object, so
 * nothing downstream can be surprised by the caller's: a `readonly` property may
 * legitimately be a getter, or live on a prototype, or sit beside extra
 * properties structural typing allows, and any of those makes "the graph I
 * measured" and "the graph I retained" two different things — which is how a
 * gesture walks past the hard bound with a stale `byteCost`, or changes what
 * replay does after its costs were fixed. Reading once is also cheap: the copy
 * is one array of wrappers, not the content.
 *
 * The PAYLOAD is what must not be copied. The delta holds everything large, and
 * it normally arrives frozen all the way down from `build_cell_history_delta`;
 * only the `{kind, delta}` wrapper around it is the caller's. Cloning the whole
 * change to own that wrapper would duplicate every string in the payload, which
 * at this size is the difference between recording a supported million-cell
 * gesture and running out of memory refusing it. `is_deeply_frozen` is what makes
 * retaining the payload by reference safe — a shallow `Object.isFrozen` would
 * pass a frozen wrapper around mutable innards, and an accessor is rejected
 * outright rather than read.
 */
function own_action(action: HistoryAction): HistoryAction {
    const changes = [...action.changes].map(own_history_change);
    return Object.freeze({ label: action.label, changes: Object.freeze(changes) });
}

function own_history_change(change: HistoryChange): HistoryChange {
    // Canonicalized like the action, and for the same reasons — but only the
    // wrapper. A deeply frozen delta is retained by reference.
    const delta = is_deeply_frozen(change.delta)
        ? change.delta
        : deep_clone_and_freeze(change.delta);
    return Object.freeze({ kind: change.kind, delta } as HistoryChange);
}

/** Builds a frozen action, so a caller reusing its builders cannot mutate history. */
export function history_action(label: string, changes: readonly HistoryChange[]): HistoryAction {
    return own_action({ label, changes });
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
