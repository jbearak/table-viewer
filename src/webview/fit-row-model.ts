/**
 * Pure row auto-fit model: the height a row needs to show every line its cells
 * paint, from the line counts the painters themselves produce (GridShell
 * counts them with Glide's `splitMultiLineText` and the rich renderer's
 * `rich_cell_wrapped_lines`, both canvas-bound). Kept free of canvas so the
 * height rule unit-tests on its own.
 */
import {
    CELL_TOOLTIP_HORIZONTAL_PADDING_PX,
} from './cell-overflow-model';
import { clamp_row_height } from './row-heights';

/** What a fitted height has to satisfy, for the grid's current font. */
export interface RowFitMetrics {
    /** The painters' em box: ascent plus descent of the base font. */
    readonly em_height: number;
    /** Glide's unitless `theme.lineHeight` (1.4). */
    readonly line_height_ratio: number;
    /** Glide's `theme.cellVerticalPadding`. */
    readonly cell_vertical_padding: number;
    /** The hover tooltip's per-line height (`line_height_for_font`). */
    readonly tooltip_line_height: number;
    /** The default row height for the font: no row fits below it. */
    readonly default_row_height: number;
}

/**
 * The height `lines` visual lines need, or the default when they fit on one.
 *
 * Two readers decide whether a cell shows all of its lines, and the height has
 * to satisfy both:
 *
 * - the painters (`drawMultiLineText`, the rich renderer) clip once
 *   `em + lineHeight * em * (lines - 1)` plus the vertical padding no longer
 *   fits; padding is counted on both sides, so the block sits clear of the
 *   borders rather than touching the bottom one;
 * - the hover tooltip (`text_overflows_cell`) reports a cell as truncated when
 *   `lines * line_height` exceeds the height less its 8px padding.
 *
 * Rounded up to a whole pixel, floored at the default and clamped like every
 * stored height.
 */
export function fit_height_for_lines(lines: number, metrics: RowFitMetrics): number {
    if (lines <= 1) return metrics.default_row_height;
    const painter = metrics.em_height
        + metrics.line_height_ratio * metrics.em_height * (lines - 1)
        + 2 * metrics.cell_vertical_padding;
    const tooltip = lines * metrics.tooltip_line_height + CELL_TOOLTIP_HORIZONTAL_PADDING_PX;
    return clamp_row_height(Math.max(
        metrics.default_row_height,
        Math.ceil(Math.max(painter, tooltip)),
    ));
}

/**
 * A row's fitted height from the visual line counts of its measured cells.
 *
 * `keep_at_least` is the row's current height when the row must not shrink:
 * one inside a vertical merge, whose block paints across rows this fit does
 * not size.
 */
export function fit_row_height(
    line_counts: Iterable<number>,
    metrics: RowFitMetrics,
    keep_at_least?: number,
): number {
    let lines = 1;
    for (const count of line_counts) if (count > lines) lines = count;
    const fitted = fit_height_for_lines(lines, metrics);
    return keep_at_least === undefined ? fitted : Math.max(fitted, keep_at_least);
}

/** One fitted source row. */
export interface FittedSourceRow {
    readonly source_row: number;
    /** `null`: the row needs no custom height (it fits the default). */
    readonly height: number | null;
}

/**
 * Ascending runs of consecutive source rows sharing one fitted height, in the
 * shape `setSourceRowHeights` takes. Rows may arrive in display order, which a
 * sort or a move makes unrelated to source order; a row named twice keeps its
 * last height.
 */
export function source_height_runs(
    rows: readonly FittedSourceRow[],
): { start: number; end: number; height: number | null }[] {
    const by_row = new Map<number, number | null>();
    for (const row of rows) by_row.set(row.source_row, row.height);
    const sorted = [...by_row.keys()].sort((left, right) => left - right);
    const runs: { start: number; end: number; height: number | null }[] = [];
    for (const source_row of sorted) {
        const height = by_row.get(source_row)!;
        const last = runs[runs.length - 1];
        if (last !== undefined && last.end === source_row - 1 && last.height === height) {
            last.end = source_row;
        } else {
            runs.push({ start: source_row, end: source_row, height });
        }
    }
    return runs;
}
