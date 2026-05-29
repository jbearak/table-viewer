/**
 * Pure variable-row-height helpers (Phase D). Heights live in a sparse
 * `Record<number, number>` keyed by row index — the same shape persisted in
 * `PerFileState.rowHeights` — so the renderer, the row-resize overlay, and the
 * state store all share one representation. Rows without an override use the
 * default. No DOM, no Glide imports: fully unit-testable.
 */

/** Default row height; matches Glide's Phase C constant. */
export const DEFAULT_ROW_HEIGHT_PX = 24;

/** Floor for a user-resized row, mirroring the old renderer's `Math.max(20, …)`. */
export const MIN_ROW_HEIGHT_PX = 20;

export type RowHeightOverrides = Record<number, number>;

/** Override for `row` if present, else `default_height`. */
export function row_height(
    overrides: RowHeightOverrides,
    row: number,
    default_height = DEFAULT_ROW_HEIGHT_PX,
): number {
    const v = overrides[row];
    return v !== undefined ? v : default_height;
}

/** Sum of row heights over the inclusive range [start_row, end_row]. */
export function span_height(
    overrides: RowHeightOverrides,
    start_row: number,
    end_row: number,
    default_height = DEFAULT_ROW_HEIGHT_PX,
): number {
    let total = 0;
    for (let r = start_row; r <= end_row; r++) {
        total += row_height(overrides, r, default_height);
    }
    return total;
}

/** Clamp a height to the allowed minimum. */
export function clamp_row_height(height: number): number {
    return Math.max(MIN_ROW_HEIGHT_PX, height);
}

/** Per-line text height used when growing a row to fit multiline content. */
export const DEFAULT_LINE_HEIGHT_PX = 18;
/** Vertical padding added around the text block of a multiline row. */
export const DEFAULT_ROW_PADDING_PX = 6;

/**
 * Natural height needed to display `text` given its explicit line breaks.
 * Counts `\n`-separated lines (empty text is one line) and returns
 * `lines * line_height + padding`, floored at {@link DEFAULT_ROW_HEIGHT_PX} so a
 * single line keeps the standard height. Soft wrapping of long single lines is
 * not modeled — only hard newlines (the Shift+Alt+Enter editing case) grow rows.
 */
export function natural_row_height(
    text: string,
    line_height = DEFAULT_LINE_HEIGHT_PX,
    padding = DEFAULT_ROW_PADDING_PX,
    default_height = DEFAULT_ROW_HEIGHT_PX,
): number {
    const lines = text.length === 0 ? 1 : text.split('\n').length;
    return Math.max(default_height, lines * line_height + padding);
}

/** Return a new overrides record with `row` set to a clamped `height`. */
export function set_row_height(
    overrides: RowHeightOverrides,
    row: number,
    height: number,
): RowHeightOverrides {
    return { ...overrides, [row]: clamp_row_height(height) };
}
