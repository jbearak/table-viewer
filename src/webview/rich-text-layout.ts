/**
 * Pure line layout for rich cell text. `rich_text_lines` splits styled runs at
 * hard line breaks (LF, CRLF, bare CR — the canonical rule in line-breaks.ts),
 * while `wrap_rich_text_lines` reflows those hard lines to a measured width
 * without losing run styles. Measurement is supplied by the caller, so this
 * module stays canvas-free and directly unit-testable.
 */
import type { CellHyperlink, CellTextStyle, RichTextRun } from '../cell-content';
import { split_lines } from './line-breaks';

/** A maximal same-style stretch of one visual line. */
export interface RichTextSegment {
    readonly text: string;
    readonly style?: CellTextStyle;
}

/** One visual line: its segments in order. A blank line has no segments. */
export type RichTextLine = readonly RichTextSegment[];

/** Payload of a rich Custom grid cell — built by cell-renderer.ts, drawn by
 *  rich-text-cell-renderer.ts. Lives here so the pure builder and the canvas
 *  renderer both depend one-way on this model. */
export interface RichCellData {
    /** Discriminant for isMatch — Glide funnels every Custom cell here. */
    readonly kind: 'rich-text';
    /** Styled segments per visual line (see rich_text_lines). */
    readonly lines: readonly RichTextLine[];
    /** Present on linked cells: renders link-colored and underlined. */
    readonly hyperlink?: CellHyperlink;
    /** The grid's configured cell font size; per-segment fonts rebuild the
     *  cell font shorthand around it, so it must match the theme. */
    readonly font_size_px: number;
    /** Width-wrap each hard line inside the painted cell. Absent keeps the
     *  cheap clipping/truncation path used by a default-height single line. */
    readonly allow_wrapping?: true;
    /** Right-to-left cell text (Glide's whole-string heuristic): segments lay
     *  out from the right edge, like the built-in Text cell's RTL path. */
    readonly rtl?: true;
    /** Markdown spelling used by the external editor while this rich cell is
     * editable. Absent on ordinary read-only rich cells. */
    readonly edit_value?: string;
}

/**
 * Split runs into visual lines. Line breaks never carry style themselves; a
 * run containing breaks contributes a segment to each line it spans. Empty
 * segments are dropped (they render nothing), but empty *lines* survive so
 * vertical layout matches the plain-text renderer's line count.
 */
export function rich_text_lines(runs: readonly RichTextRun[]): RichTextLine[] {
    const lines: RichTextSegment[][] = [[]];
    for (const run of runs) {
        const parts = split_lines(run.text);
        for (let i = 0; i < parts.length; i++) {
            if (i > 0) lines.push([]);
            if (parts[i] === '') continue;
            const segment: RichTextSegment = run.style
                ? { text: parts[i], style: run.style }
                : { text: parts[i] };
            lines[lines.length - 1].push(segment);
        }
    }
    return lines;
}

interface WrapFragment extends RichTextSegment {
    readonly source: number;
}

interface WrapToken {
    readonly is_space: boolean;
    readonly fragments: WrapFragment[];
}

const grapheme_segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

function graphemes(text: string): string[] {
    return grapheme_segmenter
        ? Array.from(grapheme_segmenter.segment(text), part => part.segment)
        : Array.from(text);
}

function append_fragment(target: WrapFragment[], fragment: WrapFragment): void {
    const last = target[target.length - 1];
    if (last?.source === fragment.source) {
        target[target.length - 1] = {
            ...last,
            text: last.text + fragment.text,
        };
        return;
    }
    target.push(fragment);
}

function append_fragments(target: WrapFragment[], fragments: readonly WrapFragment[]): void {
    for (const fragment of fragments) append_fragment(target, fragment);
}

/** Tokenize only ordinary spaces as preferred wrap points, matching Glide's
 * canvas-hypertxt path. NBSP and narrow NBSP remain part of their word and use
 * the over-wide-word fallback instead. Adjacent styled fragments stay in the
 * same token, so a style boundary never becomes a word boundary. */
function wrap_tokens(line: RichTextLine): WrapToken[] {
    const tokens: WrapToken[] = [];
    for (let source = 0; source < line.length; source++) {
        const segment = line[source];
        let start = 0;
        while (start < segment.text.length) {
            const is_space = segment.text[start] === ' ';
            let end = start + 1;
            while (end < segment.text.length && (segment.text[end] === ' ') === is_space) end++;
            const fragment: WrapFragment = {
                text: segment.text.slice(start, end),
                style: segment.style,
                source,
            };
            const last = tokens[tokens.length - 1];
            if (last?.is_space === is_space) last.fragments.push(fragment);
            else tokens.push({ is_space, fragments: [fragment] });
            start = end;
        }
    }
    return tokens;
}

function rich_line_width(
    line: readonly RichTextSegment[],
    measure: (text: string, style: CellTextStyle | undefined) => number,
): number {
    let width = 0;
    for (const segment of line) width += measure(segment.text, segment.style);
    return width;
}

interface FittingPrefix {
    readonly count: number;
    readonly width: number;
}

/** Find the largest fitting prefix from `start` without measuring the entire
 * remaining suffix. Exponential search bounds the next visual line, then a
 * binary search refines that local range. For a long unbroken value this keeps
 * measured temporary text proportional to the emitted lines instead of
 * repeatedly scanning progressively smaller suffixes. */
function fitting_grapheme_prefix(
    parts: readonly string[],
    start: number,
    available_width: number,
    style: CellTextStyle | undefined,
    measure: (text: string, style: CellTextStyle | undefined) => number,
): FittingPrefix {
    const remaining = parts.length - start;
    const width_of = (count: number): number =>
        measure(parts.slice(start, start + count).join(''), style);
    let low = 0;
    let low_width = 0;
    let high = 1;

    while (high <= remaining) {
        const width = width_of(high);
        if (width > available_width) break;
        low = high;
        low_width = width;
        if (high === remaining) return { count: low, width: low_width };
        high = Math.min(remaining, high * 2);
    }

    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        const width = width_of(middle);
        if (width <= available_width) {
            low = middle;
            low_width = width;
        } else {
            high = middle;
        }
    }
    return { count: low, width: low_width };
}

/** Split one word that is wider than an empty visual line. The word can span
 * style runs; each output fragment retains its source run. Grapheme fallback
 * always emits at least one grapheme, even if that grapheme is itself wider
 * than the cell, so layout cannot stall. */
function split_overwide_word(
    fragments: readonly WrapFragment[],
    available_width: number,
    measure: (text: string, style: CellTextStyle | undefined) => number,
): WrapFragment[][] {
    const lines: WrapFragment[][] = [];
    let current: WrapFragment[] = [];
    let current_width = 0;
    const emit_current = (): void => {
        lines.push(current);
        current = [];
        current_width = 0;
    };

    for (const fragment of fragments) {
        const parts = graphemes(fragment.text);
        let offset = 0;
        while (offset < parts.length) {
            const fitting = fitting_grapheme_prefix(
                parts,
                offset,
                Math.max(0, available_width - current_width),
                fragment.style,
                measure,
            );
            if (fitting.count > 0) {
                const prefix = parts.slice(offset, offset + fitting.count).join('');
                append_fragment(current, { ...fragment, text: prefix });
                offset += fitting.count;
                current_width += fitting.width;
                if (offset < parts.length) {
                    emit_current();
                }
                continue;
            }

            if (current.length > 0) {
                emit_current();
                continue;
            }

            // Even one grapheme can be wider than the cell. Emit it by itself so
            // the layout always advances; paint/overflow retain the true width.
            append_fragment(current, { ...fragment, text: parts[offset] });
            emit_current();
            offset++;
        }
    }

    if (current.length > 0) emit_current();
    return lines;
}

function public_line(fragments: readonly WrapFragment[]): RichTextLine {
    return fragments.map(({ text, style }) => style ? { text, style } : { text });
}

/**
 * Width-wrap hard rich-text lines without flattening their styles. Ordinary
 * spaces are preferred break points; spaces at an automatic line boundary are
 * omitted, matching the plain Text renderer's trim behavior. Words wider than
 * an empty line fall back to grapheme boundaries.
 */
export function wrap_rich_text_lines(
    lines: readonly RichTextLine[],
    available_width: number,
    measure: (text: string, style: CellTextStyle | undefined) => number,
): RichTextLine[] {
    if (available_width <= 0) return lines.map(line => [...line]);

    const wrapped: RichTextLine[] = [];
    for (const hard_line of lines) {
        if (hard_line.length === 0) {
            wrapped.push([]);
            continue;
        }

        const tokens = wrap_tokens(hard_line);
        let current: WrapFragment[] = [];
        let current_width = 0;
        let pending_spaces: WrapFragment[] | undefined;

        const emit_current = (): void => {
            wrapped.push(public_line(current));
            current = [];
            current_width = 0;
        };

        for (const token of tokens) {
            if (token.is_space) {
                pending_spaces = token.fragments;
                continue;
            }

            const word_width = rich_line_width(token.fragments, measure);
            const spaces_width = pending_spaces
                ? rich_line_width(pending_spaces, measure)
                : 0;
            const wraps_before_word = current.length > 0
                && current_width + spaces_width + word_width > available_width;
            if (wraps_before_word) emit_current();

            if (
                pending_spaces
                && !wraps_before_word
                && (current.length > 0 || spaces_width + word_width <= available_width)
            ) {
                // Preserve leading hard-line spaces only when the complete first
                // word fits. Separator whitespace at a soft break is discarded.
                append_fragments(current, pending_spaces);
                current_width += spaces_width;
            }
            pending_spaces = undefined;

            if (current.length === 0 && word_width > available_width) {
                const pieces = split_overwide_word(token.fragments, available_width, measure);
                for (let i = 0; i < pieces.length - 1; i++) {
                    wrapped.push(public_line(pieces[i]));
                }
                current = pieces[pieces.length - 1] ?? [];
                current_width = rich_line_width(current, measure);
                continue;
            }

            append_fragments(current, token.fragments);
            current_width += word_width;
        }

        // Preserve trailing spaces when they fit on the final visual line. They
        // are source content (and can carry underline/strikethrough styling),
        // but never create a blank continuation line by themselves.
        if (pending_spaces) {
            const spaces_width = rich_line_width(pending_spaces, measure);
            if (current.length === 0 || current_width + spaces_width <= available_width) {
                append_fragments(current, pending_spaces);
            }
        }
        if (current.length > 0) emit_current();
        else wrapped.push([]);
    }
    return wrapped;
}

/**
 * Widest visual line, as the rich renderer draws it: each segment measured
 * with its own style, summed per line. Parameterized by the measurer so the
 * canvas renderer, the column fitter, and unit tests share one width rule.
 */
export function rich_lines_max_width(
    lines: readonly RichTextLine[],
    measure: (text: string, style: CellTextStyle | undefined) => number,
): number {
    let max = 0;
    for (const line of lines) {
        max = Math.max(max, rich_line_width(line, measure));
    }
    return max;
}
