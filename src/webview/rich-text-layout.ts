/**
 * Pure line layout for rich cell text: split styled runs into visual lines at
 * hard line breaks (LF, CRLF, bare CR — the canonical rule in line-breaks.ts).
 * No measurement happens here; the renderer and the column fitter measure the
 * returned segments with their own canvas context and per-segment fonts, so
 * this module stays canvas-free and directly unit-testable.
 *
 * Soft wrapping is deliberately absent: rich cells render hard breaks only in
 * v1 (wrapping styled segments would need a run-aware re-implementation of
 * canvas-hypertxt for marginal benefit).
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
        let width = 0;
        for (const segment of line) {
            width += measure(segment.text, segment.style);
        }
        if (width > max) max = width;
    }
    return max;
}
