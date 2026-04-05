import { useState, useCallback, useRef } from 'react';
import type { SheetData } from '../types';
import {
    type SelectionRange,
    type SelectionState,
    type Direction,
    normalize_range,
    expand_range_for_merges,
    resolve_merge_anchor,
    move_active_cell,
    format_selection_for_clipboard,
} from './selection';

export interface ContextMenuState {
    x: number;
    y: number;
    row: number;
    col: number;
}

export function use_selection(
    sheet: SheetData,
    show_formatting: boolean
) {
    const [selection, set_selection] = useState<SelectionState | null>(null);
    const [context_menu, set_context_menu] = useState<ContextMenuState | null>(null);
    const dragging_ref = useRef(false);

    const merges = sheet.merges;
    const row_count = sheet.rowCount;
    const col_count = sheet.columnCount;

    const select_cell = useCallback(
        (row: number, col: number) => {
            const anchor = resolve_merge_anchor(row, col, merges);
            const range: SelectionRange = {
                start_row: anchor.row,
                start_col: anchor.col,
                end_row: anchor.row,
                end_col: anchor.col,
            };
            const expanded = expand_range_for_merges(range, merges);
            set_selection({
                range: expanded,
                anchor_row: anchor.row,
                anchor_col: anchor.col,
                focus_row: anchor.row,
                focus_col: anchor.col,
            });
        },
        [merges]
    );

    const extend_selection = useCallback(
        (to_row: number, to_col: number) => {
            if (!selection) return;
            const range: SelectionRange = {
                start_row: selection.anchor_row,
                start_col: selection.anchor_col,
                end_row: to_row,
                end_col: to_col,
            };
            const expanded = expand_range_for_merges(range, merges);
            set_selection({
                ...selection,
                range: expanded,
                focus_row: to_row,
                focus_col: to_col,
            });
        },
        [selection, merges]
    );

    const on_cell_mouse_down = useCallback(
        (row: number, col: number, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragging_ref.current = true;

            if (e.shiftKey && selection) {
                extend_selection(row, col);
            } else {
                select_cell(row, col);
            }
        },
        [selection, select_cell, extend_selection]
    );

    const on_cell_mouse_move = useCallback(
        (row: number, col: number) => {
            if (!dragging_ref.current) return;
            extend_selection(row, col);
        },
        [extend_selection]
    );

    const on_cell_mouse_up = useCallback(() => {
        dragging_ref.current = false;
    }, []);

    const on_context_menu = useCallback(
        (row: number, col: number, e: React.MouseEvent) => {
            e.preventDefault();
            if (selection) {
                const n = normalize_range(selection.range);
                const inside =
                    row >= n.start_row &&
                    row <= n.end_row &&
                    col >= n.start_col &&
                    col <= n.end_col;
                if (!inside) {
                    select_cell(row, col);
                }
            } else {
                select_cell(row, col);
            }
            set_context_menu({ x: e.clientX, y: e.clientY, row, col });
        },
        [selection, select_cell]
    );

    const dismiss_context_menu = useCallback(() => {
        set_context_menu(null);
    }, []);

    const copy_selection = useCallback(async () => {
        if (!selection) return;
        const text = format_selection_for_clipboard(
            sheet.rows,
            selection.range,
            merges,
            show_formatting
        );
        await navigator.clipboard.writeText(text);
    }, [selection, sheet.rows, merges, show_formatting]);

    const copy_cell = useCallback(
        async (row: number, col: number) => {
            const range: SelectionRange = {
                start_row: row,
                start_col: col,
                end_row: row,
                end_col: col,
            };
            const text = format_selection_for_clipboard(
                sheet.rows,
                range,
                merges,
                show_formatting
            );
            await navigator.clipboard.writeText(text);
        },
        [sheet.rows, merges, show_formatting]
    );

    const select_row = useCallback(
        (row: number) => {
            const range: SelectionRange = {
                start_row: row,
                start_col: 0,
                end_row: row,
                end_col: col_count - 1,
            };
            const expanded = expand_range_for_merges(range, merges);
            set_selection({
                range: expanded,
                anchor_row: row,
                anchor_col: 0,
                focus_row: row,
                focus_col: col_count - 1,
            });
        },
        [col_count, merges]
    );

    const select_column = useCallback(
        (col: number) => {
            const range: SelectionRange = {
                start_row: 0,
                start_col: col,
                end_row: row_count - 1,
                end_col: col,
            };
            const expanded = expand_range_for_merges(range, merges);
            set_selection({
                range: expanded,
                anchor_row: 0,
                anchor_col: col,
                focus_row: row_count - 1,
                focus_col: col,
            });
        },
        [row_count, merges]
    );

    const select_all = useCallback(() => {
        set_selection({
            range: {
                start_row: 0,
                start_col: 0,
                end_row: row_count - 1,
                end_col: col_count - 1,
            },
            anchor_row: 0,
            anchor_col: 0,
            focus_row: row_count - 1,
            focus_col: col_count - 1,
        });
    }, [row_count, col_count]);

    const clear_selection = useCallback(() => {
        set_selection(null);
    }, []);

    const on_key_down = useCallback(
        (e: React.KeyboardEvent) => {
            const meta = e.metaKey || e.ctrlKey;

            if (meta && e.key === 'a') {
                e.preventDefault();
                select_all();
                return;
            }

            if (meta && e.key === 'c') {
                e.preventDefault();
                copy_selection();
                return;
            }

            if (e.key === 'Escape') {
                clear_selection();
                dismiss_context_menu();
                return;
            }

            const direction_map: Record<string, Direction> = {
                ArrowUp: 'up',
                ArrowDown: 'down',
                ArrowLeft: 'left',
                ArrowRight: 'right',
                h: 'left',
                j: 'down',
                k: 'up',
                l: 'right',
                Tab: 'right',
            };

            let key = e.key;
            if (e.key === 'Tab' && e.shiftKey) {
                key = 'ShiftTab';
            }
            const shift_tab_map: Record<string, Direction> = {
                ...direction_map,
                ShiftTab: 'left',
            };

            const direction = shift_tab_map[key];
            if (!direction) return;

            if (meta && 'hjkl'.includes(e.key)) return;

            e.preventDefault();

            const current_row = selection?.anchor_row ?? 0;
            const current_col = selection?.anchor_col ?? 0;

            if (e.shiftKey && e.key !== 'Tab') {
                // Use the focus (moving edge) for shift-extension,
                // not the normalized end. This allows Shift+Up/Left
                // to extend correctly when focus is above/left of anchor.
                const focus_row = selection?.focus_row ?? current_row;
                const focus_col = selection?.focus_col ?? current_col;
                const next = move_active_cell(
                    focus_row,
                    focus_col,
                    direction,
                    row_count,
                    col_count,
                    merges
                );
                const anchor_row = selection?.anchor_row ?? current_row;
                const anchor_col = selection?.anchor_col ?? current_col;
                const range: SelectionRange = {
                    start_row: anchor_row,
                    start_col: anchor_col,
                    end_row: next.row,
                    end_col: next.col,
                };
                const expanded = expand_range_for_merges(range, merges);
                set_selection({
                    range: expanded,
                    anchor_row,
                    anchor_col,
                    focus_row: next.row,
                    focus_col: next.col,
                });
            } else {
                const next = move_active_cell(
                    current_row,
                    current_col,
                    direction,
                    row_count,
                    col_count,
                    merges
                );
                select_cell(next.row, next.col);
            }
        },
        [
            selection,
            row_count,
            col_count,
            merges,
            select_all,
            copy_selection,
            clear_selection,
            dismiss_context_menu,
            select_cell,
        ]
    );

    const is_multi_cell = selection
        ? (() => {
              const n = normalize_range(selection.range);
              return n.start_row !== n.end_row || n.start_col !== n.end_col;
          })()
        : false;

    return {
        selection,
        context_menu,
        is_multi_cell,
        on_cell_mouse_down,
        on_cell_mouse_move,
        on_cell_mouse_up,
        on_context_menu,
        on_key_down,
        dismiss_context_menu,
        copy_selection,
        copy_cell,
        select_row,
        select_column,
        select_all,
        clear_selection,
    };
}
