import { clamp_row_height } from './row-heights';

/**
 * Pure helpers for the row-resize overlay (Phase D, D-wire-3). Glide has no
 * native row resize, so GridShell detects proximity to a row border from
 * Glide's `onItemHovered`/`onMouseMove` args (`localEventY` within a cell whose
 * client `bounds` are known) and a thin draggable strip does the resize. The
 * boundary hit-test and the clamped drag arithmetic are extracted here so they
 * unit-test in plain node; the strip's pointer wiring is thin React verified by
 * the manual smoke checklist.
 */

export interface RowBoundaryHit {
    /** The row whose height changes when this boundary is dragged. */
    row: number;
    /** Client-space Y of that boundary (the row's bottom edge). */
    boundary_y: number;
}

/**
 * Given the hovered cell's row, its client-space vertical bounds
 * (`bounds_y` + `bounds_height`), the in-cell `local_event_y`, and a pixel
 * `tolerance`, return which row boundary the pointer is over — the hovered row's
 * bottom edge, or (near the top edge) the previous row's bottom edge — or null
 * when in the cell interior. The top edge of row 0 is the header and never
 * resizable.
 */
export function row_boundary_hit(
    row: number,
    bounds_y: number,
    bounds_height: number,
    local_event_y: number,
    tolerance: number,
): RowBoundaryHit | null {
    if (bounds_height - local_event_y <= tolerance) {
        return { row, boundary_y: bounds_y + bounds_height };
    }
    if (local_event_y <= tolerance && row > 0) {
        return { row: row - 1, boundary_y: bounds_y };
    }
    return null;
}

/** Clamped height for a drag of `dy` pixels from `start_height`. */
export function next_row_height(start_height: number, dy: number): number {
    return clamp_row_height(start_height + dy);
}
