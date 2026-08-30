import { hyperlinks_equal, type CellHyperlink } from '../cell-content';
import {
    MAX_HISTORY_ACTION_CELLS,
    MAX_HISTORY_ACTION_ENCODED_BYTES,
} from '../history-limits';
import {
    own_pending_row_format_template,
    own_pending_structural_changes,
    type PendingAppendedRow,
    type PendingRowCell,
    type PendingRowFormatTemplate,
    type PendingStructuralChanges,
    type PendingTailRemoval,
    type RowIdentity,
    type SavedAppendedRowSnapshot,
} from '../pending-changes';
import {
    worksheet_target_key,
    type CellHighlightColor,
    type WorksheetTarget,
} from '../types';
import {
    own_cell_history_delta,
    absent_overlay,
    build_cell_history_delta,
    combined_overlay,
    history_value,
    history_values_equal,
    hyperlink_only_overlay,
    value_only_overlay,
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

/** One temporary appended row before and after a row-owned gesture. */
export interface RowAppendHistoryDelta {
    readonly worksheet: WorksheetTarget;
    readonly pendingRowId: string;
    readonly before: PendingAppendedRow | null;
    readonly after: PendingAppendedRow | null;
    readonly beforeIndex: number | null;
    readonly afterIndex: number | null;
    readonly formatTemplates: readonly PendingRowFormatTemplate[];
    /** Row was physically removed by Save and must reacquire host admission. */
    readonly restoredFromSavedRemoval?: true;
}

/** One prospective suffix removal before and after a cancellation/replay. */
export interface TailRemovalHistoryDelta {
    readonly worksheet: WorksheetTarget;
    readonly appendHistoryId: string;
    readonly before: PendingTailRemoval | null;
    readonly after: PendingTailRemoval | null;
    readonly beforeIndex: number | null;
    readonly afterIndex: number | null;
}

/** Exact worksheet structural transition, used for workbook-wide discard. */
export interface PendingRowsHistoryDelta {
    readonly worksheet: WorksheetTarget;
    readonly before: PendingStructuralChanges;
    readonly after: PendingStructuralChanges;
}

export type HistoryChange =
    | { readonly kind: 'cell'; readonly delta: CellHistoryDelta }
    | { readonly kind: 'highlight'; readonly delta: HighlightHistoryDelta }
    | { readonly kind: 'rowAppend'; readonly delta: RowAppendHistoryDelta }
    | { readonly kind: 'tailRemoval'; readonly delta: TailRemovalHistoryDelta }
    | { readonly kind: 'pendingRows'; readonly delta: PendingRowsHistoryDelta };

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
    maxCells: MAX_HISTORY_ACTION_CELLS,
    softMaxBytes: 128 * 1024 * 1024,
    hardMaxBytes: MAX_HISTORY_ACTION_ENCODED_BYTES,
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

function json_string_code_units(text: string): number {
    let units = 2;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
            || code === 0x0a || code === 0x0c || code === 0x0d) {
            units += 2;
        } else if (code < 0x20) {
            units += 6;
        } else if (code >= 0xd800 && code <= 0xdbff) {
            const low = text.charCodeAt(index + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                units += 2;
                index += 1;
            } else {
                units += 6;
            }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            units += 6;
        } else {
            units += 1;
        }
    }
    return units;
}

/** JSON.stringify(...).length without allocating the encoded string. */
function json_code_units(value: unknown, array_slot = false): number {
    if (value === null) return 4;
    if (typeof value === 'string') return json_string_code_units(value);
    if (typeof value === 'boolean') return value ? 4 : 5;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
    if (value === undefined) return array_slot ? 4 : 0;
    if (typeof value !== 'object') return array_slot ? 4 : 0;
    let units = 2;
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            if (index > 0) units += 1;
            units += json_code_units(value[index], true);
        }
        return units;
    }
    let written = 0;
    for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        if (written > 0) units += 1;
        units += json_string_code_units(key) + 1 + json_code_units(child);
        written += 1;
    }
    return units;
}

interface ActionCharger {
    value: (value: HistoryValue) => number;
    link: (link: CellHyperlink | null) => number;
    worksheet: (worksheet: WorksheetTarget) => number;
    structural: (value: object) => number;
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
        structural: (value) => once(value, (payload) =>
            json_code_units(payload) * 2),
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
    const structural_bytes = change.kind === 'rowAppend'
        ? json_code_units({
            ...change.delta,
            formatTemplates: [],
        }) * 2 + change.delta.formatTemplates.reduce(
            (total, template) => total + charge.structural(template),
            0,
        )
        : change.kind === 'tailRemoval'
            ? charge.structural(change.delta)
            : change.kind === 'pendingRows'
                ? charge.structural(change.delta)
            : 0;
    return charge.worksheet(change.delta.worksheet) + (change.kind === 'cell'
        ? estimate_cell_delta_bytes(change.delta, charge)
        : CHANGE_OVERHEAD_BYTES + structural_bytes);
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
    if (change.kind === 'rowAppend' || change.kind === 'tailRemoval'
        || change.kind === 'pendingRows') {
        index.count += change.kind === 'pendingRows'
            ? Math.max(
                1,
                change.delta.before.appendedRows.length,
                change.delta.after.appendedRows.length,
                change.delta.before.tailRemovals.length,
                change.delta.after.tailRemovals.length,
            )
            : 1;
        return;
    }
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
    const structural_owner: StructuralHistoryOwner = { templates: new Map() };
    for (const change of action.changes) {
        pending = 0;
        let owned_change: HistoryChange;
        try {
            owned_change = own_history_change(change, owner, structural_owner);
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

/** A saved pending identity plus the exact row snapshot history must retain. */
export interface SavedHistoryRowAssignment {
    readonly worksheet: WorksheetTarget;
    readonly pendingRowId: string;
    readonly sourceRow: number;
    readonly savedFingerprint: string;
    readonly savedRow: SavedAppendedRowSnapshot;
}

function pending_cell_value(cell: PendingRowCell | undefined): HistoryValue {
    return history_value(cell?.value ?? '', cell?.valueRuns);
}

function pending_cell_link(cell: PendingRowCell | undefined): CellHyperlink | null {
    return cell?.link ?? null;
}

function saved_assignment_for_identity(
    identity: RowIdentity | undefined,
    worksheet: WorksheetTarget,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): SavedHistoryRowAssignment | undefined {
    if (identity?.kind !== 'pending') return undefined;
    const assignment = assignments.get(identity.pendingRowId);
    return assignment !== undefined
        && worksheet_target_key(assignment.worksheet) === worksheet_target_key(worksheet)
        ? assignment
        : undefined;
}

function rekey_move_provenance(
    moved_from: NonNullable<PendingRowCell['movedFrom']>,
    worksheet: WorksheetTarget,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): NonNullable<PendingRowCell['movedFrom']> {
    const source_assignment = saved_assignment_for_identity(
        moved_from.rowIdentity,
        worksheet,
        assignments,
    );
    const source_identity = source_assignment === undefined
        ? moved_from.rowIdentity
        : { kind: 'source' as const, sourceRow: source_assignment.sourceRow };
    return {
        ...moved_from,
        row: source_assignment?.sourceRow
            ?? (source_identity?.kind === 'source' ? source_identity.sourceRow : moved_from.row),
        ...(source_identity === undefined ? {} : { rowIdentity: source_identity }),
        ...(moved_from.previous === undefined ? {} : {
            previous: moved_from.previous.map((move) => {
                const previous_source = saved_assignment_for_identity(
                    move.sourceRowIdentity,
                    worksheet,
                    assignments,
                );
                const previous_destination = saved_assignment_for_identity(
                    move.destinationRowIdentity,
                    worksheet,
                    assignments,
                );
                const sourceRowIdentity = previous_source === undefined
                    ? move.sourceRowIdentity
                    : { kind: 'source' as const, sourceRow: previous_source.sourceRow };
                const destinationRowIdentity = previous_destination === undefined
                    ? move.destinationRowIdentity
                    : { kind: 'source' as const, sourceRow: previous_destination.sourceRow };
                return {
                    ...move,
                    sourceRow: previous_source?.sourceRow
                        ?? (sourceRowIdentity?.kind === 'source'
                            ? sourceRowIdentity.sourceRow
                            : move.sourceRow),
                    destinationRow: previous_destination?.sourceRow
                        ?? (destinationRowIdentity?.kind === 'source'
                            ? destinationRowIdentity.sourceRow
                            : move.destinationRow),
                    ...(sourceRowIdentity === undefined ? {} : { sourceRowIdentity }),
                    ...(destinationRowIdentity === undefined
                        ? {}
                        : { destinationRowIdentity }),
                };
            }),
        }),
    };
}

function rekey_pending_cell_provenance(
    cell: PendingRowCell | undefined,
    worksheet: WorksheetTarget,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): PendingRowCell | undefined {
    if (cell?.movedFrom === undefined) return cell;
    return {
        ...cell,
        movedFrom: rekey_move_provenance(cell.movedFrom, worksheet, assignments),
    };
}

function rekey_overlay_provenance(
    overlay: CellOverlayState,
    worksheet: WorksheetTarget,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): CellOverlayState {
    if (
        overlay.kind === 'absent'
        || overlay.value.kind === 'untouched'
        || overlay.value.movedFrom === undefined
    ) return overlay;
    return {
        ...overlay,
        value: {
            ...overlay.value,
            movedFrom: rekey_move_provenance(
                overlay.value.movedFrom,
                worksheet,
                assignments,
            ),
        },
    };
}

function rekey_appended_row_provenance(
    row: PendingAppendedRow,
    worksheet: WorksheetTarget,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): PendingAppendedRow {
    return {
        ...row,
        cells: Object.fromEntries(Object.entries(row.cells).map(([column, cell]) => [
            column,
            rekey_pending_cell_provenance(cell, worksheet, assignments),
        ])) as Readonly<Record<string, PendingRowCell>>,
    };
}

function rekey_saved_row_provenance(
    row: SavedAppendedRowSnapshot,
    worksheet: WorksheetTarget,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): SavedAppendedRowSnapshot {
    return {
        ...row,
        cells: Object.fromEntries(Object.entries(row.cells).map(([column, cell]) => [
            column,
            rekey_pending_cell_provenance(cell, worksheet, assignments),
        ])) as Readonly<Record<string, PendingRowCell>>,
    };
}

/** Represent a historical pending-row cell as an overlay over its saved value. */
function saved_row_cell_overlay(
    historical: PendingRowCell | undefined,
    persisted: PendingRowCell | undefined,
): CellOverlayState {
    const value = pending_cell_value(historical);
    const base = pending_cell_value(persisted);
    const link = pending_cell_link(historical);
    const base_link = pending_cell_link(persisted);
    const value_changed = !history_values_equal(value, base);
    const link_changed = !hyperlinks_equal(link, base_link);
    const value_metadata_changed = !structural_values_equal(
        historical?.movedFrom,
        persisted?.movedFrom,
    )
        || historical?.valueEditOrder !== persisted?.valueEditOrder
        || !structural_values_equal(
            historical?.formulaReferenceBases ?? [],
            persisted?.formulaReferenceBases ?? [],
        );
    const value_dimension_changed = value_changed || value_metadata_changed;
    if (!value_dimension_changed && !link_changed) return absent_overlay();
    if (value_dimension_changed && link_changed) {
        return combined_overlay(
            value,
            base,
            link,
            base_link,
            false,
            undefined,
            undefined,
            true,
            historical?.movedFrom,
            historical?.valueEditOrder,
            historical?.formulaReferenceBases,
        );
    }
    if (value_dimension_changed) {
        return value_only_overlay(
            value,
            base,
            false,
            undefined,
            undefined,
            true,
            historical?.movedFrom,
            historical?.valueEditOrder,
            historical?.formulaReferenceBases,
        );
    }
    return hyperlink_only_overlay(base, link, base_link);
}

function saved_row_cell_changes(
    delta: RowAppendHistoryDelta,
    assignment: SavedHistoryRowAssignment,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): HistoryChange[] {
    const columns = new Set([
        ...Object.keys(delta.before?.cells ?? {}),
        ...Object.keys(delta.after?.cells ?? {}),
        ...Object.keys(assignment.savedRow.cells),
    ].map(Number));
    const changes: HistoryChange[] = [];
    for (const source_column of [...columns].sort((left, right) => left - right)) {
        const before = delta.before === null
            ? absent_overlay()
            : saved_row_cell_overlay(
                rekey_pending_cell_provenance(
                    delta.before.cells[source_column],
                    assignment.worksheet,
                    assignments,
                ),
                rekey_pending_cell_provenance(
                    assignment.savedRow.cells[source_column],
                    assignment.worksheet,
                    assignments,
                ),
            );
        const after = delta.after === null
            ? absent_overlay()
            : saved_row_cell_overlay(
                rekey_pending_cell_provenance(
                    delta.after.cells[source_column],
                    assignment.worksheet,
                    assignments,
                ),
                rekey_pending_cell_provenance(
                    assignment.savedRow.cells[source_column],
                    assignment.worksheet,
                    assignments,
                ),
            );
        const cell = build_cell_history_delta({
            worksheet: assignment.worksheet,
            sourceRow: assignment.sourceRow,
            sourceColumn: source_column,
            before,
            after,
            persistedValue: pending_cell_value(assignment.savedRow.cells[source_column]),
            persistedHyperlink: pending_cell_link(assignment.savedRow.cells[source_column]),
        });
        if (cell !== undefined) changes.push({ kind: 'cell', delta: cell });
    }
    return changes;
}

function saved_row_highlight_changes(
    delta: RowAppendHistoryDelta,
    assignment: SavedHistoryRowAssignment,
): HistoryChange[] {
    const columns = new Set([
        ...Object.keys(delta.before?.highlights ?? {}),
        ...Object.keys(delta.after?.highlights ?? {}),
    ].map(Number));
    const changes: HistoryChange[] = [];
    for (const sourceColumn of [...columns].sort((left, right) => left - right)) {
        const before = delta.before?.highlights?.[sourceColumn] ?? null;
        const after = delta.after?.highlights?.[sourceColumn] ?? null;
        if (before === after) continue;
        changes.push({
            kind: 'highlight',
            delta: {
                worksheet: assignment.worksheet,
                sourceRow: assignment.sourceRow,
                sourceColumn,
                before,
                after,
            },
        });
    }
    return changes;
}

function saved_tail_removal(
    assignment: SavedHistoryRowAssignment,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): PendingTailRemoval {
    return {
        appendHistoryId: assignment.pendingRowId,
        sourceRow: assignment.sourceRow,
        savedFingerprint: assignment.savedFingerprint,
        savedRow: rekey_saved_row_provenance(
            assignment.savedRow,
            assignment.worksheet,
            assignments,
        ),
    };
}

function rekey_structural_provenance(
    snapshot: PendingStructuralChanges,
    worksheet: WorksheetTarget,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): PendingStructuralChanges {
    const rekey_identity = (identity: RowIdentity): RowIdentity => {
        const assignment = saved_assignment_for_identity(identity, worksheet, assignments);
        return assignment === undefined
            ? identity
            : { kind: 'source', sourceRow: assignment.sourceRow };
    };
    return {
        ...snapshot,
        appendedRows: snapshot.appendedRows.map((row) =>
            rekey_appended_row_provenance(row, worksheet, assignments)),
        tailRemovals: snapshot.tailRemovals.map((removal) => ({
            ...removal,
            savedRow: rekey_saved_row_provenance(
                removal.savedRow,
                worksheet,
                assignments,
            ),
        })),
        conflicts: snapshot.conflicts.map((conflict) => ({
            ...conflict,
            ...(conflict.formulaCells === undefined ? {} : {
                formulaCells: conflict.formulaCells.map((cell) => ({
                    ...cell,
                    rowIdentity: rekey_identity(cell.rowIdentity),
                })),
            }),
        })),
    };
}

function rekey_change_provenance(
    change: HistoryChange,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): HistoryChange {
    const worksheet = change.delta.worksheet;
    switch (change.kind) {
        case 'cell':
            return {
                ...change,
                delta: {
                    ...change.delta,
                    beforeOverlay: rekey_overlay_provenance(
                        change.delta.beforeOverlay,
                        worksheet,
                        assignments,
                    ),
                    afterOverlay: rekey_overlay_provenance(
                        change.delta.afterOverlay,
                        worksheet,
                        assignments,
                    ),
                },
            };
        case 'rowAppend':
            return {
                ...change,
                delta: {
                    ...change.delta,
                    before: change.delta.before === null
                        ? null
                        : rekey_appended_row_provenance(
                            change.delta.before,
                            worksheet,
                            assignments,
                        ),
                    after: change.delta.after === null
                        ? null
                        : rekey_appended_row_provenance(
                            change.delta.after,
                            worksheet,
                            assignments,
                        ),
                },
            };
        case 'tailRemoval': {
            const rekey_removal = (removal: PendingTailRemoval | null) => removal === null
                ? null
                : {
                    ...removal,
                    savedRow: rekey_saved_row_provenance(
                        removal.savedRow,
                        worksheet,
                        assignments,
                    ),
                };
            return {
                ...change,
                delta: {
                    ...change.delta,
                    before: rekey_removal(change.delta.before),
                    after: rekey_removal(change.delta.after),
                },
            };
        }
        case 'pendingRows':
            return {
                ...change,
                delta: {
                    ...change.delta,
                    before: rekey_structural_provenance(
                        change.delta.before,
                        worksheet,
                        assignments,
                    ),
                    after: rekey_structural_provenance(
                        change.delta.after,
                        worksheet,
                        assignments,
                    ),
                },
            };
        case 'highlight':
            return change;
    }
}

function structural_snapshot_without(
    snapshot: PendingStructuralChanges,
    pending_row_ids: ReadonlySet<string>,
    tail_removal_ids: ReadonlySet<string>,
): PendingStructuralChanges {
    const appendedRows = snapshot.appendedRows.filter((row) => !pending_row_ids.has(row.id));
    const tailRemovals = snapshot.tailRemovals.filter(
        (removal) => !tail_removal_ids.has(removal.appendHistoryId),
    );
    const used_templates = new Set(appendedRows.map((row) => row.formatTemplateId));
    const conflicts = snapshot.conflicts.flatMap((conflict) => {
        const pendingRowIds = conflict.pendingRowIds.filter((id) => !pending_row_ids.has(id));
        const tailRemovalIds = conflict.tailRemovalIds.filter((id) => !tail_removal_ids.has(id));
        const formulaCells = conflict.formulaCells?.filter((cell) =>
            cell.rowIdentity.kind !== 'pending'
            || !pending_row_ids.has(cell.rowIdentity.pendingRowId));
        return pendingRowIds.length === 0
            && tailRemovalIds.length === 0
            && (formulaCells?.length ?? 0) === 0 ? [] : [{
            ...conflict,
            pendingRowIds,
            tailRemovalIds,
            ...(formulaCells === undefined ? {} : { formulaCells }),
        }];
    });
    return {
        formatTemplates: snapshot.formatTemplates.filter(
            (template) => used_templates.has(template.id),
        ),
        appendedRows,
        tailRemovals,
        ...(appendedRows.length === 0 || snapshot.appendBasis === undefined
            ? {}
            : { appendBasis: snapshot.appendBasis }),
        conflicts,
    };
}

function* expand_saved_pending_snapshot(
    change: Extract<HistoryChange, { kind: 'pendingRows' }>,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
): IterableIterator<HistoryChange> {
    const worksheet_key = worksheet_target_key(change.delta.worksheet);
    const before_rows = change.delta.before.appendedRows;
    const after_rows = change.delta.after.appendedRows;
    const templates = new Map<string, PendingRowFormatTemplate>();
    for (const template of change.delta.before.formatTemplates) templates.set(template.id, template);
    for (const template of change.delta.after.formatTemplates) {
        if (!templates.has(template.id)) templates.set(template.id, template);
    }
    const matched_after_ids = new Set<string>();
    const expanded_ids = new Set<string>();
    const row_change = (
        before: PendingAppendedRow | null,
        after: PendingAppendedRow | null,
        beforeIndex: number | null,
        afterIndex: number | null,
    ): HistoryChange | undefined => {
        const id = before?.id ?? after?.id;
        if (id === undefined) return undefined;
        const assignment = assignments.get(id);
        if (assignment === undefined
            || worksheet_target_key(assignment.worksheet) !== worksheet_key) return undefined;
        expanded_ids.add(id);
        if (structural_values_equal(before, after)) return undefined;
        const template_ids = new Set([
            before?.formatTemplateId,
            after?.formatTemplateId,
        ].filter((value): value is string => value !== undefined));
        const used_templates = [...template_ids].flatMap((template_id) => {
            const template = templates.get(template_id);
            return template === undefined ? [] : [template];
        });
        return {
            kind: 'rowAppend',
            delta: {
                worksheet: change.delta.worksheet,
                pendingRowId: id,
                before,
                after,
                beforeIndex,
                afterIndex,
                formatTemplates: used_templates,
            },
        };
    };
    let after_cursor = 0;
    for (const [before_index, before] of before_rows.entries()) {
        while (after_cursor < after_rows.length
            && after_rows[after_cursor].createdOrder < before.createdOrder) after_cursor += 1;
        const after_index = after_rows[after_cursor]?.id === before.id ? after_cursor : -1;
        const after = after_index < 0 ? null : after_rows[after_index];
        if (after !== null) matched_after_ids.add(after.id);
        const expanded = row_change(
            before,
            after,
            before_index,
            after_index < 0 ? null : after_index,
        );
        if (expanded !== undefined) yield expanded;
    }
    for (const [after_index, after] of after_rows.entries()) {
        if (matched_after_ids.has(after.id)) continue;
        const expanded = row_change(null, after, null, after_index);
        if (expanded !== undefined) yield expanded;
    }
    if (expanded_ids.size === 0) {
        yield change;
        return;
    }
    const before = structural_snapshot_without(change.delta.before, expanded_ids, new Set());
    const after = structural_snapshot_without(change.delta.after, expanded_ids, new Set());
    if (!structural_values_equal(before, after)) {
        yield {
            kind: 'pendingRows' as const,
            delta: { worksheet: change.delta.worksheet, before, after },
        };
    }
}

function rekey_output_meter(label: string, hardMaxBytes: number): () => void {
    let floor = estimate_string_bytes(barrier_label(label));
    return () => {
        floor += CHANGE_OVERHEAD_BYTES;
        if (floor > hardMaxBytes) throw new BudgetExhausted();
    };
}

function rekey_saved_action(
    action: HistoryAction,
    assignments: ReadonlyMap<string, SavedHistoryRowAssignment>,
    retain_change: () => void,
): HistoryAction {
    const tail_changes: Extract<HistoryChange, { kind: 'tailRemoval' }>[] = [];
    const other_changes: HistoryChange[] = [];
    const expanded_changes = function* (): IterableIterator<HistoryChange> {
        for (const change of action.changes) {
            if (change.kind === 'pendingRows') {
                yield* expand_saved_pending_snapshot(change, assignments);
            } else {
                yield change;
            }
        }
    };
    for (const raw_change of expanded_changes()) {
        if (raw_change.kind !== 'rowAppend') {
            retain_change();
            other_changes.push(rekey_change_provenance(raw_change, assignments));
            continue;
        }
        const assignment = assignments.get(raw_change.delta.pendingRowId);
        if (assignment === undefined) {
            retain_change();
            other_changes.push(rekey_change_provenance(raw_change, assignments));
            continue;
        }
        if ((raw_change.delta.before === null) !== (raw_change.delta.after === null)) {
            retain_change();
            const removal = saved_tail_removal(assignment, assignments);
            tail_changes.push({
                kind: 'tailRemoval',
                delta: {
                    worksheet: assignment.worksheet,
                    appendHistoryId: removal.appendHistoryId,
                    before: raw_change.delta.before === null ? removal : null,
                    after: raw_change.delta.after === null ? removal : null,
                    // Saved removals join whatever safe suffix earlier undos have
                    // already staged, so their insertion index is resolved by
                    // source coordinate at replay time.
                    beforeIndex: null,
                    afterIndex: null,
                },
            });
        }
        const cell_changes = saved_row_cell_changes(raw_change.delta, assignment, assignments);
        for (const change of cell_changes) {
            retain_change();
            other_changes.push(change);
        }
        const highlight_changes = saved_row_highlight_changes(raw_change.delta, assignment);
        for (const change of highlight_changes) {
            retain_change();
            other_changes.push(change);
        }
    }
    // A forward transition that removes tail-removal records must walk from the
    // highest source coordinate down; adding them walks low-to-high. Undo reverses
    // this order and therefore does the complementary safe walk automatically.
    tail_changes.sort((left, right) => {
        const left_removes = left.delta.after === null;
        const right_removes = right.delta.after === null;
        if (left_removes !== right_removes) return left_removes ? -1 : 1;
        const order = left.delta.before?.sourceRow
            ?? left.delta.after?.sourceRow
            ?? 0;
        const other = right.delta.before?.sourceRow
            ?? right.delta.after?.sourceRow
            ?? 0;
        return left_removes ? other - order : order - other;
    });
    return { label: action.label, changes: [...tail_changes, ...other_changes] };
}

/**
 * Advance temporary row identities in both history stacks after a successful save.
 * Entry identity/move counts remain intact so an outstanding menu projection still
 * names the same chronological action.
 */
export function rekey_saved_appended_row_history(
    state: HistoryStackState,
    saved: readonly SavedHistoryRowAssignment[],
    bounds: HistoryBounds = DEFAULT_HISTORY_BOUNDS,
): HistoryStackState {
    if (saved.length === 0) return state;
    const assignments = new Map(saved.map((row) => [row.pendingRowId, row]));
    const rekey_stack = (
        entries: readonly HistoryEntry[],
    ): readonly HistoryEntry[] | undefined => {
        const rekeyed: HistoryEntry[] = [];
        for (const entry of entries) {
            let action: HistoryAction;
            try {
                action = rekey_saved_action(
                    entry.action,
                    assignments,
                    rekey_output_meter(entry.action.label, bounds.hardMaxBytes),
                );
            } catch (error) {
                if (!(error instanceof BudgetExhausted)) throw error;
                return undefined;
            }
            if (action.changes.length === 0) continue;
            const measured = own_and_measure(action, bounds.hardMaxBytes);
            if (measured === undefined) return undefined;
            rekeyed.push({
                ...measured,
                id: entry.id,
                moves: entry.moves,
                epoch: entry.epoch,
            });
        }
        return rekeyed;
    };
    const undoStack = rekey_stack(state.undoStack);
    if (undoStack === undefined) {
        return refused(state, 'Save appended rows', bounds.hardMaxBytes).state;
    }
    const redoStack = rekey_stack(state.redoStack);
    if (redoStack === undefined) {
        return refused(state, 'Save appended rows', bounds.hardMaxBytes).state;
    }
    return bound_rekeyed_history({ ...state, undoStack, redoStack }, bounds);
}

export interface SavedTailRemovalCommit {
    readonly worksheet: WorksheetTarget;
    readonly removal: PendingTailRemoval;
}

function expand_committed_pending_snapshot(
    change: Extract<HistoryChange, { kind: 'pendingRows' }>,
    committed_ids_by_sheet: ReadonlyMap<string, ReadonlySet<string>>,
): HistoryChange[] {
    const worksheet_key = worksheet_target_key(change.delta.worksheet);
    const ids = committed_ids_by_sheet.get(worksheet_key) ?? new Set<string>();
    const before_removals = new Map(change.delta.before.tailRemovals.map((removal, index) => [
        removal.appendHistoryId,
        { removal, index },
    ]));
    const after_removals = new Map(change.delta.after.tailRemovals.map((removal, index) => [
        removal.appendHistoryId,
        { removal, index },
    ]));
    const present_ids = new Set([...ids].filter((id) => {
        const before = before_removals.get(id)?.removal ?? null;
        const after = after_removals.get(id)?.removal ?? null;
        return !structural_values_equal(before, after);
    }));
    if (present_ids.size === 0) return [change];
    const removal_changes: HistoryChange[] = [];
    for (const id of present_ids) {
        const before_entry = before_removals.get(id);
        const after_entry = after_removals.get(id);
        const before = before_entry?.removal ?? null;
        const after = after_entry?.removal ?? null;
        if (structural_values_equal(before, after)) continue;
        removal_changes.push({
            kind: 'tailRemoval',
            delta: {
                worksheet: change.delta.worksheet,
                appendHistoryId: id,
                before,
                after,
                beforeIndex: before_entry?.index ?? null,
                afterIndex: after_entry?.index ?? null,
            },
        });
    }
    const before = structural_snapshot_without(change.delta.before, new Set(), present_ids);
    const after = structural_snapshot_without(change.delta.after, new Set(), present_ids);
    return [
        ...removal_changes,
        ...(structural_values_equal(before, after) ? [] : [{
            kind: 'pendingRows' as const,
            delta: { worksheet: change.delta.worksheet, before, after },
        }]),
    ];
}

function pending_cell_at_overlay(
    overlay: CellOverlayState,
    persisted: PendingRowCell | undefined,
): PendingRowCell | undefined {
    if (overlay.kind === 'absent') return persisted;
    const value = overlay.value.kind === 'present'
        ? overlay.value.value
        : overlay.value.anchor;
    const link = overlay.hyperlink.kind === 'present'
        ? overlay.hyperlink.value
        : persisted?.link ?? null;
    const value_edit_order = overlay.value.kind === 'present'
        ? overlay.value.valueEditOrder
        : persisted?.valueEditOrder;
    const moved_from = overlay.value.kind === 'present'
        ? overlay.value.movedFrom
        : persisted?.movedFrom;
    const formula_reference_bases = overlay.value.kind === 'present'
        ? overlay.value.formulaReferenceBases
        : persisted?.formulaReferenceBases;
    if (
        value.text === ''
        && value.runs === undefined
        && link === null
        && value_edit_order === undefined
        && moved_from === undefined
        && formula_reference_bases === undefined
    ) return undefined;
    return {
        value: value.text,
        ...(value.runs === undefined ? {} : { valueRuns: value.runs }),
        ...(link === null ? {} : { link }),
        ...(value_edit_order === undefined ? {} : { valueEditOrder: value_edit_order }),
        ...(moved_from === undefined ? {} : { movedFrom: moved_from }),
        ...(formula_reference_bases === undefined ? {} : {
            formulaReferenceBases: formula_reference_bases,
        }),
    };
}

/**
 * Advance a saved tail-removal transition after the deletion reaches disk.
 * The physical row no longer exists, so a future replay is an admitted append
 * of the retained snapshot rather than another toggle of a pending removal.
 */
export function rekey_committed_tail_removal_history(
    state: HistoryStackState,
    committed: readonly SavedTailRemovalCommit[],
    bounds: HistoryBounds = DEFAULT_HISTORY_BOUNDS,
): HistoryStackState {
    if (committed.length === 0) return state;
    const committed_rows = committed.map((item) => {
        const worksheet = item.worksheet;
        const removal = item.removal;
        return {
            worksheet,
            removal,
            worksheetKey: worksheet_target_key(worksheet),
            appendHistoryId: removal.appendHistoryId,
            sourceRow: removal.sourceRow,
        };
    });
    const committed_ids_by_sheet = new Map<string, Set<string>>();
    const committed_ids_by_source = new Map<string, Set<string>>();
    for (const item of committed_rows) {
        const ids = committed_ids_by_sheet.get(item.worksheetKey) ?? new Set<string>();
        ids.add(item.appendHistoryId);
        committed_ids_by_sheet.set(item.worksheetKey, ids);
        const source_key = `${item.worksheetKey}\u0000${item.sourceRow}`;
        const source_ids = committed_ids_by_source.get(source_key) ?? new Set<string>();
        source_ids.add(item.appendHistoryId);
        committed_ids_by_source.set(source_key, source_ids);
    }
    const visit_committed_pending_transitions = (
        change: Extract<HistoryChange, { kind: 'pendingRows' }>,
        visit: (id: string) => void,
    ): void => {
        const ids = committed_ids_by_sheet.get(worksheet_target_key(change.delta.worksheet));
        if (ids === undefined) return;
        const before = change.delta.before.tailRemovals;
        const after = change.delta.after.tailRemovals;
        let before_index = 0;
        let after_index = 0;
        while (before_index < before.length || after_index < after.length) {
            const prior = before[before_index];
            const next = after[after_index];
            if (prior !== undefined && next !== undefined
                && prior.sourceRow === next.sourceRow) {
                if (prior.appendHistoryId === next.appendHistoryId) {
                    if (ids.has(prior.appendHistoryId)
                        && !structural_values_equal(prior, next)) visit(prior.appendHistoryId);
                } else {
                    if (ids.has(prior.appendHistoryId)) visit(prior.appendHistoryId);
                    if (ids.has(next.appendHistoryId)) visit(next.appendHistoryId);
                }
                before_index += 1;
                after_index += 1;
            } else if (next === undefined
                || (prior !== undefined && prior.sourceRow < next.sourceRow)) {
                if (ids.has(prior.appendHistoryId)) visit(prior.appendHistoryId);
                before_index += 1;
            } else {
                if (ids.has(next.appendHistoryId)) visit(next.appendHistoryId);
                after_index += 1;
            }
        }
    };
    const preflight_history = (): boolean => {
        try {
            const entries = [...state.undoStack, ...state.redoStack];
            const meters = new Map<object, {
                readonly retain: () => void;
                readonly seen: Set<string>;
            }>();
            const meter_for = (entry: HistoryEntry) => {
                let meter = meters.get(entry.id);
                if (meter === undefined) {
                    meter = {
                        retain: rekey_output_meter(entry.action.label, bounds.hardMaxBytes),
                        seen: new Set(),
                    };
                    meters.set(entry.id, meter);
                }
                return meter;
            };
            const transitioning_keys = new Set<string>();
            for (const entry of entries) {
                const retain_replacement = (key: string): void => {
                    transitioning_keys.add(key);
                    const meter = meter_for(entry);
                    if (meter.seen.has(key)) return;
                    meter.seen.add(key);
                    meter.retain();
                };
                for (const change of entry.action.changes) {
                    const worksheet_key = worksheet_target_key(change.delta.worksheet);
                    if (change.kind === 'pendingRows') {
                        visit_committed_pending_transitions(
                            change,
                            (id) => retain_replacement(`${worksheet_key}\u0000${id}`),
                        );
                    } else if (change.kind === 'tailRemoval') {
                        const ids = committed_ids_by_sheet.get(worksheet_key);
                        if (ids?.has(change.delta.appendHistoryId)
                            && !structural_values_equal(
                                change.delta.before,
                                change.delta.after,
                            )) {
                            retain_replacement(
                                `${worksheet_key}\u0000${change.delta.appendHistoryId}`,
                            );
                        }
                    }
                }
            }
            for (const entry of entries) {
                for (const change of entry.action.changes) {
                    if (change.kind !== 'cell' && change.kind !== 'highlight') continue;
                    const worksheet_key = worksheet_target_key(change.delta.worksheet);
                    const meter = meter_for(entry);
                    for (const id of committed_ids_by_source.get(
                        `${worksheet_key}\u0000${change.delta.sourceRow}`,
                    ) ?? []) {
                        const key = `${worksheet_key}\u0000${id}`;
                        if (!transitioning_keys.has(key) || meter.seen.has(key)) continue;
                        meter.seen.add(key);
                        meter.retain();
                    }
                }
            }
            return true;
        } catch (error) {
            if (!(error instanceof BudgetExhausted)) throw error;
            return false;
        }
    };
    if (!preflight_history()) {
        return refused(state, 'Remove appended rows', bounds.hardMaxBytes).state;
    }
    const expand_stack = (entries: readonly HistoryEntry[]): readonly HistoryEntry[] =>
        entries.map((entry) => ({
            ...entry,
            action: {
                ...entry.action,
                changes: entry.action.changes.flatMap((change) => (
                    change.kind === 'pendingRows'
                        ? expand_committed_pending_snapshot(change, committed_ids_by_sheet)
                        : [change]
                )),
            },
        }));
    const expanded_state = {
        ...state,
        undoStack: expand_stack(state.undoStack),
        redoStack: expand_stack(state.redoStack),
    };
    const chronological = [
        ...expanded_state.undoStack,
        ...[...expanded_state.redoStack].reverse(),
    ];
    interface IndexedHistoryChange {
        readonly entry: HistoryEntry;
        readonly index: number;
        readonly sequence: number;
        readonly change: HistoryChange;
    }
    const tail_changes_by_id = new Map<string, IndexedHistoryChange[]>();
    const row_changes_by_source = new Map<string, IndexedHistoryChange[]>();
    let sequence = 0;
    const index_change = (
        index: Map<string, IndexedHistoryChange[]>,
        key: string,
        item: IndexedHistoryChange,
    ): void => {
        const values = index.get(key) ?? [];
        values.push(item);
        index.set(key, values);
    };
    for (const [index, entry] of chronological.entries()) {
        for (const change of entry.action.changes) {
            const worksheet_key = worksheet_target_key(change.delta.worksheet);
            const item = { entry, index, sequence: sequence++, change };
            if (change.kind === 'tailRemoval') {
                index_change(
                    tail_changes_by_id,
                    `${worksheet_key}\u0000${change.delta.appendHistoryId}`,
                    item,
                );
            } else if (change.kind === 'cell' || change.kind === 'highlight') {
                index_change(
                    row_changes_by_source,
                    `${worksheet_key}\u0000${change.delta.sourceRow}`,
                    item,
                );
            }
        }
    }
    const formats = new Map<number, PendingRowFormatTemplate[]>();
    const formats_by_identity = new WeakMap<object, PendingRowFormatTemplate>();
    const replacements = new Map<object, Array<{
        readonly key: string;
        readonly sourceRow: number;
        readonly change: () => Extract<HistoryChange, { kind: 'rowAppend' }>;
    }>>();
    const consumed = new Map<object, Set<HistoryChange>>();
    const replacement_floors = new Map<object, number>();

    for (const committed_row of committed_rows) {
        const {
            worksheet,
            removal,
            worksheetKey: worksheet_key,
            appendHistoryId: append_history_id,
            sourceRow: source_row,
        } = committed_row;
        const relevant = [
            ...(tail_changes_by_id.get(
                `${worksheet_key}\u0000${append_history_id}`,
            ) ?? []),
            ...(row_changes_by_source.get(`${worksheet_key}\u0000${source_row}`) ?? []),
        ].sort((left, right) => (left.index - right.index) || (left.sequence - right.sequence));
        if (!relevant.some(({ change }) => change.kind === 'tailRemoval')) continue;
        for (const index of new Set(relevant.map((item) => item.index))) {
            const entry = chronological[index];
            const floor = (replacement_floors.get(entry.id)
                ?? estimate_string_bytes(barrier_label(entry.action.label)))
                + CHANGE_OVERHEAD_BYTES;
            if (floor > bounds.hardMaxBytes) {
                return refused(state, 'Remove appended rows', bounds.hardMaxBytes).state;
            }
            replacement_floors.set(entry.id, floor);
        }

        const format = removal.savedRow.format;
        let template = formats_by_identity.get(format);
        if (template === undefined) {
            const format_hash = structural_value_hash(format);
            const candidates = formats.get(format_hash) ?? [];
            template = candidates.find((candidate) =>
                structural_values_equal(candidate.format, format));
            if (template === undefined) {
                template = Object.freeze({
                    id: `restored-format:${append_history_id}`,
                    format,
                });
                candidates.push(template);
                formats.set(format_hash, candidates);
            }
            formats_by_identity.set(format, template);
        }
        const cell_transitions = new Map<number, Array<{
            index: number;
            before: CellOverlayState;
            after: CellOverlayState;
        }>>();
        const highlight_transitions = new Map<number, Array<{
            index: number;
            before: CellHighlightColor | null;
            after: CellHighlightColor | null;
        }>>();
        const existence: Array<{
            index: number;
            before: boolean;
            after: boolean;
        }> = [];
        for (const item of relevant) {
            if (item.change.kind === 'cell') {
                const list = cell_transitions.get(item.change.delta.sourceColumn) ?? [];
                list.push({
                    index: item.index,
                    before: item.change.delta.beforeOverlay,
                    after: item.change.delta.afterOverlay,
                });
                cell_transitions.set(item.change.delta.sourceColumn, list);
            } else if (item.change.kind === 'highlight') {
                const list = highlight_transitions.get(item.change.delta.sourceColumn) ?? [];
                list.push({
                    index: item.index,
                    before: item.change.delta.before,
                    after: item.change.delta.after,
                });
                highlight_transitions.set(item.change.delta.sourceColumn, list);
            } else {
                existence.push({
                    index: item.index,
                    before: item.change.delta.before === null,
                    after: item.change.delta.after === null,
                });
            }
            const set = consumed.get(item.entry.id) ?? new Set<HistoryChange>();
            set.add(item.change);
            consumed.set(item.entry.id, set);
        }
        const side_at = <T,>(
            transitions: readonly { index: number; before: T; after: T }[],
            boundary: number,
            fallback: T,
        ): T => {
            let low = 0;
            let high = transitions.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (transitions[middle].index < boundary) low = middle + 1;
                else high = middle;
            }
            if (low > 0) return transitions[low - 1].after;
            return transitions[low]?.before ?? fallback;
        };
        const row_at = (boundary: number): PendingAppendedRow | null => {
            if (!side_at(existence, boundary, true)) return null;
            const cells: Record<string, PendingRowCell> = {
                ...removal.savedRow.cells,
            };
            for (const [column, transitions] of cell_transitions) {
                const cell = pending_cell_at_overlay(
                    side_at(transitions, boundary, absent_overlay()),
                    removal.savedRow.cells[column],
                );
                if (cell === undefined) delete cells[column];
                else cells[column] = cell;
            }
            const highlights: Record<string, CellHighlightColor> = {
                ...(removal.savedRow.highlights ?? {}),
            };
            for (const [column, transitions] of highlight_transitions) {
                const color = side_at(
                    transitions,
                    boundary,
                    removal.savedRow.highlights?.[column] ?? null,
                );
                if (color === null) delete highlights[column];
                else highlights[column] = color;
            }
            return {
                id: append_history_id,
                cells,
                formatTemplateId: template!.id,
                createdOrder: source_row,
                ...(removal.savedRow.viewerRowHeight === undefined
                    ? {}
                    : { viewerRowHeight: removal.savedRow.viewerRowHeight }),
                ...(Object.keys(highlights).length === 0 ? {} : { highlights }),
            };
        };
        for (const index of new Set(relevant.map((item) => item.index))) {
            const entry = chronological[index];
            const list = replacements.get(entry.id) ?? [];
            list.push({
                key: `${worksheet_key}\u0000${append_history_id}`,
                sourceRow: source_row,
                change: () => ({
                    kind: 'rowAppend',
                    delta: {
                        worksheet,
                        pendingRowId: append_history_id,
                        before: row_at(index),
                        after: row_at(index + 1),
                        beforeIndex: null,
                        afterIndex: null,
                        formatTemplates: [template],
                        restoredFromSavedRemoval: true,
                    },
                }),
            });
            replacements.set(entry.id, list);
        }
    }

    const rekey_stack = (
        entries: readonly HistoryEntry[],
    ): readonly HistoryEntry[] | undefined => {
        const rekeyed: HistoryEntry[] = [];
        for (const entry of entries) {
            const replacement = replacements.get(entry.id);
            if (replacement === undefined) {
                rekeyed.push(entry);
                continue;
            }
            const removed = consumed.get(entry.id) ?? new Set();
            const retain_change = rekey_output_meter(
                entry.action.label,
                bounds.hardMaxBytes,
            );
            const changes: HistoryChange[] = [];
            try {
                for (const descriptor of replacement
                    .sort((left, right) => left.sourceRow - right.sourceRow)) {
                    retain_change();
                    changes.push(descriptor.change());
                }
                for (const change of entry.action.changes) {
                    if (removed.has(change)) continue;
                    retain_change();
                    changes.push(change);
                }
            } catch (error) {
                if (!(error instanceof BudgetExhausted)) throw error;
                return undefined;
            }
            const action: HistoryAction = {
                label: entry.action.label,
                changes,
            };
            const measured = own_and_measure(action, bounds.hardMaxBytes);
            if (measured === undefined) return undefined;
            rekeyed.push({
                ...measured,
                id: entry.id,
                moves: entry.moves,
                epoch: entry.epoch,
            });
        }
        return rekeyed;
    };
    const undoStack = rekey_stack(expanded_state.undoStack);
    if (undoStack === undefined) {
        return refused(state, 'Remove appended rows', bounds.hardMaxBytes).state;
    }
    const redoStack = rekey_stack(expanded_state.redoStack);
    if (redoStack === undefined) {
        return refused(state, 'Remove appended rows', bounds.hardMaxBytes).state;
    }
    return bound_rekeyed_history({ ...state, undoStack, redoStack }, bounds);
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

/** Re-apply aggregate bounds after a save changes retained history payloads. */
function bound_rekeyed_history(
    state: HistoryStackState,
    bounds: HistoryBounds,
): HistoryStackState {
    let undo = [...state.undoStack];
    let redo = [...state.redoStack];
    const exceeds = (): boolean => {
        const usage = totals([...undo, ...redo]);
        return undo.length + redo.length > bounds.maxActions
            || usage.cells > bounds.maxCells
            || usage.bytes > bounds.softMaxBytes;
    };
    while (exceeds() && undo.length + redo.length > 1) {
        if (undo.length > 0) undo.shift();
        else redo.shift();
    }
    return {
        ...state,
        undoStack: undo,
        redoStack: redo,
    };
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
        // Recorded even though nothing moved: this path is what takes the entry
        // off the stack, so a duplicate delivery would find `position === -1`
        // and — for a redo of the live epoch — ADOPT what this call just
        // dropped, resurrecting a refused gesture and evicting a newer action to
        // seat it. The other drop above needs no entry: an absent entry that
        // failed the adoption test fails it identically next time.
        COMMITTED_MOVES.set(entry.id, entry.moves + 1);
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

export interface RetainedSavedAppendAuthority extends WorksheetTarget {
    readonly appendHistoryIds: readonly string[];
}

export interface RetainedPendingRowAuthority extends WorksheetTarget {
    readonly pendingRowIds: readonly string[];
}

/** Temporary row identities still reachable from either history stack. */
export function retained_pending_row_authorities(
    state: HistoryStackState,
): readonly RetainedPendingRowAuthority[] {
    const groups = new Map<string, { worksheet: WorksheetTarget; ids: Set<string> }>();
    const retain = (worksheet: WorksheetTarget, id: string): void => {
        const key = worksheet_target_key(worksheet);
        const group = groups.get(key) ?? { worksheet, ids: new Set<string>() };
        group.ids.add(id);
        groups.set(key, group);
    };
    for (const entry of [...state.undoStack, ...state.redoStack]) {
        for (const change of entry.action.changes) {
            if (change.kind === 'rowAppend'
                && change.delta.restoredFromSavedRemoval !== true) {
                retain(change.delta.worksheet, change.delta.pendingRowId);
            } else if (change.kind === 'pendingRows') {
                for (const row of [
                    ...change.delta.before.appendedRows,
                    ...change.delta.after.appendedRows,
                ]) retain(change.delta.worksheet, row.id);
            }
        }
    }
    return Object.freeze([...groups.values()].map(({ worksheet, ids }) => Object.freeze({
        ...worksheet,
        pendingRowIds: Object.freeze([...ids]),
    })));
}

/**
 * Saved-row capabilities that are still reachable from either history stack.
 * The renderer can only retire host authority with this projection; it cannot
 * create authority, which remains a consequence of a verified save.
 */
export function retained_saved_append_authorities(
    state: HistoryStackState,
): readonly RetainedSavedAppendAuthority[] {
    const groups = new Map<string, { worksheet: WorksheetTarget; ids: Set<string> }>();
    for (const entry of [...state.undoStack, ...state.redoStack]) {
        for (const change of entry.action.changes) {
            if (change.kind === 'pendingRows') {
                for (const removal of [
                    ...change.delta.before.tailRemovals,
                    ...change.delta.after.tailRemovals,
                ]) {
                    const key = worksheet_target_key(change.delta.worksheet);
                    const group = groups.get(key) ?? {
                        worksheet: change.delta.worksheet,
                        ids: new Set<string>(),
                    };
                    group.ids.add(removal.appendHistoryId);
                    groups.set(key, group);
                }
                continue;
            }
            const retained = change.kind === 'tailRemoval'
                ? { worksheet: change.delta.worksheet, id: change.delta.appendHistoryId }
                : change.kind === 'rowAppend' && change.delta.restoredFromSavedRemoval === true
                    ? { worksheet: change.delta.worksheet, id: change.delta.pendingRowId }
                    : undefined;
            if (retained === undefined) continue;
            const key = worksheet_target_key(retained.worksheet);
            const group = groups.get(key) ?? {
                worksheet: retained.worksheet,
                ids: new Set<string>(),
            };
            group.ids.add(retained.id);
            groups.set(key, group);
        }
    }
    return Object.freeze([...groups.values()].map(({ worksheet, ids }) => Object.freeze({
        ...worksheet,
        appendHistoryIds: Object.freeze([...ids]),
    })));
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
interface StructuralHistoryOwner {
    readonly templates: Map<string, PendingRowFormatTemplate[]>;
}

function mix_structural_hash(hash: number, value: number): number {
    return Math.imul(hash ^ value, 0x01000193) >>> 0;
}

/** Allocation-free fingerprint; equality is still checked inside collision buckets. */
function structural_value_hash(value: unknown): number {
    if (value === null) return 0x42108421;
    if (value === undefined) return 0x10204081;
    if (typeof value === 'boolean') return value ? 0x51ed270b : 0x51ed270a;
    if (typeof value === 'number') {
        const whole = Math.trunc(value);
        const fraction = Math.trunc((value - whole) * 0x7fffffff);
        return mix_structural_hash(0x4e554d42, (whole ^ fraction) >>> 0);
    }
    if (typeof value === 'string') {
        let hash = 0x53545200;
        for (let index = 0; index < value.length; index += 1) {
            hash = mix_structural_hash(hash, value.charCodeAt(index));
        }
        return hash;
    }
    if (typeof value !== 'object') return 0x7f4a7c15;
    if (Array.isArray(value)) {
        let hash = mix_structural_hash(0x41525200, value.length);
        for (const child of value) hash = mix_structural_hash(hash, structural_value_hash(child));
        return hash;
    }
    let xor = 0;
    let sum = 0;
    let count = 0;
    for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const pair = mix_structural_hash(
            structural_value_hash(key),
            structural_value_hash((value as Record<string, unknown>)[key]),
        );
        xor ^= pair;
        sum = (sum + Math.imul(pair, 0x9e3779b1)) >>> 0;
        count += 1;
    }
    return mix_structural_hash(mix_structural_hash(0x4f424a00, xor), sum ^ count);
}

function structural_values_equal(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (typeof left !== 'object' || left === null
        || typeof right !== 'object' || right === null) return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index += 1) {
            if (!structural_values_equal(left[index], right[index])) return false;
        }
        return true;
    }
    let left_count = 0;
    let right_count = 0;
    for (const key in left) {
        if (!Object.hasOwn(left, key)) continue;
        left_count += 1;
        if (!Object.hasOwn(right, key)
            || !structural_values_equal(
                (left as Record<string, unknown>)[key],
                (right as Record<string, unknown>)[key],
            )) return false;
    }
    for (const key in right) {
        if (Object.hasOwn(right, key)) right_count += 1;
    }
    return left_count === right_count;
}

/** Snapshot structural input once, without retaining caller-owned string views. */
function snapshot_structural_input<T>(value: T, ancestors = new Set<object>()): T {
    if (typeof value === 'string') return materialized_string(value) as T;
    if (typeof value !== 'object' || value === null) return value;
    if (ancestors.has(value)) throw new TypeError('Structural history cannot contain cycles');
    ancestors.add(value);
    if (Array.isArray(value)) {
        const copied = value.map((entry) => snapshot_structural_input(entry, ancestors));
        ancestors.delete(value);
        return Object.freeze(copied) as T;
    }
    const copied: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        copied[key] = snapshot_structural_input(child, ancestors);
    }
    ancestors.delete(value);
    return Object.freeze(copied) as T;
}

function own_structural_template(
    value: PendingRowFormatTemplate,
    structural_owner: StructuralHistoryOwner,
): PendingRowFormatTemplate {
    const normalized = own_pending_row_format_template(snapshot_structural_input(value));
    const candidates = structural_owner.templates.get(normalized.id) ?? [];
    const retained = candidates.find((candidate) =>
        structural_values_equal(candidate.format, normalized.format));
    if (retained !== undefined) return retained;
    candidates.push(normalized);
    structural_owner.templates.set(normalized.id, candidates);
    return normalized;
}

function own_history_change(
    change: HistoryChange,
    owner: HistoryActionOwner,
    structural_owner: StructuralHistoryOwner,
): HistoryChange {
    if (change.kind === 'cell') {
        return Object.freeze({ kind: 'cell', delta: own_cell_history_delta(change.delta, owner) });
    }
    if (change.kind === 'highlight') {
        return Object.freeze({
            kind: 'highlight',
            delta: own_highlight_history_delta(change.delta, owner),
        });
    }
    if (change.kind === 'rowAppend') {
        const owned_templates = change.delta.formatTemplates.map((template) =>
            own_structural_template(template, structural_owner));
        const own_row = (row: PendingAppendedRow | null): PendingAppendedRow | null => {
            if (row === null) return null;
            const template = owned_templates.find(
                (candidate) => candidate.id === row.formatTemplateId,
            );
            if (template === undefined) {
                throw new TypeError('Row history lost its format template');
            }
            return own_pending_structural_changes({
                formatTemplates: [template],
                appendedRows: [snapshot_structural_input(row)],
            }).appendedRows[0];
        };
        const before = own_row(change.delta.before);
        const after = own_row(change.delta.after);
        const formats_by_id = new Map<string, PendingRowFormatTemplate>();
        for (const row of [before, after]) {
            if (row === null || formats_by_id.has(row.formatTemplateId)) continue;
            const template = owned_templates.find(
                (candidate) => candidate.id === row.formatTemplateId,
            );
            if (template === undefined) {
                throw new TypeError('Row history lost its format template');
            }
            own_pending_structural_changes({
                formatTemplates: [template],
                appendedRows: [row],
            });
            formats_by_id.set(row.formatTemplateId, template);
        }
        const formats = [...formats_by_id.values()];
        return Object.freeze({
            kind: 'rowAppend',
            delta: Object.freeze({
                worksheet: owner.own_worksheet_target(change.delta.worksheet),
                pendingRowId: owner.own_string(change.delta.pendingRowId),
                before,
                after,
                beforeIndex: change.delta.beforeIndex,
                afterIndex: change.delta.afterIndex,
                formatTemplates: formats,
                ...(change.delta.restoredFromSavedRemoval === true
                    ? { restoredFromSavedRemoval: true as const }
                    : {}),
            }),
        });
    }
    if (change.kind === 'pendingRows') {
        return Object.freeze({
            kind: 'pendingRows',
            delta: Object.freeze({
                worksheet: owner.own_worksheet_target(change.delta.worksheet),
                before: own_pending_structural_changes(
                    snapshot_structural_input(change.delta.before),
                ),
                after: own_pending_structural_changes(
                    snapshot_structural_input(change.delta.after),
                ),
            }),
        });
    }
    const own_removal = (removal: PendingTailRemoval | null): PendingTailRemoval | null => {
        if (removal === null) return null;
        return own_pending_structural_changes({
            tailRemovals: [snapshot_structural_input(removal)],
        }).tailRemovals[0];
    };
    return Object.freeze({
        kind: 'tailRemoval',
        delta: Object.freeze({
            worksheet: owner.own_worksheet_target(change.delta.worksheet),
            appendHistoryId: owner.own_string(change.delta.appendHistoryId),
            before: own_removal(change.delta.before),
            after: own_removal(change.delta.after),
            beforeIndex: change.delta.beforeIndex,
            afterIndex: change.delta.afterIndex,
        }),
    });
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
    return action.changes.some((change) => change.kind === 'cell'
        || change.kind === 'rowAppend'
        || change.kind === 'tailRemoval'
        || change.kind === 'pendingRows');
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
