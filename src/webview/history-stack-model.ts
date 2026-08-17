import type { CellHyperlink } from '../cell-content';
import {
    worksheet_target_key,
    type CellHighlightColor,
    type WorksheetTarget,
} from '../types';
import {
    canonical_cell_history_delta,
    type CellHistoryDelta,
    type CellOverlayState,
    type HistoryDirection,
    type HistoryValue,
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

/** An action history owns, with the costs the bounds are enforced against. */
export interface MeasuredAction {
    readonly action: HistoryAction;
    /** Distinct cells the action touches, counting a cell once per change. */
    readonly cellCount: number;
    /** Estimated retained bytes. Approximate by construction — see `estimate_*`. */
    readonly byteCost: number;
}

/** A recorded action, identified so an asynchronous replay can be committed. */
export interface HistoryEntry extends MeasuredAction {
    /**
     * The history this entry was recorded into.
     *
     * Bumped whenever history is discarded wholesale — a clear or a refusal — so
     * a replay still in flight across that boundary can be told from one whose
     * entry merely left the stack because a fresh recording cleared the redos.
     * The first must not be readmitted; the second must.
     */
    readonly epoch: number;
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
    /**
     * The gesture that forced it, for the message. Truncated to
     * `MAX_BARRIER_LABEL_LENGTH`: a label can be built from data, and retaining an
     * unbounded one on the refusal path would keep alive some of the very memory
     * the refusal exists to release.
     */
    readonly label: string;
}

/**
 * Enough to name a gesture in a menu or a message, and nothing like enough to
 * matter against the byte bounds.
 *
 * Every label history retains is truncated to it, not just a barrier's. A label
 * can be built from data, and a bound that merely refused an oversized one would
 * still have to retain it to say which gesture it refused.
 */
export const MAX_BARRIER_LABEL_LENGTH = 200;

/**
 * The retained form of a label: at most `MAX_BARRIER_LABEL_LENGTH` code units,
 * built as a fresh flat string.
 *
 * Copied unit by unit rather than sliced, and assembled by `fromCharCode` rather
 * than by interpolation, because neither of those produces a string that stands
 * on its own: V8 answers `slice` with a view that retains the WHOLE of its parent
 * and `${a}${b}` with a rope that retains both halves. A label built from data —
 * the pasted content, a cell's text — would then be charged a few hundred bytes
 * while keeping hundreds of MiB alive, which is `hardMaxBytes` defeated by the
 * one string that is not measured against it. Every label is materialized, not
 * just an over-long one, since a caller can hand us a short view of a huge parent.
 *
 * A truncation that would split a surrogate pair drops the pair instead of
 * keeping its high half, so the result is never lone-surrogate garbage.
 */
function barrier_label(label: string): string {
    const kept = label.length <= MAX_BARRIER_LABEL_LENGTH
        ? label.length
        : MAX_BARRIER_LABEL_LENGTH - 1;
    const units: number[] = [];
    for (let index = 0; index < kept; index += 1) units.push(label.charCodeAt(index));
    const last = units[units.length - 1];
    if (last !== undefined && last >= 0xd800 && last <= 0xdbff) units.pop();
    if (kept < label.length) units.push(0x2026);
    return String.fromCharCode(...units);
}

export interface HistoryStackState {
    /** Oldest first; the last element is the next thing undo would apply. */
    readonly undoStack: readonly HistoryEntry[];
    /** Most recently undone last; the last element is the next thing redo would apply. */
    readonly redoStack: readonly HistoryEntry[];
    readonly barrier: HistoryBarrier | undefined;
    /** Incremented on every discard of the whole history. See `HistoryEntry.epoch`. */
    readonly epoch: number;
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
 *
 * `maxCells` is the loosest of the three in practice. A canonical cell change
 * costs at least `CHANGE_OVERHEAD_BYTES` in shape alone, so the byte bounds bind
 * first on any wide gesture and a paste approaching a million cells is refused on
 * bytes long before the count matters. It is kept as a second ceiling because it
 * is the one a reader reasons about — "how many cells can I undo" — and because
 * it still binds on the accretion case the byte bounds are loose about: many
 * modest gestures whose shapes add up.
 */
export const DEFAULT_HISTORY_BOUNDS: HistoryBounds = {
    maxActions: 100,
    maxCells: 1_000_000,
    softMaxBytes: 128 * 1024 * 1024,
    hardMaxBytes: 256 * 1024 * 1024,
};

export function empty_history_stack(): HistoryStackState {
    return { undoStack: [], redoStack: [], barrier: undefined, epoch: 0 };
}

/**
 * Fixed per-change allowance for the object graph around the payload.
 *
 * A canonical cell change is not one object but a small tree of them: the
 * `{kind, delta}` wrapper, the delta, its worksheet target, two overlay states
 * each with two dimensions, a transition with two sides, and the value objects
 * those hold. Fifteen-odd small objects, each with a header and its slots, so a
 * few hundred bytes of shape before a single character of content.
 *
 * Set high enough to cover that, because the alternative is worse than a
 * conservative refusal: a per-change figure that flatters the shape lets a paste
 * of a million short values measure ~250MiB and retain a multiple of it, which is
 * how a bounded history exhausts the heap it was bounded to protect. A
 * consequence worth naming: with this figure the byte bound binds well before
 * `maxCells` on wide gestures, so a million-cell paste is refused — history
 * clears behind a barrier and the gesture stays applied. That is the designed
 * behaviour for a gesture too large to retain, not an accident of the constant.
 */
const CHANGE_OVERHEAD_BYTES = 1_024;
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

/**
 * Charges each distinct worksheet identity string once per action.
 *
 * `sheetName` and `worksheetId` are retained in every delta and neither is
 * length-bounded — a name comes from the file, an id from its relationships — so
 * a gesture carrying a megabyte-long name past the byte bound is a gesture that
 * exhausted the heap history was bounded to protect.
 *
 * Charged per distinct STRING VALUE rather than per delta: a million-cell paste
 * names one worksheet, whose name exists once in memory however many deltas point
 * at it, and charging each of them would refuse gestures that fit the bound. Keyed
 * on the value because that is the only thing a `Set` can key on, which errs
 * safely: two equal strings from different sources are charged once, and the
 * measurement is an estimate either way.
 */
function worksheet_charger(): (worksheet: WorksheetTarget) => number {
    const counted = new Set<string>();
    const once = (text: string | undefined): number => {
        if (text === undefined || counted.has(text)) return 0;
        counted.add(text);
        return estimate_string_bytes(text);
    };
    return (worksheet) => once(worksheet.sheetName) + once(worksheet.worksheetId);
}

function estimate_change_bytes(
    change: HistoryChange,
    charge_worksheet: (worksheet: WorksheetTarget) => number,
): number {
    const worksheet = charge_worksheet(change.delta.worksheet);
    return worksheet + (change.kind === 'cell'
        ? estimate_cell_delta_bytes(change.delta)
        : CHANGE_OVERHEAD_BYTES);
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

/** The action as history would retain it, with its costs. */
type OwnedAction = MeasuredAction;

/** Costs of an action this module already owns, so nothing needs rebuilding. */
function measure_costs(action: HistoryAction): HistoryCosts {
    const cells = new Set<string>();
    const charge_worksheet = worksheet_charger();
    let byteCost = estimate_string_bytes(action.label);
    for (const change of action.changes) {
        cells.add(change_cell_key(change));
        byteCost += estimate_change_bytes(change, charge_worksheet);
    }
    return { cellCount: cells.size, byteCost };
}

/**
 * The action history will retain, canonicalized and measured together.
 *
 * `budget` stops the walk as soon as the retained bytes exceed it, returning
 * `undefined`. That interleaving is the point: an oversized gesture has to be
 * refused without first rebuilding the whole of it, because the caller's graph
 * and the existing history are both still live while it is being rebuilt — the
 * process can run out of memory on the way to deciding not to keep it. Rebuilding
 * copies only the skeleton, but a gesture large enough to refuse has a great many
 * skeletons.
 */
function own_and_measure(action: HistoryAction, budget = Infinity): OwnedAction | undefined {
    const cells = new Set<string>();
    const charge_worksheet = worksheet_charger();
    const owned: HistoryChange[] = [];
    // Truncated rather than charged: a label can be built from data, and a bound
    // that merely refused an oversized one would still have to retain it to say
    // so in the barrier.
    const label = barrier_label(String(action.label));
    let byteCost = estimate_string_bytes(label);
    for (const change of action.changes) {
        const canonical = own_history_change(change);
        byteCost += estimate_change_bytes(canonical, charge_worksheet);
        if (byteCost > budget) return undefined;
        cells.add(change_cell_key(canonical));
        owned.push(canonical);
    }
    const canonical = Object.freeze({ label, changes: Object.freeze(owned) });
    CANONICAL_ACTIONS.add(canonical);
    return { action: canonical, cellCount: cells.size, byteCost };
}

/**
 * Actions this module built, which therefore need no second rebuild.
 *
 * `history_action` exists so a caller can hold an owned action, and a caller who
 * uses it before recording would otherwise pay for the whole canonical graph
 * twice — once unbudgeted in the builder, once again in the recorder. Weakly
 * held, so remembering an action never keeps it alive.
 */
const CANONICAL_ACTIONS = new WeakSet<HistoryAction>();

/**
 * Measures an action's costs and takes ownership of it. Both costs are estimates.
 *
 * No identity is handed out: only `record_history_action` can mint an entry,
 * because an entry's `id`, `moves` and `epoch` only mean anything relative to
 * the history it was recorded into.
 */
export function measure_history_action(action: HistoryAction): MeasuredAction {
    // No budget, so the walk always completes.
    return own_and_measure(action) as OwnedAction;
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
    /**
     * The bound that was passed. No total accompanies it: the measurement stops
     * at the bound rather than completing, precisely so an oversized gesture is
     * never fully rebuilt just to report how oversized it was.
     */
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
    const label = barrier_label(String(action.label));

    // Canonicalized and measured in one walk, which abandons the rebuild as soon
    // as the hard bound is passed. Everything below therefore reads the graph
    // history will retain, not whatever the caller's object answers next.
    //
    // Pass a plain `{label, changes}` to get that short circuit. An action from
    // `history_action` was already built in full, so it is only measured here —
    // which is why a caller recording an enormous gesture should not build one
    // first.
    //
    // `action.changes` is passed through rather than copied: a copy would
    // enumerate and allocate the whole of a million-change gesture before the
    // budget could stop at the first oversized prefix, which is the peak-memory
    // spike the budget exists to avoid. The walk reads the array once and retains
    // only what it visited.
    const owned = CANONICAL_ACTIONS.has(action)
        ? { action, ...measure_costs(action) }
        : own_and_measure({ label, changes: action.changes }, bounds.hardMaxBytes);
    if (owned === undefined) return refused(state, label, bounds);
    // A gesture that moved nothing is answered before the byte bound is
    // consulted, so no barrier can be installed for an action that never needed
    // recording — a label built from data must not be able to destroy valid
    // history. It is answered after the walk because the walk is what reads the
    // changes, and reading them twice is what the copy above was avoiding.
    if (owned.action.changes.length === 0) return { kind: 'empty', state };
    if (owned.byteCost > bounds.hardMaxBytes) return refused(state, label, bounds);

    const entry: HistoryEntry = { ...owned, id: {}, moves: 0, epoch: state.epoch };
    const { kept, evicted } = evict_to_fit([...state.undoStack, entry], bounds);
    return {
        kind: 'recorded',
        state: { undoStack: kept, redoStack: [], barrier: state.barrier, epoch: state.epoch },
        evicted,
    };
}

/**
 * History discarded behind a barrier, the gesture left applied.
 *
 * The epoch advances with the discard: a replay in flight across it must not be
 * readmitted afterwards, and the epoch is how a late commit can tell.
 */
function refused(
    state: HistoryStackState,
    label: string,
    bounds: HistoryBounds,
): RefusedOutcome {
    return {
        kind: 'refused',
        state: {
            undoStack: [],
            redoStack: [],
            barrier: { reason: 'action-too-large', label },
            epoch: state.epoch + 1,
        },
        reason: 'action-too-large',
        hardMaxBytes: bounds.hardMaxBytes,
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
 * compares against disk — so the entry has to be readable before it is consumed.
 * The caller commits with `commit_history_move` only once replay has landed, and
 * simply keeps the old state when it has not.
 *
 * ONE REPLAY AT A TIME is the caller's obligation. The stack tolerates a commit
 * arriving late, out of order, or twice, and says which case it was; what it
 * cannot repair is two replays of the SAME entry in flight together. Both would
 * find the same compare-and-swap precondition satisfied, both could land, and no
 * bookkeeping here can tell "the second attempt applied it again" from "the first
 * attempt's commit is merely late". So the caller must not start a move while one
 * is outstanding — a keypress arriving mid-replay is dropped, not queued twice.
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
    /**
     * Older entries dropped to make room. Only ever non-zero on the adoption
     * path below, which grows the history rather than moving within it.
     */
    readonly evicted: number;
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
 * The replay landed, but the entry is no longer in a position to move: another
 * move committed, or history was cleared, while this replay was in flight. (A
 * landed redo whose stack was cleared by a fresh recording is adopted instead —
 * see `commit_history_move`.)
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
 * ever committed it. Its content is applied all the same, so it is ADOPTED as the
 * newest undo entry rather than discarded — which is also where it belongs
 * chronologically, its content having landed after everything the undo stack
 * already holds. Discarding it would leave a reapplied change with no record, and
 * the next undo would skip it to unwind an older gesture instead.
 *
 * Adoption is confined to that one case by the epoch: an entry from a history
 * since discarded describes a document this one may no longer be, and readmitting
 * it would let undo write the old workbook's content into the new one wherever
 * their worksheet identities happen to agree. And because adoption grows the
 * history rather than moving within it, `bounds` are re-applied — otherwise a
 * redo landing into a stack recording had just trimmed to the limit would leave
 * it one entry over.
 */
export function commit_history_move(
    state: HistoryStackState,
    direction: HistoryDirection,
    entry: HistoryEntry,
    bounds: HistoryBounds = DEFAULT_HISTORY_BOUNDS,
): CommitOutcome {
    const other: HistoryDirection = direction === 'undo' ? 'redo' : 'undo';
    const destination = stack_for(state, other);
    const from = stack_for(state, direction);

    // This commit, or a later one that superseded it, has already run.
    if ((COMMITTED_MOVES.get(entry.id) ?? 0) > entry.moves) {
        return { kind: 'already-committed', state };
    }

    const position = from.findIndex((candidate) => candidate.id === entry.id);
    if (position === -1) {
        // The entry has left the stack without being committed — only recording
        // can do that, by clearing the redo stack. The replay landed, so its
        // content IS applied; adopting it as the newest undo entry keeps history
        // able to unwind it, and is chronologically right because that content
        // was applied after everything the undo stack already holds.
        // Unless history was discarded in the meantime: an entry from an earlier
        // epoch describes a document this history no longer claims to.
        if (direction === 'redo' && entry.epoch === state.epoch) {
            const adopted: HistoryEntry = { ...entry, moves: entry.moves + 1 };
            const { kept, evicted } = evict_to_fit([...state.undoStack, adopted], bounds);
            COMMITTED_MOVES.set(entry.id, adopted.moves);
            return { kind: 'moved', state: { ...state, undoStack: kept }, evicted };
        }
        return { kind: 'dropped', state };
    }
    if (position !== from.length - 1) {
        const kept = [...from.slice(0, position), ...from.slice(position + 1)];
        return {
            kind: 'dropped',
            state: with_stacks(state, direction, kept, destination),
        };
    }
    const moved: HistoryEntry = { ...from[position], moves: entry.moves + 1 };
    COMMITTED_MOVES.set(entry.id, moved.moves);
    return {
        kind: 'moved',
        state: with_stacks(state, direction, from.slice(0, -1), [...destination, moved]),
        evicted: 0,
    };
}

/**
 * How many moves of each entry have been committed.
 *
 * Kept beside the stacks rather than in them, because a committed entry can leave
 * history altogether: eviction drops the oldest, and an adopted redo that later
 * ages out would otherwise look exactly like one whose first commit never
 * arrived — so a duplicate commit would adopt it a second time, evicting a newer
 * action to resurrect an old one as the next undo. Keyed on the entry's identity
 * and weakly held, so the ledger disappears with the entry and no bound is needed.
 *
 * This is the one piece of history that is not a function of `HistoryStackState`.
 * It has to outlive the state, and the state has nowhere bounded to record it.
 */
const COMMITTED_MOVES = new WeakMap<object, number>();

function with_stacks(
    state: HistoryStackState,
    direction: HistoryDirection,
    from: readonly HistoryEntry[],
    to: readonly HistoryEntry[],
): HistoryStackState {
    return direction === 'undo'
        ? { ...state, undoStack: from, redoStack: to }
        : { ...state, undoStack: to, redoStack: from };
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
    return { undoStack: [], redoStack: [], barrier: state.barrier, epoch: state.epoch + 1 };
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
 * Decided over the whole action at once rather than by comparing each change to
 * the first, because `worksheet_target_matches` treats its first argument as
 * authoritative — an id-less target compared against an identified one falls back
 * to the name, while the reverse insists on the id — and a relation that
 * asymmetric is not transitive. Two targets sharing a name but carrying different
 * ids each match an id-less first target, so a pairwise-against-the-first check
 * called a cross-sheet gesture single-sheet whenever the id-less change happened
 * to be applied first. Neither application order nor which change is strongest
 * may decide this.
 *
 * So: at most one distinct id, at most one distinct name, and — only when some
 * change identifies its sheet by position alone — at most one distinct index. An
 * index is otherwise ignored, since an external reorder reassigns indices while
 * the identity it carries alongside stays true.
 */
export function action_is_single_worksheet(action: HistoryAction): boolean {
    const ids = new Set<string>();
    const names = new Set<string>();
    const indices = new Set<number>();
    let positional = false;
    for (const { delta } of action.changes) {
        const { sheetIndex, sheetName, worksheetId } = delta.worksheet;
        if (worksheetId !== undefined) ids.add(worksheetId);
        if (sheetName !== undefined) names.add(sheetName);
        if (worksheetId === undefined && sheetName === undefined) positional = true;
        indices.add(sheetIndex);
    }
    return ids.size <= 1 && names.size <= 1 && (!positional || indices.size <= 1);
}

/**
 * The change history will retain, isolated from the caller.
 *
 * Every change is CANONICALIZED rather than inspected and conditionally reused.
 * The declared fields are read exactly once into a fresh frozen object of the
 * declared shape, so nothing downstream can be surprised by the caller's: a
 * `readonly` property may legitimately be a getter, live on a prototype, or sit
 * beside extra properties structural typing allows, and any of those makes "the
 * graph measured" and "the graph retained" two different things — which is how an
 * unmeasured payload rides past the hard bound, or replay's target changes after
 * the costs were fixed.
 *
 * What is rebuilt is the SKELETON — a handful of small objects per cell. The
 * content is shared, the strings and their runs copied by reference into the new
 * shape. That is what makes this affordable on the million-cell gestures history
 * has to bound rather than refuse: duplicating the content would double peak
 * memory at the exact moment there is least of it.
 */
function own_history_change(change: HistoryChange): HistoryChange {
    return change.kind === 'cell'
        ? Object.freeze({ kind: 'cell', delta: canonical_cell_history_delta(change.delta) })
        : Object.freeze({ kind: 'highlight', delta: canonical_highlight_delta(change.delta) });
}

function canonical_highlight_delta(delta: HighlightHistoryDelta): HighlightHistoryDelta {
    const { sheetIndex, sheetName, worksheetId } = delta.worksheet;
    return Object.freeze({
        worksheet: Object.freeze({
            sheetIndex,
            ...(sheetName === undefined ? {} : { sheetName }),
            ...(worksheetId === undefined ? {} : { worksheetId }),
        }),
        sourceRow: delta.sourceRow,
        sourceColumn: delta.sourceColumn,
        before: delta.before,
        after: delta.after,
    });
}

/** Builds a frozen action, so a caller reusing its builders cannot mutate history. */
export function history_action(label: string, changes: readonly HistoryChange[]): HistoryAction {
    return (own_and_measure({ label, changes }) as OwnedAction).action;
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
