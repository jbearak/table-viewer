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

/** A run as it appears in the source, before cell-font inheritance resolves. */
export interface ParsedSourceRun {
    readonly text: string;
    /** Absent when the run had no `<rPr>` — it inherits the cell font. A
     *  present `<rPr>` REPLACES the cell font (OOXML semantics), so missing
     *  properties inside it are false, not inherited. */
    readonly style?: CellTextStyle;
    readonly inherits_cell_font: boolean;
}

export interface ParsedXlsxString {
    readonly text: string;
    /** Present only when the source string had `<r>` runs. */
    readonly runs?: readonly ParsedSourceRun[];
}

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

/** Parse the four supported properties out of an `<rPr>` body. Unsupported
 *  properties (font, color, size, vertAlign, …) are ignored. */
export function parse_run_properties(rpr_inner: string): CellTextStyle | undefined {
    return normalize_text_style({
        ...(prop_on(rpr_inner, 'b') ? { bold: true } : {}),
        ...(prop_on(rpr_inner, 'i') ? { italic: true } : {}),
        ...(underline_on(rpr_inner) ? { underline: true } : {}),
        ...(prop_on(rpr_inner, 'strike') ? { strikethrough: true } : {}),
    });
}

/**
 * Parse the inner XML of an `<si>` or `<is>` element. Handles the plain
 * single-`<t>` form and the rich `<r>` form; `<rPh>` phonetic runs are skipped
 * by the boundary-aware `<r>` scan exactly as the legacy flattening did.
 */
export function parse_xlsx_string_item(inner: string): ParsedXlsxString {
    if (inner.indexOf('<r>') === -1 && inner.indexOf('<r ') === -1) {
        const t = get_text(inner, 't');
        return { text: t !== null ? decode_xml(t) : '' };
    }
    const runs: ParsedSourceRun[] = [];
    let text = '';
    iter_elements(inner, 'r', (_open, r_inner) => {
        const t = get_text(r_inner, 't');
        if (t === null) return;
        const run_text = decode_xml(t);
        text += run_text;
        const rpr = get_text(r_inner, 'rPr');
        if (rpr === null) {
            runs.push({ text: run_text, inherits_cell_font: true });
        } else {
            const style = parse_run_properties(rpr);
            runs.push({
                text: run_text,
                ...(style ? { style } : {}),
                inherits_cell_font: false,
            });
        }
    });
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

/**
 * Bind a parsed string's runs to a referencing cell's font, producing
 * effective runs — or undefined when the result carries no information beyond
 * the whole-cell flags (every run resolves to exactly the cell style), so
 * plain strings stay cheap.
 */
export function resolve_rich_text_runs(
    parsed: ParsedXlsxString,
    cell_style: CellTextStyle | undefined,
): RichText | undefined {
    if (!parsed.runs) return undefined;
    let all_cell_style = true;
    const runs = parsed.runs.map((run) => {
        const style = run.inherits_cell_font ? cell_style : run.style;
        if (!text_styles_equal(style, cell_style)) all_cell_style = false;
        return style ? { text: run.text, style } : { text: run.text };
    });
    if (all_cell_style) return undefined;
    return normalize_rich_text({ runs });
}
