/**
 * Canonical, format-neutral model of rich cell content.
 *
 * A cell's text either carries one whole-cell style (`CellTextStyle`) or is
 * split into runs (`RichText`), each with its own *effective* style — what the
 * run actually looks like, after any OOXML inheritance against the cell font
 * has been resolved by the parser. Nothing downstream (storage, transport,
 * dirty state, rendering, writing) re-derives inheritance.
 *
 * Markdown is deliberately absent here: it is an editor serialization handled
 * by rich-text-markdown.ts, never the stored value.
 */

/** Effective visual style of a run or a whole cell. Sparse: absent = false. */
export interface CellTextStyle {
    readonly bold?: true;
    readonly italic?: true;
    readonly underline?: true;
    readonly strikethrough?: true;
}

export interface RichTextRun {
    readonly text: string;
    /** Effective style; absent means plain. Never an empty object after
     *  normalization. */
    readonly style?: CellTextStyle;
}

/** Normalized rich text: no empty runs, no adjacent runs with equal styles,
 *  empty text = `{ runs: [] }`. Concatenated run text is the cell's plain
 *  value. */
export interface RichText {
    readonly runs: readonly RichTextRun[];
}

/** A cell hyperlink. Excel's model: at most one per cell, targeting either an
 *  external URL or a location inside the workbook. */
export type CellHyperlink =
    | { readonly kind: 'external'; readonly target: string; readonly tooltip?: string }
    | { readonly kind: 'internal'; readonly location: string; readonly tooltip?: string };

/** The rich-content fields shared by the parser's CellData and the webview's
 *  RenderedCell — declared once so a new field cannot be added to one model
 *  and forgotten on the other. All sparse: absent = plain cell. */
export interface RichCellFields {
    /** Whole-cell underline from the cell's font. Absent = false. */
    underline?: boolean;
    /** Whole-cell strikethrough from the cell's font. Absent = false. */
    strikethrough?: boolean;
    /**
     * Character-level runs, present only when the source string carries them.
     * Run styles are EFFECTIVE (inheritance against the cell font already
     * resolved by the parser); concatenated run text equals the raw text.
     */
    richText?: RichText;
    /** The cell's hyperlink (Excel: at most one per cell). */
    hyperlink?: CellHyperlink;
}

const STYLE_KEYS = ['bold', 'italic', 'underline', 'strikethrough'] as const;

/** Drop false/absent fields; return undefined for an all-plain style. */
export function normalize_text_style(
    style: CellTextStyle | undefined,
): CellTextStyle | undefined {
    if (!style) return undefined;
    let out: { -readonly [K in keyof CellTextStyle]?: true } | undefined;
    for (const key of STYLE_KEYS) {
        if (style[key]) (out ??= {})[key] = true;
    }
    return out;
}

export function text_styles_equal(
    left: CellTextStyle | undefined,
    right: CellTextStyle | undefined,
): boolean {
    for (const key of STYLE_KEYS) {
        if ((left?.[key] ?? false) !== (right?.[key] ?? false)) return false;
    }
    return true;
}

/** Union of two styles: any property true in either is true in the result. */
/** Enforce the RichText invariants: remove empty runs, normalize styles, and
 *  merge adjacent runs whose styles are equal. */
export function normalize_rich_text(value: RichText): RichText {
    const runs: RichTextRun[] = [];
    for (const run of value.runs) {
        if (run.text === '') continue;
        const style = normalize_text_style(run.style);
        const prev = runs[runs.length - 1];
        if (prev && text_styles_equal(prev.style, style)) {
            runs[runs.length - 1] = { text: prev.text + run.text, ...(prev.style ? { style: prev.style } : {}) };
        } else {
            runs.push(style ? { text: run.text, style } : { text: run.text });
        }
    }
    return { runs };
}

/** Semantic equality of two already-arbitrary rich values (normalizes both). */
export function rich_text_equal(left: RichText, right: RichText): boolean {
    const a = normalize_rich_text(left).runs;
    const b = normalize_rich_text(right).runs;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].text !== b[i].text) return false;
        if (!text_styles_equal(a[i].style, b[i].style)) return false;
    }
    return true;
}

export function rich_text_plain_text(value: RichText): string {
    let text = '';
    for (const run of value.runs) text += run.text;
    return text;
}

export function rich_text_from_plain(text: string, style?: CellTextStyle): RichText {
    if (text === '') return { runs: [] };
    const normalized = normalize_text_style(style);
    return { runs: [normalized ? { text, style: normalized } : { text }] };
}

/** True when any run carries any style. */
export function rich_text_has_styles(value: RichText): boolean {
    return value.runs.some((run) => normalize_text_style(run.style) !== undefined);
}

export function hyperlinks_equal(
    left: CellHyperlink | null | undefined,
    right: CellHyperlink | null | undefined,
): boolean {
    if (!left || !right) return !left === !right;
    if (left.kind !== right.kind) return false;
    if ((left.tooltip ?? '') !== (right.tooltip ?? '')) return false;
    if (left.kind === 'external' && right.kind === 'external') {
        return left.target === right.target;
    }
    if (left.kind === 'internal' && right.kind === 'internal') {
        return left.location === right.location;
    }
    return false;
}
