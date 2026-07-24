// Shared zoom model for the desktop window. Electron applies zoom per
// `webContents`, and the main window is made of several: the tab-bar renderer
// plus one WebContentsView per open file. Zooming only the focused one (what
// the stock `viewMenu` roles do) scales either the tab bar or the table, never
// both, so the app keeps a single zoom level here and applies it to every
// webContents at once. The tab-bar bounds are scaled by the same factor, since
// the renderer's CSS pixels grow with the zoom while the view bounds are
// expressed in unscaled window pixels.
//
// Pure module (no electron import) so it is unit-testable.

/** Electron's zoom-level step: each level multiplies the scale by 1.2. */
const ZOOM_STEP = 1.2;

/** Roughly 40% – 250%, matching the range Chrome offers by default. */
export const MIN_ZOOM_LEVEL = -5;
export const MAX_ZOOM_LEVEL = 5;

export function clamp_zoom_level(level: number): number {
    if (!Number.isFinite(level)) return 0;
    return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, Math.round(level)));
}

/** The CSS-pixel scale factor Electron applies for `level`. */
export function zoom_factor(level: number): number {
    return ZOOM_STEP ** clamp_zoom_level(level);
}
