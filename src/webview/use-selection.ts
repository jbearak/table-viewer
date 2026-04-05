import React, { useState, useCallback, useRef, useEffect } from 'react';
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

    useEffect(() => {
        set_selection(null);
        set_context_menu(null);
        dragging_ref.current = false;
    }, [sheet]);

    useEffect(() => {
        const stop_dragging = () => {
            dragging_ref.current = false;
        };

        document.addEventListener('mouseup', stop_dragging);
        window.addEventListener('pointerup', stop_dragging);

        return () => {
            document.removeEventListener('mouseup', stop_dragging);
            window.removeEventListener('pointerup', stop_dragging);
        };
    }, []);

    const build_selection_state = useCallback(
        (
            range: SelectionRange,
            anchor_row: number,
            anchor_col: number,
            focus_row: number,
            focus_col: number
        ): SelectionState => {
            const expanded = expand_range_for_merges(range, merges);
            const anchor = resolve_merge_anchor(anchor_row, anchor_col, merges);
            const focus = resolve_merge_anchor(focus_row, focus_col, merges);

            return {
                range: expanded,
                anchor_row: anchor.row,
                anchor_col: anchor.col,
                focus_row: focus.row,
                focus_col: focus.col,
            };
        },
        [merges]
    );

    const safe_write_to_clipboard = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch (error) {
            console.error('Failed to write to clipboard', error);
        }
    }, []);

    const select_cell = useCallback(
        (row: number, col: number) => {
            const anchor = resolve_merge_anchor(row, col, merges);
            const range: SelectionRange = {
                start_row: anchor.row,
                start_col: anchor.col,
                end_row: anchor.row,
                end_col: anchor.col,
            };
            set_selection(
                build_selection_state(
                    range,
                    anchor.row,
                    anchor.col,
                    anchor.row,
                    anchor.col
                )
            );
        },
        [build_selection_state, merges]
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
            set_selection(
                build_selection_state(
                    range,
                    selection.anchor_row,
                    selection.anchor_col,
                    to_row,
                    to_col
                )
            );
        },
        [selection, build_selection_state]
    );

    const on_cell_mouse_down = useCallback(
        (row: number, col: number, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            // Focus the table container so keyboard events fire
            const container = (e.target as HTMLElement).closest('.table-container') as HTMLElement | null;
            container?.focus();
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
            const anchor = resolve_merge_anchor(row, col, merges);
            const target_row = anchor.row;
            const target_col = anchor.col;

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

            set_context_menu({
                x: e.clientX,
                y: e.clientY,
                row: target_row,
                col: target_col,
            });
        },
        [selection, select_cell, merges]
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
        await safe_write_to_clipboard(text);
    }, [selection, sheet.rows, merges, show_formatting, safe_write_to_clipboard]);

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
            await safe_write_to_clipboard(text);
        },
        [sheet.rows, merges, show_formatting, safe_write_to_clipboard]
    );

    const select_row = useCallback(
        (row: number) => {
            if (col_count === 0) return;
            const range: SelectionRange = {
                start_row: row,
                start_col: 0,
                end_row: row,
                end_col: col_count - 1,
            };
            set_selection(
                build_selection_state(range, row, 0, row, col_count - 1)
            );
        },
        [col_count, build_selection_state]
    );

    const select_column = useCallback(
        (col: number) => {
            if (row_count === 0) return;
            const range: SelectionRange = {
                start_row: 0,
                start_col: col,
                end_row: row_count - 1,
                end_col: col,
            };
            set_selection(
                build_selection_state(range, 0, col, row_count - 1, col)
            );
        },
        [row_count, build_selection_state]
    );

    const select_all = useCallback(() => {
        if (row_count === 0 || col_count === 0) return;
        const range: SelectionRange = {
            start_row: 0,
            start_col: 0,
            end_row: row_count - 1,
            end_col: col_count - 1,
        };
        set_selection(
            build_selection_state(range, 0, 0, row_count - 1, col_count - 1)
        );
    }, [row_count, col_count, build_selection_state]);

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

            let key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
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
                set_selection(
                    build_selection_state(
                        range,
                        anchor_row,
                        anchor_col,
                        next.row,
                        next.col
                    )
                );
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
            build_selection_state,
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
