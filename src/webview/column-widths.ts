/**
 * The range a column's width is kept within.
 *
 * In a module with no imports because the host clamps a width it is asked to
 * store with the same rule the grid draws by, and the host's build must not
 * reach the grid's own modules (`grid-model` names Glide's types).
 */
export const MIN_COLUMN_WIDTH_PX = 40;
export const MAX_COLUMN_WIDTH_PX = 3200;

/** Clamp a column width to the renderer's allowed range. */
export function clamp_column_width(width: number): number {
    return Math.max(MIN_COLUMN_WIDTH_PX, Math.min(MAX_COLUMN_WIDTH_PX, width));
}
