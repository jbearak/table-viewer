import type { CellHyperlink } from '../cell-content';
import {
    type CellHighlightColor,
    type WorksheetTarget,
} from '../types';
import {
    own_cell_history_delta,
    type HistoryActionOwner,
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

/**
 * A gesture offered for recording, whose changes may still be being generated.
 *
 * The recorder walks `changes` exactly once and stops at the first oversized
 * prefix, so a caller whose gesture is unbounded — discarding a whole workbook's
 * edits, where every edited cell on every sheet contributes a change — can pass a
 * generator and never materialize more of it than history is willing to keep.
 * Passing an array is the same thing with the walk already done.
 *
 * The RETAINED action is always `HistoryAction`, with a real array: replay indexes
 * it, walks it in both directions, and must get the same answer every time. An
 * iterable is how a gesture ARRIVES, never how it is held.
 */
export interface HistoryActionSource {
    readonly label: string;
    readonly changes: Iterable<HistoryChange>;
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
    if (label.length <= MAX_BARRIER_LABEL_LENGTH) return materialized_string(label);
    const kept = MAX_BARRIER_LABEL_LENGTH - 1;
    const last = label.charCodeAt(kept - 1);
    // A cut through a surrogate pair drops the pair rather than keeping its high
    // half, so the result is never lone-surrogate garbage.
    const end = last >= 0xd800 && last <= 0xdbff ? kept - 1 : kept;
    return `${materialized_string(label.slice(0, end))}…`;
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
 * `maxCells` is the loosest of the three in practice. An owned cell change
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
 * An owned cell change is not one object but a small tree of them: the
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

interface ActionCharger {
    value: (value: HistoryValue) => number;
    link: (link: CellHyperlink | null) => number;
    worksheet: (worksheet: WorksheetTarget) => number;
}

/**
 * Charges what ONE ACTION retains, over the whole of that action.
 *
 * Scoped to the action rather than the delta because that is the scope ownership
 * has: the action's owner materializes each distinct string once and hands the
 * same one to every delta asking for an equal one. A charger rebuilt per delta
 * would charge the same retained string once per delta holding it, so pasting one
 * 20MiB value into ten cells would measure ten copies of memory that exists once
 * — and refuse, clearing valid history, a gesture that fits the bound easily.
 *
 * Two identities, because the action shares two different things two different
 * ways:
 *
 *   - Objects are keyed by identity. A delta's transitions and its overlay
 *     snapshots share their payloads — `build_cell_history_delta` puts the same
 *     `HistoryValue` in `value.desired.content` and `afterOverlay.value.value`,
 *     and `copy_cell_history_delta` preserves that alias through its per-delta
 *     memo — so charging both views would roughly double a paste's cost.
 *   - Strings are keyed by VALUE, which is what the owner shares them by. Two
 *     distinct payload objects in two deltas may hold the same one string; so may
 *     two distinct worksheet targets that differ only in `sheetIndex`.
 *
 * Object shape is still charged per object, since each is separately allocated —
 * only the strings inside them are shared.
 */
function action_charger(): ActionCharger {
    const counted = new WeakSet<object>();
    const charged = new Set<string>();
    const string_bytes = (text: string): number => {
        if (charged.has(text)) return 0;
        charged.add(text);
        return estimate_string_bytes(text);
    };
    const once = <T extends object>(payload: T | null, cost: (payload: T) => number): number => {
        if (payload === null || counted.has(payload)) return 0;
        counted.add(payload);
        return cost(payload);
    };
    return {
        value: (value) => once(value, (payload) => {
            let total = string_bytes(payload.text);
            for (const run of payload.runs?.runs ?? []) {
                total += RUN_OVERHEAD_BYTES + string_bytes(run.text);
            }
            return total;
        }),
        link: (link) => once(link, (payload) => {
            const destination = payload.kind === 'external' ? payload.target : payload.location;
            return string_bytes(destination) + string_bytes(payload.tooltip ?? '');
        }),
        // `sheetName` and `worksheetId` are held by every delta and neither is
        // length-bounded — a name comes from the file, an id from its
        // relationships — so a gesture carrying a megabyte-long name past the byte
        // bound is a gesture that exhausted the heap history was bounded to
        // protect. Charged by value like any other string: a million-cell paste
        // over a long sheet name pays for that name once. Distinct targets are
        // still charged separately for their own shape, since replay needs each
        // tuple; it is only the equal strings inside them that are shared.
        worksheet: (worksheet) => once(worksheet, (target) =>
            string_bytes(target.sheetName ?? '') + string_bytes(target.worksheetId ?? '')),
    };
}

function estimate_overlay_bytes(
    overlay: CellOverlayState,
    charge: ActionCharger,
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
 * share with the transitions is charged once — see `action_charger`.
 */
function estimate_cell_delta_bytes(delta: CellHistoryDelta, charge: ActionCharger): number {
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

function estimate_change_bytes(change: HistoryChange, charge: ActionCharger): number {
    return charge.worksheet(change.delta.worksheet) + (change.kind === 'cell'
        ? estimate_cell_delta_bytes(change.delta, charge)
        : CHANGE_OVERHEAD_BYTES);
}

/** Columns touched, by row. */
type RowIndex = Map<number, Set<number>>;

/**
 * Cells counted on one worksheet, reached by whichever identifier names it.
 *
 * Three maps rather than one key, because the identifiers are not interchangeable:
 * an id names a sheet an external reorder cannot move, a name names it when there
 * is no id, and an index is all a target without either has.
 */
interface WorksheetCellIndex {
    readonly byId: Map<string, RowIndex>;
    readonly byName: Map<string, RowIndex>;
    readonly byIndex: Map<number, RowIndex>;
}

/**
 * Distinct cells an action touches, counted without building a key per cell.
 *
 * A key holding the worksheet identity would be O(changes x identity length) of
 * work and of retained string, on an identity nothing bounds — a real cost on the
 * million-cell gestures this counter exists to bound. Indexing the fields directly
 * costs a few map lookups and retains only what the action already holds.
 *
 * Lives for one measurement and dies with it: nothing here outlives the walk.
 */
interface CellCountIndex {
    readonly cell: WorksheetCellIndex;
    readonly highlight: WorksheetCellIndex;
    count: number;
}

function worksheet_cell_index(): WorksheetCellIndex {
    return { byId: new Map(), byName: new Map(), byIndex: new Map() };
}

function cell_count_index(): CellCountIndex {
    return { cell: worksheet_cell_index(), highlight: worksheet_cell_index(), count: 0 };
}

/**
 * Counts a change's cell, once.
 *
 * A cell's value and its highlight are separate changes and count separately; one
 * cell touched twice by a gesture — a paste overlapping its own source — counts
 * once. Worksheets are told apart by identity before index, as replay does, since
 * an external reorder reassigns indices and two sheets must never collapse into
 * one counted cell.
 */
function add_counted_cell(index: CellCountIndex, change: HistoryChange): void {
    const { worksheet, sourceRow, sourceColumn } = change.delta;
    const sheets = change.kind === 'cell' ? index.cell : index.highlight;
    const rows = worksheet.worksheetId !== undefined
        ? map_row_index(sheets.byId, worksheet.worksheetId)
        : worksheet.sheetName !== undefined
            ? map_row_index(sheets.byName, worksheet.sheetName)
            : map_row_index(sheets.byIndex, worksheet.sheetIndex);
    let columns = rows.get(sourceRow);
    if (columns === undefined) {
        columns = new Set();
        rows.set(sourceRow, columns);
    }
    if (columns.has(sourceColumn)) return;
    columns.add(sourceColumn);
    index.count += 1;
}

function map_row_index<K>(sheets: Map<K, RowIndex>, key: K): RowIndex {
    const existing = sheets.get(key);
    if (existing !== undefined) return existing;
    const rows: RowIndex = new Map();
    sheets.set(key, rows);
    return rows;
}

interface HistoryCosts {
    readonly cellCount: number;
    readonly byteCost: number;
}

/** Costs of an action this module already owns, so nothing needs rebuilding. */
function measure_costs(action: HistoryAction): HistoryCosts {
    const cells = cell_count_index();
    const charge = action_charger();
    let byteCost = estimate_string_bytes(action.label);
    for (const change of action.changes) {
        add_counted_cell(cells, change);
        byteCost += estimate_change_bytes(change, charge);
    }
    return { cellCount: cells.count, byteCost };
}

/** Thrown by the owner to abandon a rebuild mid-change. Never escapes this module. */
class BudgetExhausted extends Error {}

/**
 * How much of a string is copied at a time when materializing it.
 *
 * Large enough that a cell's text is one pass, small enough that the argument list
 * never approaches the engine's limit on a spread call.
 */
const MATERIALIZE_CHUNK = 4_096;

/**
 * A string that stands on its own, holding no other string alive.
 *
 * V8 answers `slice` with a view retaining the WHOLE of its parent, and `a + b`
 * with a rope retaining both halves, so a twenty-character cell sliced out of a
 * 300MiB document keeps all 300MiB reachable while the estimator charges it forty
 * bytes — the hard bound defeated by content it did measure, honestly, at the wrong
 * size. `String.fromCharCode` is one of the few constructions that actually
 * allocates a fresh flat string rather than a view of an existing one.
 *
 * Private, and called from exactly two places: an action taking ownership of a
 * string, and a barrier label. That is the rule made mechanical — searching for
 * this function finds every point where memory crosses into history.
 */
function materialized_string(text: string): string {
    if (text.length <= MATERIALIZE_CHUNK) return materialized_chunk(text, 0, text.length);
    const chunks: string[] = [];
    for (let start = 0; start < text.length; start += MATERIALIZE_CHUNK) {
        chunks.push(materialized_chunk(text, start, Math.min(start + MATERIALIZE_CHUNK, text.length)));
    }
    // Joined rather than accumulated with `+=`: the result is one flat string, where
    // a chain of concatenations would be a rope thousands of nodes deep. Its pieces
    // are all ours either way, so nothing foreign is retained.
    return chunks.join('');
}

function materialized_chunk(text: string, start: number, end: number): string {
    const units: number[] = [];
    for (let index = start; index < end; index += 1) units.push(text.charCodeAt(index));
    return String.fromCharCode(...units);
}

/** Absent optional fields, as index keys no string can collide with. */
const ABSENT_SHEET_NAME = Symbol('absent sheet name');
const ABSENT_WORKSHEET_ID = Symbol('absent worksheet id');
type NameKey = string | typeof ABSENT_SHEET_NAME;
type IdKey = string | typeof ABSENT_WORKSHEET_ID;

/**
 * Owns everything one ACTION retains: its strings, and its worksheet targets.
 *
 * The whole of history's ownership boundary. Materializing a string is what makes
 * the byte bound honest — a retained view keeps its parent alive while being
 * charged its own length — and SHARING is the other half: materializing per delta
 * would turn one worksheet name into a copy per cell, each charged once by an
 * estimator that deduplicates. Both belong to the action, because the action is
 * the unit that is recorded, measured, refused, evicted and released.
 *
 * A target is shared per exact declared tuple, not per replay identity: two targets
 * agreeing on an id but disagreeing on a name are one sheet to replay and two
 * different snapshots to retain, and what is shared has to be what is retained or
 * the estimator's per-object charge is wrong again.
 *
 * Every map here is created per call and unreachable when it returns. Nothing
 * survives a refusal, so nothing needs cleaning up after one.
 */
function action_owner(trip: (cost: number) => void): HistoryActionOwner {
    const strings = new Map<string, string>();
    const targets = new Map<number, Map<NameKey, Map<IdKey, WorksheetTarget>>>();
    const own_string = (text: string): string => {
        const seen = strings.get(text);
        // Already retained for this action, so it costs nothing more.
        if (seen !== undefined) return seen;
        trip(estimate_string_bytes(text));
        const materialized = materialized_string(text);
        strings.set(text, materialized);
        return materialized;
    };
    return {
        own_string,
        own_worksheet_target: (target) => {
            // Each field read exactly once: an accessor answering differently on a
            // second read must not pair one field's value with another's.
            const { sheetIndex, sheetName, worksheetId } = target;
            const by_name = map_entry(targets, sheetIndex, () => new Map<NameKey, Map<IdKey, WorksheetTarget>>());
            const by_id = map_entry(by_name, sheetName ?? ABSENT_SHEET_NAME, () => new Map<IdKey, WorksheetTarget>());
            const key = worksheetId ?? ABSENT_WORKSHEET_ID;
            const seen = by_id.get(key);
            if (seen !== undefined) return seen;
            // Charged through `own_string`, so an identity too large to retain trips
            // the budget here rather than after it has been copied.
            const owned = Object.freeze({
                sheetIndex,
                ...(sheetName === undefined ? {} : { sheetName: own_string(sheetName) }),
                ...(worksheetId === undefined ? {} : { worksheetId: own_string(worksheetId) }),
            });
            by_id.set(key, owned);
            return owned;
        },
        charge_run: () => trip(RUN_OVERHEAD_BYTES),
    };
}

function map_entry<K, V>(map: Map<K, V>, key: K, make: () => V): V {
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    const created = make();
    map.set(key, created);
    return created;
}

/**
 * The action history will retain, rebuilt into the action's ownership and
 * measured in the same walk.
 *
 * `budget` stops the walk as soon as the retained bytes exceed it, returning
 * `undefined`. That interleaving is the point: an oversized gesture has to be
 * refused without first rebuilding the whole of it, because the caller's graph
 * and the existing history are both still live while it is being rebuilt — the
 * process can run out of memory on the way to deciding not to keep it. Rebuilding
 * copies only the skeleton, but a gesture large enough to refuse has a great many
 * skeletons.
 *
 * The budget reaches INSIDE a change as well as between them, via a meter the
 * owner calls for every string it retains. One cell can hold enough
 * rich-text runs to exceed the bound by itself, and checking only between changes
 * would rebuild all of it — the caller's graph and the whole clone alive together
 * — before deciding to keep none of it. The meter's running total is a floor on
 * the change's cost, not the cost itself: `estimate_change_bytes` still has the
 * last word below, since it also charges the shape.
 */
function own_and_measure(
    action: HistoryActionSource,
    budget = Infinity,
): MeasuredAction | undefined {
    const cells = cell_count_index();
    const charge = action_charger();
    const owned: HistoryChange[] = [];
    // Truncated rather than charged: a label can be built from data, and a bound
    // that merely refused an oversized one would still have to retain it to say
    // so in the barrier.
    const label = barrier_label(String(action.label));
    let byteCost = estimate_string_bytes(label);
    // What the rebuild has retained so far, reset per change: the finished change is
    // recharged in full below, deduplicating payloads the way memory does. This
    // running figure exists only to stop a runaway rebuild mid-change.
    let pending = 0;
    const trip = (cost: number): void => {
        pending += cost;
        if (byteCost + pending > budget) throw new BudgetExhausted();
    };
    const owner = action_owner(trip);
    for (const change of action.changes) {
        pending = 0;
        let owned_change: HistoryChange;
        try {
            owned_change = own_history_change(change, owner);
        } catch (error) {
            if (error instanceof BudgetExhausted) return undefined;
            throw error;
        }
        byteCost += estimate_change_bytes(owned_change, charge);
        if (byteCost > budget) return undefined;
        add_counted_cell(cells, owned_change);
        owned.push(owned_change);
    }
    const owned_action = Object.freeze({ label, changes: Object.freeze(owned) });
    OWNED_ACTIONS.add(owned_action);
    return { action: owned_action, cellCount: cells.count, byteCost };
}

/**
 * Actions this module built, which therefore need no second rebuild.
 *
 * `history_action` exists so a caller can hold an owned action, and a caller who
 * uses it before recording would otherwise pay for the whole owned graph twice —
 * once unbudgeted in the builder, once again in the recorder. Weakly held, so
 * remembering an action never keeps it alive.
 */
const OWNED_ACTIONS = new WeakSet<HistoryAction>();

/**
 * Whether this is an action this module already built and measured.
 *
 * The membership test doubles as the narrowing: only `own_and_measure` adds to
 * the set, and everything it adds has an array of changes. A streamed source can
 * never be in it, so a generator cannot reach the no-rebuild path — where it
 * would be walked by `measure_costs` and then walked AGAIN by whatever read the
 * retained action, the second walk finding an exhausted iterator.
 */
function is_owned_action(
    action: HistoryAction | HistoryActionSource,
): action is HistoryAction {
    return OWNED_ACTIONS.has(action as HistoryAction);
}

/**
 * Measures an action's costs and takes ownership of it. Both costs are estimates.
 *
 * No identity is handed out: only `record_history_action` can mint an entry,
 * because an entry's `id`, `moves` and `epoch` only mean anything relative to
 * the history it was recorded into.
 */
export function measure_history_action(action: HistoryAction): MeasuredAction {
    // No budget, so the walk always completes.
    return own_and_measure(action) as MeasuredAction;
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
    action: HistoryAction | HistoryActionSource,
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
    const owned = is_owned_action(action)
        ? { action, ...measure_costs(action) }
        : own_and_measure({ label, changes: action.changes }, bounds.hardMaxBytes);
    if (owned === undefined) return refused(state, label, bounds.hardMaxBytes);
    // A gesture that moved nothing is answered before the byte bound is
    // consulted, so no barrier can be installed for an action that never needed
    // recording — a label built from data must not be able to destroy valid
    // history. It is answered after the walk because the walk is what reads the
    // changes, and reading them twice is what the copy above was avoiding.
    if (owned.action.changes.length === 0) return { kind: 'empty', state };
    if (owned.byteCost > bounds.hardMaxBytes) return refused(state, label, bounds.hardMaxBytes);

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
    hardMaxBytes: number,
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
        hardMaxBytes,
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
 * A gesture is single-sheet when its targets AGREE, which needs more than each
 * identifier being individually unique: an id-only target and a name-only target
 * share no identifier at all, so "one distinct id, one distinct name" would call
 * two demonstrably different sheets one sheet.
 *
 * What is actually being asked is whether the targets are all LINKED. Each target
 * carries up to two identifiers, and a target carrying both asserts they name the
 * same sheet; the identifiers of a single-sheet gesture therefore form one
 * connected group. `{id: rId1}` beside `{name: Data}` is two groups and spans
 * sheets; add `{id: rId1, name: Data}` and the three become one and it does not.
 *
 * Two distinct ids or two distinct names contradict outright. An index is believed
 * only for a target that carries no identity at all, since an external reorder
 * reassigns indices while the identity carried alongside stays true.
 */
export function action_is_single_worksheet(action: HistoryAction): boolean {
    // At most three identifiers can be consistent — one id, one name, one index — so
    // the groups are tracked as three labels merged in place. A set per change would
    // hold a quarter of a million of them alive on a wide gesture.
    let id: string | undefined;
    let name: string | undefined;
    let index: number | undefined;
    // Which of the three have been proved to name the same sheet. `id` and `name`
    // start apart and are linked by the first target that carries both.
    let id_linked_to_name = false;
    let seen_id = false;
    let seen_name = false;
    let seen_index = false;
    for (const { delta } of action.changes) {
        const { sheetIndex, sheetName, worksheetId } = delta.worksheet;
        if (worksheetId !== undefined) {
            if (seen_id && id !== worksheetId) return false;
            id = worksheetId;
            seen_id = true;
        }
        if (sheetName !== undefined) {
            if (seen_name && name !== sheetName) return false;
            name = sheetName;
            seen_name = true;
        }
        if (worksheetId !== undefined && sheetName !== undefined) id_linked_to_name = true;
        // Only a target with nothing else to go on is believed about its index.
        if (worksheetId === undefined && sheetName === undefined) {
            if (seen_index && index !== sheetIndex) return false;
            index = sheetIndex;
            seen_index = true;
        }
    }
    // A positional target shares no identifier with an identified one, so it is its
    // own group; and an id-only target beside a name-only one is two groups until
    // some target asserts they are the same sheet.
    if (seen_index && (seen_id || seen_name)) return false;
    return !seen_id || !seen_name || id_linked_to_name;
}

/**
 * The change history will retain, isolated from the caller.
 *
 * Every change is REBUILT rather than inspected and conditionally reused.
 * The declared fields are read exactly once into a fresh frozen object of the
 * declared shape, so nothing downstream can be surprised by the caller's: a
 * `readonly` property may legitimately be a getter, live on a prototype, or sit
 * beside extra properties structural typing allows, and any of those makes "the
 * graph measured" and "the graph retained" two different things — which is how an
 * unmeasured payload rides past the hard bound, or replay's target changes after
 * the costs were fixed.
 *
 * What is rebuilt is the shape: the wrappers, the run objects, the styles — a
 * handful of small objects per cell, plus one per run. Strings are not copied
 * per occurrence; the action's owner materializes each distinct one once and
 * every delta holding an equal one gets that same string. That is what makes this
 * affordable on the million-cell gestures history has to bound rather than
 * refuse: a copy per occurrence would multiply peak memory at the exact moment
 * there is least of it.
 */
function own_history_change(change: HistoryChange, owner: HistoryActionOwner): HistoryChange {
    return change.kind === 'cell'
        ? Object.freeze({ kind: 'cell', delta: own_cell_history_delta(change.delta, owner) })
        : Object.freeze({ kind: 'highlight', delta: own_highlight_history_delta(change.delta, owner) });
}

function own_highlight_history_delta(
    delta: HighlightHistoryDelta,
    owner: HistoryActionOwner,
): HighlightHistoryDelta {
    return Object.freeze({
        // The same sharing a cell delta gets, so a multi-cell highlight gesture
        // holds one target and is charged for one — the estimator charges the
        // object, and a target per highlighted cell would charge a long sheet name
        // once per cell and refuse a gesture that retains one copy of it.
        worksheet: owner.own_worksheet_target(delta.worksheet),
        sourceRow: delta.sourceRow,
        sourceColumn: delta.sourceColumn,
        before: delta.before,
        after: delta.after,
    });
}

/** Builds a frozen action, so a caller reusing its builders cannot mutate history. */
export function history_action(label: string, changes: readonly HistoryChange[]): HistoryAction {
    return (own_and_measure({ label, changes }) as MeasuredAction).action;
}

/**
 * Whether this action contains a cell change.
 *
 * Structural, deliberately: what a cell change IMPLIES about the edit session is
 * replay policy and lives with the replay rules, not in the stack. Asked as a
 * presence question and never as the absence of highlights, because one
 * chronological history means a single action can carry both kinds and a caller
 * reasoning from "no highlights" would answer wrongly for the mixed case.
 */
export function action_has_cell_changes(action: HistoryAction): boolean {
    return action.changes.some((change) => change.kind === 'cell');
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
