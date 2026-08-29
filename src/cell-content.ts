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

import { is_plain_record } from './plain-record';

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

/** Drop false/absent fields; return undefined for an all-plain style. Accepts
 *  loose boolean flags (e.g. a cell's whole-cell font fields) since dropping
 *  falsy fields is exactly this function's job. */
export function normalize_text_style(
    style: { readonly [K in keyof CellTextStyle]?: boolean } | undefined,
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

/**
 * Whether the formatting of text retained across an edit stayed the same.
 *
 * Formatting is only reported as changed when the two values give us evidence
 * of it. Equal text can be compared exactly. For changed text, the length of
 * a longest retained character sequence is compared with the longest sequence
 * that also preserves style. This matters for repeated characters: deleting the
 * first bold `A` from `AA` may retain the second plain `A`, so greedily pairing
 * the two first characters would invent a formatting change. Inserted or deleted
 * characters do not count as formatting changes by themselves.
 */
export function rich_text_formatting_equal(left: RichText, right: RichText): boolean {
    const a = normalize_rich_text(left);
    const b = normalize_rich_text(right);
    const a_text = rich_text_plain_text(a);
    const b_text = rich_text_plain_text(b);
    if (a_text === b_text) return rich_text_equal(a, b);
    // With no retained character there is no formatting evidence to compare.
    if (a_text === '' || b_text === '') return true;

    // The common case for a text-only external edit needs no alignment at all.
    // It also keeps large plain cells from allocating one object per code point
    // merely to prove that neither side carries formatting.
    if (!rich_text_has_styles(a) && !rich_text_has_styles(b)) return true;

    // Check the budget before expanding into code points. UTF-16 length is an
    // upper bound on code-point count, so this may conservatively omit a note for
    // astral-heavy text but can never invent a formatting change.
    if (a_text.length * b_text.length > 1_000_000) return true;

    const expand = (value: RichText): Array<{
        readonly character: string;
        readonly style: CellTextStyle | undefined;
    }> => value.runs.flatMap((run) => Array.from(run.text, (character) => ({
        character,
        style: run.style,
    })));
    const a_characters = expand(a);
    const b_characters = expand(b);

    const lcs_length = (styles_must_match: boolean): number => {
        const [rows, columns] = a_characters.length >= b_characters.length
            ? [a_characters, b_characters]
            : [b_characters, a_characters];
        let previous = new Uint32Array(columns.length + 1);
        let current = new Uint32Array(columns.length + 1);
        for (const row of rows) {
            current.fill(0);
            for (let column = 0; column < columns.length; column += 1) {
                const candidate = columns[column];
                const matches = row.character === candidate.character
                    && (!styles_must_match || text_styles_equal(row.style, candidate.style));
                current[column + 1] = matches
                    ? previous[column] + 1
                    : Math.max(previous[column + 1], current[column]);
            }
            [previous, current] = [current, previous];
        }
        return previous[columns.length];
    };

    return lcs_length(false) === lcs_length(true);
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

// --- Validation (durable state and wire payloads are untrusted) ---

const MAX_RUNS_PER_CELL = 4096;

function is_valid_style(value: unknown): boolean {
    if (!is_plain_record(value)) return false;
    for (const [key, flag] of Object.entries(value)) {
        if (key !== 'bold' && key !== 'italic' && key !== 'underline' && key !== 'strikethrough') {
            return false;
        }
        if (flag !== true) return false;
    }
    return true;
}

export function is_valid_rich_text(value: unknown): value is RichText {
    if (!is_plain_record(value) || !Array.isArray(value.runs)) return false;
    if (value.runs.length > MAX_RUNS_PER_CELL) return false;
    for (const run of value.runs) {
        if (!is_plain_record(run) || typeof run.text !== 'string') return false;
        if (run.style !== undefined && !is_valid_style(run.style)) return false;
    }
    return true;
}

/**
 * A well-formed rich-text value whose concatenated run text equals `text`.
 *
 * The text-agreement half is a security boundary shared by the durable
 * validator and the wire sanitizer: base validation and the CSV serializer see
 * an entry's string sides, but the xlsx writer writes the runs' text when
 * styled — runs spelling different text would smuggle a value past both.
 */
export function is_matching_rich_text(value: unknown, text: string): value is RichText {
    return is_valid_rich_text(value) && rich_text_plain_text(value) === text;
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
