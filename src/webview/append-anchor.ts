/**
 * Pure geometry for the append dock's phantom-row launcher.
 *
 * The launcher renders as one more row slot: the same rectangle the row-number
 * gutter would paint for a row directly below the last display row. The shell
 * measures the last row's gutter cell and the grid root, converts them to
 * root-relative coordinates, and this module decides — with no DOM access, so
 * every branch is unit-testable — where the slot goes, whether it is on screen
 * at all, and how far the open dock's panel must rise to stay on screen.
 */

/** The slot never rises into the grid's header band. */
export const APPEND_ANCHOR_HEADER_CLEARANCE_PX = 36;
/** While the dock is open, the pinned slot stays clear of Glide's overlay
 *  horizontal scrollbar so the count controls are never under it. */
export const APPEND_ANCHOR_SCROLLBAR_CLEARANCE_PX = 12;

/** A measured rectangle in `.grid-shell-root` coordinates. */
export interface AppendSlotRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/**
 * Where the row-anchored launcher goes.
 *
 * `panel_lift` is how many pixels the open dock's panel bottom sits above the
 * slot's bottom: zero when the whole slot is on screen (the panel's bottom
 * aligns with the slot's bottom), and the clipped amount when the slot pokes
 * past the viewport (the panel's bottom aligns with the viewport bottom
 * instead — it never extends below the screen).
 */
export interface AppendDockAnchor {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
    readonly panel_lift: number;
}

export interface AppendAnchorInput {
    /** Height of `.grid-shell-root`; non-positive means no usable geometry. */
    readonly root_height: number;
    /**
     * The phantom slot: the rectangle one row height below the last row's
     * gutter cell, in root coordinates. Undefined when the grid could not
     * report bounds (not mounted yet, no rows, collapsed layout).
     */
    readonly slot: AppendSlotRect | undefined;
    /** The quick-add panel is open, so the user is mid-gesture. */
    readonly dock_open: boolean;
}

/**
 * 'corner': no usable geometry — fall back to the fixed corner inset so the
 * affordance always exists somewhere (headless test DOMs take this branch).
 * 'hidden': the slot is fully off screen and the dock is closed.
 * Otherwise the slot to render, clipped/pinned per the rules below.
 */
export type AppendAnchorResult = AppendDockAnchor | 'corner' | 'hidden';

export function compute_append_anchor(input: AppendAnchorInput): AppendAnchorResult {
    const root_height = Math.round(input.root_height);
    if (root_height <= 0) return 'corner';
    const slot = input.slot;
    if (slot === undefined || slot.width <= 0 || slot.height <= 0) {
        // Mid-gesture the dock must not vanish; without geometry the corner is
        // the only placement left.
        return input.dock_open ? 'corner' : 'hidden';
    }
    const height = Math.max(Math.round(slot.height), 16);
    const width = Math.max(Math.round(slot.width), 16);
    const left = Math.round(slot.left);
    let top = Math.round(slot.top);
    if (input.dock_open) {
        // Pin the slot inside the viewport while a count is being typed, so a
        // scroll never carries the open controls away from under the user.
        const min_top = APPEND_ANCHOR_HEADER_CLEARANCE_PX;
        const max_top = root_height - height - APPEND_ANCHOR_SCROLLBAR_CLEARANCE_PX;
        if (max_top < min_top) return 'corner';
        top = Math.min(Math.max(top, min_top), max_top);
    } else if (
        top >= root_height
        || top + height <= APPEND_ANCHOR_HEADER_CLEARANCE_PX
    ) {
        // Fully below the viewport, or fully behind the header band. A
        // partially visible slot renders and clips at the root's edge, exactly
        // the way a real row does.
        return 'hidden';
    }
    return {
        left,
        top,
        width,
        height,
        panel_lift: Math.max(0, top + height - root_height),
    };
}

/**
 * Stable identity for a result, so an imperative measuring loop can tell "the
 * geometry settled" from "still moving" without deep comparison.
 */
export function append_anchor_key(result: AppendAnchorResult): string {
    if (typeof result === 'string') return result;
    return `${result.left},${result.top},${result.width},${result.height},${result.panel_lift}`;
}
