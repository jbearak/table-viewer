/**
 * View steps: a sort, a filter, hidden rows, or hidden columns as one undoable
 * gesture.
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
 */

import {
    MAX_PERSISTED_HIDDEN_ROWS,
    type FilterEntry,
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

export type ViewHistoryDelta = TransformViewDelta | ColumnsViewDelta;

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
    | 'too-many-hidden';

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
];

function ordered_skips(found: ReadonlySet<ViewSkipReason>): ViewSkipReason[] {
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
 *    truncates at the second).
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
