import { GridCellKind, type GridCell } from '@glideapps/glide-data-grid';
import type { RenderedCell } from '../data-source/interface';
import type { MergeIndex } from './merge-index';

/**
 * Cell-content construction for the Glide grid (Phase D). Pure (no canvas, no
 * Glide runtime beyond the erased-at-build enum/type), so it is unit-tested
 * directly. The hybrid merge mechanism from Spike D0:
 *
 *  - **Horizontal-only merges** (rowSpan === 1): every cell in the span — anchor
 *    and covered — returns the anchor's content plus `span: [startCol, endCol]`.
 *    Glide draws one block and clips interior vertical gridlines out. Echoing the
 *    content on covered cells is required: otherwise a covered column repaints
 *    blank over the anchor, and a span whose anchor column is scrolled off draws
 *    empty.
 *  - **Vertical / 2D merges** (rowSpan > 1): the anchor and all covered cells
 *    render blank with no span; the transparent overlay canvas paints the block
 *    (content + border that covers the interior horizontal gridlines Glide can't
 *    suppress for multi-row spans).
 *  - **Plain cells**: text with raw/formatted + optional bold/italic font.
 */

/** CSS font shorthand fragment for Glide's `baseFontStyle` (family/size context
 *  comes from the theme). Undefined when neither flag is set so the theme font
 *  wins. */
export function font_style(bold: boolean, italic: boolean): string | undefined {
    if (!bold && !italic) return undefined;
    const parts: string[] = [];
    if (italic) parts.push('italic');
    if (bold) parts.push('600');
    parts.push('13px');
    return parts.join(' ');
}

const BLANK: GridCell = {
    kind: GridCellKind.Text,
    data: '',
    displayData: '',
    allowOverlay: false,
};

function text_cell(
    c: RenderedCell,
    show_formatting: boolean,
    span?: [number, number],
): GridCell {
    const style = show_formatting ? font_style(c.bold, c.italic) : undefined;
    return {
        kind: GridCellKind.Text,
        data: c.raw ?? '',
        displayData: c.formatted,
        allowOverlay: false,
        ...(style ? { themeOverride: { baseFontStyle: style } } : {}),
        ...(span ? { span } : {}),
    };
}

/**
 * Build the `GridCell` for (row, col). `cells` is the current row's data (from
 * the paged loader), or undefined while the page is still loading.
 */
export function build_grid_cell(
    row: number,
    col: number,
    cells: (RenderedCell | null)[] | undefined,
    merge_index: MergeIndex,
    show_formatting: boolean,
): GridCell {
    const entry = merge_index.entry_at(row, col);

    if (entry) {
        if (entry.horizontalOnly) {
            // Anchor lives in the same row; echo its content + span on every
            // cell of the span.
            const anchor_cell = cells ? cells[entry.startCol] : undefined;
            if (!anchor_cell) return { ...BLANK, span: [entry.startCol, entry.endCol] };
            return text_cell(anchor_cell, show_formatting, [entry.startCol, entry.endCol]);
        }
        // rowSpan > 1: the overlay paints content; keep the Glide cell blank.
        return BLANK;
    }

    const c = cells ? cells[col] : undefined;
    if (!c) return BLANK;
    return text_cell(c, show_formatting);
}
