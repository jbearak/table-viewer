// A sparse index of the grid's row heights: the default height, the runs of
// rows whose height differs from it, and prefix sums over those runs. It
// answers a row's height, the top of a row and the row at a y position in
// O(log runs), so the grid never walks every row to place one.
//
// Exactness: the heights it is built from are geometry heights
// (`geometry_row_height`): multiples of 2^-16 px no taller than
// `MAX_ROW_HEIGHT_PX`. Sums of such numbers are exact in any order while the
// total stays under 2^37 px, so `top` agrees bit for bit with a running sum
// of `height` from row 0, which is how Glide's own loops add them up.
import { DEFAULT_ROW_HEIGHT_PX, MAX_ROW_HEIGHT_PX } from './row-heights';

/** Every geometry height is a multiple of this. */
export const ROW_HEIGHT_QUANTUM = 2 ** -16;

/**
 * The height the grid draws for a row whose height is `height`: a
 * non-finite height takes `fallback`, then the result is clamped to
 * [2^-16, MAX_ROW_HEIGHT_PX] and rounded to the nearest multiple of 2^-16.
 */
export function geometry_row_height(height: number, fallback: number): number {
    const finite = Number.isFinite(height) ? height : Number.isFinite(fallback) ? fallback : DEFAULT_ROW_HEIGHT_PX;
    const bounded = Math.min(MAX_ROW_HEIGHT_PX, Math.max(ROW_HEIGHT_QUANTUM, finite));
    return Math.max(ROW_HEIGHT_QUANTUM, Math.round(bounded / ROW_HEIGHT_QUANTUM) * ROW_HEIGHT_QUANTUM);
}

/** Consecutive rows `[start, start + count)` of one height. */
export interface RowHeightRun {
    readonly start: number;
    readonly count: number;
    readonly height: number;
}

export interface RowHeightIndex {
    /** Rows `[0, rowCount)` take their runs' heights; every other row the default. */
    readonly rowCount: number;
    readonly defaultHeight: number;
    /** The runs whose height differs from the default, sorted, disjoint, adjacent equal ones joined. */
    readonly runs: readonly RowHeightRun[];
    /** The height of `row`; the default for a row outside `[0, rowCount)` or not an integer. */
    height(row: number): number;
    /**
     * The sum of the heights of rows `[0, row)`; for a negative row, minus the
     * rows `[row, 0)`. A fractional row counts as the row below it.
     */
    top(row: number): number;
    /**
     * The first row `r >= 0` with `top(r + 1) > y`: the row whose span holds
     * `y`. NaN and negative `y` give 0; `+Infinity` gives `+Infinity` (no row
     * holds it), which a caller clamps to its row count; a `y` past the last
     * safe-integer row gives `Number.MAX_SAFE_INTEGER`.
     */
    rowAtY(y: number): number;
}

/**
 * An index over `rowCount` rows of `defaultHeight`, except `runs` (sorted by
 * start, disjoint). Runs are clipped to `[0, rowCount)`; default-height runs
 * are dropped and adjacent runs of one height joined. A row count that is not
 * a non-negative safe integer counts as 0, the default and run heights pass
 * through `geometry_row_height`, and a run whose start or count is not a safe
 * integer is skipped.
 */
export function create_row_height_index(
    rowCountIn: number,
    defaultHeightIn: number,
    runs: readonly RowHeightRun[],
): RowHeightIndex {
    const rowCount = Number.isSafeInteger(rowCountIn) && rowCountIn > 0 ? rowCountIn : 0;
    const defaultHeight = geometry_row_height(defaultHeightIn, DEFAULT_ROW_HEIGHT_PX);
    const kept: RowHeightRun[] = [];
    let previous_end = 0;
    for (const input of runs) {
        if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.count)) continue;
        const run = { ...input, height: geometry_row_height(input.height, defaultHeight) };
        const start = Math.max(run.start, previous_end, 0);
        const end = Math.min(run.start + run.count, rowCount);
        if (end <= start) continue;
        previous_end = end;
        if (run.height === defaultHeight) continue;
        const last = kept[kept.length - 1];
        if (last !== undefined && last.start + last.count === start && last.height === run.height) {
            kept[kept.length - 1] = { start: last.start, count: last.count + end - start, height: run.height };
        } else {
            kept.push({ start, count: end - start, height: run.height });
        }
    }
    const starts = kept.map((run) => run.start);
    // Each run's absolute top, accumulated from positive lengths so that no
    // intermediate value exceeds the true top (exact while it fits, §0).
    const run_tops: number[] = [];
    let at_y = 0;
    let at_row = 0;
    for (const run of kept) {
        at_y += (run.start - at_row) * defaultHeight;
        run_tops.push(at_y);
        at_y += run.count * run.height;
        at_row = run.start + run.count;
    }
    // The number of runs starting at or before `row`.
    const runs_through = (row: number): number => {
        let low = 0;
        let high = starts.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (starts[middle]! <= row) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    const height = (row: number): number => {
        if (!Number.isInteger(row) || row < 0 || row >= rowCount) return defaultHeight;
        const run = kept[runs_through(row) - 1];
        return run !== undefined && row < run.start + run.count ? run.height : defaultHeight;
    };
    const top = (rowIn: number): number => {
        const row = Math.floor(rowIn);
        // The last run starting before `row`, then its rows or the gap after it.
        const at = runs_through(row - 1) - 1;
        const run = kept[at];
        if (run === undefined) return row * defaultHeight;
        const end = run.start + run.count;
        return row <= end
            ? run_tops[at]! + (row - run.start) * run.height
            : run_tops[at]! + run.count * run.height + (row - end) * defaultHeight;
    };
    const run_top = (index: number): number => run_tops[index]!;
    const rowAtY = (y: number): number => {
        if (Number.isNaN(y) || y <= 0) return 0;
        if (y === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
        // The last run starting at or above y.
        let low = 0;
        let high = kept.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (run_top(middle) <= y) low = middle + 1;
            else high = middle;
        }
        let row: number;
        const run = kept[low - 1];
        if (run === undefined) {
            row = Math.floor(y / defaultHeight);
        } else {
            const start_top = run_top(low - 1);
            const end_top = start_top + run.count * run.height;
            row = y < end_top
                ? run.start + Math.floor((y - start_top) / run.height)
                : run.start + run.count + Math.floor((y - end_top) / defaultHeight);
        }
        if (!(row < Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
        // Inside the exact range (§0 of the plan) the division lands on the
        // row; past it, rounding can leave it one off. Settle by the index's
        // own sums, a few steps at most.
        for (let step = 0; step < 4 && row > 0 && top(row) > y; step++) row -= 1;
        for (let step = 0; step < 4 && top(row + 1) <= y; step++) row += 1;
        return row;
    };
    return Object.freeze({
        rowCount,
        defaultHeight,
        runs: Object.freeze(kept),
        height,
        top,
        rowAtY,
    });
}

/** A row-height callable that carries its index, as the grid takes it. */
export type IndexedRowHeight = ((row: number) => number) & { readonly rowHeightIndex: RowHeightIndex };

/** The index's `height` as a callable carrying the index. */
export function indexed_row_height(index: RowHeightIndex): IndexedRowHeight {
    const height = (row: number): number => index.height(row);
    return Object.freeze(Object.assign(height, { rowHeightIndex: index }));
}
