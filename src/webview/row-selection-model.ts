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
