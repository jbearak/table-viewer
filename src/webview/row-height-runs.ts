// Every grid row's height, as GridShell resolves it, and the same heights as
// runs for a `RowHeightIndex`: built from the stored heights, the layers over
// them, the unsaved rows and a border drag's preview, in proportion to those
// and to the projection's runs, never to the rows.
import type { PendingRowProjection } from './pending-row-projection';
import { create_row_height_index, geometry_row_height, type RowHeightIndex, type RowHeightRun } from './row-height-index';
import { resolved_row_height, type RowHeightLayer, type RowHeightOverrides } from './row-heights';

/** A border drag's preview: the dragged row and the selected rows it resizes with it. */
export interface RowHeightPreview {
    readonly row: number;
    /** Glide's row selection: `hasIndex`, and `toRanges` as half-open slices. */
    readonly rows: {
        hasIndex(row: number): boolean;
        toRanges(): readonly (readonly [number, number])[];
    } | null;
    readonly height: number;
}

export interface RowHeightInputs {
    readonly projection: Pick<
        PendingRowProjection,
        'rowCount' | 'row_at' | 'source_row_runs' | 'deletedBandStart' | 'fixedRowCount'
    >;
    /** The host's stored heights, keyed by source-display row. */
    readonly rowHeights: RowHeightOverrides;
    /** Optimistic layers over them, oldest first; display-keyed like the record. */
    readonly layers: readonly RowHeightLayer[] | undefined;
    /** A geometry height (`geometry_row_height`): the caller clamps it at its source. */
    readonly defaultHeight: number;
    /** The height an unsaved row (pending, replacement, tail removal) carries, if any. */
    readonly structuralHeight: (row: number) => number | undefined;
}

const finite_or = (height: number | undefined, fallback: number): number =>
    height !== undefined && Number.isFinite(height) ? height : fallback;

/**
 * A row's height as saving and fitting read it: the preview (unless
 * `include_preview` is false), else an unsaved row's own height, else the
 * newest layer holding its source-display row, else the stored height, else
 * the default. A row outside the grid, and any non-finite height, takes the
 * default.
 */
export function raw_row_height_of(
    inputs: RowHeightInputs,
    preview: RowHeightPreview | undefined,
    row: number,
    include_preview = true,
): number {
    const { projection, defaultHeight } = inputs;
    if (!Number.isSafeInteger(row) || row < 0 || row >= projection.rowCount) return defaultHeight;
    if (include_preview && preview !== undefined && (preview.row === row || preview.rows?.hasIndex(row) === true)) {
        return finite_or(preview.height, defaultHeight);
    }
    const projected = projection.row_at(row);
    if (projected === undefined) return defaultHeight;
    // The stored heights and the layers over them are the host's, keyed by
    // its display rows. An unsaved row is not one of those: with no height of
    // its own it takes the default, not the height of the saved row that its
    // place in the grid happens to number.
    if (projected.kind !== 'source') return finite_or(inputs.structuralHeight(row), defaultHeight);
    return finite_or(
        resolved_row_height(inputs.rowHeights, inputs.layers, projected.sourceDisplayRow, defaultHeight),
        defaultHeight,
    );
}

/** The height the grid draws for `row`: `raw_row_height_of`, bounded and quantized. */
export function geometry_row_height_of(
    inputs: RowHeightInputs,
    preview: RowHeightPreview | undefined,
    row: number,
): number {
    return geometry_row_height(raw_row_height_of(inputs, preview, row), inputs.defaultHeight);
}

/**
 * Paint `height` over `[start, end)` intervals (sorted, disjoint) onto
 * `runs` (sorted, disjoint): one merge of the two lists.
 */
function painted(
    runs: readonly RowHeightRun[],
    intervals: readonly (readonly [number, number])[],
    height: number,
): RowHeightRun[] {
    const out: RowHeightRun[] = [];
    let at = 0;
    // The part of `runs[at]` not yet emitted starts at `from`.
    let from = runs[0]?.start ?? 0;
    const emit_runs_before = (limit: number) => {
        while (at < runs.length) {
            const run = runs[at]!;
            const start = Math.max(run.start, from);
            const end = run.start + run.count;
            if (start >= limit) return;
            if (end <= limit) {
                if (end > start) out.push({ start, count: end - start, height: run.height });
                at++;
                from = runs[at]?.start ?? 0;
            } else {
                out.push({ start, count: limit - start, height: run.height });
                from = limit;
                return;
            }
        }
    };
    const skip_runs_before = (limit: number) => {
        while (at < runs.length) {
            const run = runs[at]!;
            const end = run.start + run.count;
            if (end <= limit) {
                at++;
                from = runs[at]?.start ?? 0;
            } else {
                from = Math.max(from, limit);
                return;
            }
        }
    };
    for (const [start, end] of intervals) {
        if (end <= start) continue;
        emit_runs_before(start);
        out.push({ start, count: end - start, height });
        skip_runs_before(end);
    }
    emit_runs_before(Number.POSITIVE_INFINITY);
    return out;
}

/**
 * The stored heights under the layers, as sorted disjoint runs of geometry
 * heights over source-display rows (default-height runs dropped). In
 * proportion to the stored keys and the layers' intervals.
 */
export function source_display_height_runs(
    rowHeights: RowHeightOverrides,
    layers: readonly RowHeightLayer[] | undefined,
    defaultHeight: number,
): RowHeightRun[] {
    const keyed: RowHeightRun[] = [];
    for (const key in rowHeights) {
        if (!Object.hasOwn(rowHeights, key)) continue;
        const row = Number(key);
        // Only the keys `rowHeights[row]` can reach for a source-display row.
        if (!Number.isSafeInteger(row) || row < 0 || String(row) !== key) continue;
        keyed.push({ start: row, count: 1, height: geometry_row_height(rowHeights[row]!, defaultHeight) });
    }
    keyed.sort((left, right) => left.start - right.start);
    let runs: RowHeightRun[] = keyed;
    // Oldest first, so the newest layer holding a row is painted last.
    for (const layer of layers ?? []) {
        if (layer.rows.length === 0) continue;
        runs = painted(
            runs,
            layer.rows.map((interval) => [interval.start, interval.end + 1] as const),
            geometry_row_height(layer.height, defaultHeight),
        );
    }
    return runs.filter((run) => run.height !== defaultHeight);
}

/** The first of `runs` (sorted, disjoint) that ends after `row`. */
function first_run_ending_after(runs: readonly RowHeightRun[], row: number): number {
    let low = 0;
    let high = runs.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (runs[middle]!.start + runs[middle]!.count > row) high = middle;
        else low = middle + 1;
    }
    return low;
}

/**
 * Every display row's geometry height, without the preview, as runs: the
 * source-display runs copied through the projection's runs, and the unsaved
 * rows one by one. In proportion to the projection's runs, the copied runs
 * and the unsaved rows.
 */
export function display_height_runs(
    inputs: RowHeightInputs,
    source_runs: readonly RowHeightRun[],
): RowHeightRun[] {
    const { projection, defaultHeight } = inputs;
    const out: RowHeightRun[] = [];
    const copy = (display_start: number, count: number, source_display_start: number) => {
        const end = source_display_start + count;
        for (let at = first_run_ending_after(source_runs, source_display_start); at < source_runs.length; at++) {
            const run = source_runs[at]!;
            if (run.start >= end) break;
            const start = Math.max(run.start, source_display_start);
            const stop = Math.min(run.start + run.count, end);
            out.push({ start: display_start + start - source_display_start, count: stop - start, height: run.height });
        }
    };
    const one = (row: number) => {
        const height = geometry_row_height(raw_row_height_of(inputs, undefined, row), defaultHeight);
        if (height !== defaultHeight) out.push({ start: row, count: 1, height });
    };
    const fixed = Math.min(projection.fixedRowCount, projection.rowCount);
    if (fixed > 0) copy(0, fixed, 0);
    const band = Math.min(projection.deletedBandStart, projection.rowCount);
    if (band > fixed) {
        for (const run of projection.source_row_runs(fixed, band - 1)) {
            if (run.kind === 'row') {
                one(run.displayRow);
            } else {
                copy(run.displayStart, run.count, run.sourceDisplayStart);
            }
        }
    }
    for (let row = Math.max(band, fixed); row < projection.rowCount; row++) one(row);
    return out;
}

/** The index of `display_height_runs`, with the preview painted over it. */
export function preview_row_height_index(
    base: RowHeightIndex,
    preview: RowHeightPreview | undefined,
): RowHeightIndex {
    if (preview === undefined) return base;
    const intervals: [number, number][] = [[preview.row, preview.row + 1]];
    for (const [start, end] of preview.rows?.toRanges() ?? []) intervals.push([start, end]);
    intervals.sort((left, right) => left[0] - right[0]);
    // Join overlapping intervals, clipped to the grid.
    const joined: [number, number][] = [];
    for (const [start, end] of intervals) {
        const low = Math.max(0, start);
        const high = Math.min(base.rowCount, end);
        if (high <= low) continue;
        const last = joined[joined.length - 1];
        if (last !== undefined && low <= last[1]) last[1] = Math.max(last[1], high);
        else joined.push([low, high]);
    }
    const height = geometry_row_height(finite_or(preview.height, base.defaultHeight), base.defaultHeight);
    return create_row_height_index(base.rowCount, base.defaultHeight, painted(base.runs, joined, height));
}

/** Whether two indexes give every row the same height. */
export function same_row_heights(left: RowHeightIndex, right: RowHeightIndex): boolean {
    if (left === right) return true;
    if (left.rowCount !== right.rowCount || left.defaultHeight !== right.defaultHeight) return false;
    if (left.runs.length !== right.runs.length) return false;
    for (let at = 0; at < left.runs.length; at++) {
        const a = left.runs[at]!;
        const b = right.runs[at]!;
        if (a.start !== b.start || a.count !== b.count || a.height !== b.height) return false;
    }
    return true;
}
