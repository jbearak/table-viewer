import type { MergeEntry } from './merge-index';
import { font_style } from './cell-renderer';

/**
 * Pure geometry/selection helpers for the merge overlay (Phase D, D-wire-2).
 *
 * Vertical and 2D merges (rowSpan > 1) cannot use Glide's native horizontal-only
 * `cell.span`, so they are painted by a transparent canvas stacked above the
 * grid (see {@link MergeOverlay}). These helpers are the testable core: choosing
 * which merges the overlay owns, hit-testing them against the visible region,
 * and converting Glide's client-space `getBounds` rectangles into overlay-local
 * paint rectangles. No DOM/canvas here so they unit-test in plain node.
 */

/** A client/screen-space rectangle, matching Glide's `Rectangle`. */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Point {
    x: number;
    y: number;
}

/**
 * Cell-coordinate visible region as reported by Glide's `onVisibleRegionChanged`
 * (`x` = first visible column, `y` = first visible row, `width`/`height` =
 * column/row counts).
 */
export interface CellRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Merges the overlay is responsible for: any spanning more than one row. The
 *  horizontal-only merges (rowSpan === 1) are drawn by Glide's native span. */
export function overlay_entries(entries: readonly MergeEntry[]): MergeEntry[] {
    return entries.filter((e) => e.rowSpan > 1);
}

/** True when the merge block's cell range overlaps the visible region (inclusive
 *  on both axes). */
export function block_intersects_region(
    entry: MergeEntry,
    region: CellRegion,
): boolean {
    const region_end_row = region.y + region.height - 1;
    const region_end_col = region.x + region.width - 1;
    return (
        entry.startRow <= region_end_row &&
        entry.endRow >= region.y &&
        entry.startCol <= region_end_col &&
        entry.endCol >= region.x
    );
}

/**
 * Overlay-local paint rectangle for a merge block. `top_left` / `bottom_right`
 * are the client-space bounds of the block's first and last cells (from Glide's
 * `getBounds`); `origin` is the overlay canvas's own client origin (its
 * `getBoundingClientRect` x/y). The block rect is the union of the two cell
 * rects, translated into the canvas's local coordinate space.
 */
export function overlay_block_rect(
    top_left: Rect,
    bottom_right: Rect,
    origin: Point,
): Rect {
    const x = top_left.x - origin.x;
    const y = top_left.y - origin.y;
    const right = bottom_right.x + bottom_right.width - origin.x;
    const bottom = bottom_right.y + bottom_right.height - origin.y;
    return { x, y, width: right - x, height: bottom - y };
}

/** Canvas `font` shorthand for a block's content: the bold/italic style (or a
 *  bare size when neither flag is set) with the theme font family appended. */
export function block_font(
    bold: boolean,
    italic: boolean,
    family: string,
): string {
    const base = font_style(bold, italic) ?? '13px';
    return `${base} ${family}`;
}
