// Zoom model for the desktop app. Electron applies zoom per `webContents`, and
// a viewer window is exactly one of those, so zoom is per-window — like a
// browser tab, or Excel's per-workbook zoom. The View menu still drives it
// through here rather than through the stock `viewMenu` roles, so the level
// stays inside a sane range instead of running away.
//
// Pure module (no electron import) so it is unit-testable.

/** Roughly 40% – 250%, matching the range Chrome offers by default. */
export const MIN_ZOOM_LEVEL = -5;
export const MAX_ZOOM_LEVEL = 5;

export function clamp_zoom_level(level: number): number {
    if (!Number.isFinite(level)) return 0;
    return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, Math.round(level)));
}
