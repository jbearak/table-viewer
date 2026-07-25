// Placement for new viewer windows. Each spreadsheet gets its own window, so
// several of them are open at once: a new window cascades down-right from the
// most recent one instead of landing exactly on top of it, and every window is
// kept inside the display's work area (never taller or wider than the screen,
// never positioned off it).
//
// Pure module (no electron import) so it is unit-testable; the caller supplies
// the work area from `screen.getDisplayNearestPoint(...)`.

export interface WindowBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface WindowSize {
    width: number;
    height: number;
}

/** Size of the first window when nothing has been remembered yet. */
export const DEFAULT_WINDOW_WIDTH = 1200;
export const DEFAULT_WINDOW_HEIGHT = 800;
/** Smallest usable viewer window (also the BrowserWindow minimum). */
export const MIN_WINDOW_WIDTH = 480;
export const MIN_WINDOW_HEIGHT = 320;
/** How far each new window steps down and right from the previous one. */
export const CASCADE_STEP = 28;

/**
 * Where the size of a new window comes from.
 *
 * `match-last` is the default and the native-app convention: window geometry is
 * window state, silently tracked as the user resizes. `fixed` turns the same
 * two numbers into a preference the user types — and, crucially, stops the app
 * writing to them, so a stray drag cannot rewrite what was typed.
 */
export type NewWindowSizeMode = 'match-last' | 'fixed';

export function sanitize_new_window_size_mode(value: unknown): NewWindowSizeMode {
    return value === 'fixed' ? 'fixed' : 'match-last';
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

function finite(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Size for a new window: the remembered size when there is one, clamped to the
 * usable range and never larger than the work area (a size remembered from a
 * bigger monitor must not overflow the current one).
 */
export function fit_window_size(
    work_area: WindowBounds,
    preferred: Partial<WindowSize> | null,
): WindowSize {
    const wanted_width = Math.round(finite(preferred?.width, DEFAULT_WINDOW_WIDTH));
    const wanted_height = Math.round(finite(preferred?.height, DEFAULT_WINDOW_HEIGHT));
    return {
        // The work area wins over the minimum: on a display smaller than the
        // minimum, filling it beats hanging off the edge.
        width: Math.min(work_area.width, Math.max(MIN_WINDOW_WIDTH, wanted_width)),
        height: Math.min(work_area.height, Math.max(MIN_WINDOW_HEIGHT, wanted_height)),
    };
}

/**
 * Bounds for a new viewer window: `previous` (the most recently opened window,
 * if any) is cascaded from, otherwise the window is centered. A cascade that
 * would run off the work area restarts at its top-left corner.
 */
export function next_window_bounds(
    work_area: WindowBounds,
    preferred: Partial<WindowSize> | null,
    previous: WindowBounds | null,
): WindowBounds {
    const { width, height } = fit_window_size(work_area, preferred);
    const max_x = work_area.x + work_area.width - width;
    const max_y = work_area.y + work_area.height - height;

    let x: number;
    let y: number;
    if (previous) {
        x = previous.x + CASCADE_STEP;
        y = previous.y + CASCADE_STEP;
        // Out of room on an axis: wrap that axis, and only that one. Wrapping
        // both together would stack every window in the corner whenever one axis
        // has no slack — which is the common case, since the window is sized to
        // fit the work area and a short work area then leaves max_y == y.
        if (x > max_x) x = work_area.x;
        if (y > max_y) y = work_area.y;
    } else {
        x = work_area.x + Math.round((work_area.width - width) / 2);
        y = work_area.y + Math.round((work_area.height - height) / 2);
    }

    return {
        x: Math.round(clamp(x, work_area.x, Math.max(work_area.x, max_x))),
        y: Math.round(clamp(y, work_area.y, Math.max(work_area.y, max_y))),
        width,
        height,
    };
}
