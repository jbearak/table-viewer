// Chrome metrics shared by the main process (which positions the per-tab
// WebContentsViews below the tab bar) and the tab-bar renderer (which sizes the
// bar itself). Both must agree, or the bar and the table overlap.

/** Font size the stock 38px tab bar was designed around. */
export const BASE_FONT_SIZE_PX = 13;

/** Stock tab-bar height, kept exactly at the base font size. */
export const BASE_TAB_BAR_HEIGHT = 38;

/** Tab-bar height (in the renderer's CSS pixels) for a configured font size. */
export function tab_bar_height(font_size_px: number = BASE_FONT_SIZE_PX): number {
    if (!Number.isFinite(font_size_px) || font_size_px <= 0) {
        return BASE_TAB_BAR_HEIGHT;
    }
    return Math.max(
        BASE_TAB_BAR_HEIGHT,
        Math.round(font_size_px * 2 + (BASE_TAB_BAR_HEIGHT - BASE_FONT_SIZE_PX * 2)),
    );
}
