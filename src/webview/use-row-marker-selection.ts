import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    type MutableRefObject,
} from 'react';
import {
    CompactSelection,
    type CellClickedEventArgs,
    type GridMouseEventArgs,
    type GridSelection,
    type Item,
} from '@glideapps/glide-data-grid';
import type { DisplayRowInterval } from '../types';
import {
    grid_selection_contains_row,
    selected_display_row_intervals,
} from './highlight-selection-model';
import {
    marker_drag_rows,
    marker_drag_state_for_selection,
    type MarkerDragState,
} from './row-selection-model';

export interface RowMarkerMenuRequest {
    x: number;
    y: number;
    row: number;
    display_rows: DisplayRowInterval[];
}

export interface RowMarkerSelectionCoordinator {
    on_pointer_down_capture: React.PointerEventHandler<HTMLDivElement>;
    observe_hover(args: GridMouseEventArgs): void;
    handle_hover_drag(args: GridMouseEventArgs): boolean;
    intercept_selection_change(selection: GridSelection): boolean;
    on_cell_clicked(cell: Item, event: CellClickedEventArgs): void;
    on_context_menu(row: number, event: CellClickedEventArgs): void;
}

interface UseRowMarkerSelectionOptions {
    row_count: number;
    selection_ref: MutableRefObject<GridSelection>;
    set_selection: (selection: GridSelection) => void;
    on_open_menu: (request: RowMarkerMenuRequest) => void;
}

function build_menu_request(
    selection: GridSelection,
    row: number,
    row_count: number,
    event: CellClickedEventArgs,
): { inside: boolean; request: RowMarkerMenuRequest } {
    const inside = grid_selection_contains_row(selection, row);
    return {
        inside,
        request: {
            x: event.bounds.x + event.localEventX,
            y: event.bounds.y + event.localEventY,
            row,
            display_rows: inside
                ? selected_display_row_intervals(selection, row_count)
                    ?? [{ start: row, end: row }]
                : [{ start: row, end: row }],
        },
    };
}

/** Coordinates Glide's row-marker mouse, touch, drag, and context-menu event
 * ordering while GridShell remains the owner of the controlled selection. */
export function use_row_marker_selection({
    row_count,
    selection_ref,
    set_selection,
    on_open_menu,
}: UseRowMarkerSelectionOptions): RowMarkerSelectionCoordinator {
    const drag_ref = useRef<MarkerDragState | null>(null);
    const hover_row_ref = useRef<number | null>(null);
    const reclick_row_ref = useRef<number | null>(null);
    const click_restore_ref = useRef<number | null>(null);
    const context_row_ref = useRef<number | null>(null);
    const touch_selection_ref = useRef<GridSelection['rows'] | null>(null);

    const on_pointer_down_capture = useCallback<React.PointerEventHandler<HTMLDivElement>>(
        (event) => {
            const row = hover_row_ref.current;
            const rows = selection_ref.current.rows;
            if (
                event.button !== 0
                || event.shiftKey
                || event.ctrlKey
                || event.metaKey
                || row === null
                || rows.length !== 1
                || !rows.hasIndex(row)
            ) return;
            reclick_row_ref.current = row;
            drag_ref.current = { anchor: row, base: rows };
        },
        [selection_ref],
    );

    useEffect(() => {
        // Deferred one macrotask: touch pointerup precedes Glide's completion
        // selection, which may arm marker state after a synchronous clear.
        let timer: number | undefined;
        const end_drag = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                drag_ref.current = null;
                reclick_row_ref.current = null;
            }, 0);
        };
        window.addEventListener('pointerup', end_drag);
        window.addEventListener('blur', end_drag);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener('pointerup', end_drag);
            window.removeEventListener('blur', end_drag);
        };
    }, []);

    const observe_hover = useCallback((args: GridMouseEventArgs) => {
        hover_row_ref.current = args.kind === 'cell' && args.location[0] < 0
            ? args.location[1]
            : null;
    }, []);

    const handle_hover_drag = useCallback((args: GridMouseEventArgs): boolean => {
        const drag = drag_ref.current;
        if (!drag) return false;
        if ((args.buttons & 1) === 0) {
            drag_ref.current = null;
            return false;
        }
        if (args.kind !== 'cell' || args.location[1] < 0) return false;
        const rows = marker_drag_rows(drag, args.location[1], row_count);
        if (!rows.equals(selection_ref.current.rows)) {
            set_selection({ columns: CompactSelection.empty(), rows });
        }
        return true;
    }, [row_count, selection_ref, set_selection]);

    const intercept_selection_change = useCallback((selection: GridSelection): boolean => {
        const touch_rows = touch_selection_ref.current;
        if (touch_rows && !selection.current) {
            touch_selection_ref.current = null;
            set_selection({ columns: CompactSelection.empty(), rows: touch_rows });
            return true;
        }
        const context_row = context_row_ref.current;
        if (
            selection.current
            && context_row !== null
            && selection.current.cell[1] === context_row
        ) {
            context_row_ref.current = null;
            set_selection({
                columns: CompactSelection.empty(),
                rows: CompactSelection.fromSingleSelection(context_row),
            });
            return true;
        }
        if (selection.current) {
            drag_ref.current = null;
            return false;
        }
        // Preserve a sole selected row on plain re-click. Pointer capture has
        // already armed its drag before Glide reports the empty selection.
        if (
            reclick_row_ref.current !== null
            && drag_ref.current
            && selection.rows.length === 0
            && selection.columns.length === 0
        ) return true;
        // Glide's native marker drag reports a bare contiguous replacement;
        // custom hover selection preserves the cmd/ctrl-selected base instead.
        if (drag_ref.current && selection.rows.length > 0) return true;

        const previous_rows = selection_ref.current.rows;
        click_restore_ref.current = selection.rows.length === 0
            && selection.columns.length === 0
            && previous_rows.length === 1
            ? previous_rows.first() ?? null
            : null;
        drag_ref.current = selection.rows.length > 0
            ? marker_drag_state_for_selection(previous_rows, selection.rows)
            : null;
        return false;
    }, [selection_ref, set_selection]);

    const on_cell_clicked = useCallback((cell: Item, event: CellClickedEventArgs) => {
        const [column, row] = cell;
        if (
            column < 0
            && event.isTouch
            && event.isLongTouch !== true
            && selection_ref.current.rows.length === 1
            && selection_ref.current.rows.hasIndex(row)
        ) {
            // Touch selection runs after onCellClicked. Preserve the sole row
            // through Glide's ensuing toggle-off callback.
            touch_selection_ref.current = selection_ref.current.rows;
            return;
        }
        if (column < 0 && event.isLongTouch === true) {
            event.preventDefault();
            drag_ref.current = null;
            const current = selection_ref.current;
            const { inside, request } = build_menu_request(
                current,
                row,
                row_count,
                event,
            );
            const rows = inside
                ? current.rows
                : CompactSelection.fromSingleSelection(row);
            touch_selection_ref.current = rows;
            set_selection({ columns: CompactSelection.empty(), rows });
            on_open_menu(request);
            return;
        }
        const restore_row = click_restore_ref.current;
        click_restore_ref.current = null;
        if (
            column >= 0
            || restore_row === null
            || row !== restore_row
            || event.button !== 0
            || event.shiftKey
            || event.ctrlKey
            || event.metaKey
        ) return;
        set_selection({
            columns: CompactSelection.empty(),
            rows: CompactSelection.fromSingleSelection(restore_row),
        });
    }, [on_open_menu, row_count, selection_ref, set_selection]);

    const on_context_menu = useCallback((row: number, event: CellClickedEventArgs) => {
        drag_ref.current = null;
        const current = selection_ref.current;
        const { inside, request } = build_menu_request(
            current,
            row,
            row_count,
            event,
        );
        if (!inside) {
            context_row_ref.current = row;
            set_selection({
                columns: CompactSelection.empty(),
                rows: CompactSelection.fromSingleSelection(row),
            });
            // Glide normally follows the context callback synchronously with a
            // first-data-cell selection. If that cell was already active its
            // update is a no-op, so retire the guard after the current stack.
            queueMicrotask(() => {
                if (context_row_ref.current === row) context_row_ref.current = null;
            });
        }
        on_open_menu(request);
    }, [on_open_menu, row_count, selection_ref, set_selection]);

    return useMemo(() => ({
        on_pointer_down_capture,
        observe_hover,
        handle_hover_drag,
        intercept_selection_change,
        on_cell_clicked,
        on_context_menu,
    }), [
        handle_hover_drag,
        intercept_selection_change,
        observe_hover,
        on_cell_clicked,
        on_context_menu,
        on_pointer_down_capture,
    ]);
}
