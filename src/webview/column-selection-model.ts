import { CompactSelection, type GridSelection } from '@glideapps/glide-data-grid';

/** Columns selected at the moment a header drag begins. */
export interface HeaderDragState {
    /** Display column the drag started on (stays fixed while dragging). */
    anchor: number;
    /** Column selection captured at drag start; the live range is unioned onto
     *  this, so shrinking the drag never erases pre-existing selected columns. */
    base: CompactSelection;
}

/** Union the anchor→hover range onto the drag's base selection. Recomputing
 *  from the base each time makes shrinking the drag drop columns that were
 *  only ever covered by a wider sweep. */
export function header_drag_columns(
    drag: HeaderDragState,
    hovered_column: number,
    display_column_count: number,
): CompactSelection {
    const clamped = Math.max(0, Math.min(hovered_column, display_column_count - 1));
    const start = Math.min(drag.anchor, clamped);
    const end = Math.max(drag.anchor, clamped);
    return drag.base.add([start, end + 1]);
}

function compact_contains(selection: GridSelection['columns'], index: number): boolean {
    if (typeof selection.hasIndex === 'function') return selection.hasIndex(index);
    if (typeof selection.toArray === 'function') return selection.toArray().includes(index);
    return false;
}

function compact_to_array(selection: GridSelection['columns']): number[] {
    if (typeof selection.toArray === 'function') return selection.toArray();
    if (Symbol.iterator in Object(selection)) {
        return Array.from(selection as Iterable<number>);
    }
    return [];
}

/** Derive the drag state a header mousedown arms. Glide applies the click's
 *  selection before any drag movement, so the anchor is the column the click
 *  added — or the sole selected column when a re-click added nothing. Returns
 *  null when no single anchor is identifiable (e.g. shift-click ranges). */
export function header_drag_state_for_selection(
    previous_columns: GridSelection['columns'],
    next_columns: GridSelection['columns'],
): HeaderDragState | null {
    const next = compact_to_array(next_columns);
    const added = next.filter((column) => !compact_contains(previous_columns, column));
    const anchor = added.length === 1
        ? added[0]
        : next.length === 1
            ? next[0]
            : undefined;
    return anchor === undefined ? null : { anchor, base: next_columns };
}

/** Whether a display column belongs to the explicit header selection. */
export function grid_selection_contains_column(
    selection: GridSelection,
    display_column: number,
): boolean {
    return compact_contains(selection.columns, display_column);
}

/** Display columns covered by the selection, ascending: the explicit header
 *  selection when present, else the columns spanned by the current cell range
 *  (and range stack). Mirrors selected_display_row_intervals for rows. */
export function selected_display_columns(
    selection: GridSelection,
    display_column_count: number,
): number[] {
    const explicit = compact_to_array(selection.columns)
        .filter((column) => Number.isSafeInteger(column)
            && column >= 0
            && column < display_column_count);
    if (explicit.length > 0) return [...new Set(explicit)].sort((a, b) => a - b);
    const current = selection.current;
    if (!current) return [];
    const covered = new Set<number>();
    for (const range of [current.range, ...current.rangeStack]) {
        const start = Math.max(0, range.x);
        const end = Math.min(display_column_count - 1, range.x + range.width - 1);
        for (let column = start; column <= end; column++) covered.add(column);
    }
    return [...covered].sort((a, b) => a - b);
}

/** Selected display columns in left-to-right order, mapped to source columns.
 *  Columns without a source mapping (stale indexes) are dropped. */
export function selected_source_columns(
    selection: GridSelection,
    source_column_for_display: (display_column: number) => number | undefined,
): { display_cols: number[]; source_cols: number[] } {
    const display_cols: number[] = [];
    const source_cols: number[] = [];
    for (const display_column of selection.columns) {
        const source_column = source_column_for_display(display_column);
        if (source_column === undefined) continue;
        display_cols.push(display_column);
        source_cols.push(source_column);
    }
    return { display_cols, source_cols };
}
