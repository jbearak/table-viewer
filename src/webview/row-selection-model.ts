import type { CompactSelection, GridSelection } from '@glideapps/glide-data-grid';
import {
    header_drag_columns,
    header_drag_state_for_selection,
    type HeaderDragState,
} from './column-selection-model';

/** Rows captured when a row-marker drag begins; same shape as a header drag
 *  (the anchor/base drag arithmetic is axis-generic). */
export type MarkerDragState = HeaderDragState;

/** Union the anchor→hover range onto the drag's base rows. */
export function marker_drag_rows(
    drag: MarkerDragState,
    hovered_row: number,
    display_row_count: number,
): CompactSelection {
    return header_drag_columns(drag, hovered_row, display_row_count);
}

/** Derive the drag state a row-marker mousedown arms — the same anchor
 *  inference as headers, applied to the rows axis. */
export function marker_drag_state_for_selection(
    previous_rows: GridSelection['rows'],
    next_rows: GridSelection['rows'],
): MarkerDragState | null {
    return header_drag_state_for_selection(previous_rows, next_rows);
}

/** Whether Glide's upper-left marker-header toggle should be redirected to the
 *  canonical full-grid select-all, cleared, or left to normal marker handling. */
export type CornerRowToggleAction = 'select_all' | 'clear';

export interface CornerRowToggleContext {
    /** The selection Glide is proposing (its native marker-header toggle). */
    next: GridSelection;
    /** The controlled selection before this change. */
    previous: GridSelection;
    row_count: number;
    column_count: number;
    /** A row-marker drag is armed/in-flight. */
    marker_drag_active: boolean;
    /** Row under the pointer when it sits on a marker cell, else null. The
     *  corner is a header (not a marker cell), so a real corner click reports
     *  null here — a genuine marker interaction reports its row. */
    hovered_marker_row: number | null;
}

function is_full_grid_rectangle(
    selection: GridSelection,
    row_count: number,
    column_count: number,
): boolean {
    const range = selection.current?.range;
    return range !== undefined
        && range.x === 0
        && range.y === 0
        && range.width === column_count
        && range.height === row_count;
}

function is_full_row_selection(
    rows: GridSelection['rows'],
    row_count: number,
): boolean {
    // length === row_count with endpoints 0 and row_count-1 forces every row to
    // be present, so no gap check is needed.
    return rows.length === row_count
        && rows.first() === 0
        && rows.last() === row_count - 1;
}

/**
 * Classify a bare row-selection change as Glide's marker-header ("corner")
 * toggle so GridShell can redirect it to the canonical full-grid select-all
 * instead of a rows-only selection. Returns null for anything that is a genuine
 * marker click/drag or an ordinary selection change.
 *
 * The second corner click after a redirect matters: once redirected, the
 * controlled selection holds a full rectangle in `current` with empty `rows`,
 * so Glide proposes all rows again rather than its native empty toggle. Seeing
 * the previous selection was already the full rectangle, that repeat is a clear.
 */
export function corner_row_toggle_action(
    context: CornerRowToggleContext,
): CornerRowToggleAction | null {
    const {
        next,
        previous,
        row_count,
        column_count,
        marker_drag_active,
        hovered_marker_row,
    } = context;
    if (row_count === 0 || column_count === 0) return null;
    // The corner toggle never produces a current cell or a column selection.
    if (next.current) return null;
    if (next.columns.length > 0) return null;
    // A drag or a pointer resting on a marker cell means a real marker gesture,
    // even when it happens to span every row (e.g. drag-to-all, shift-range).
    if (marker_drag_active) return null;
    if (hovered_marker_row !== null) return null;

    if (is_full_row_selection(next.rows, row_count)) {
        return is_full_grid_rectangle(previous, row_count, column_count)
            ? 'clear'
            : 'select_all';
    }
    if (next.rows.length === 0) {
        // Glide's native toggle-off, or the redirect's own clear: only treat it
        // as a corner clear when everything was previously selected.
        if (
            is_full_grid_rectangle(previous, row_count, column_count)
            || is_full_row_selection(previous.rows, row_count)
        ) {
            return 'clear';
        }
    }
    return null;
}
