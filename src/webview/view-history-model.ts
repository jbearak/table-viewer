/**
 * View steps: a sort, a filter, hidden rows, hidden columns, column widths,
 * row heights, or the Header Row as one undoable gesture.
 *
 * A view step stores only what its gesture changed. Sort and filters are small
 * ordered lists, stored whole, before and after. Hidden rows and hidden
 * columns are sets other things also write (a promoted Header Row hides the
 * rows above it; another window can hide more), so the step stores the
 * members it hid and showed, not the set.
 *
 * Replay never compares. It writes from the live state: a list is set to the
 * step's other side, set members are added and removed. A view slice holds
 * nothing a person can lose, so there is nothing for a compare-and-swap to
 * protect, and writing from the live state makes replay idempotent: a step
 * whose effect is already in place has nothing to do.
 *
 * A view step never stands in the way of an older step. The parts of it that
 * cannot apply now, for a reason this window can see, are skipped and named;
 * the entry still moves. See `transform_replay_target`.
 *
 * Sizes (column widths, row heights) are members too, each with the value it
 * held before and after. They are recorded from what the host says its write
 * changed, never from what this window believed: a window's own sizes can be
 * stale (another window's write is not sent to it), and only the host knows
 * which source rows a row gesture touched. Sizes are positional and have no
 * schema: nothing re-associates a stored width when column names change.
 *
 * The Header Row is a step too. Its two sides are stored whole (one small
 * value per worksheet) and the hidden rows that changed with it as members,
 * both from what the host says its write changed. It has no schema: a header
 * change is what changes the schema. See `header_replay_target`.
 */

import {
    first_non_hidden_source_row,
    hidden_rows_after_header_change,
} from '../header-hidden-rows';
import {
    MAX_PERSISTED_HIDDEN_ROWS,
    type ColumnWidthChange,
    type ColumnWidthsSheetRequest,
    type ExcelHeaderChange,
    type ExcelHeaderSide,
    type ExcelHeaderTarget,
    type FilterEntry,
    type RowHeightsChange,
    type SourceRowHeightRun,
    type SheetTransformState,
    type SortKey,
    type WorksheetTarget,
} from '../types';

/** An ordered list a gesture replaced. */
export interface ListTransition<T> {
    readonly before: readonly T[];
    readonly after: readonly T[];
}

/** Set members a gesture hid and showed; each sorted, unique, and disjoint. */
export interface MemberTransition {
    readonly hidden: readonly number[];
    readonly shown: readonly number[];
}

/** Sort, filters and hidden rows of one worksheet: the slices `setTransform` installs. */
export interface TransformViewDelta {
    readonly worksheet: WorksheetTarget;
    readonly slice: 'transform';
    /** The sheet's transform schema when recorded (`transform_schema_for_sheet`). */
    readonly schema: string;
    readonly sort?: ListTransition<SortKey>;
    readonly filters?: ListTransition<FilterEntry>;
    /** Canonical source rows. */
    readonly hiddenRows?: MemberTransition;
}

/** Hidden source columns of one worksheet. */
export interface ColumnsViewDelta extends MemberTransition {
    readonly worksheet: WorksheetTarget;
    readonly slice: 'columns';
    readonly schema: string;
}

/** What a gesture did to a worksheet's Auto-fit, when it was the toggle itself. */
export type AutoFitChange = 'on' | 'off';

/** Stored widths of source columns of one worksheet. */
export interface ColumnWidthsViewDelta {
    readonly worksheet: WorksheetTarget;
    readonly slice: 'columnWidths';
    /** The source columns the write changed, ascending. `null`: no stored width. */
    readonly columns: readonly ColumnWidthChange[];
    /** Set when the gesture turned Auto-fit on or off for the worksheet. */
    readonly autoFit?: AutoFitChange;
}

/** Custom heights of source rows of one worksheet. */
export interface RowHeightsViewDelta {
    readonly worksheet: WorksheetTarget;
    readonly slice: 'rowHeights';
    /** What the gesture set on every row it changed. `null`: a reset. */
    readonly after: number | null;
    /**
     * The rows the write changed and what each held before, as ascending,
     * disjoint runs of consecutive source rows with one prior height.
     * `null`: no custom height.
     */
    readonly before: readonly SourceRowHeightRun[];
}

/** The Header Row of one worksheet, and the hidden rows that changed with it. */
export interface HeaderViewDelta {
    readonly worksheet: WorksheetTarget;
    readonly slice: 'header';
    readonly before: ExcelHeaderSide;
    readonly after: ExcelHeaderSide;
    /** Canonical source rows the change hid and showed. */
    readonly hiddenRows?: MemberTransition;
}

export type ViewHistoryDelta =
    | TransformViewDelta
    | ColumnsViewDelta
    | ColumnWidthsViewDelta
    | RowHeightsViewDelta
    | HeaderViewDelta;

/** A view gesture ready to record: its Edit-menu label and its one change. */
export interface ViewStep {
    readonly label: string;
    readonly delta: ViewHistoryDelta;
}

export type ViewDirection = 'undo' | 'redo';

/** Why part of a view step was not applied. */
export type ViewSkipReason =
    | 'columns-changed'
    | 'rows-above-header'
    | 'header-row'
    | 'rows-gone'
    | 'too-many-hidden'
    | 'columns-gone'
    | 'sheets-gone'
    | 'too-many-heights'
    | 'header-unavailable'
    | 'header-row-gone';

type TransformRules = Pick<SheetTransformState, 'sort' | 'filters' | 'hiddenRows'>;

const lists_equal = (left: readonly unknown[], right: readonly unknown[]): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

function sorted_unique(values: Iterable<number>): number[] {
    return [...new Set(values)].sort((left, right) => left - right);
}

/** Members of `left` that are not in `right`, sorted. */
function difference(left: readonly number[], right: readonly number[]): number[] {
    const excluded = new Set(right);
    return sorted_unique(left.filter((value) => !excluded.has(value)));
}

function plural(count: number, one: string, many: string): string {
    return count === 1 ? one : `${count} ${many}`;
}

function filter_label(transition: ListTransition<FilterEntry>): string {
    const after_by_column = new Map(transition.after.map((entry) => [entry.colIndex, entry]));
    let removed = 0;
    for (const entry of transition.before) {
        const kept = after_by_column.get(entry.colIndex);
        if (kept === undefined) {
            removed += 1;
        } else if (!lists_equal([entry], [kept])) {
            return 'Filter';
        }
    }
    if (removed === 0 || transition.after.length !== transition.before.length - removed) {
        return 'Filter';
    }
    return removed === 1 ? 'Clear filter' : 'Clear filters';
}

function transform_label(delta: TransformViewDelta): string {
    const slices = [delta.sort, delta.filters, delta.hiddenRows]
        .filter((slice) => slice !== undefined).length;
    if (slices !== 1) return 'Change view';
    if (delta.sort !== undefined) return delta.sort.after.length === 0 ? 'Clear sort' : 'Sort';
    if (delta.filters !== undefined) return filter_label(delta.filters);
    const rows = delta.hiddenRows!;
    if (rows.hidden.length > 0 && rows.shown.length > 0) return 'Change view';
    return rows.hidden.length > 0
        ? `Hide ${plural(rows.hidden.length, 'row', 'rows')}`
        : 'Unhide rows';
}

/**
 * The step from one set of rules to another, or undefined when none of the
 * three slices changed. Absent rules equal empty ones. `onlyChangedRows` is
 * not a slice: a compare window's toggle is never a step.
 */
export function transform_view_step(
    worksheet: WorksheetTarget,
    schema: string,
    before: TransformRules | undefined,
    after: TransformRules | undefined,
): ViewStep | undefined {
    const sort = lists_equal(before?.sort ?? [], after?.sort ?? [])
        ? undefined
        : { before: [...(before?.sort ?? [])], after: [...(after?.sort ?? [])] };
    const filters = lists_equal(before?.filters ?? [], after?.filters ?? [])
        ? undefined
        : { before: [...(before?.filters ?? [])], after: [...(after?.filters ?? [])] };
    const hidden = difference(after?.hiddenRows ?? [], before?.hiddenRows ?? []);
    const shown = difference(before?.hiddenRows ?? [], after?.hiddenRows ?? []);
    const hiddenRows = hidden.length === 0 && shown.length === 0
        ? undefined
        : { hidden, shown };
    if (sort === undefined && filters === undefined && hiddenRows === undefined) return undefined;
    const delta: TransformViewDelta = {
        worksheet,
        slice: 'transform',
        schema,
        ...(sort === undefined ? {} : { sort }),
        ...(filters === undefined ? {} : { filters }),
        ...(hiddenRows === undefined ? {} : { hiddenRows }),
    };
    return { label: transform_label(delta), delta };
}

/**
 * The step of a sort or filter gesture a refresh overtook, judged by what the
 * refresh adopted. The gesture landed only if the adopted rules equal its
 * target in every slice where the target differs from its baseline; the step
 * is then that difference and nothing else the refresh changed.
 */
export function overtaken_transform_step(
    worksheet: WorksheetTarget,
    schema: string,
    baseline: TransformRules | undefined,
    target: TransformRules,
    adopted: TransformRules | undefined,
): ViewStep | undefined {
    const step = transform_view_step(worksheet, schema, baseline, target);
    if (step === undefined || step.delta.slice !== 'transform') return undefined;
    return transform_slices_equal(step.delta, target, adopted) ? step : undefined;
}

/** Whether two sets of rules agree in every slice `delta` names. */
export function transform_slices_equal(
    delta: TransformViewDelta,
    left: TransformRules | undefined,
    right: TransformRules | undefined,
): boolean {
    if (delta.sort !== undefined && !lists_equal(left?.sort ?? [], right?.sort ?? [])) return false;
    if (
        delta.filters !== undefined
        && !lists_equal(left?.filters ?? [], right?.filters ?? [])
    ) return false;
    return delta.hiddenRows === undefined || lists_equal(
        sorted_unique(left?.hiddenRows ?? []),
        sorted_unique(right?.hiddenRows ?? []),
    );
}

/** The step from one hidden-column set to another, or undefined when they are equal. */
export function columns_view_step(
    worksheet: WorksheetTarget,
    schema: string,
    before_hidden: readonly number[],
    after_hidden: readonly number[],
): ViewStep | undefined {
    const hidden = difference(after_hidden, before_hidden);
    const shown = difference(before_hidden, after_hidden);
    if (hidden.length === 0 && shown.length === 0) return undefined;
    const label = hidden.length > 0 && shown.length > 0
        ? 'Change view'
        : hidden.length > 0
            ? `Hide ${plural(hidden.length, 'column', 'columns')}`
            : `Show ${plural(shown.length, 'column', 'columns')}`;
    return { label, delta: { worksheet, slice: 'columns', schema, hidden, shown } };
}

/** What replay needs to know about a worksheet as it is now. */
export interface TransformReplaySheet {
    readonly schema: string;
    /** Source rows, not the displayed count. */
    readonly sourceRowCount: number;
    /** Rows `0..protectedRows-1` must stay hidden: they are above the Header Row. */
    readonly protectedRows: number;
    /** The Header Row's source row while it is on: it cannot be hidden. */
    readonly headerRow?: number;
}

export interface TransformReplayTarget {
    /** The rules to install: the live rules with the step's other side written in. */
    readonly target: SheetTransformState;
    /** Why parts of the step were left out, in a fixed order, each once. */
    readonly skipped: readonly ViewSkipReason[];
    /** Whether `target` differs from the live rules in a slice the step names. */
    readonly changes: boolean;
}

/** The members a direction hides and shows. */
function replay_members(
    transition: MemberTransition,
    direction: ViewDirection,
): { readonly hide: readonly number[]; readonly show: readonly number[] } {
    return direction === 'undo'
        ? { hide: transition.shown, show: transition.hidden }
        : { hide: transition.hidden, show: transition.shown };
}

const SKIP_ORDER: readonly ViewSkipReason[] = [
    'columns-changed',
    'rows-above-header',
    'header-row',
    'rows-gone',
    'too-many-hidden',
    'sheets-gone',
    'columns-gone',
    'too-many-heights',
    'header-unavailable',
    'header-row-gone',
];

/** Skip reasons in the order they are said, each once. */
export function ordered_skips(found: ReadonlySet<ViewSkipReason>): ViewSkipReason[] {
    return SKIP_ORDER.filter((reason) => found.has(reason));
}

/**
 * The rules a transform step's replay installs, from the live rules.
 *
 * Skipped, each from state this window already holds:
 *  - sort and filters when the sheet's columns changed since the step was
 *    recorded (they name columns by position; the app drops an installed sort
 *    and filter across the same change);
 *  - showing a row above the Header Row, and hiding the Header Row itself
 *    (the host requires the first and refuses the second);
 *  - hiding a row past the end of the worksheet, and hiding at all when the
 *    set would pass `MAX_PERSISTED_HIDDEN_ROWS` (the host drops the first and
 *    refuses the second).
 */
export function transform_replay_target(
    delta: TransformViewDelta,
    direction: ViewDirection,
    live: SheetTransformState | undefined,
    sheet: TransformReplaySheet,
): TransformReplayTarget {
    const skipped = new Set<ViewSkipReason>();
    const columns_changed = delta.schema !== sheet.schema;
    let sort = live?.sort ?? [];
    let filters = live?.filters ?? [];
    if (delta.sort !== undefined) {
        if (columns_changed) skipped.add('columns-changed');
        else sort = [...(direction === 'undo' ? delta.sort.before : delta.sort.after)];
    }
    if (delta.filters !== undefined) {
        if (columns_changed) skipped.add('columns-changed');
        else filters = [...(direction === 'undo' ? delta.filters.before : delta.filters.after)];
    }
    const live_hidden = sorted_unique(live?.hiddenRows ?? []);
    let hidden_rows = live_hidden;
    if (delta.hiddenRows !== undefined) {
        const { hide, show } = replay_members(delta.hiddenRows, direction);
        const next = new Set(live_hidden);
        for (const row of show) {
            if (!next.has(row)) continue;
            if (row < sheet.protectedRows) skipped.add('rows-above-header');
            else next.delete(row);
        }
        const before_hiding = sorted_unique(next);
        for (const row of hide) {
            if (next.has(row)) continue;
            if (row >= sheet.sourceRowCount) skipped.add('rows-gone');
            else if (row === sheet.headerRow) skipped.add('header-row');
            else next.add(row);
        }
        if (next.size > MAX_PERSISTED_HIDDEN_ROWS) {
            skipped.add('too-many-hidden');
            hidden_rows = before_hiding;
        } else {
            hidden_rows = sorted_unique(next);
        }
    }
    const { hiddenRows: _live_hidden, ...rest } = live ?? { sort: [], filters: [] };
    const target: SheetTransformState = {
        ...rest,
        sort: [...sort],
        filters: [...filters],
        ...(hidden_rows.length === 0 ? {} : { hiddenRows: hidden_rows }),
        schema: sheet.schema,
    };
    return {
        target,
        skipped: ordered_skips(skipped),
        changes: !transform_slices_equal(delta, target, live),
    };
}

export interface ColumnsReplayTarget {
    /** The hidden source columns to install, sorted. */
    readonly hidden: readonly number[];
    readonly skipped: readonly ViewSkipReason[];
    /** Whether `hidden` differs from the live hidden set. */
    readonly changes: boolean;
}

/** The hidden columns a column step's replay installs, from the live hidden set. */
export function columns_replay_target(
    delta: ColumnsViewDelta,
    direction: ViewDirection,
    live_hidden: readonly number[],
    sheet: { readonly schema: string; readonly columnCount: number },
): ColumnsReplayTarget {
    const live = sorted_unique(live_hidden);
    if (delta.schema !== sheet.schema) {
        return { hidden: live, skipped: ['columns-changed'], changes: false };
    }
    const { hide, show } = replay_members(delta, direction);
    const next = new Set(live);
    for (const column of show) next.delete(column);
    for (const column of hide) {
        if (column < sheet.columnCount) next.add(column);
    }
    const hidden = sorted_unique(next);
    return { hidden, skipped: [], changes: !lists_equal(hidden, live) };
}

// ---- Sizes: column widths and row heights ----

/** How many rows the runs cover. */
function run_row_count(runs: readonly SourceRowHeightRun[]): number {
    let count = 0;
    for (const run of runs) count += run.end - run.start + 1;
    return count;
}

/**
 * The step of one worksheet's width write, from what the host says it
 * changed; undefined when it changed nothing.
 *
 * The label is the toggle's when the gesture was the Auto-fit toggle, and
 * otherwise counts the columns: a drag, a fanned-out drag, a double-click fit.
 */
export function column_widths_view_step(
    worksheet: WorksheetTarget,
    columns: readonly ColumnWidthChange[],
    auto_fit?: AutoFitChange,
): ViewStep | undefined {
    const changed = columns
        .filter((entry) => entry.before !== entry.after)
        .sort((left, right) => left.column - right.column);
    if (changed.length === 0) return undefined;
    return {
        label: column_widths_label(changed.length, auto_fit),
        delta: {
            worksheet,
            slice: 'columnWidths',
            columns: changed.map(({ column, before, after }) => ({ column, before, after })),
            ...(auto_fit === undefined ? {} : { autoFit: auto_fit }),
        },
    };
}

/** The Edit-menu label of a width gesture that changed `count` columns in all. */
export function column_widths_label(count: number, auto_fit?: AutoFitChange): string {
    if (auto_fit === 'on') return 'Auto-fit columns';
    if (auto_fit === 'off') return 'Restore column widths';
    return `Resize ${plural(count, 'column', 'columns')}`;
}

/**
 * The step of a row resize or reset, from what the host says its write
 * changed; undefined when it changed nothing.
 */
export function row_heights_view_step(
    worksheet: WorksheetTarget,
    change: RowHeightsChange,
): ViewStep | undefined {
    const rows = run_row_count(change.before);
    if (rows === 0) return undefined;
    const label = change.height === null
        ? rows === 1 ? 'Reset row height' : `Reset ${rows} row heights`
        : `Resize ${plural(rows, 'row', 'rows')}`;
    return {
        label,
        delta: {
            worksheet,
            slice: 'rowHeights',
            after: change.height,
            before: change.before.map(({ start, end, height }) => ({ start, end, height })),
        },
    };
}

export interface ColumnWidthsReplayTarget {
    /** The widths to ask for: the step's side for each of its columns still in the worksheet. */
    readonly widths: ColumnWidthsSheetRequest['widths'];
    readonly skipped: readonly ViewSkipReason[];
}

/**
 * The widths a width step's replay asks for on its worksheet.
 *
 * Member by member, from the step alone: undo asks for each column's `before`,
 * redo for its `after`; `null` removes the stored width. Columns the step never
 * touched are not named and keep what they have. A column the worksheet no
 * longer has is left out. Whether anything is left to change is the host's to
 * say: this window's widths can be stale.
 */
export function column_widths_replay_target(
    delta: ColumnWidthsViewDelta,
    direction: ViewDirection,
    column_count: number,
): ColumnWidthsReplayTarget {
    const widths: { column: number; width: number | null }[] = [];
    let gone = false;
    for (const entry of delta.columns) {
        if (entry.column >= column_count) {
            gone = true;
            continue;
        }
        widths.push({
            column: entry.column,
            width: direction === 'undo' ? entry.before : entry.after,
        });
    }
    return { widths, skipped: gone ? ['columns-gone'] : [] };
}

/**
 * What a width step's replay leaves of Auto-fit on its worksheet: `'on'` (with
 * the worksheet's widths just before the replay wrote as the widths to
 * restore), or `'off'`.
 *
 * Walking history leaves the toolbar as the gesture left it. Only the two
 * gestures that are the toggle are tracked; every other width write ends
 * Auto-fit, as a drag does.
 */
export function auto_fit_after_width_replay(
    delta: ColumnWidthsViewDelta,
    direction: ViewDirection,
): AutoFitChange {
    if (delta.autoFit === undefined) return 'off';
    const turned_on = delta.autoFit === 'on';
    return (direction === 'redo') === turned_on ? 'on' : 'off';
}

export interface RowHeightsReplayTarget {
    /** The runs to write, clipped to the worksheet. */
    readonly rows: readonly SourceRowHeightRun[];
    readonly skipped: readonly ViewSkipReason[];
}

/**
 * The heights a row-height step's replay asks for.
 *
 * Undo sets each run back to the height it held (`null` removes the custom
 * height); redo sets every row to the step's height. Rows the worksheet no
 * longer has are left out. Rows above or at a promoted Header Row are written
 * like any other: a height is keyed by source row, and a promotion renumbers
 * none.
 */
export function row_heights_replay_target(
    delta: RowHeightsViewDelta,
    direction: ViewDirection,
    source_row_count: number,
): RowHeightsReplayTarget {
    const rows: SourceRowHeightRun[] = [];
    let gone = false;
    for (const run of delta.before) {
        if (run.start >= source_row_count) {
            gone = true;
            continue;
        }
        const end = Math.min(run.end, source_row_count - 1);
        if (end !== run.end) gone = true;
        rows.push({
            start: run.start,
            end,
            height: direction === 'undo' ? run.height : delta.after,
        });
    }
    return { rows, skipped: gone ? ['rows-gone'] : [] };
}

// ---- The Header Row ----

/**
 * The header change of one worksheet as a step's change, from what the host
 * says its write changed; undefined when it changed nothing.
 */
export function header_view_delta(
    worksheet: WorksheetTarget,
    change: ExcelHeaderChange,
): HeaderViewDelta | undefined {
    const hidden = sorted_unique(change.hidden);
    const shown = sorted_unique(change.shown);
    const rows_changed = hidden.length > 0 || shown.length > 0;
    if (
        change.before.mode === change.after.mode
        && change.before.row === change.after.row
        && !rows_changed
    ) return undefined;
    const side = (from: ExcelHeaderSide): ExcelHeaderSide => (
        from.row === undefined ? { mode: from.mode } : { mode: from.mode, row: from.row }
    );
    return {
        worksheet,
        slice: 'header',
        before: side(change.before),
        after: side(change.after),
        ...(rows_changed ? { hiddenRows: { hidden, shown } } : {}),
    };
}

/**
 * The Edit-menu label of a header step, from its changes, one per worksheet.
 *
 * The two all-sheets labels are the menu items' own words. "Unhide rows" is
 * the label the same button records when no header is in the way.
 *
 * The label follows what changed, not which control was used: an all-sheets
 * item that found every worksheet but one already there records one change,
 * and reads as that worksheet's own step.
 */
export function header_step_label(deltas: readonly HeaderViewDelta[]): string {
    if (deltas.length === 1) {
        const [delta] = deltas;
        if (delta!.after.row !== undefined) return `Use row ${delta!.after.row + 1} as header`;
        return (delta!.hiddenRows?.shown.length ?? 0) > 0 ? 'Unhide rows' : 'Turn off header row';
    }
    if (deltas.length > 1 && deltas.every((delta) => delta.after.row !== undefined)) {
        return 'Use first row as header on all sheets';
    }
    if (deltas.length > 1 && deltas.every((delta) => delta.after.row === undefined)) {
        return 'Show first row as data on all sheets';
    }
    return 'Change header row';
}

/** What replay needs to know about a worksheet as this window holds it now. */
export interface HeaderReplaySheet {
    /** Source rows. */
    readonly sourceRowCount: number;
    /** The hidden rows this window holds for the worksheet. They can be stale. */
    readonly hiddenRows: readonly number[];
}

export interface HeaderReplayTarget {
    /** What to ask the host for; absent when the whole worksheet is skipped. */
    readonly target?: ExcelHeaderTarget;
    readonly skipped: readonly ViewSkipReason[];
}

/**
 * The header state a header step's replay asks for on one worksheet.
 *
 * Member by member, from the step alone, and never compared with what the
 * window shows: the side wanted is the step's other side, whole; the rows it
 * hid are shown and the rows it showed are hidden. Whether anything is left
 * to change is the host's to say, because this window's hidden rows can be
 * stale. A row goes with an explicit header only: an automatic side restores
 * the detector's choice, and an explicit side with no row ("on, with every row
 * hidden") is asked for as `null`.
 *
 * Skipped, so that a refusal by the host cannot park the entry over something
 * this window can see:
 *  - rows to hide that the worksheet no longer has are left out;
 *  - the row the step used as the Header Row is no longer in the worksheet;
 *  - more rows would be hidden than can be stored;
 *  - "on, with no row" on a worksheet that would be left with a row showing.
 * The last two are predicted from the hidden rows this window holds. If those
 * were stale and the host refuses after all, the entry stays with the host's
 * reason, the host refreshes this window, and the next press predicts from
 * what is there.
 */
export function header_replay_target(
    delta: HeaderViewDelta,
    direction: ViewDirection,
    sheet: HeaderReplaySheet,
): HeaderReplayTarget {
    const wanted = direction === 'undo' ? delta.before : delta.after;
    const { hide, show } = replay_members(
        delta.hiddenRows ?? { hidden: [], shown: [] },
        direction,
    );
    if (wanted.mode === 'on' && wanted.row !== undefined && wanted.row >= sheet.sourceRowCount) {
        return { skipped: ['header-row-gone'] };
    }
    const skipped = new Set<ViewSkipReason>();
    const hide_rows = hide.filter((row) => row < sheet.sourceRowCount);
    if (hide_rows.length !== hide.length) skipped.add('rows-gone');
    const header_source_row = wanted.mode === 'on' ? wanted.row ?? null : undefined;
    const left = hidden_rows_after_header_change(sheet.hiddenRows, {
        hide: hide_rows,
        show,
        sourceRowCount: sheet.sourceRowCount,
        ...(typeof header_source_row === 'number' ? { headerSourceRow: header_source_row } : {}),
        limit: MAX_PERSISTED_HIDDEN_ROWS,
    });
    if (left === undefined) {
        return { skipped: ordered_skips(skipped.add('too-many-hidden')) };
    }
    if (
        header_source_row === null
        && first_non_hidden_source_row(sheet.sourceRowCount, left) !== undefined
    ) {
        return { skipped: ordered_skips(skipped.add('header-unavailable')) };
    }
    return {
        target: {
            mode: wanted.mode,
            ...(header_source_row === undefined ? {} : { headerSourceRow: header_source_row }),
            hideRows: hide_rows,
            showRows: [...show],
        },
        skipped: ordered_skips(skipped),
    };
}
