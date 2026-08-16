import { GridCellKind, direction, type CustomCell, type GridCell } from './glide-data-grid';
import type { RenderedCell } from '../data-source/interface';
import { rich_text_from_plain, type CellTextStyle } from '../cell-content';
import { has_line_break, normalize_line_breaks } from './line-breaks';
import { rich_text_lines, type RichCellData } from './rich-text-layout';

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

/** True when the cell carries content only the rich renderer can draw: run
 *  styles, a hyperlink, or whole-cell underline/strikethrough (the Text cell's
 *  font shorthand covers bold/italic only). */
export function needs_rich_renderer(c: RenderedCell): boolean {
    return c.richText !== undefined
        || c.hyperlink !== undefined
        || c.underline === true
        || c.strikethrough === true;
}

/** Memoized rich cells: build_grid_cell is Glide's per-cell paint callback
 *  (every visible cell, every frame, no caching above it), and splitting runs
 *  into lines allocates. RenderedCells are immutable and shared by reference
 *  from the row store, so the object is the cache key; font size and the
 *  Formatting toggle are the other inputs that shape the payload. Entries die
 *  with their cells. */
const rich_cell_cache = new WeakMap<
    RenderedCell,
    { font_size_px: number; show_formatting: boolean; cell: CustomCell<RichCellData> }
>();

function rich_cell(
    c: RenderedCell,
    show_formatting: boolean,
    overlay: CellEditOverlay | undefined,
    font_size_px: number,
): GridCell {
    const cached = rich_cell_cache.get(c);
    let cell = cached !== undefined
        && cached.font_size_px === font_size_px
        && cached.show_formatting === show_formatting
        ? cached.cell
        : undefined;
    if (!cell) {
        // Same displayed-text rule as the Text path: the Formatting toggle
        // switches between the formatted value and the raw one (a linked date
        // cell must show '7/16/2023', not its serial). Line breaks are handled
        // by rich_text_lines splitting runs on the canonical hard-break rule,
        // mirroring the Text path's normalize_line_breaks.
        const display = show_formatting ? c.formatted : (c.raw ?? '');
        // Whole-cell flags become one styled run for link/underline-only
        // cells. With formatting off only the link presentation survives
        // (mirroring the Text path dropping bold/italic): plain runs, and the
        // renderer's link color/underline keyed on `hyperlink`.
        const style: CellTextStyle | undefined = show_formatting
            ? {
                ...(c.bold ? { bold: true as const } : {}),
                ...(c.italic ? { italic: true as const } : {}),
                ...(c.underline ? { underline: true as const } : {}),
                ...(c.strikethrough ? { strikethrough: true as const } : {}),
            }
            : undefined;
        const runs = show_formatting && c.richText
            ? c.richText.runs
            : rich_text_from_plain(display, style).runs;
        cell = {
            kind: GridCellKind.Custom,
            data: {
                kind: 'rich-text',
                lines: rich_text_lines(runs),
                ...(c.hyperlink ? { hyperlink: c.hyperlink } : {}),
                font_size_px,
                // Whole-string RTL heuristic, same as Glide's Text cell.
                ...(direction(display) === 'rtl' ? { rtl: true as const } : {}),
            },
            // Copy takes the raw source text, like the Text path's `data`.
            copyData: c.raw ?? '',
            allowOverlay: false,
            // Not this cell's turn to accept edits (see build_grid_cell's
            // gate); keep Glide's paste path closed the same way `refused`
            // does for Text.
            readonly: true,
            // The grid reads `cursor` straight off the hovered cell — no
            // needsHover animation involved. Signals Ctrl/Cmd+click.
            ...(c.hyperlink ? { cursor: 'pointer' as const } : {}),
        };
        rich_cell_cache.set(c, { font_size_px, show_formatting, cell });
    }
    // The tint is per-view state, not cell content — apply outside the cache.
    return overlay?.bg
        ? { ...cell, themeOverride: { bgCell: overlay.bg } }
        : cell;
}

/**
 * The rich payload the grid would paint for this cell, or undefined when it
 * renders as plain Text. Shares rich_cell's memoized build, so hover-time
 * consumers (the overflow tooltip) see exactly the lines the renderer draws.
 */
export function rich_cell_display_data(
    c: RenderedCell,
    show_formatting: boolean,
    font_size_px: number = DEFAULT_CELL_FONT_SIZE_PX,
): RichCellData | undefined {
    if (!(show_formatting ? needs_rich_renderer(c) : c.hyperlink !== undefined)) {
        return undefined;
    }
    return (rich_cell(c, show_formatting, undefined, font_size_px) as CustomCell<RichCellData>).data;
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
    // Rich *text styling* is a Formatting-on display concern, like bold/italic
    // on the Text path; the hyperlink presentation (link color, underline,
    // pointer) is semantic and survives the toggle. Either way the rich
    // renderer steps aside whenever the cell must interact: an editable
    // overlay or a dirty value needs the Text cell (Glide's overlay editor and
    // paste path key off kind: Text), so in edit mode rich cells render plain
    // — their raw text is what stage-3 editing operates on. Ctrl/Cmd+click
    // link opening reads the loaded RenderedCell in the grid shell, not this
    // GridCell, so it works either way.
    if (
        c
        && (show_formatting ? needs_rich_renderer(c) : c.hyperlink !== undefined)
        && !overlay?.editable
        && overlay?.dirty_value === undefined
    ) {
        return rich_cell(c, show_formatting, overlay, font_size_px);
    }
    return text_cell(c ?? EMPTY_CELL, show_formatting, overlay, font_size_px, soft_wrap);
}
