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

/**
 * Core CSS `font` shorthand fragment shared by every font builder in the
 * webview: optional `italic` style, optional `600` weight, then `<size>px` — in
 * the order the CSS/canvas font parser requires (style → weight → size). No
 * family (callers append it when needed). A plain cell yields just `<size>px`.
 */
export function font_shorthand(bold: boolean, italic: boolean, size_px: number): string {
    const parts: string[] = [];
    if (italic) parts.push('italic');
    if (bold) parts.push('600');
    parts.push(`${size_px}px`);
    return parts.join(' ');
}

/** Default cell size, mirroring the theme's `baseFontStyle` fallback. */
export const DEFAULT_CELL_FONT_SIZE_PX = 13;

/** CSS font shorthand fragment for Glide's `baseFontStyle` (family context comes
 *  from the theme). Undefined when neither flag is set so the theme font wins;
 *  otherwise the theme's resolved size must be repeated, since a `themeOverride`
 *  replaces `baseFontStyle` wholesale. */
export function font_style(
    bold: boolean,
    italic: boolean,
    size_px: number = DEFAULT_CELL_FONT_SIZE_PX,
): string | undefined {
    if (!bold && !italic) return undefined;
    return font_shorthand(bold, italic, size_px);
}

const BLANK: GridCell = {
    kind: GridCellKind.Text,
    data: '',
    displayData: '',
    allowOverlay: false,
};

/**
 * Per-cell editing state, supplied by the grid shell whenever the sheet is
 * editable, an edit exists, or a highlight applies. Colors are theme-resolved by
 * the caller to keep this module canvas/theme-free.
 *
 * Where it is honoured, by cell shape:
 *  - plain cells, and horizontal (`rowSpan === 1`) merges: fully — dirty value,
 *    tint, and `editable`.
 *  - `rowSpan > 1` merges, anchor and covered alike: not at all. Those blocks are
 *    painted by the merge overlay canvas rather than by the Glide cell, so this
 *    returns a blank non-overlay cell and the user cannot open an editor on one.
 *    Read-only was the whole story while editing was CSV-only; with worksheet
 *    editing it is a gap, tracked separately, not a rule.
 */
export interface CellEditOverlay {
    /** When set, display this dirty value instead of the persisted content. */
    dirty_value?: string;
    /** themeOverride background tint for dirty / conflicted cells. */
    bg?: string;
    /** Open Glide's edit overlay on this cell. */
    editable?: boolean;
    /**
     * Editing is available on this sheet but we are refusing *this* cell (its
     * canonical source identity is unresolved). Distinct from `!editable`, which
     * is also true for every cell of a read-only sheet — see the `readonly` flag
     * below.
     */
    refused?: boolean;
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
    font_size_px: number = DEFAULT_CELL_FONT_SIZE_PX,
): GridCell {
    const style = show_formatting
        ? font_style(c.bold, c.italic, font_size_px)
        : undefined;
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
        // Belt and braces with `allowOverlay: false`. Glide's paste path
        // (`pasteToCell` in data-editor.js) does not consult `allowOverlay` at all
        // — it gates on `isReadWriteCell`, which for a Text cell checks only
        // `readonly !== true` — so a cell we refuse to open an overlay on would
        // still accept a paste or a cut.
        //
        // Keyed on `refused`, not on `!editable`. An overlay is supplied for any
        // cell that needs a tint or a dirty value, and cell highlights are plain
        // view state available on read-only sheets, so `!editable` would put
        // `readonly: true` on a highlighted cell of a read-only sheet — where
        // nothing was ever offered to refuse. Glide derives the DOM
        // `aria-readonly` from this flag, so that would make a cell announce
        // itself differently from its unhighlighted neighbour purely because the
        // user coloured it.
        ...(overlay?.refused ? { readonly: true } : {}),
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
    font_size_px: number = DEFAULT_CELL_FONT_SIZE_PX,
): GridCell {
    const entry = merge_index.entry_at(row, col);

    if (entry) {
        if (entry.horizontalOnly) {
            // Anchor lives in the same row; echo its content + span on every
            // cell of the span.
            const anchor_cell = cells ? cells[entry.startCol] : undefined;
            if (!anchor_cell) return { ...BLANK, span: [entry.startCol, entry.endCol] };
            return text_cell(
                anchor_cell,
                show_formatting,
                [entry.startCol, entry.endCol],
                overlay,
                font_size_px,
            );
        }
        // rowSpan > 1: the overlay canvas paints content, so the Glide cell stays
        // blank — which also drops `overlay.editable`, leaving these blocks
        // non-editable. See the `CellEditOverlay` doc comment.
        return BLANK;
    }

    const c = cells ? cells[col] : undefined;
    if (!c) {
        // In edit mode an empty cell can still be edited or hold a dirty value,
        // so synthesize a blank editable cell; otherwise it's read-only.
        return overlay
            ? text_cell(EMPTY_CELL, show_formatting, undefined, overlay, font_size_px)
            : BLANK;
    }
    return text_cell(c, show_formatting, undefined, overlay, font_size_px);
}
