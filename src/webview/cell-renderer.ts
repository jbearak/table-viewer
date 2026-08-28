import { GridCellKind, direction, type CustomCell, type GridCell } from './glide-data-grid';
import type { RenderedCell } from '../data-source/interface';
import { rich_text_from_plain, type CellTextStyle, type RichText } from '../cell-content';
import { has_line_break, normalize_line_breaks, split_lines } from './line-breaks';
import {
    rich_text_lines,
    type RichCellData,
    type RichTextLine,
    type RichTextSegment,
} from './rich-text-layout';
import { choose_diff_mode, word_diff } from './word-diff';
import { UNKNOWN_XLSX_FORMULA_RESULT } from '../xlsx-formula';

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
    /** Raw dirty text used for editing, copying, diffing, and saving. */
    dirty_value?: string;
    /** Formatting-on paint text for a scalar dirty XLSX value. */
    dirty_display?: string;
    /**
     * What the edit overlay opens with, when it differs from the displayed
     * text — the markdown serialization of the cell's effective rich content
     * (or of the dirty entry's runs) on sheets that edit as markdown. Absent
     * on plain sheets, where the editor opens with the raw text as before.
     */
    edit_value?: string;
    /** Parsed rich value of a dirty Markdown edit. This is the paint authority
     * while the workbook has not yet been saved and reloaded. */
    dirty_rich?: RichText;
    /** The dirty XLSX value is a formula whose calculated result is unknown. */
    formula_result_pending?: true;
    /** themeOverride background tint for dirty / conflicted cells. */
    bg?: string;
    /** The "before" text to diff against the cell's current text. The Diff
     * toggle supplies it with `dirty_value` (pre-edit vs edited text); git
     * compare mode supplies the raw or formatted original spelling selected for
     * the active Formatting state. */
    diff_base?: string;
    /** Git compare: this cell belongs to a deleted row, whose content *is* the
     * original text — struck through whole, with no "after" side to diff. */
    compare_deleted?: boolean;
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

/** Resolved theme colors for Diff mode's before/after text. Literal strings
 *  (GridShell resolves them from the VS Code theme) so this module stays
 *  theme-free; the fallbacks keep it independently testable. */
export interface DiffColors {
    readonly deleted: string;
    readonly added: string;
}

/** The spec colors for deleted/added text when the theme provides none —
 *  also the defaults below, keeping this module independently testable.
 *  vscode-theme.ts imports these so the two cannot drift. */
export const DIFF_FALLBACK_COLORS: DiffColors = { deleted: 'red', added: 'green' };

/** Separator between the before and after halves of an arrow-form diff. */
const DIFF_ARROW = ' → ';

/**
 * Visual lines for a Diff-mode cell. Numbers and short values render as
 * `old → new` (old in the deletion color, new in the addition color); longer
 * text gets an inline word diff with deleted words struck through. Splits on
 * hard breaks the way rich_text_lines does, so multiline values lay out
 * exactly like every other rich cell.
 */
export function diff_lines(
    base: string,
    value: string,
    raw_type: RenderedCell['rawType'],
    colors: DiffColors,
): RichTextLine[] {
    const parts = choose_diff_mode(base, value, raw_type) === 'arrow'
        ? [
            { text: base, kind: 'deleted' as const },
            { text: DIFF_ARROW, kind: 'unchanged' as const },
            { text: value, kind: 'added' as const },
        ]
        : word_diff(base, value);
    const lines: RichTextSegment[][] = [[]];
    for (const part of parts) {
        const pieces = split_lines(part.text);
        for (let i = 0; i < pieces.length; i++) {
            if (i > 0) lines.push([]);
            if (pieces[i] === '') continue;
            lines[lines.length - 1].push({
                text: pieces[i],
                ...(part.kind === 'deleted'
                    ? { style: { strikethrough: true as const }, diff_color: colors.deleted }
                    : part.kind === 'added'
                        ? { diff_color: colors.added }
                        : {}),
            });
        }
    }
    return lines;
}

function pending_formula_lines(base: string, colors: DiffColors): RichTextLine[] {
    return base === ''
        ? [[{ text: UNKNOWN_XLSX_FORMULA_RESULT, diff_color: colors.added }]]
        : diff_lines(base, UNKNOWN_XLSX_FORMULA_RESULT, 'number', colors);
}

function persisted_displayed_text(
    c: RenderedCell | null | undefined,
    show_formatting: boolean,
): string {
    if (c?.formulaResultPending) return UNKNOWN_XLSX_FORMULA_RESULT;
    return show_formatting ? c?.formatted ?? '' : c?.raw ?? '';
}

/** Visual lines for a compare-deleted cell: the whole text struck through in
 *  the deletion color, split on hard breaks like every other rich cell. */
function deleted_lines(text: string, colors: DiffColors): RichTextLine[] {
    return split_lines(text).map((line) =>
        line === ''
            ? []
            : [{
                text: line,
                style: { strikethrough: true as const },
                diff_color: colors.deleted,
            }]);
}

/** Memoized rich cells: build_grid_cell is Glide's per-cell paint callback
 *  (every visible cell, every frame, no caching above it), and splitting runs
 *  into lines allocates — word_diff especially. RenderedCells are immutable and
 *  shared by reference from the row store, so the object is the cache key; font
 *  size, Formatting, the row-height wrapping input, and (for git compare cells)
 *  the diff base and colors are the other inputs that shape the payload.
 *  Entries die with their cells. */
const rich_cell_cache = new WeakMap<
    RenderedCell,
    {
        show_formatting: boolean;
        soft_wrap: boolean;
        diff_base: string | undefined;
        compare_deleted: boolean;
        diff_colors: DiffColors;
        cell: CustomCell<RichCellData>;
    }
>();

export function displayed_text(
    c: RenderedCell | null | undefined,
    show_formatting: boolean,
    overlay: CellEditOverlay | undefined,
): string {
    if (overlay?.formula_result_pending) {
        const base = persisted_displayed_text(c, show_formatting);
        return base === ''
            ? UNKNOWN_XLSX_FORMULA_RESULT
            : `${base}${DIFF_ARROW}${UNKNOWN_XLSX_FORMULA_RESULT}`;
    }
    if (overlay?.dirty_value !== undefined) {
        return show_formatting && overlay.diff_base === undefined
            ? overlay.dirty_display ?? overlay.dirty_value
            : overlay.dirty_value;
    }
    return persisted_displayed_text(c, show_formatting);
}

function rich_cell(
    c: RenderedCell,
    show_formatting: boolean,
    overlay: CellEditOverlay | undefined,
    font_size_px: number,
    soft_wrap = false,
    link_modifier_held = false,
    diff_colors: DiffColors = DIFF_FALLBACK_COLORS,
): CustomCell<RichCellData> {
    // Dirty edit state churns per keystroke, so it is never cached; the git
    // compare inputs (diff_base / compare_deleted) are stable per generation
    // and participate in the cache key instead — a compare page's word diffs
    // must not be recomputed every frame.
    const can_cache = overlay?.dirty_rich === undefined
        && overlay?.dirty_value === undefined
        && !overlay?.formula_result_pending;
    const cached = can_cache ? rich_cell_cache.get(c) : undefined;
    let cell = cached !== undefined
        && cached.cell.data.font_size_px === font_size_px
        && cached.show_formatting === show_formatting
        && cached.soft_wrap === soft_wrap
        && cached.diff_base === overlay?.diff_base
        && cached.compare_deleted === (overlay?.compare_deleted ?? false)
        && cached.diff_colors === diff_colors
        ? cached.cell
        : undefined;
    if (!cell) {
        // Same displayed-text rule as the Text path: the Formatting toggle switches
        // between the formatted value and the raw one (a linked date cell must show
        // '7/16/2023', not its serial). Hard breaks are sufficient to request the
        // rich multiline path; otherwise GridShell enables wrapping only after the
        // effective row/merge height exceeds one default row.
        //
        // Compare bases are selected upstream from the same Formatting state,
        // so both before and after switch together without affecting identity.
        const display = displayed_text(c, show_formatting, overlay);
        // The wrap heuristic looks at everything the cell will paint: for a
        // diff cell that includes the old text, whose hard breaks must still
        // trigger the multiline path even when the new value has none.
        const allow_wrapping = cell_allows_wrapping(display, soft_wrap)
            || (overlay?.diff_base !== undefined && has_line_break(overlay.diff_base));
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
        // Diff first: while the toggle is on, before/after replaces every other
        // spelling of a dirty cell's content, including its markdown runs. A
        // compare-deleted cell has no "after" side — its own text *is* the
        // removed original, struck through whole in the deletion color.
        const lines = overlay?.compare_deleted
            ? deleted_lines(display, diff_colors)
            : overlay?.formula_result_pending
            ? pending_formula_lines(
                persisted_displayed_text(c, show_formatting),
                diff_colors,
            )
            : overlay?.diff_base !== undefined
            ? diff_lines(overlay.diff_base, display, c.rawType, diff_colors)
            : rich_text_lines(
                show_formatting && overlay?.dirty_rich
                    ? overlay.dirty_rich.runs
                    : overlay?.dirty_value !== undefined
                        ? rich_text_from_plain(display, style).runs
                    : (show_formatting && c.richText
                        ? c.richText.runs
                        : rich_text_from_plain(display, style).runs),
            );
        cell = {
            kind: GridCellKind.Custom,
            data: {
                kind: 'rich-text',
                lines,
                ...(c.hyperlink ? { hyperlink: c.hyperlink } : {}),
                font_size_px,
                ...(allow_wrapping ? { allow_wrapping: true as const } : {}),
                // Whole-string RTL heuristic, same as Glide's Text cell.
                ...(direction(display) === 'rtl' ? { rtl: true as const } : {}),
            },
            // Copy takes the raw source text, like the Text path's `data`.
            copyData: overlay?.dirty_value ?? c.raw ?? '',
            allowOverlay: false,
            // Not this cell's turn to accept edits (see build_grid_cell's
            // gate); keep Glide's paste path closed the same way `refused`
            // does for Text.
            readonly: true,
        };
        if (can_cache) rich_cell_cache.set(c, {
            show_formatting,
            soft_wrap,
            diff_base: overlay?.diff_base,
            compare_deleted: overlay?.compare_deleted ?? false,
            diff_colors,
            cell,
        });
    }
    // Per-view state, not cell content — applied outside the cache. The
    // pointer cursor appears only while the open gesture is actually
    // available (Ctrl/Cmd held over an external link): a bare hover keeps
    // the normal cell cursor, since a plain click selects, not opens. The
    // grid reads `cursor` straight off the hovered cell.
    const pointer = link_modifier_held && c.hyperlink?.kind === 'external';
    return overlay?.bg || pointer || overlay?.editable || overlay?.edit_value !== undefined
        ? {
            ...cell,
            ...(pointer ? { cursor: 'pointer' as const } : {}),
            ...(overlay?.bg ? { themeOverride: { bgCell: overlay.bg } } : {}),
            ...(overlay?.editable ? { allowOverlay: true, readonly: false } : {}),
            ...(overlay?.dirty_value !== undefined ? { copyData: overlay.dirty_value } : {}),
            ...(overlay?.edit_value !== undefined
                ? { data: { ...cell.data, edit_value: overlay.edit_value } }
                : {}),
        }
        : cell;
}

/**
 * Whether this cell wants the rich renderer under the current Formatting
 * toggle. Text styling is a Formatting-on concern; hyperlink presentation is
 * semantic and survives the toggle. Shared so the painted cell and the
 * tooltip payload cannot answer differently.
 */
function renders_rich(c: RenderedCell, show_formatting: boolean): boolean {
    return show_formatting ? needs_rich_renderer(c) : c.hyperlink !== undefined;
}

/**
 * The rich payload the grid would paint for this cell, or undefined when it
 * renders as plain Text. Shares rich_cell's memoized build, so hover-time
 * consumers (the overflow tooltip) see exactly the lines the renderer draws.
 */
export function rich_cell_display_data(
    c: RenderedCell | null,
    show_formatting: boolean,
    font_size_px: number = DEFAULT_CELL_FONT_SIZE_PX,
    overlay?: CellEditOverlay,
    soft_wrap = false,
    diff_colors: DiffColors = DIFF_FALLBACK_COLORS,
): RichCellData | undefined {
    if (
        !(c && renders_rich(c, show_formatting))
        && !(show_formatting && overlay?.dirty_rich !== undefined)
        && !overlay?.formula_result_pending
        && overlay?.diff_base === undefined
        && !overlay?.compare_deleted
    ) return undefined;
    return rich_cell(
        c ?? EMPTY_CELL,
        show_formatting,
        overlay,
        font_size_px,
        soft_wrap,
        false,
        diff_colors,
    ).data;
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
    const display = normalize_line_breaks(displayed_text(c, show_formatting, overlay));
    return {
        kind: GridCellKind.Text,
        // `edit_value` first: on a markdown sheet the overlay editor must open
        // with the cell's markup, not the plain projection — deleting the `**`
        // around a bold cell's text is how the user un-bolds it, so the field
        // has to open with the `**` present.
        data: overlay?.edit_value ?? overlay?.dirty_value ?? (c.raw ?? ''),
        displayData: display,
        // Copy stays the plain text even when `data` is markup: Ctrl+C on an
        // editable markdown cell must put the cell's value on the clipboard,
        // not its edit-field spelling.
        ...(overlay?.edit_value !== undefined
            ? { copyData: overlay?.dirty_value ?? (c.raw ?? '') }
            : {}),
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
    link_modifier_held = false,
    diff_colors: DiffColors = DIFF_FALLBACK_COLORS,
): GridCell {
    const c = cells?.[col];
    if (!c && !overlay) return BLANK;
    // A formula cell paints its cached result, but editing is an operation on
    // the formula itself. Supplying edit_value leaves displayData and copyData
    // on the result while Glide's overlay opens with the leading `=` formula.
    const effective_overlay = c?.formula !== undefined
        && overlay?.editable
        && overlay.dirty_value === undefined
        && overlay.edit_value === undefined
        ? { ...overlay, edit_value: c.formula }
        : overlay;
    // Rich *text styling* is a Formatting-on display concern, like bold/italic
    // on the Text path; the hyperlink presentation (link color, underline,
    // pointer) is semantic and survives the toggle. Either way the rich
    // renderer remains active in edit mode. GridShell supplies an external
    // editor for editable rich cells and translates its result back to text;
    // keeping this path active makes a committed Markdown edit repaint with its
    // new runs immediately. Ctrl/Cmd+click
    // link opening reads the loaded RenderedCell in the grid shell, not this
    // GridCell, so it works either way.
    if (
        (c && renders_rich(c, show_formatting))
        || (show_formatting && overlay?.dirty_rich !== undefined)
        || overlay?.formula_result_pending
        // Diff mode paints mixed colors and strikethrough, which only the
        // rich renderer can draw — regardless of the Formatting toggle.
        || overlay?.diff_base !== undefined
        || overlay?.compare_deleted
    ) {
        return rich_cell(
            c ?? EMPTY_CELL,
            show_formatting,
            effective_overlay,
            font_size_px,
            soft_wrap,
            link_modifier_held,
            diff_colors,
        );
    }
    return text_cell(c ?? EMPTY_CELL, show_formatting, effective_overlay, font_size_px, soft_wrap);
}
