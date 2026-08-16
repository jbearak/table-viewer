/**
 * OOXML rich-string parsing shared by the sharedStrings (`<si>`) and inline
 * string (`<is>`) paths — one implementation so the two cannot diverge.
 *
 * A rich string's runs are parsed WITHOUT binding them to any cell: a run with
 * no `<rPr>` inherits the referencing cell's font, and one shared string may be
 * referenced by cells with different fonts. `resolve_rich_text_runs` performs
 * that binding per cell (with a small cache in the caller keyed by string index
 * and cell-style bits).
 */

import { get_attr, get_text, iter_elements, decode_xml } from './ooxml-xml';
import {
    normalize_rich_text,
    normalize_text_style,
    text_styles_equal,
    type CellTextStyle,
    type RichText,
} from './cell-content';
import type { FontEntry } from './spreadsheet-format';

/** A run as it appears in the source, before cell-font inheritance resolves.
 *  `style` is tri-state: absent = no `<rPr>`, the run inherits the cell font;
 *  `null` = an explicit `<rPr>` with none of the supported properties (OOXML:
 *  a present `<rPr>` REPLACES the cell font, so this run is plain); an object
 *  = explicit formatting. */
export interface ParsedSourceRun {
    readonly text: string;
    readonly style?: CellTextStyle | null;
}

/** A rich `<si>`/`<is>` — plain strings stay plain `string`s so a large
 *  sharedStrings table doesn't allocate a wrapper per entry. */
export interface ParsedRichString {
    readonly text: string;
    readonly runs: readonly ParsedSourceRun[];
}

export type ParsedXlsxString = string | ParsedRichString;

/** Parse boolean-ish OOXML property values: absent val = true. */
function prop_on(inner: string, tag: string): boolean {
    let on = false;
    iter_elements(inner, tag, (open_tag) => {
        const val = get_attr(open_tag, 'val');
        on = val === null || (val !== '0' && val !== 'false');
    });
    return on;
}

/** Underline: `<u/>` = single; val of none/0/false = off; any other value
 *  (single, double, singleAccounting, …) = on. */
function underline_on(inner: string): boolean {
    let on = false;
    iter_elements(inner, 'u', (open_tag) => {
        const val = get_attr(open_tag, 'val');
        on = val === null || (val !== 'none' && val !== '0' && val !== 'false');
    });
    return on;
}

/**
 * Parse the four supported properties out of an OOXML font-property body —
 * both `<rPr>` (run) and `<font>` (styles.xml) use the same child tags, so
 * this is the single decoder for both. Unsupported properties (name, color,
 * size, vertAlign, …) are ignored. Returns undefined when all four are off.
 */
export function parse_font_properties(inner: string): CellTextStyle | undefined {
    let style: { -readonly [K in keyof CellTextStyle]?: true } | undefined;
    if (prop_on(inner, 'b')) (style ??= {}).bold = true;
    if (prop_on(inner, 'i')) (style ??= {}).italic = true;
    if (underline_on(inner)) (style ??= {}).underline = true;
    if (prop_on(inner, 'strike')) (style ??= {}).strikethrough = true;
    return style;
}

/**
 * Parse the inner XML of an `<si>` or `<is>` element. Handles the plain
 * single-`<t>` form and the rich `<r>` form; `<rPh>` phonetic runs are skipped
 * by the boundary-aware `<r>` scan exactly as the legacy flattening did.
 */
export function parse_xlsx_string_item(inner: string): ParsedXlsxString {
    const runs: ParsedSourceRun[] = [];
    let text = '';
    iter_elements(inner, 'r', (_open, r_inner) => {
        const t = get_text(r_inner, 't');
        if (t === null) return;
        const run_text = decode_xml(t);
        text += run_text;
        const rpr = get_text(r_inner, 'rPr');
        if (rpr === null) {
            runs.push({ text: run_text });
        } else {
            runs.push({ text: run_text, style: parse_font_properties(rpr) ?? null });
        }
    });
    // No <r> runs (the boundary-aware scan also rejects <rPh>/<rPr> prefixes):
    // the plain single-<t> form.
    if (runs.length === 0) {
        const t = get_text(inner, 't');
        return t !== null ? decode_xml(t) : '';
    }
    return { text, runs };
}

/** The cell font as a sparse style, for inheritance and for whole-cell flags. */
export function font_to_style(font: FontEntry): CellTextStyle | undefined {
    return normalize_text_style({
        ...(font.bold ? { bold: true } : {}),
        ...(font.italic ? { italic: true } : {}),
        ...(font.underline ? { underline: true } : {}),
        ...(font.strikethrough ? { strikethrough: true } : {}),
    });
}

/** Compact cache key for a cell font's four flags. Lives here, next to
 *  font_to_style, so a new CellTextStyle property extends both together. */
export function font_style_bits(font: FontEntry): number {
    return (font.bold ? 1 : 0) | (font.italic ? 2 : 0)
        | (font.underline ? 4 : 0) | (font.strikethrough ? 8 : 0);
}

/** Number of distinct font_style_bits values — the cache-key stride. */
export const FONT_STYLE_BITS_RANGE = 16;

/**
 * Bind a parsed rich string's runs to a referencing cell's font, producing
 * effective runs — or undefined when the result carries no information beyond
 * the whole-cell flags (every run resolves to exactly the cell style), so
 * plain strings stay cheap.
 */
export function resolve_rich_text_runs(
    parsed: ParsedRichString,
    cell_style: CellTextStyle | undefined,
): RichText | undefined {
    let all_cell_style = true;
    const runs = parsed.runs.map((run) => {
        const style = run.style === undefined ? cell_style : run.style ?? undefined;
        if (!text_styles_equal(style, cell_style)) all_cell_style = false;
        return style ? { text: run.text, style } : { text: run.text };
    });
    if (all_cell_style) return undefined;
    return normalize_rich_text({ runs });
}
