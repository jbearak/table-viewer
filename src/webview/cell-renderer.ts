import { GridCellKind, type GridCell } from './glide-data-grid';
import type { RenderedCell } from '../data-source/interface';
import { has_line_break, normalize_line_breaks } from './line-breaks';

/**
 * Cell-content construction for the Glide grid. Pure (no canvas, no Glide
 * runtime beyond the erased-at-build enum/type), so it is unit-tested directly.
 *
 * Merged cells need no handling here: the vendored grid resolves merges
 * internally from the `mergedRanges` prop — its draw loop asks this callback
 * for the *anchor's* coordinates and paints one block at the merge's full
 * bounds, so every cell simply returns its own content.
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

/**
 * Per-cell editing state, supplied by the grid shell whenever the sheet is
 * editable, an edit exists, or a highlight applies. Colors are theme-resolved by
 * the caller to keep this module canvas/theme-free.
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

/**
 * Shared cell for the no-content, no-overlay case (an unloaded page, a null
 * cell on a read-only sheet). getCellContent runs once per visible cell per
 * draw with no caching above it, so returning one immutable object instead of
 * synthesizing a fresh GridCell keeps scrolling an unloaded region
 * allocation-free.
 */
const BLANK: GridCell = {
    kind: GridCellKind.Text,
    data: '',
    displayData: '',
    allowOverlay: false,
};

/** Shared rendering/measurement rule: hard breaks always wrap; otherwise only
 * cells with enough effective vertical space take Glide's wrapping path. Put
 * the known boolean first so tall cells skip the text scan on every draw. */
export function cell_allows_wrapping(text: string, soft_wrap = false): boolean {
    return soft_wrap || has_line_break(text);
}

function text_cell(
    c: RenderedCell,
    show_formatting: boolean,
    overlay?: CellEditOverlay,
    font_size_px: number = DEFAULT_CELL_FONT_SIZE_PX,
    soft_wrap = false,
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
    //
    // Only the displayed text has its line breaks normalized: Glide's renderer,
    // wrapper, and column measurer split on `\n` alone, so a CRLF or bare CR
    // (CHAR(13) / vbCr in Excel, either in CSV fields) would render and measure
    // as one line while the app's fit/overflow/row-height models treat it as a
    // break. Normalizing `data` too would silently rewrite the value on the
    // next edit or copy.
    const display = normalize_line_breaks(
        overlay?.dirty_value ?? (show_formatting ? c.formatted : (c.raw ?? '')),
    );
    return {
        kind: GridCellKind.Text,
        data: overlay?.dirty_value ?? (c.raw ?? ''),
        displayData: display,
        allowOverlay: overlay?.editable ?? false,
        // Wrap on a hard line break, or whenever the caller says the row is tall
        // enough for wrapping to show (`soft_wrap`: row height above the default).
        // Deliberately more eager than Excel, which wraps only wrapText-styled
        // cells — here a taller row should always reveal more of its content, so
        // the source style is not consulted (the parsers do not even read it).
        // Not unconditional, though: with allowWrapping Glide routes the draw
        // through canvas-hypertxt's wrap layout, whose 500-entry cache a wide
        // viewport churns every frame, so a default-height row — where wrapping
        // could only ever show one line anyway — keeps the cheap truncating
        // single-line path.
        ...(cell_allows_wrapping(display, soft_wrap) ? { allowWrapping: true } : {}),
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
    };
}

/**
 * Build the `GridCell` for a column of the given row. `cells` is the row's data
 * (from the paged loader), or undefined while the page is still loading. A
 * missing cell renders blank — still editable in edit mode (the overlay's
 * dirty value / tint apply), read-only otherwise. `soft_wrap` marks the row as
 * taller than the default, which turns on soft wrapping for its cells.
 */
export function build_grid_cell(
    col: number,
    cells: (RenderedCell | null)[] | undefined,
    show_formatting: boolean,
    overlay?: CellEditOverlay,
    font_size_px: number = DEFAULT_CELL_FONT_SIZE_PX,
    soft_wrap = false,
): GridCell {
    const c = cells?.[col];
    if (!c && !overlay) return BLANK;
    return text_cell(c ?? EMPTY_CELL, show_formatting, overlay, font_size_px, soft_wrap);
}
