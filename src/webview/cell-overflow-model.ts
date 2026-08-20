/**
 * Pure helpers for the truncated-cell hover tooltip.
 *
 * Glide paints cells on canvas and ellipsizes / clips text that does not fit.
 * There is no built-in tooltip, so the grid shell shows one on hover when the
 * displayed value overflows the painted cell bounds. Keeping the overflow rule
 * here (no DOM) lets it unit-test without a canvas or Glide runtime.
 */
import { has_line_break, split_lines } from './line-breaks';
import type { CellHyperlink, CellTextStyle } from '../cell-content';
import {
    rich_lines_max_width,
    wrap_rich_text_lines,
    type RichTextLine,
} from './rich-text-layout';

/** Mirrors Glide's default `cellHorizontalPadding`. */
export const CELL_TOOLTIP_HORIZONTAL_PADDING_PX = 8;

/**
 * Approximate ink line box for the grid's 13px base font. Used only to detect
 * vertical clipping of wrapped / multiline content; a small miss just toggles
 * the tooltip a few pixels early or late.
 */
export const CELL_TOOLTIP_LINE_HEIGHT_PX = 16;

/** Hover dwell before the truncated-cell tooltip appears (ms). */
export const CELL_TOOLTIP_SHOW_DELAY_MS = 350;

/** Max characters retained in a tooltip body (guards pathological cells). */
export const CELL_TOOLTIP_MAX_CHARS = 4000;

export interface CellOverflowOptions {
    /** Painted cell height; when omitted, only horizontal overflow is considered. */
    cell_height?: number;
    /** Line box used for vertical-fit estimates. */
    line_height?: number;
    /**
     * When true, long lines are assumed to wrap inside the cell (Glide's
     * `allowWrapping`). When false, any line wider than the inner width
     * overflows, and hard newlines also count as overflow (single-line clip).
     */
    wrapping?: boolean;
    horizontal_padding?: number;
}

/**
 * True when `text` cannot fully fit in a cell of `cell_width` (and optional
 * `cell_height`). `measure` returns the rendered width of a single unwrapped
 * line in CSS pixels (typically canvas `measureText`).
 */
export function text_overflows_cell(
    text: string,
    cell_width: number,
    measure: (line: string) => number,
    options: CellOverflowOptions = {},
): boolean {
    if (!text) return false;

    const padding = options.horizontal_padding ?? CELL_TOOLTIP_HORIZONTAL_PADDING_PX;
    const available_width = Math.max(0, cell_width - padding * 2);
    if (available_width <= 0) return true;

    const wrapping = options.wrapping ?? has_line_break(text);
    const lines = split_lines(text);
    // Without wrapping Glide draws a single clipped line — any hard break or
    // wide line means content is not fully visible.
    if (!wrapping) {
        if (lines.length > 1) return true;
        return measure(lines[0] ?? '') > available_width + 0.5;
    }

    let total_lines = 0;
    for (const line of lines) {
        const width = measure(line);
        if (width <= available_width + 0.5) {
            total_lines += 1;
            continue;
        }
        // Cheap wrap estimate: enough lines to hold the measured ink width.
        // Real word-breaking may use one more line; erring toward "overflows"
        // only affects whether the tooltip appears.
        total_lines += Math.max(1, Math.ceil(width / available_width));
    }

    const cell_height = options.cell_height;
    if (cell_height === undefined) {
        // No height budget: any wrap beyond a single visual line is truncated
        // in the default single-row cell, so treat multi-line layout as overflow.
        return total_lines > 1 || measure(split_lines(text).join(' ')) > available_width + 0.5;
    }

    const line_height = options.line_height ?? CELL_TOOLTIP_LINE_HEIGHT_PX;
    const available_height = Math.max(0, cell_height - padding);
    const needed_height = total_lines * line_height;
    return needed_height > available_height + 0.5;
}

/**
 * Overflow rule for cells the rich renderer draws. Each segment is measured
 * with its own style; when wrapping is enabled, the same run-aware layout used
 * by the canvas renderer determines visual lines before fit is evaluated.
 */
export function rich_text_overflows_cell(
    lines: readonly RichTextLine[],
    cell_width: number,
    measure: (text: string, style: CellTextStyle | undefined) => number,
    options: Pick<
        CellOverflowOptions,
        'cell_height' | 'line_height' | 'horizontal_padding' | 'wrapping'
    > = {},
): boolean {
    const padding = options.horizontal_padding ?? CELL_TOOLTIP_HORIZONTAL_PADDING_PX;
    const available_width = Math.max(0, cell_width - padding * 2);
    if (available_width <= 0) return lines.some((line) => line.length > 0);
    const visual_lines = options.wrapping
        ? wrap_rich_text_lines(lines, available_width, measure)
        : lines;
    // A single grapheme can remain wider than the cell even after wrapping.
    if (rich_lines_max_width(visual_lines, measure) > available_width + 0.5) return true;
    if (visual_lines.length <= 1) return false;
    const cell_height = options.cell_height;
    // No height budget: a default single-row cell clips past the first line.
    if (cell_height === undefined) return true;
    const line_height = options.line_height ?? CELL_TOOLTIP_LINE_HEIGHT_PX;
    return visual_lines.length * line_height > Math.max(0, cell_height - padding) + 0.5;
}

/** What a hyperlink hover surfaces: the author's tooltip when set, else where
 *  the link goes. Excel shows the same on hover. */
export function hyperlink_tooltip_text(link: CellHyperlink): string {
    return link.tooltip ?? (link.kind === 'external' ? link.target : link.location);
}

/** The open-gesture hint appended to a linked cell's tooltip — the modifier is
 *  platform-specific, so the discoverability line must name the right key. */
export function link_open_hint(is_mac: boolean): string {
    return is_mac ? 'Cmd+click to open link' : 'Ctrl+click to open link';
}

/**
 * Content of the hover tooltip, or null for no tooltip. Overflowing text and a
 * hyperlink each earn one; when both apply the link destination goes on its
 * own final line. A linked cell shows a tooltip even without overflow: with
 * Ctrl/Cmd+click as the open gesture, the user needs to see where a link goes
 * before committing — and `open_hint` (see {@link link_open_hint}) teaches
 * the gesture itself, since a plain click only selects.
 */
export function cell_tooltip_content(
    text: string,
    overflows: boolean,
    link: CellHyperlink | undefined,
    open_hint?: string,
): string | null {
    const link_text = link ? hyperlink_tooltip_text(link) : undefined;
    if (link_text === undefined) return overflows ? text : null;
    // The hint applies only to external links — internal ones aren't openable.
    const hint = link?.kind === 'external' && open_hint ? `\n${open_hint}` : '';
    return overflows ? `${text}\n${link_text}${hint}` : `${link_text}${hint}`;
}

/** Clamp tooltip copy so a single pathological cell cannot flood the DOM. */
export function clamp_tooltip_text(
    text: string,
    max_chars: number = CELL_TOOLTIP_MAX_CHARS,
): string {
    if (text.length <= max_chars) return text;
    if (max_chars <= 1) return '…';
    return `${text.slice(0, max_chars - 1)}…`;
}

/**
 * Viewport-fixed position for a cell tooltip, prefer below the cell and flip
 * above when the bottom would clip. Horizontally centers on the cell and
 * clamps into the window with an 8px gutter.
 */
export function cell_tooltip_position(
    bounds: { x: number; y: number; width: number; height: number },
    tooltip_size: { width: number; height: number },
    viewport: { width: number; height: number } = {
        width: typeof window !== 'undefined' ? window.innerWidth : 0,
        height: typeof window !== 'undefined' ? window.innerHeight : 0,
    },
    gap = 6,
): { left: number; top: number } {
    const tooltip_width = Math.max(0, tooltip_size.width);
    const tooltip_height = Math.max(0, tooltip_size.height);
    const gutter = 8;

    let left = bounds.x + bounds.width / 2 - tooltip_width / 2;
    left = Math.min(
        Math.max(left, gutter),
        Math.max(gutter, viewport.width - tooltip_width - gutter),
    );

    const below = bounds.y + bounds.height + gap;
    const above = bounds.y - tooltip_height - gap;
    const fits_below = below + tooltip_height + gutter <= viewport.height;
    const top = fits_below || above < gutter ? below : above;

    return { left, top };
}
