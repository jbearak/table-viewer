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

/**
 * Per-cell editing state, supplied by the grid shell only in CSV edit mode
 * (CSV sheets have no merges, so this is applied solely to the plain-cell path).
 * Colors are theme-resolved by the caller to keep this module canvas/theme-free.
 */
export interface CellEditOverlay {
    /** When set, display this dirty value instead of the persisted content. */
    dirty_value?: string;
    /** themeOverride background tint for dirty / conflicted cells. */
    bg?: string;
    /** Open Glide's edit overlay on this cell. */
    editable?: boolean;
}

const EMPTY_CELL: RenderedCell = {
    raw: '',
    formatted: '',
    bold: false,
    italic: false,
};

function text_cell(
    c: RenderedCell,
    show_formatting: boolean,
    span?: [number, number],
    overlay?: CellEditOverlay,
): GridCell {
    const style = show_formatting ? font_style(c.bold, c.italic) : undefined;
    const theme_override: { baseFontStyle?: string; bgCell?: string } = {};
    if (style) theme_override.baseFontStyle = style;
    if (overlay?.bg) theme_override.bgCell = overlay.bg;
    const has_override = theme_override.baseFontStyle !== undefined || theme_override.bgCell !== undefined;
    // The Formatting toggle switches the *displayed* text between the formatted
    // value (e.g. '3.14') and the raw underlying value (e.g. '3.14159'). `data`
    // always holds the raw value so editing and copy work off the source text.
    const display = overlay?.dirty_value ?? (show_formatting ? c.formatted : (c.raw ?? ''));
    return {
        kind: GridCellKind.Text,
        data: overlay?.dirty_value ?? (c.raw ?? ''),
        displayData: display,
        allowOverlay: overlay?.editable ?? false,
        // Render hard line breaks across multiple lines so a grown row's content
        // is visible (rows auto-grow after a multiline edit in grid-shell). Not
        // applied to spanned (horizontal-merge) cells — wrapping inside a span is
        // unsupported and multiline merge text is vanishingly rare.
        ...(display.includes('\n') && !span ? { allowWrapping: true } : {}),
        ...(has_override ? { themeOverride: theme_override } : {}),
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
    overlay?: CellEditOverlay,
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
    if (!c) {
        // In CSV edit mode an empty cell can still be edited or hold a dirty
        // value, so synthesize a blank editable cell; otherwise it's read-only.
        return overlay
            ? text_cell(EMPTY_CELL, show_formatting, undefined, overlay)
            : BLANK;
    }
    return text_cell(c, show_formatting, undefined, overlay);
}
