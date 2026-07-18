/**
 * Pure column auto-fit model. Replaces the former DOM-walking column measurer:
 * the Glide grid has no `<td>`s to measure, so widths are computed from sampled
 * loaded-row text via an injected `measure` (an offscreen canvas `measureText`
 * in the grid shell). Keeping `measure` a parameter lets the fitting rule be
 * unit-tested without a canvas.
 */
import type { RenderedCell } from '../data-source/interface';
import { font_shorthand } from './cell-renderer';
import { MIN_COLUMN_WIDTH_PX } from './grid-model';

/** Smallest width a fitted column may take. Aliases the grid's clamp floor
 *  ({@link MIN_COLUMN_WIDTH_PX}) so the fit rule and manual-resize clamp share
 *  one minimum. */
export const MIN_COLUMN_WIDTH = MIN_COLUMN_WIDTH_PX;
/** Slack added to the widest measured text so glyphs don't touch the border. */
export const COLUMN_PADDING = 16;

/** The displayed text of a cell plus the font flags that change its width. */
export interface MeasurableCell {
    text: string;
    bold: boolean;
    italic: boolean;
}

/**
 * Build a CSS `font` shorthand for a canvas 2D context, matching how the grid
 * renders cells (see {@link font_shorthand} in cell-renderer): optional `italic`,
 * optional `600` weight, then `<size>px <family>`. Order matters — the canvas
 * parser expects style before weight before size.
 */
export function canvas_font(
    bold: boolean,
    italic: boolean,
    family: string,
    size = 13,
): string {
    return `${font_shorthand(bold, italic, size)} ${family}`;
}

/**
 * Fitted width for one column: the widest measured cell plus padding, never
 * below {@link MIN_COLUMN_WIDTH}. An empty column collapses to the minimum.
 */
export function fit_column_width(
    cells: readonly MeasurableCell[],
    measure: (cell: MeasurableCell) => number,
    min_width: number = MIN_COLUMN_WIDTH,
    padding: number = COLUMN_PADDING,
): number {
    let max = 0;
    for (const cell of cells) {
        const w = measure(cell);
        if (w > max) max = w;
    }
    if (max === 0) return min_width;
    return Math.max(min_width, max + padding);
}

/**
 * Fit an ordered set of source columns against source-shaped loaded rows.
 * Output remains keyed by source column so callers can merge the visible-width
 * patch without disturbing widths for hidden columns.
 */
export function fit_column_widths(
    sample: readonly Readonly<Partial<Record<number, MeasurableCell | null>>>[],
    source_columns: readonly number[],
    measure: (cell: MeasurableCell) => number,
    min_width: number = MIN_COLUMN_WIDTH,
    padding: number = COLUMN_PADDING,
): Record<number, number> {
    const widths: Record<number, number> = {};
    for (const source_column of source_columns) {
        const cells: MeasurableCell[] = [];
        for (const row of sample) {
            const cell = row[source_column];
            if (cell) cells.push(cell);
        }
        widths[source_column] = fit_column_width(cells, measure, min_width, padding);
    }
    return widths;
}

/**
 * Adapt a loaded {@link RenderedCell} to a {@link MeasurableCell}, choosing the
 * text the grid actually displays (`formatted` when formatting is on, else the
 * raw value) and dropping the bold/italic flags when formatting is off.
 */
export function measurable_from_rendered(
    cell: RenderedCell | null,
    show_formatting: boolean,
): MeasurableCell | null {
    if (!cell) return null;
    const text = show_formatting ? cell.formatted : cell.raw ?? '';
    return {
        text: text ?? '',
        bold: show_formatting && cell.bold,
        italic: show_formatting && cell.italic,
    };
}
