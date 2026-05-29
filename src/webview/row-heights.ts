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

/** Return a new overrides record with `row` set to a clamped `height`. */
export function set_row_height(
    overrides: RowHeightOverrides,
    row: number,
    height: number,
): RowHeightOverrides {
    return { ...overrides, [row]: clamp_row_height(height) };
}
