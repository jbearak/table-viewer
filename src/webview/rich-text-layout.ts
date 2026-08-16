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
import type { CellTextStyle, RichTextRun } from '../cell-content';
import { LINE_BREAK_RE } from './line-breaks';

/** A maximal same-style stretch of one visual line. */
export interface RichTextSegment {
    readonly text: string;
    readonly style?: CellTextStyle;
}

/** One visual line: its segments in order. A blank line has no segments. */
export type RichTextLine = readonly RichTextSegment[];

/**
 * Split runs into visual lines. Line breaks never carry style themselves; a
 * run containing breaks contributes a segment to each line it spans. Empty
 * segments are dropped (they render nothing), but empty *lines* survive so
 * vertical layout matches the plain-text renderer's line count.
 */
export function rich_text_lines(runs: readonly RichTextRun[]): RichTextLine[] {
    const lines: RichTextSegment[][] = [[]];
    for (const run of runs) {
        const parts = run.text.split(LINE_BREAK_RE);
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
