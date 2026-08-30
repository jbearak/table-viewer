/** Shared highlight vocabulary for source cells and Pending Appended Rows. */
export const CELL_HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;

export type CellHighlightColor = typeof CELL_HIGHLIGHT_COLORS[number];

export function is_cell_highlight_color(value: unknown): value is CellHighlightColor {
    return (CELL_HIGHLIGHT_COLORS as readonly unknown[]).includes(value);
}
