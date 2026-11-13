// Worksheet Layout (ADR 0004): the prospective order of a worksheet's body
// rows and of its columns, by identity, with removed rows and columns kept in
// place as tombstones for the rest of the edit session.
//
// This module is the one definition of where an identity lands. The webview
// store, the row and column projections, the durable and wire codecs, formula
// rendering, and both save planners all read layouts through it, so it is a
// pure leaf: no imports from the webview or the host.
//
// Coordinates, used consistently below:
//   - A **source row** is a canonical source row, the same number as
//     `RowIdentity.sourceRow` and the row half of a source cell key. A row
//     layout covers the body `[bodyStart, bodyStart + bodyRowCount)` only;
//     `bodyStart` is the 1-based number of the Header Row (0 without one).
//   - A **source column** is a 0-based source column.
//   - A **position** is a 0-based index into the full order, tombstones
//     included.
//   - A **body index** is a live entry's prospective 1-based number within the
//     body (or within the columns): the k-th live entry has body index k. The
//     save maps say "0-based body index" explicitly where they use one.
//   - A **display index** is a 0-based index into the displayed order, which
//     keeps Pending Row Removals and Pending Column Removals in place and skips
//     discarded Pending Rows and Pending Columns.
//
// Rows and columns share one axis core. A row layout is already a list of runs;
// a column layout is read as runs of consecutive source columns and single
// Pending Columns, so every operation, lookup, and map is written once.
import type { PendingRowId, RowIdentity } from './pending-changes';
import { MAX_SHEET_COLUMNS } from './spreadsheet-safety';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Opaque, host-minted, worksheet-scoped identity of a Pending Column. */
export type PendingColumnId = string;

export type ColumnIdentity =
    | { readonly kind: 'source'; readonly sourceColumn: number }
    | { readonly kind: 'pending'; readonly pendingColumnId: PendingColumnId };

/** A stretch of source rows or columns: `[start, start + count)`. */
export interface SourceInterval {
    readonly start: number;
    readonly count: number;
}

/** Body rows, live or tombstoned, in prospective order, compressed into runs. */
export type RowLayoutRun =
    | { readonly kind: 'source'; readonly start: number; readonly count: number }
    | { readonly kind: 'pending'; readonly ids: readonly PendingRowId[] };

export interface DiscardedPendingRow {
    readonly id: PendingRowId;
    readonly createdOrder: number;
}

export interface RowLayout {
    readonly runs: readonly RowLayoutRun[];
    /** Pending Row Removals: source body rows, as sorted disjoint intervals. */
    readonly removedSourceRows: readonly SourceInterval[];
    /** Discarded Pending Inserted Rows, kept for formula rendering and never displayed. */
    readonly discardedPendingRows: readonly DiscardedPendingRow[];
}

export interface DiscardedPendingColumn {
    readonly id: PendingColumnId;
    readonly createdOrder: number;
}

export interface ColumnLayout {
    /** Every column, live or tombstoned, in prospective order. */
    readonly columns: readonly ColumnIdentity[];
    /** Pending Column Removals, ascending. */
    readonly removedSourceColumns: readonly number[];
    readonly discardedPendingColumns: readonly DiscardedPendingColumn[];
}

export const MAX_ROW_LAYOUT_RUNS = 10_000;
export const MAX_REMOVED_ROW_INTERVALS = 100_000;
export const MAX_COLUMN_LAYOUT_ENTRIES = 512;
/** Limits: at most 256 discarded Pending Column tombstones per worksheet. */
export const MAX_DISCARDED_PENDING_COLUMNS = MAX_SHEET_COLUMNS;

export const TOO_MANY_ROW_RUNS_MESSAGE =
    "Can't insert or move rows here without saving first: this sheet has too many separate row changes.";
export const TOO_MANY_ROW_REMOVALS_MESSAGE =
    "Can't delete this many separate groups of rows at once. Save first, or delete fewer.";
export const TOO_MANY_RESTORED_ROW_GROUPS_MESSAGE =
    "Can't restore these rows without saving first: this sheet has too many separate groups of deleted rows.";
export const TOO_MANY_LIVE_COLUMNS_MESSAGE =
    `Can't add columns here: a sheet can have at most ${MAX_SHEET_COLUMNS} columns.`;
export const TOO_MANY_COLUMN_ENTRIES_MESSAGE =
    "Can't insert columns here without saving first: this sheet has too many column changes.";
export const TOO_WIDE_TO_RESTRUCTURE_MESSAGE =
    'This file has more columns than Table Viewer can restructure.';

export type EntryStatus = 'live' | 'removed' | 'discarded';

/**
 * One piece of the **live segments** partition: a maximal stretch of one
 * source run with one removal status, or a single Pending Row or Pending
 * Column (live or discarded). Segments are in full order and cover it exactly.
 * The CF/DV split counter and the writer cut rules at these boundaries.
 */
export type LayoutSegment =
    | (SegmentPlacement & {
        readonly kind: 'source';
        readonly start: number;
        readonly count: number;
        readonly status: 'live' | 'removed';
    })
    | (SegmentPlacement & {
        readonly kind: 'pending';
        readonly id: string;
        readonly count: 1;
        readonly status: 'live' | 'discarded';
    });

export interface SegmentPlacement {
    /** Index of the run this segment lies in (row runs, or column runs as read by this module). */
    readonly run: number;
    /** Full-order position of the segment's first entry. */
    readonly position: number;
    /** Live entries before the segment: its first entry's 0-based body index when live. */
    readonly liveBefore: number;
    /** Displayed entries before the segment: its first entry's display index when displayed. */
    readonly displayBefore: number;
}

/**
 * Everything rendering, projection, and moved detection ask of one axis,
 * answered in `O(log S)` for `S` segments (runs + removal intervals + pending
 * entries, all bounded by the layout limits). Build it once per layout.
 */
export interface AxisLayoutIndex<I> {
    readonly segments: readonly LayoutSegment[];
    /** N: live entries. */
    readonly liveCount: number;
    /** Entries in full order, tombstones included. */
    readonly entryCount: number;
    /** Displayed entries: everything except discarded Pending Rows or Columns. */
    readonly displayCount: number;
    /** A live Pending Inserted Row or live Pending Column exists. */
    readonly hasLiveInserted: boolean;
    /** A discarded Pending Row or Pending Column tombstone exists. */
    readonly hasDiscarded: boolean;
    /** Some source run is out of ascending source order (removed rows count). */
    readonly hasOutOfOrderRun: boolean;
    /** `hasLiveInserted || hasOutOfOrderRun`. */
    readonly hasInsertOrOutOfOrderRun: boolean;
    status_of(identity: I): EntryStatus | undefined;
    is_live(identity: I): boolean;
    /** 0-based full-order position, tombstones included; undefined for an unknown identity. */
    position_of(identity: I): number | undefined;
    identity_at_position(position: number): I | undefined;
    /** Prospective 1-based body index of a live entry; undefined for tombstones. */
    body_index_of(identity: I): number | undefined;
    /** Live entry with the given 1-based body index, in `1..liveCount`. */
    identity_at_body_index(body_index: number): I | undefined;
    /** Live entries at positions `< position`. */
    live_count_before(position: number): number;
    /** First live entry at a position in `[first, last]`, inclusive. */
    first_live_between(first: number, last: number): I | undefined;
    /** Last live entry at a position in `[first, last]`, inclusive. */
    last_live_between(first: number, last: number): I | undefined;
    /** 0-based display index; undefined for discarded or unknown identities. */
    display_index_of(identity: I): number | undefined;
    identity_at_display_index(display_index: number): I | undefined;
    /** Displayed identities in order: removed source entries in place, discarded ones skipped. */
    display_identities(): IterableIterator<I>;
    /**
     * Whether a source identity lies in a source run that is out of ascending
     * source order with the nearest source run on either side, skipping
     * pending runs. Always false for pending identities.
     */
    in_displaced_source_run(identity: I): boolean;
}

export type RowLayoutIndex = AxisLayoutIndex<RowIdentity>;
export type ColumnLayoutIndex = AxisLayoutIndex<ColumnIdentity>;

export type LayoutValidationReason =
    | 'malformed'
    | 'source-coverage'
    | 'non-canonical'
    | 'pending-membership'
    | 'discarded-tombstone'
    | 'created-order'
    | 'removed-entries'
    | 'too-many-runs'
    | 'too-many-removals'
    | 'too-many-column-entries'
    | 'too-many-live-columns'
    | 'too-many-discarded-columns'
    | 'too-wide-to-restructure';

export interface LayoutValidationError {
    readonly reason: LayoutValidationReason;
    readonly message: string;
}

export type LayoutRefusalReason =
    | 'unknown-identity'
    | 'no-live-entry'
    | 'invalid-pending-id'
    | 'invalid-created-order'
    | 'not-removed'
    | 'too-many-runs'
    | 'too-many-removals'
    | 'too-many-column-entries'
    | 'too-many-live-columns'
    | 'too-wide-to-restructure';

export interface LayoutRefusal {
    readonly reason: LayoutRefusalReason;
    readonly message: string;
}

export type LayoutResult<L> =
    | { readonly ok: true; readonly layout: L }
    | { readonly ok: false; readonly refusal: LayoutRefusal };

/** What the row validator needs besides the layout. */
export interface RowLayoutContext {
    /** First body source row: the Header Row's 1-based number, or 0 without one. */
    readonly bodyStart: number;
    readonly bodyRowCount: number;
    /**
     * Every live Pending Row of the worksheet (`appendedRows`), both origins.
     * Absent `origin` means `append`.
     */
    readonly pendingRows: readonly {
        readonly id: PendingRowId;
        readonly origin?: 'append' | 'insert';
        readonly createdOrder: number;
    }[];
    /** Whether the session's admission ledger minted `id` for an insert. */
    readonly mintedAsInsert: (id: PendingRowId) => boolean;
}

/** What the column validator needs besides the layout. */
export interface ColumnLayoutContext {
    readonly sourceColumnCount: number;
    /** Every live Pending Column of the worksheet. */
    readonly pendingColumns: readonly {
        readonly id: PendingColumnId;
        readonly createdOrder: number;
    }[];
}

/**
 * Save-time row map. Old rows are canonical source rows; new positions are
 * **0-based body indexes** (the first live body row is 0). The receipt adds the
 * Header Row offset: new canonical row = `bodyStart + bodyIndex`.
 */
export interface RowSaveMap {
    /**
     * Complete map of live source rows, ascending by `sourceRow`: each entry
     * moves `count` consecutive source rows to `count` consecutive body
     * indexes. Unmoved rows, shifted or not, are included.
     */
    readonly rowRuns: readonly {
        readonly sourceRow: number;
        readonly count: number;
        readonly bodyIndex: number;
    }[];
    /** Pending Row Removals, as in the layout. */
    readonly removedRows: readonly SourceInterval[];
    /** Live Pending Inserted Rows, in layout order. */
    readonly insertedRows: readonly { readonly pendingRowId: PendingRowId; readonly bodyIndex: number }[];
}

/** Save-time column map. New positions are 0-based column indexes. */
export interface ColumnSaveMap {
    /** Index = old source column; value = new 0-based column, or null when removed. */
    readonly columnMap: readonly (number | null)[];
    /** Live Pending Columns, in layout order. */
    readonly insertedColumns: readonly { readonly pendingColumnId: PendingColumnId; readonly column: number }[];
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/** `s:<sourceRow>` or `p:<pendingRowId>`: the key Pending Column cells use. */
export function row_identity_key(identity: RowIdentity): string {
    return identity.kind === 'source' ? `s:${identity.sourceRow}` : `p:${identity.pendingRowId}`;
}

/** `f:<row>`: the Pending Column cell key for a fixed row at or above the Header Row. */
export function fixed_row_identity_key(row: number): string {
    return `f:${row}`;
}

/** `s:<sourceColumn>` or `p:<pendingColumnId>`: the Glide column id in layout mode. */
export function column_identity_key(identity: ColumnIdentity): string {
    return identity.kind === 'source' ? `s:${identity.sourceColumn}` : `p:${identity.pendingColumnId}`;
}

export function row_identities_equal(left: RowIdentity, right: RowIdentity): boolean {
    return left.kind === 'source'
        ? right.kind === 'source' && left.sourceRow === right.sourceRow
        : right.kind === 'pending' && left.pendingRowId === right.pendingRowId;
}

export function column_identities_equal(left: ColumnIdentity, right: ColumnIdentity): boolean {
    return left.kind === 'source'
        ? right.kind === 'source' && left.sourceColumn === right.sourceColumn
        : right.kind === 'pending' && left.pendingColumnId === right.pendingColumnId;
}

/**
 * 0-based canonical row of the `ordinal`-th (0-based) live Pending Appended
 * Row: the band follows the live layout, so it is `H + N + i` 1-based.
 */
export function appended_row_source_row(body_start: number, live_count: number, ordinal: number): number {
    return body_start + live_count + ordinal;
}

// ---------------------------------------------------------------------------
// Axis core
// ---------------------------------------------------------------------------

type AxisEntry =
    | { readonly kind: 'source'; readonly source: number }
    | { readonly kind: 'pending'; readonly id: string };

type AxisRun =
    | { readonly kind: 'source'; readonly start: number; readonly count: number }
    | { readonly kind: 'pending'; readonly ids: readonly string[] };

interface AxisModel {
    readonly runs: readonly AxisRun[];
    /** Sorted, disjoint, non-adjacent. */
    readonly removed: readonly SourceInterval[];
    readonly discarded: ReadonlySet<string>;
}

interface IdentityCodec<I> {
    read(identity: I): AxisEntry;
    source(source: number): I;
    pending(id: string): I;
}

const ROW_CODEC: IdentityCodec<RowIdentity> = {
    read: (identity) => identity.kind === 'source'
        ? { kind: 'source', source: identity.sourceRow }
        : { kind: 'pending', id: identity.pendingRowId },
    source: (source) => Object.freeze({ kind: 'source', sourceRow: source }),
    pending: (id) => Object.freeze({ kind: 'pending', pendingRowId: id }),
};

const COLUMN_CODEC: IdentityCodec<ColumnIdentity> = {
    read: (identity) => identity.kind === 'source'
        ? { kind: 'source', source: identity.sourceColumn }
        : { kind: 'pending', id: identity.pendingColumnId },
    source: (source) => Object.freeze({ kind: 'source', sourceColumn: source }),
    pending: (id) => Object.freeze({ kind: 'pending', pendingColumnId: id }),
};

function interval(start: number, count: number): SourceInterval {
    return Object.freeze({ start, count });
}

/** Smallest index whose interval ends after `value`, or `intervals.length`. */
function first_interval_ending_after(intervals: readonly SourceInterval[], value: number): number {
    let low = 0;
    let high = intervals.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        const entry = intervals[middle]!;
        if (entry.start + entry.count > value) high = middle;
        else low = middle + 1;
    }
    return low;
}

function interval_contains(intervals: readonly SourceInterval[], value: number): boolean {
    const index = first_interval_ending_after(intervals, value);
    const entry = intervals[index];
    return entry !== undefined && entry.start <= value;
}

/** Largest index `i` with `key(items[i]) <= value`, or -1. */
function last_at_or_below<T>(items: readonly T[], value: number, key: (item: T) => number): number {
    let low = 0;
    let high = items.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (key(items[middle]!) <= value) low = middle + 1;
        else high = middle;
    }
    return low - 1;
}

/** Sorted unique values as maximal intervals of consecutive values. */
function intervals_of_sorted(values: readonly number[]): SourceInterval[] {
    const out: SourceInterval[] = [];
    let start = -1;
    let count = 0;
    for (const value of values) {
        if (count > 0 && value === start + count) {
            count++;
            continue;
        }
        if (count > 0) out.push(interval(start, count));
        start = value;
        count = 1;
    }
    if (count > 0) out.push(interval(start, count));
    return out;
}

function sorted_unique(values: Iterable<number>): number[] {
    return [...new Set(values)].sort((left, right) => left - right);
}

/** Sort, drop empty intervals, and merge overlapping or adjacent ones. */
function canonical_intervals(intervals: readonly SourceInterval[]): SourceInterval[] {
    const sorted = intervals
        .filter((entry) => entry.count > 0)
        .slice()
        .sort((left, right) => left.start - right.start);
    const out: SourceInterval[] = [];
    for (const entry of sorted) {
        const last = out[out.length - 1];
        if (last !== undefined && entry.start <= last.start + last.count) {
            const end = Math.max(last.start + last.count, entry.start + entry.count);
            out[out.length - 1] = interval(last.start, end - last.start);
        } else {
            out.push(interval(entry.start, entry.count));
        }
    }
    return out;
}

/** `intervals` minus the sorted unique `values`. */
function subtract_values(intervals: readonly SourceInterval[], values: readonly number[]): SourceInterval[] {
    const out: SourceInterval[] = [];
    let cursor = 0;
    for (const entry of intervals) {
        let start = entry.start;
        const end = entry.start + entry.count;
        while (cursor < values.length && values[cursor]! < entry.start) cursor++;
        while (cursor < values.length && values[cursor]! < end) {
            const value = values[cursor]!;
            if (value > start) out.push(interval(start, value - start));
            start = value + 1;
            cursor++;
        }
        if (end > start) out.push(interval(start, end - start));
    }
    return out;
}

/** Merge adjacent source runs that continue each other and adjacent pending runs; drop empty runs. */
function canonical_runs(runs: readonly AxisRun[]): AxisRun[] {
    const out: AxisRun[] = [];
    let pending: string[] | undefined;
    for (const run of runs) {
        if (run.kind === 'pending') {
            if (run.ids.length === 0) continue;
            if (pending !== undefined) {
                pending.push(...run.ids);
                continue;
            }
            pending = [...run.ids];
            out.push({ kind: 'pending', ids: pending });
            continue;
        }
        if (run.count <= 0) continue;
        pending = undefined;
        const last = out[out.length - 1];
        if (last?.kind === 'source' && last.start + last.count === run.start) {
            out[out.length - 1] = { kind: 'source', start: last.start, count: last.count + run.count };
        } else {
            out.push({ kind: 'source', start: run.start, count: run.count });
        }
    }
    return out.map((run) => run.kind === 'source'
        ? Object.freeze({ kind: 'source', start: run.start, count: run.count })
        : Object.freeze({ kind: 'pending', ids: Object.freeze([...run.ids]) }));
}

function build_segments(model: AxisModel): LayoutSegment[] {
    const segments: LayoutSegment[] = [];
    let position = 0;
    let live = 0;
    let display = 0;
    const push = (segment: LayoutSegment): void => {
        segments.push(Object.freeze(segment));
        position += segment.count;
        if (segment.status === 'live') live += segment.count;
        if (segment.status !== 'discarded') display += segment.count;
    };
    model.runs.forEach((run, run_index) => {
        if (run.kind === 'pending') {
            for (const id of run.ids) {
                push({
                    kind: 'pending',
                    id,
                    count: 1,
                    status: model.discarded.has(id) ? 'discarded' : 'live',
                    run: run_index,
                    position,
                    liveBefore: live,
                    displayBefore: display,
                });
            }
            return;
        }
        const end = run.start + run.count;
        let cursor = run.start;
        let removal = first_interval_ending_after(model.removed, cursor);
        while (cursor < end) {
            const next = model.removed[removal];
            const inside = next !== undefined && next.start <= cursor;
            const stop = inside
                ? Math.min(end, next.start + next.count)
                : Math.min(end, next === undefined ? end : next.start);
            push({
                kind: 'source',
                start: cursor,
                count: stop - cursor,
                status: inside ? 'removed' : 'live',
                run: run_index,
                position,
                liveBefore: live,
                displayBefore: display,
            });
            if (inside && stop === next.start + next.count) removal++;
            cursor = stop;
        }
    });
    return segments;
}

/** Per run: out of ascending order with the nearest source run on either side. */
function displaced_runs(runs: readonly AxisRun[]): boolean[] {
    const displaced = runs.map(() => false);
    let previous: { start: number; index: number } | undefined;
    runs.forEach((run, index) => {
        if (run.kind !== 'source') return;
        if (previous !== undefined && previous.start > run.start) {
            displaced[index] = true;
            displaced[previous.index] = true;
        }
        previous = { start: run.start, index };
    });
    return displaced;
}

interface AxisIndexInternals {
    readonly model: AxisModel;
    readonly segments: readonly LayoutSegment[];
    segment_index_of(entry: AxisEntry): number | undefined;
}

function create_axis_index<I>(model: AxisModel, codec: IdentityCodec<I>): AxisLayoutIndex<I> & AxisIndexInternals {
    const segments = build_segments(model);
    const last = segments[segments.length - 1];
    const entry_count = last === undefined ? 0 : last.position + last.count;
    const live_count = last === undefined ? 0 : last.liveBefore + (last.status === 'live' ? last.count : 0);
    const display_count = last === undefined ? 0 : last.displayBefore + (last.status === 'discarded' ? 0 : last.count);
    const source_order: number[] = [];
    const live_order: number[] = [];
    const display_order: number[] = [];
    const pending_index = new Map<string, number>();
    let has_live_inserted = false;
    let has_discarded = false;
    segments.forEach((segment, index) => {
        if (segment.kind === 'source') source_order.push(index);
        else {
            pending_index.set(segment.id, index);
            if (segment.status === 'live') has_live_inserted = true;
            else has_discarded = true;
        }
        if (segment.status === 'live') live_order.push(index);
        if (segment.status !== 'discarded') display_order.push(index);
    });
    source_order.sort((left, right) => (segments[left] as { start: number }).start
        - (segments[right] as { start: number }).start);
    const displaced = displaced_runs(model.runs);
    const has_out_of_order = displaced.some(Boolean);

    const segment_index_of = (entry: AxisEntry): number | undefined => {
        if (entry.kind === 'pending') return pending_index.get(entry.id);
        if (!Number.isSafeInteger(entry.source)) return undefined;
        const found = last_at_or_below(source_order, entry.source,
            (index) => (segments[index] as { start: number }).start);
        if (found < 0) return undefined;
        const index = source_order[found]!;
        const segment = segments[index]!;
        return segment.kind === 'source' && entry.source < segment.start + segment.count ? index : undefined;
    };
    const offset_in = (segment: LayoutSegment, entry: AxisEntry): number =>
        segment.kind === 'source' && entry.kind === 'source' ? entry.source - segment.start : 0;
    const identity_in = (segment: LayoutSegment, offset: number): I =>
        segment.kind === 'source' ? codec.source(segment.start + offset) : codec.pending(segment.id);
    const locate = (identity: I): { segment: LayoutSegment; offset: number } | undefined => {
        const entry = codec.read(identity);
        const index = segment_index_of(entry);
        if (index === undefined) return undefined;
        const segment = segments[index]!;
        return { segment, offset: offset_in(segment, entry) };
    };
    const find_in = (
        order: readonly number[],
        value: number,
        key: (segment: LayoutSegment) => number,
    ): { segment: LayoutSegment; offset: number } | undefined => {
        if (!Number.isSafeInteger(value) || value < 0) return undefined;
        const found = last_at_or_below(order, value, (index) => key(segments[index]!));
        if (found < 0) return undefined;
        const segment = segments[order[found]!]!;
        const offset = value - key(segment);
        return offset < segment.count ? { segment, offset } : undefined;
    };
    const all_order = segments.map((_, index) => index);
    const live_at = (rank: number): { segment: LayoutSegment; offset: number } | undefined =>
        find_in(live_order, rank, (segment) => segment.liveBefore);
    const live_count_before = (position: number): number => {
        if (position <= 0) return 0;
        if (position >= entry_count) return live_count;
        const found = find_in(all_order, position, (segment) => segment.position)!;
        return found.segment.liveBefore + (found.segment.status === 'live' ? found.offset : 0);
    };

    return Object.freeze({
        model,
        segments: Object.freeze(segments),
        segment_index_of,
        liveCount: live_count,
        entryCount: entry_count,
        displayCount: display_count,
        hasLiveInserted: has_live_inserted,
        hasDiscarded: has_discarded,
        hasOutOfOrderRun: has_out_of_order,
        hasInsertOrOutOfOrderRun: has_live_inserted || has_out_of_order,
        status_of(identity: I) {
            return locate(identity)?.segment.status;
        },
        is_live(identity: I) {
            return locate(identity)?.segment.status === 'live';
        },
        position_of(identity: I) {
            const found = locate(identity);
            return found === undefined ? undefined : found.segment.position + found.offset;
        },
        identity_at_position(position: number) {
            const found = find_in(all_order, position, (segment) => segment.position);
            return found === undefined ? undefined : identity_in(found.segment, found.offset);
        },
        body_index_of(identity: I) {
            const found = locate(identity);
            return found === undefined || found.segment.status !== 'live'
                ? undefined
                : found.segment.liveBefore + found.offset + 1;
        },
        identity_at_body_index(body_index: number) {
            const found = live_at(body_index - 1);
            return found === undefined ? undefined : identity_in(found.segment, found.offset);
        },
        live_count_before,
        first_live_between(first: number, last_position: number) {
            const rank = live_count_before(Math.max(0, first));
            const found = live_at(rank);
            if (found === undefined) return undefined;
            return found.segment.position + found.offset <= last_position
                ? identity_in(found.segment, found.offset)
                : undefined;
        },
        last_live_between(first: number, last_position: number) {
            const rank = live_count_before(Math.min(entry_count, last_position + 1)) - 1;
            const found = live_at(rank);
            if (found === undefined) return undefined;
            return found.segment.position + found.offset >= first
                ? identity_in(found.segment, found.offset)
                : undefined;
        },
        display_index_of(identity: I) {
            const found = locate(identity);
            return found === undefined || found.segment.status === 'discarded'
                ? undefined
                : found.segment.displayBefore + found.offset;
        },
        identity_at_display_index(display_index: number) {
            const found = find_in(display_order, display_index, (segment) => segment.displayBefore);
            return found === undefined ? undefined : identity_in(found.segment, found.offset);
        },
        *display_identities() {
            for (const index of display_order) {
                const segment = segments[index]!;
                for (let offset = 0; offset < segment.count; offset++) yield identity_in(segment, offset);
            }
        },
        in_displaced_source_run(identity: I) {
            const found = locate(identity);
            return found !== undefined && found.segment.kind === 'source' && displaced[found.segment.run] === true;
        },
    });
}

// ---------------------------------------------------------------------------
// Operations on the axis core
// ---------------------------------------------------------------------------

type Item =
    | { readonly kind: 'source'; readonly start: number; readonly count: number; readonly live: boolean }
    | { readonly kind: 'pending'; readonly id: string; readonly live: boolean };

function item_of(segment: LayoutSegment): Item {
    return segment.kind === 'source'
        ? { kind: 'source', start: segment.start, count: segment.count, live: segment.status === 'live' }
        : { kind: 'pending', id: segment.id, live: segment.status === 'live' };
}

function runs_of_items(items: readonly Item[]): AxisRun[] {
    return canonical_runs(items.map((item) => item.kind === 'source'
        ? { kind: 'source', start: item.start, count: item.count }
        : { kind: 'pending', ids: [item.id] }));
}

function refuse(reason: LayoutRefusalReason, message: string): { ok: false; refusal: LayoutRefusal } {
    return { ok: false, refusal: Object.freeze({ reason, message }) };
}

type ItemsResult = { ok: true; items: Item[] } | { ok: false; refusal: LayoutRefusal };

function unknown_identity(axis: AxisName): { ok: false; refusal: LayoutRefusal } {
    return refuse('unknown-identity', `That ${axis} is not part of this sheet's layout.`);
}

function no_live_entry(axis: AxisName): { ok: false; refusal: LayoutRefusal } {
    return refuse('no-live-entry', `Select at least one ${axis} that isn't deleted.`);
}

type AxisName = 'row' | 'column';

function validate_new_ids(
    index: AxisIndexInternals,
    ids: readonly string[],
    axis: AxisName,
): { ok: false; refusal: LayoutRefusal } | undefined {
    const seen = new Set<string>();
    for (const id of ids) {
        if (typeof id !== 'string' || id.length === 0 || seen.has(id)
            || index.segment_index_of({ kind: 'pending', id }) !== undefined) {
            return refuse('invalid-pending-id', `Each new ${axis} needs a new, unique id.`);
        }
        seen.add(id);
    }
    return ids.length === 0 ? refuse('invalid-pending-id', `Insert at least one ${axis}.`) : undefined;
}

/**
 * Insert `ids` as live pending entries beside the live `anchor`. Before: right
 * before the anchor, so after the tombstones glued to the entry before it.
 * After: after the anchor's own glued tombstones.
 */
function insert_items(
    index: AxisIndexInternals,
    anchor: AxisEntry,
    side: 'before' | 'after',
    ids: readonly string[],
    axis: AxisName,
): ItemsResult {
    const anchor_index = index.segment_index_of(anchor);
    if (anchor_index === undefined) return unknown_identity(axis);
    const segment = index.segments[anchor_index]!;
    if (segment.status !== 'live') return no_live_entry(axis);
    const invalid = validate_new_ids(index, ids, axis);
    if (invalid !== undefined) return invalid;
    const items = index.segments.map(item_of);
    let at: number;
    if (segment.kind === 'source' && anchor.kind === 'source') {
        const cut = anchor.source - segment.start + (side === 'after' ? 1 : 0);
        const pieces: Item[] = [];
        if (cut > 0) pieces.push({ kind: 'source', start: segment.start, count: cut, live: true });
        if (cut < segment.count) {
            pieces.push({ kind: 'source', start: segment.start + cut, count: segment.count - cut, live: true });
        }
        items.splice(anchor_index, 1, ...pieces);
        at = anchor_index + (cut > 0 ? 1 : 0);
    } else {
        at = anchor_index + (side === 'after' ? 1 : 0);
    }
    if (side === 'after') while (at < items.length && !items[at]!.live) at++;
    items.splice(at, 0, ...ids.map((id): Item => ({ kind: 'pending', id, live: true })));
    return { ok: true, items };
}

/**
 * Move the live entries of `selection`, each with the tombstones glued to it,
 * in their current order, to just before the first live entry at or after
 * `before` that is not itself moving (or to the end).
 */
function move_items(
    index: AxisIndexInternals,
    selection: readonly AxisEntry[],
    before: AxisEntry | 'end',
    axis: AxisName,
): ItemsResult {
    const selected_sources: number[] = [];
    const selected_pending = new Set<string>();
    for (const entry of selection) {
        const found = index.segment_index_of(entry);
        if (found === undefined) return unknown_identity(axis);
        if (index.segments[found]!.status !== 'live') continue;
        if (entry.kind === 'source') selected_sources.push(entry.source);
        else selected_pending.add(entry.id);
    }
    if (selected_sources.length === 0 && selected_pending.size === 0) return no_live_entry(axis);
    let before_source: number | undefined;
    let before_pending: string | undefined;
    if (before !== 'end') {
        if (index.segment_index_of(before) === undefined) return unknown_identity(axis);
        if (before.kind === 'source') before_source = before.source;
        else before_pending = before.id;
    }
    const selected = intervals_of_sorted(sorted_unique(selected_sources));

    // Split live source segments so each item is wholly selected or not and
    // `before` starts an item; mark every item moved or staying.
    type MovingItem = Item & { moved: boolean; before: boolean };
    const items: MovingItem[] = [];
    let last_live_moved = false;
    for (const segment of index.segments) {
        if (segment.kind === 'pending') {
            const live = segment.status === 'live';
            const moved: boolean = live ? selected_pending.has(segment.id) : last_live_moved;
            if (live) last_live_moved = moved;
            items.push({ ...item_of(segment), moved, before: segment.id === before_pending });
            continue;
        }
        const end = segment.start + segment.count;
        const contains_before = before_source !== undefined
            && before_source >= segment.start && before_source < end;
        if (segment.status !== 'live') {
            items.push({ ...item_of(segment), moved: last_live_moved, before: contains_before });
            continue;
        }
        const cuts = new Set<number>([segment.start, end]);
        if (contains_before) cuts.add(before_source!);
        for (let at = first_interval_ending_after(selected, segment.start); at < selected.length; at++) {
            const entry = selected[at]!;
            if (entry.start >= end) break;
            if (entry.start > segment.start) cuts.add(entry.start);
            if (entry.start + entry.count < end) cuts.add(entry.start + entry.count);
        }
        const points = [...cuts].sort((left, right) => left - right);
        for (let at = 0; at + 1 < points.length; at++) {
            const start = points[at]!;
            const moved = interval_contains(selected, start);
            last_live_moved = moved;
            items.push({
                kind: 'source',
                start,
                count: points[at + 1]! - start,
                live: true,
                moved,
                before: start === before_source,
            });
        }
    }
    let target = before === 'end' ? items.length : items.findIndex((item) => item.before);
    while (target < items.length && (!items[target]!.live || items[target]!.moved)) target++;
    const out: Item[] = [];
    const moving = items.filter((item) => item.moved);
    items.forEach((item, at) => {
        if (at === target) out.push(...moving);
        if (!item.moved) out.push(item);
    });
    if (target >= items.length) out.push(...moving);
    return { ok: true, items: out.map((item): Item => item.kind === 'source'
        ? { kind: 'source', start: item.start, count: item.count, live: item.live }
        : { kind: 'pending', id: item.id, live: item.live }) };
}

/**
 * Weighted longest increasing subsequence over source runs, weighted by live
 * count, ties toward earlier runs (the lexicographically smallest run-index
 * sequence among the heaviest). Returns the indexes of runs that kept order.
 * `O(R log R)`.
 */
function order_keeping_runs(runs: readonly AxisRun[], weights: readonly number[]): Set<number> {
    const candidates: { run: number; start: number; weight: number }[] = [];
    runs.forEach((run, index) => {
        if (run.kind === 'source' && weights[index]! > 0) {
            candidates.push({ run: index, start: run.start, weight: weights[index]! });
        }
    });
    const count = candidates.length;
    // Rank by descending start, so "starts after mine" is a prefix in a Fenwick tree.
    const by_start = candidates.map((_, order) => order)
        .sort((left, right) => candidates[right]!.start - candidates[left]!.start);
    const rank = new Array<number>(count);
    by_start.forEach((order, position) => {
        rank[order] = position + 1;
    });
    const tree_value = new Array<number>(count + 1).fill(-1);
    const tree_order = new Array<number>(count + 1).fill(-1);
    const better = (value: number, order: number, than_value: number, than_order: number): boolean =>
        value > than_value || (value === than_value && than_value >= 0 && order < than_order);
    const best = new Array<number>(count);
    const next = new Array<number>(count);
    for (let order = count - 1; order >= 0; order--) {
        // Query ranks 1..rank-1: runs with a larger start, all later in layout order.
        let found_value = -1;
        let found_order = -1;
        for (let at = rank[order]! - 1; at > 0; at -= at & -at) {
            if (better(tree_value[at]!, tree_order[at]!, found_value, found_order)) {
                found_value = tree_value[at]!;
                found_order = tree_order[at]!;
            }
        }
        best[order] = candidates[order]!.weight + Math.max(0, found_value);
        next[order] = found_order;
        for (let at = rank[order]!; at <= count; at += at & -at) {
            if (better(best[order]!, order, tree_value[at]!, tree_order[at]!)) {
                tree_value[at] = best[order]!;
                tree_order[at] = order;
            }
        }
    }
    let head = -1;
    for (let order = 0; order < count; order++) {
        if (head < 0 || best[order]! > best[head]!) head = order;
    }
    const kept = new Set<number>();
    for (let order = head; order >= 0; order = next[order]!) kept.add(candidates[order]!.run);
    return kept;
}

function moved_sources(index: AxisIndexInternals): SourceInterval[] {
    const weights = index.model.runs.map(() => 0);
    for (const segment of index.segments) {
        if (segment.status === 'live') weights[segment.run] += segment.count;
    }
    const kept = order_keeping_runs(index.model.runs, weights);
    const moved = index.segments
        .filter((segment): segment is Extract<LayoutSegment, { kind: 'source' }> =>
            segment.kind === 'source' && segment.status === 'live' && !kept.has(segment.run))
        .map((segment) => interval(segment.start, segment.count));
    return canonical_intervals(moved);
}

function live_source_mapping(index: AxisIndexInternals): { source: number; count: number; to: number }[] {
    const pieces = index.segments
        .filter((segment): segment is Extract<LayoutSegment, { kind: 'source' }> =>
            segment.kind === 'source' && segment.status === 'live')
        .map((segment) => ({ source: segment.start, count: segment.count, to: segment.liveBefore }))
        .sort((left, right) => left.source - right.source);
    const out: { source: number; count: number; to: number }[] = [];
    for (const piece of pieces) {
        const last = out[out.length - 1];
        if (last !== undefined && last.source + last.count === piece.source && last.to + last.count === piece.to) {
            last.count += piece.count;
        } else {
            out.push({ ...piece });
        }
    }
    return out;
}

/** First and last full-order positions of the live entries of `selection`, if any. */
function live_span<I>(
    index: AxisLayoutIndex<I>,
    selection: readonly I[],
): { first: number; last: number } | undefined {
    let first = Infinity;
    let last = -Infinity;
    for (const identity of selection) {
        if (!index.is_live(identity)) continue;
        const position = index.position_of(identity)!;
        if (position < first) first = position;
        if (position > last) last = position;
    }
    return last < 0 ? undefined : { first, last };
}

/**
 * The anchor Insert uses for a selection: its first live entry for "before",
 * its last live entry for "after" (so a selection ending in a tombstone
 * anchors on the last live entry and lands after that entry's glued
 * tombstones). Undefined when the selection has no live entry, which disables
 * Insert.
 */
export function insert_anchor_for_selection<I>(
    index: AxisLayoutIndex<I>,
    selection: readonly I[],
    side: 'before' | 'after',
): I | undefined {
    const span = live_span(index, selection);
    if (span === undefined) return undefined;
    return index.identity_at_position(side === 'before' ? span.first : span.last);
}

/**
 * The `before` argument for one step of Move up/left ('backward') or
 * down/right ('forward'): the block passes one live neighbor together with its
 * glued tombstones. Undefined when the selection has no live entry or no live
 * neighbor in that direction.
 */
export function step_move_target<I>(
    index: AxisLayoutIndex<I>,
    selection: readonly I[],
    direction: 'backward' | 'forward',
): I | 'end' | undefined {
    const span = live_span(index, selection);
    if (span === undefined) return undefined;
    if (direction === 'backward') {
        const first = index.identity_at_position(span.first)!;
        const body_index = index.body_index_of(first)!;
        return body_index > 1 ? index.identity_at_body_index(body_index - 1) : undefined;
    }
    const last = index.identity_at_position(span.last)!;
    const body_index = index.body_index_of(last)!;
    if (body_index >= index.liveCount) return undefined;
    return body_index + 1 >= index.liveCount ? 'end' : index.identity_at_body_index(body_index + 2);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function row_model(layout: RowLayout): AxisModel {
    return {
        runs: layout.runs,
        removed: layout.removedSourceRows,
        discarded: new Set(layout.discardedPendingRows.map((row) => row.id)),
    };
}

function freeze_row_layout(
    runs: readonly AxisRun[],
    removed: readonly SourceInterval[],
    discarded: readonly DiscardedPendingRow[],
): RowLayout {
    return Object.freeze({
        runs: Object.freeze(canonical_runs(runs)) as readonly RowLayoutRun[],
        removedSourceRows: Object.freeze(canonical_intervals(removed)),
        discardedPendingRows: Object.freeze(discarded
            .map((row) => Object.freeze({ id: row.id, createdOrder: row.createdOrder }))
            .sort((left, right) => left.createdOrder - right.createdOrder
                || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))),
    });
}

/**
 * Join new source rows `[old_count, new_count)` to a row layout as one source
 * run placed right after the run holding the highest-numbered old source row,
 * wherever a move left it, and before the append band, which is outside the
 * layout. Used when rows are appended on disk under a layout (design
 * "External changes") and when an append-only save turns Pending Appended
 * Rows into source rows under a layout that history still records.
 */
export function append_source_rows_to_layout(
    layout: RowLayout,
    body_start: number,
    old_count: number,
    new_count: number,
): RowLayout {
    if (new_count <= old_count) return layout;
    const added = { kind: 'source' as const, start: old_count, count: new_count - old_count };
    const highest = old_count - 1;
    const index = highest < body_start
        ? -1
        : layout.runs.findIndex((run) =>
            run.kind === 'source' && highest >= run.start && highest < run.start + run.count);
    const runs = [...layout.runs];
    if (index < 0) {
        // A header-only body: the new rows are the whole body.
        runs.unshift(added);
    } else {
        // The run holding the highest old row ends at the old body's end, so
        // the new rows extend it in place, keeping the runs canonical.
        const run = runs[index] as Extract<RowLayoutRun, { kind: 'source' }>;
        runs[index] = { kind: 'source', start: run.start, count: run.count + added.count };
    }
    return Object.freeze({ ...layout, runs: Object.freeze(runs) });
}

/**
 * The first body source row: one past the active Header Row, or 0 without one.
 *
 * An auto-detected Header Row carries no `sourceRow`, because it is always the
 * first row; only an explicit override names one. Reading a missing
 * `sourceRow` as "no header" would put the Header Row inside the body layout,
 * where Delete and Move could reach it.
 */
export function header_body_start(
    header: { readonly active: boolean; readonly sourceRow?: number } | undefined,
): number {
    return header?.active === true ? (header.sourceRow ?? 0) + 1 : 0;
}

/** The source layout of a body: one source run covering it, or none for a header-only sheet. */
export function source_row_layout(body_start: number, body_row_count: number): RowLayout {
    return freeze_row_layout(
        body_row_count > 0 ? [{ kind: 'source', start: body_start, count: body_row_count }] : [],
        [],
        [],
    );
}

/**
 * Canonical form: adjacent continuing source runs and adjacent pending runs
 * merged, empty runs dropped, removal intervals sorted and merged, discarded
 * rows ordered by `createdOrder`.
 */
export function canonical_row_layout(layout: RowLayout): RowLayout {
    return freeze_row_layout(layout.runs, layout.removedSourceRows, layout.discardedPendingRows);
}

export function row_layouts_equal(left: RowLayout, right: RowLayout): boolean {
    return JSON.stringify(canonical_row_layout(left)) === JSON.stringify(canonical_row_layout(right));
}

/** Whether a valid layout is the source layout of its body. */
export function is_source_row_layout(layout: RowLayout): boolean {
    const canonical = canonical_row_layout(layout);
    return canonical.removedSourceRows.length === 0
        && canonical.discardedPendingRows.length === 0
        && (canonical.runs.length === 0
            || (canonical.runs.length === 1 && canonical.runs[0]!.kind === 'source'));
}

/**
 * Whether the live layout differs from the source layout: a live Pending
 * Inserted Row, a Pending Row Removal, or a moved run. A valid layout that
 * differs from the source layout only by discarded tombstones has none.
 */
export function has_live_row_layout_change(layout: RowLayout): boolean {
    return has_live_change(row_model(layout));
}

function has_live_change(model: AxisModel): boolean {
    if (model.removed.length > 0) return true;
    let previous = -1;
    for (const run of model.runs) {
        if (run.kind === 'pending') {
            if (run.ids.some((id) => !model.discarded.has(id))) return true;
            continue;
        }
        if (run.start < previous) return true;
        previous = run.start;
    }
    return false;
}

export function index_row_layout(layout: RowLayout): RowLayoutIndex {
    return create_axis_index(row_model(layout), ROW_CODEC);
}

function row_index_internals(layout: RowLayout): AxisIndexInternals {
    return create_axis_index(row_model(layout), ROW_CODEC);
}

function row_result(layout: RowLayout, items: readonly Item[]): LayoutResult<RowLayout> {
    const runs = runs_of_items(items);
    if (runs.length > MAX_ROW_LAYOUT_RUNS) return refuse('too-many-runs', TOO_MANY_ROW_RUNS_MESSAGE);
    return { ok: true, layout: freeze_row_layout(runs, layout.removedSourceRows, layout.discardedPendingRows) };
}

/** Insert live Pending Inserted Rows `ids` before or after the live `anchor`. */
export function insert_rows(
    layout: RowLayout,
    anchor: RowIdentity,
    side: 'before' | 'after',
    ids: readonly PendingRowId[],
): LayoutResult<RowLayout> {
    const result = insert_items(row_index_internals(layout), ROW_CODEC.read(anchor), side, ids, 'row');
    return result.ok ? row_result(layout, result.items) : result;
}

/**
 * The source row whose format a run of `count` Pending Inserted Rows, the
 * first of which is `first_id`, copies at admission (design "Formatting
 * inheritance"): the nearest live source row above the run, or, when none is
 * above it (the run sits directly below the Header Row), the nearest one
 * below it. Null when the layout has no live source row, as on a header-only
 * worksheet, which takes the default format.
 */
export function insert_template_source_row(
    layout: RowLayout,
    first_id: PendingRowId,
    count: number,
): number | null {
    const index = index_row_layout(layout);
    const first = index.body_index_of({ kind: 'pending', pendingRowId: first_id });
    if (first === undefined) throw new Error('The inserted rows are not live in the layout.');
    for (let body_index = first - 1; body_index >= 1; body_index -= 1) {
        const identity = index.identity_at_body_index(body_index);
        if (identity?.kind === 'source') return identity.sourceRow;
    }
    for (let body_index = first + count; body_index <= index.liveCount; body_index += 1) {
        const identity = index.identity_at_body_index(body_index);
        if (identity?.kind === 'source') return identity.sourceRow;
    }
    return null;
}

/**
 * Delete rows in place: live source rows become Pending Row Removals and live
 * Pending Inserted Rows become discarded tombstones carrying
 * `created_order(id)`. Entries that are already tombstones are left alone.
 */
export function delete_rows(
    layout: RowLayout,
    identities: readonly RowIdentity[],
    created_order: (id: PendingRowId) => number,
): LayoutResult<RowLayout> {
    const index = index_row_layout(layout);
    const added: number[] = [];
    const discarded = [...layout.discardedPendingRows];
    const seen = new Set<string>();
    for (const identity of identities) {
        const status = index.status_of(identity);
        if (status === undefined) return unknown_identity('row');
        if (status !== 'live') continue;
        if (identity.kind === 'source') {
            added.push(identity.sourceRow);
            continue;
        }
        if (seen.has(identity.pendingRowId)) continue;
        seen.add(identity.pendingRowId);
        const order = created_order(identity.pendingRowId);
        if (!Number.isSafeInteger(order)) {
            return refuse('invalid-created-order', 'A deleted pending row needs its creation order.');
        }
        discarded.push({ id: identity.pendingRowId, createdOrder: order });
    }
    const removed = canonical_intervals([
        ...layout.removedSourceRows,
        ...intervals_of_sorted(sorted_unique(added)),
    ]);
    if (removed.length > MAX_REMOVED_ROW_INTERVALS) {
        return refuse('too-many-removals', TOO_MANY_ROW_REMOVALS_MESSAGE);
    }
    return { ok: true, layout: freeze_row_layout(layout.runs, removed, discarded) };
}

/** Cancel Pending Row Removals; every row must currently be removed. */
export function restore_rows(layout: RowLayout, source_rows: readonly number[]): LayoutResult<RowLayout> {
    const rows = sorted_unique(source_rows);
    for (const row of rows) {
        if (!Number.isSafeInteger(row) || !interval_contains(layout.removedSourceRows, row)) {
            return refuse('not-removed', 'Only deleted rows can be restored.');
        }
    }
    const removed = subtract_values(layout.removedSourceRows, rows);
    if (removed.length > MAX_REMOVED_ROW_INTERVALS) {
        return refuse('too-many-removals', TOO_MANY_RESTORED_ROW_GROUPS_MESSAGE);
    }
    return { ok: true, layout: freeze_row_layout(layout.runs, removed, layout.discardedPendingRows) };
}

/**
 * Move the live rows of `identities` (each with its glued tombstones) to just
 * before `before`. A `before` that is a tombstone, or one of the moving rows,
 * resolves to the next live row that is not moving, so a drop between a live
 * row and its glued tombstones lands after them.
 */
export function move_rows(
    layout: RowLayout,
    identities: readonly RowIdentity[],
    before: RowIdentity | 'end',
): LayoutResult<RowLayout> {
    const result = move_items(
        row_index_internals(layout),
        identities.map(ROW_CODEC.read),
        before === 'end' ? 'end' : ROW_CODEC.read(before),
        'row',
    );
    return result.ok ? row_result(layout, result.items) : result;
}

/** Drop discarded Pending Inserted Rows no stored Formula Anchor names. */
export function drop_unreferenced_row_tombstones(
    layout: RowLayout,
    is_referenced: (id: PendingRowId) => boolean,
): RowLayout {
    const dropped = new Set(layout.discardedPendingRows
        .filter((row) => !is_referenced(row.id))
        .map((row) => row.id));
    if (dropped.size === 0) return canonical_row_layout(layout);
    return freeze_row_layout(
        layout.runs.map((run) => run.kind === 'pending'
            ? { kind: 'pending', ids: run.ids.filter((id) => !dropped.has(id)) }
            : run),
        layout.removedSourceRows,
        layout.discardedPendingRows.filter((row) => !dropped.has(row.id)),
    );
}

/**
 * Live source rows outside the heaviest order-preserving subsequence of source
 * runs (ties toward earlier runs), as sorted intervals: the Moved Rows.
 */
export function moved_source_rows(layout: RowLayout): readonly SourceInterval[] {
    return Object.freeze(moved_sources(row_index_internals(layout)));
}

/** The row half of the save receipt. See `RowSaveMap` for coordinates. */
export function row_save_map(layout: RowLayout): RowSaveMap {
    const index = row_index_internals(layout);
    return Object.freeze({
        rowRuns: Object.freeze(live_source_mapping(index).map((entry) => Object.freeze({
            sourceRow: entry.source,
            count: entry.count,
            bodyIndex: entry.to,
        }))),
        removedRows: Object.freeze(canonical_intervals(layout.removedSourceRows)),
        insertedRows: Object.freeze(index.segments
            .filter((segment) => segment.kind === 'pending' && segment.status === 'live')
            .map((segment) => Object.freeze({
                pendingRowId: (segment as { id: string }).id,
                bodyIndex: segment.liveBefore,
            }))),
    });
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function column_model(layout: ColumnLayout): AxisModel {
    return {
        runs: canonical_runs(layout.columns.map((column): AxisRun => column.kind === 'source'
            ? { kind: 'source', start: column.sourceColumn, count: 1 }
            : { kind: 'pending', ids: [column.pendingColumnId] })),
        removed: intervals_of_sorted(sorted_unique(layout.removedSourceColumns)),
        discarded: new Set(layout.discardedPendingColumns.map((column) => column.id)),
    };
}

function freeze_column_layout(
    columns: readonly ColumnIdentity[],
    removed: readonly number[],
    discarded: readonly DiscardedPendingColumn[],
): ColumnLayout {
    return Object.freeze({
        columns: Object.freeze(columns.map((column) => column.kind === 'source'
            ? COLUMN_CODEC.source(column.sourceColumn)
            : COLUMN_CODEC.pending(column.pendingColumnId))),
        removedSourceColumns: Object.freeze(sorted_unique(removed)),
        discardedPendingColumns: Object.freeze(discarded
            .map((column) => Object.freeze({ id: column.id, createdOrder: column.createdOrder }))
            .sort((left, right) => left.createdOrder - right.createdOrder
                || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))),
    });
}

function columns_of_items(items: readonly Item[]): ColumnIdentity[] {
    const columns: ColumnIdentity[] = [];
    for (const item of items) {
        if (item.kind === 'pending') columns.push(COLUMN_CODEC.pending(item.id));
        else for (let offset = 0; offset < item.count; offset++) columns.push(COLUMN_CODEC.source(item.start + offset));
    }
    return columns;
}

/** The source layout of `source_column_count` columns. */
export function source_column_layout(source_column_count: number): ColumnLayout {
    return freeze_column_layout(
        Array.from({ length: source_column_count }, (_, column) => COLUMN_CODEC.source(column)),
        [],
        [],
    );
}

/** Canonical form: removals ascending and unique, discarded columns ordered by `createdOrder`. */
export function canonical_column_layout(layout: ColumnLayout): ColumnLayout {
    return freeze_column_layout(layout.columns, layout.removedSourceColumns, layout.discardedPendingColumns);
}

export function column_layouts_equal(left: ColumnLayout, right: ColumnLayout): boolean {
    return JSON.stringify(canonical_column_layout(left)) === JSON.stringify(canonical_column_layout(right));
}

/** Whether a valid layout is the source layout: every source column in order and nothing else. */
export function is_source_column_layout(layout: ColumnLayout): boolean {
    return layout.removedSourceColumns.length === 0
        && layout.discardedPendingColumns.length === 0
        && layout.columns.every((column, index) => column.kind === 'source' && column.sourceColumn === index);
}

/** Like `has_live_row_layout_change`, for columns. */
export function has_live_column_layout_change(layout: ColumnLayout): boolean {
    return has_live_change(column_model(layout));
}

export function index_column_layout(layout: ColumnLayout): ColumnLayoutIndex {
    return create_axis_index(column_model(layout), COLUMN_CODEC);
}

function column_index_internals(layout: ColumnLayout): AxisIndexInternals {
    return create_axis_index(column_model(layout), COLUMN_CODEC);
}

function source_column_count_of(layout: ColumnLayout): number {
    let count = 0;
    for (const column of layout.columns) if (column.kind === 'source') count++;
    return count;
}

function too_wide(layout: ColumnLayout): { ok: false; refusal: LayoutRefusal } | undefined {
    return source_column_count_of(layout) > MAX_SHEET_COLUMNS
        ? refuse('too-wide-to-restructure', TOO_WIDE_TO_RESTRUCTURE_MESSAGE)
        : undefined;
}

function live_column_count(layout: ColumnLayout): number {
    return layout.columns.length - layout.removedSourceColumns.length - layout.discardedPendingColumns.length;
}

export function insert_columns(
    layout: ColumnLayout,
    anchor: ColumnIdentity,
    side: 'before' | 'after',
    ids: readonly PendingColumnId[],
): LayoutResult<ColumnLayout> {
    const wide = too_wide(layout);
    if (wide !== undefined) return wide;
    const result = insert_items(column_index_internals(layout), COLUMN_CODEC.read(anchor), side, ids, 'column');
    if (!result.ok) return result;
    if (live_column_count(layout) + ids.length > MAX_SHEET_COLUMNS) {
        return refuse('too-many-live-columns', TOO_MANY_LIVE_COLUMNS_MESSAGE);
    }
    if (layout.columns.length + ids.length > MAX_COLUMN_LAYOUT_ENTRIES) {
        return refuse('too-many-column-entries', TOO_MANY_COLUMN_ENTRIES_MESSAGE);
    }
    return {
        ok: true,
        layout: freeze_column_layout(
            columns_of_items(result.items),
            layout.removedSourceColumns,
            layout.discardedPendingColumns,
        ),
    };
}

/** Like `delete_rows`, for columns. */
export function delete_columns(
    layout: ColumnLayout,
    identities: readonly ColumnIdentity[],
    created_order: (id: PendingColumnId) => number,
): LayoutResult<ColumnLayout> {
    const wide = too_wide(layout);
    if (wide !== undefined) return wide;
    const index = index_column_layout(layout);
    const removed = [...layout.removedSourceColumns];
    const discarded = [...layout.discardedPendingColumns];
    const seen = new Set<string>();
    for (const identity of identities) {
        const status = index.status_of(identity);
        if (status === undefined) return unknown_identity('column');
        if (status !== 'live') continue;
        if (identity.kind === 'source') {
            removed.push(identity.sourceColumn);
            continue;
        }
        if (seen.has(identity.pendingColumnId)) continue;
        seen.add(identity.pendingColumnId);
        const order = created_order(identity.pendingColumnId);
        if (!Number.isSafeInteger(order)) {
            return refuse('invalid-created-order', 'A deleted pending column needs its creation order.');
        }
        discarded.push({ id: identity.pendingColumnId, createdOrder: order });
    }
    return { ok: true, layout: freeze_column_layout(layout.columns, removed, discarded) };
}

/** Cancel Pending Column Removals; every column must currently be removed. */
export function restore_columns(layout: ColumnLayout, source_columns: readonly number[]): LayoutResult<ColumnLayout> {
    const removed = new Set(layout.removedSourceColumns);
    const restored = sorted_unique(source_columns);
    for (const column of restored) {
        if (!removed.has(column)) return refuse('not-removed', 'Only deleted columns can be restored.');
    }
    if (live_column_count(layout) + restored.length > MAX_SHEET_COLUMNS) {
        return refuse('too-many-live-columns', TOO_MANY_LIVE_COLUMNS_MESSAGE);
    }
    for (const column of restored) removed.delete(column);
    return {
        ok: true,
        layout: freeze_column_layout(layout.columns, [...removed], layout.discardedPendingColumns),
    };
}

/** Like `move_rows`, for columns. */
export function move_columns(
    layout: ColumnLayout,
    identities: readonly ColumnIdentity[],
    before: ColumnIdentity | 'end',
): LayoutResult<ColumnLayout> {
    const wide = too_wide(layout);
    if (wide !== undefined) return wide;
    const result = move_items(
        column_index_internals(layout),
        identities.map(COLUMN_CODEC.read),
        before === 'end' ? 'end' : COLUMN_CODEC.read(before),
        'column',
    );
    if (!result.ok) return result;
    return {
        ok: true,
        layout: freeze_column_layout(
            columns_of_items(result.items),
            layout.removedSourceColumns,
            layout.discardedPendingColumns,
        ),
    };
}

/** Drop discarded Pending Columns no stored Formula Anchor names. */
export function drop_unreferenced_column_tombstones(
    layout: ColumnLayout,
    is_referenced: (id: PendingColumnId) => boolean,
): ColumnLayout {
    const dropped = new Set(layout.discardedPendingColumns
        .filter((column) => !is_referenced(column.id))
        .map((column) => column.id));
    return freeze_column_layout(
        layout.columns.filter((column) => column.kind === 'source' || !dropped.has(column.pendingColumnId)),
        layout.removedSourceColumns,
        layout.discardedPendingColumns.filter((column) => !dropped.has(column.id)),
    );
}

/** Live source columns that are Moved Columns, as sorted intervals. */
export function moved_source_columns(layout: ColumnLayout): readonly SourceInterval[] {
    return Object.freeze(moved_sources(column_index_internals(layout)));
}

/** The column half of the save receipt. */
export function column_save_map(layout: ColumnLayout): ColumnSaveMap {
    const index = column_index_internals(layout);
    const column_map = new Array<number | null>(source_column_count_of(layout)).fill(null);
    for (const entry of live_source_mapping(index)) {
        for (let offset = 0; offset < entry.count; offset++) column_map[entry.source + offset] = entry.to + offset;
    }
    return Object.freeze({
        columnMap: Object.freeze(column_map),
        insertedColumns: Object.freeze(index.segments
            .filter((segment) => segment.kind === 'pending' && segment.status === 'live')
            .map((segment) => Object.freeze({
                pendingColumnId: (segment as { id: string }).id,
                column: segment.liveBefore,
            }))),
    });
}

// ---------------------------------------------------------------------------
// Validation (invariants 1-7)
// ---------------------------------------------------------------------------

function invalid(reason: LayoutValidationReason, message: string): LayoutValidationError {
    return Object.freeze({ reason, message });
}

function is_count(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function is_id(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

/** Shape check for removal intervals: sorted, disjoint, non-adjacent, non-empty, within `[low, high)`. */
function check_removed_intervals(
    intervals: unknown,
    low: number,
    high: number,
    label: string,
): LayoutValidationError | undefined {
    if (!Array.isArray(intervals)) return invalid('malformed', `${label} must be a list.`);
    let end = -Infinity;
    for (const entry of intervals as readonly unknown[]) {
        const record = entry as { start?: unknown; count?: unknown } | null;
        if (typeof record !== 'object' || record === null || !is_count(record.start) || !is_count(record.count)) {
            return invalid('malformed', `${label} must hold whole-number intervals.`);
        }
        if (record.count === 0 || record.start <= end) {
            return invalid('removed-entries', `${label} must be sorted, disjoint, non-adjacent, and non-empty.`);
        }
        if (record.start < low || record.start + record.count > high) {
            return invalid('removed-entries', `${label} must lie within the body.`);
        }
        end = record.start + record.count;
    }
    return undefined;
}

/** Check a row layout against invariants 1-5 and 7, or return why it fails. */
export function validate_row_layout(layout: RowLayout, context: RowLayoutContext): LayoutValidationError | undefined {
    if (typeof layout !== 'object' || layout === null || !Array.isArray(layout.runs)
        || !Array.isArray(layout.removedSourceRows) || !Array.isArray(layout.discardedPendingRows)) {
        return invalid('malformed', 'Row layout must have runs, removed rows, and discarded rows.');
    }
    if (!is_count(context.bodyStart) || !is_count(context.bodyRowCount)) {
        return invalid('malformed', 'Row layout context must name a whole-number body.');
    }
    if (layout.runs.length > MAX_ROW_LAYOUT_RUNS) return invalid('too-many-runs', TOO_MANY_ROW_RUNS_MESSAGE);
    if (layout.removedSourceRows.length > MAX_REMOVED_ROW_INTERVALS) {
        return invalid('too-many-removals', TOO_MANY_ROW_REMOVALS_MESSAGE);
    }
    const body_end = context.bodyStart + context.bodyRowCount;
    const sources: { start: number; count: number }[] = [];
    const run_ids = new Set<string>();
    let previous: RowLayoutRun | undefined;
    for (const run of layout.runs as readonly unknown[]) {
        const record = run as Partial<Record<'kind' | 'start' | 'count' | 'ids', unknown>> | null;
        if (typeof record !== 'object' || record === null) {
            return invalid('malformed', 'Row layout runs must be objects.');
        }
        if (record.kind === 'source') {
            if (!is_count(record.start) || !is_count(record.count)) {
                return invalid('malformed', 'Row layout source runs must have whole-number start and count.');
            }
            if (record.count === 0) return invalid('non-canonical', 'Row layout has an empty source run.');
            if (record.start < context.bodyStart || record.start + record.count > body_end) {
                return invalid('source-coverage', 'Row layout source run lies outside the body.');
            }
            if (previous?.kind === 'source' && previous.start + previous.count === record.start) {
                return invalid('non-canonical', 'Row layout has two adjacent source runs that should be one.');
            }
            sources.push({ start: record.start, count: record.count });
            previous = { kind: 'source', start: record.start, count: record.count };
        } else if (record.kind === 'pending') {
            if (!Array.isArray(record.ids) || !(record.ids as unknown[]).every(is_id)) {
                return invalid('malformed', 'Row layout pending runs must list pending row ids.');
            }
            const ids = record.ids as readonly string[];
            if (ids.length === 0) return invalid('non-canonical', 'Row layout has an empty pending run.');
            if (previous?.kind === 'pending') {
                return invalid('non-canonical', 'Row layout has two adjacent pending runs that should be one.');
            }
            for (const id of ids) {
                if (run_ids.has(id)) return invalid('pending-membership', `Pending row ${id} appears twice in the row layout.`);
                run_ids.add(id);
            }
            previous = { kind: 'pending', ids };
        } else {
            return invalid('malformed', 'Row layout run has an unknown kind.');
        }
    }
    sources.sort((left, right) => left.start - right.start);
    let covered = context.bodyStart;
    for (const source of sources) {
        if (source.start !== covered) {
            return invalid('source-coverage', source.start < covered
                ? 'A source row appears in more than one row layout run.'
                : `Source row ${covered} is missing from the row layout.`);
        }
        covered += source.count;
    }
    if (covered !== body_end) return invalid('source-coverage', `Source row ${covered} is missing from the row layout.`);

    const removed_error = check_removed_intervals(
        layout.removedSourceRows, context.bodyStart, body_end, 'Removed source rows');
    if (removed_error !== undefined) return removed_error;

    const orders = new Set<number>();
    const live_ids = new Set<string>();
    for (const row of context.pendingRows) {
        if (!is_count(row.createdOrder) || orders.has(row.createdOrder)) {
            return invalid('created-order', 'Pending rows must have unique creation orders.');
        }
        orders.add(row.createdOrder);
        if (live_ids.has(row.id)) return invalid('pending-membership', `Pending row ${row.id} is listed twice.`);
        live_ids.add(row.id);
        const inserted = row.origin === 'insert';
        if (inserted !== run_ids.has(row.id)) {
            return invalid('pending-membership', inserted
                ? `Inserted pending row ${row.id} is missing from the row layout.`
                : `Appended pending row ${row.id} must not appear in the row layout.`);
        }
    }
    const discarded_ids = new Set<string>();
    for (const row of layout.discardedPendingRows as readonly unknown[]) {
        const record = row as Partial<Record<'id' | 'createdOrder', unknown>> | null;
        if (typeof record !== 'object' || record === null || !is_id(record.id)) {
            return invalid('malformed', 'Discarded pending rows must have an id and a creation order.');
        }
        const id = record.id;
        if (!is_count(record.createdOrder) || orders.has(record.createdOrder)) {
            return invalid('created-order', 'Pending rows must have unique creation orders.');
        }
        orders.add(record.createdOrder);
        if (discarded_ids.has(id) || live_ids.has(id)) {
            return invalid('discarded-tombstone', `Discarded pending row ${id} is listed twice or is still live.`);
        }
        if (!run_ids.has(id)) {
            return invalid('discarded-tombstone', `Discarded pending row ${id} is missing from the row layout.`);
        }
        if (!context.mintedAsInsert(id)) {
            return invalid('discarded-tombstone', `Discarded pending row ${id} was not minted as an inserted row.`);
        }
        discarded_ids.add(id);
    }
    for (const id of run_ids) {
        if (!live_ids.has(id) && !discarded_ids.has(id)) {
            return invalid('pending-membership', `Row layout names unknown pending row ${id}.`);
        }
    }
    return undefined;
}

export function assert_valid_row_layout(layout: RowLayout, context: RowLayoutContext): void {
    const error = validate_row_layout(layout, context);
    if (error !== undefined) throw new TypeError(error.message);
}

/** Check a column layout against invariants 6 and 7 and the column limits, or return why it fails. */
export function validate_column_layout(
    layout: ColumnLayout,
    context: ColumnLayoutContext,
): LayoutValidationError | undefined {
    if (typeof layout !== 'object' || layout === null || !Array.isArray(layout.columns)
        || !Array.isArray(layout.removedSourceColumns) || !Array.isArray(layout.discardedPendingColumns)) {
        return invalid('malformed', 'Column layout must have columns, removed columns, and discarded columns.');
    }
    if (!is_count(context.sourceColumnCount)) {
        return invalid('malformed', 'Column layout context must name a whole-number column count.');
    }
    if (layout.discardedPendingColumns.length > MAX_DISCARDED_PENDING_COLUMNS) {
        return invalid('too-many-discarded-columns', TOO_MANY_COLUMN_ENTRIES_MESSAGE);
    }
    const seen_sources = new Set<number>();
    const seen_ids = new Set<string>();
    for (const column of layout.columns as readonly unknown[]) {
        const record = column as Partial<Record<'kind' | 'sourceColumn' | 'pendingColumnId', unknown>> | null;
        if (typeof record !== 'object' || record === null) {
            return invalid('malformed', 'Column layout entries must be objects.');
        }
        if (record.kind === 'source') {
            if (!is_count(record.sourceColumn)) {
                return invalid('malformed', 'Column layout source columns must be whole numbers.');
            }
            if (record.sourceColumn >= context.sourceColumnCount || seen_sources.has(record.sourceColumn)) {
                return invalid('source-coverage', `Source column ${record.sourceColumn} is out of range or listed twice.`);
            }
            seen_sources.add(record.sourceColumn);
        } else if (record.kind === 'pending') {
            if (!is_id(record.pendingColumnId)) {
                return invalid('malformed', 'Column layout pending columns must have an id.');
            }
            if (seen_ids.has(record.pendingColumnId)) {
                return invalid('pending-membership', `Pending column ${record.pendingColumnId} appears twice in the column layout.`);
            }
            seen_ids.add(record.pendingColumnId);
        } else {
            return invalid('malformed', 'Column layout entry has an unknown kind.');
        }
    }
    if (seen_sources.size !== context.sourceColumnCount) {
        return invalid('source-coverage', 'Every source column must appear in the column layout.');
    }
    // The source layout of a wide file is what an absent layout means; only a
    // changed layout has to fit the restructuring limits.
    const changed = !is_source_column_layout(layout);
    if (changed && context.sourceColumnCount > MAX_SHEET_COLUMNS) {
        return invalid('too-wide-to-restructure', TOO_WIDE_TO_RESTRUCTURE_MESSAGE);
    }
    if (changed && layout.columns.length > MAX_COLUMN_LAYOUT_ENTRIES) {
        return invalid('too-many-column-entries', TOO_MANY_COLUMN_ENTRIES_MESSAGE);
    }
    const removed = layout.removedSourceColumns as readonly unknown[];
    for (let index = 0; index < removed.length; index++) {
        const column = removed[index];
        if (!is_count(column)) return invalid('malformed', 'Removed source columns must be whole numbers.');
        if (column >= context.sourceColumnCount || (index > 0 && column <= (removed[index - 1] as number))) {
            return invalid('removed-entries', 'Removed source columns must be ascending, unique, and in range.');
        }
    }
    const orders = new Set<number>();
    const live_ids = new Set<string>();
    for (const column of context.pendingColumns) {
        if (!is_count(column.createdOrder) || orders.has(column.createdOrder)) {
            return invalid('created-order', 'Pending columns must have unique creation orders.');
        }
        orders.add(column.createdOrder);
        if (live_ids.has(column.id)) {
            return invalid('pending-membership', `Pending column ${column.id} is listed twice.`);
        }
        live_ids.add(column.id);
        if (!seen_ids.has(column.id)) {
            return invalid('pending-membership', `Pending column ${column.id} is missing from the column layout.`);
        }
    }
    const discarded_ids = new Set<string>();
    for (const column of layout.discardedPendingColumns as readonly unknown[]) {
        const record = column as Partial<Record<'id' | 'createdOrder', unknown>> | null;
        if (typeof record !== 'object' || record === null || !is_id(record.id)) {
            return invalid('malformed', 'Discarded pending columns must have an id and a creation order.');
        }
        if (!is_count(record.createdOrder) || orders.has(record.createdOrder)) {
            return invalid('created-order', 'Pending columns must have unique creation orders.');
        }
        orders.add(record.createdOrder);
        if (discarded_ids.has(record.id) || live_ids.has(record.id)) {
            return invalid('discarded-tombstone', `Discarded pending column ${record.id} is listed twice or is still live.`);
        }
        if (!seen_ids.has(record.id)) {
            return invalid('discarded-tombstone', `Discarded pending column ${record.id} is missing from the column layout.`);
        }
        discarded_ids.add(record.id);
    }
    for (const id of seen_ids) {
        if (!live_ids.has(id) && !discarded_ids.has(id)) {
            return invalid('pending-membership', `Column layout names unknown pending column ${id}.`);
        }
    }
    if (changed && layout.columns.length - removed.length - discarded_ids.size > MAX_SHEET_COLUMNS) {
        return invalid('too-many-live-columns', TOO_MANY_LIVE_COLUMNS_MESSAGE);
    }
    return undefined;
}

export function assert_valid_column_layout(layout: ColumnLayout, context: ColumnLayoutContext): void {
    const error = validate_column_layout(layout, context);
    if (error !== undefined) throw new TypeError(error.message);
}
