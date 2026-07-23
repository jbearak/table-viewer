/**
 * Pure helpers for the truncated-cell hover tooltip.
 *
 * Glide paints cells on canvas and ellipsizes / clips text that does not fit.
 * There is no built-in tooltip, so the grid shell shows one on hover when the
 * displayed value overflows the painted cell bounds. Keeping the overflow rule
 * here (no DOM) lets it unit-test without a canvas or Glide runtime.
 */

/** Mirrors Glide's default `cellHorizontalPadding` and the merge-overlay inset. */
export const CELL_TOOLTIP_HORIZONTAL_PADDING_PX = 8;

/**
 * Approximate ink line box for the grid's 13px base font. Used only to detect
 * vertical clipping of wrapped / multiline content; a small miss just toggles
 * the tooltip a few pixels early or late.
 */
export const CELL_TOOLTIP_LINE_HEIGHT_PX = 16;

/** Hover dwell before the truncated-cell tooltip appears (ms). */
export const CELL_TOOLTIP_SHOW_DELAY_MS = 120;

/**
 * Grace period after the pointer leaves the cell before the tooltip hides.
 * Long enough to move onto the tooltip itself without it disappearing.
 */
export const CELL_TOOLTIP_HIDE_DELAY_MS = 200;

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

    const wrapping = options.wrapping ?? text.includes('\n');
    const lines = text.split('\n');
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
        return total_lines > 1 || measure(text.replace(/\n/g, ' ')) > available_width + 0.5;
    }

    const line_height = options.line_height ?? CELL_TOOLTIP_LINE_HEIGHT_PX;
    const available_height = Math.max(0, cell_height - padding);
    const needed_height = total_lines * line_height;
    return needed_height > available_height + 0.5;
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
