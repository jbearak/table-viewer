import { useState, useCallback, useEffect, useRef } from 'react';
import type { CellData } from '../types';

export interface EditingCell {
    row: number;
    col: number;
    value: string;
}

export function use_editing(
    rows: (CellData | null)[][],
    row_count: number,
    col_count: number
) {
    const [edit_mode, set_edit_mode] = useState(false);
    const [editing_cell, set_editing_cell] = useState<EditingCell | null>(null);
    const [dirty_cells, set_dirty_cells] = useState<Map<string, string>>(new Map());

    const is_dirty = dirty_cells.size > 0;

    const toggle_edit_mode = useCallback(() => {
        set_edit_mode(prev => !prev);
        set_editing_cell(null);
    }, []);

    const start_editing = useCallback((row: number, col: number) => {
        if (!edit_mode) return;
        const key = `${row}:${col}`;
        const dirty_value = dirty_cells.get(key);
        if (dirty_value !== undefined) {
            set_editing_cell({ row, col, value: dirty_value });
            return;
        }
        const cell = rows[row]?.[col];
        const value = cell !== null ? String(cell?.raw ?? '') : '';
        set_editing_cell({ row, col, value });
    }, [edit_mode, rows, dirty_cells]);

    const confirm_edit = useCallback((new_value: string) => {
        if (!editing_cell) return;
        const { row, col } = editing_cell;
        const key = `${row}:${col}`;

        const cell = rows[row]?.[col];
        const original = cell !== null ? String(cell?.raw ?? '') : '';

        set_editing_cell(null);

        if (new_value === original) {
            set_dirty_cells(prev => {
                if (!prev.has(key)) return prev;
                const next = new Map(prev);
                next.delete(key);
                return next;
            });
            return;
        }

        set_dirty_cells(prev => {
            const next = new Map(prev);
            next.set(key, new_value);
            return next;
        });
    }, [editing_cell, rows]);

    const cancel_edit = useCallback(() => {
        set_editing_cell(null);
    }, []);

    const clear_dirty = useCallback(() => {
        set_dirty_cells(new Map());
    }, []);

    const get_display_value = useCallback((row: number, col: number): string | null => {
        return dirty_cells.get(`${row}:${col}`) ?? null;
    }, [dirty_cells]);

    // Reset editing state when rows change externally (e.g., file reload)
    const prev_rows_ref = useRef(rows);
    useEffect(() => {
        if (prev_rows_ref.current !== rows && edit_mode) {
            set_editing_cell(null);
            set_dirty_cells(new Map());
            set_edit_mode(false);
        }
        prev_rows_ref.current = rows;
    }, [rows, edit_mode]);

    // Read the current value from the active cell editor DOM input
    const get_active_editor_value = useCallback((): string | null => {
        if (!editing_cell) return null;
        const el = document.querySelector('.cell-editor-input') as HTMLInputElement | HTMLTextAreaElement | null;
        return el ? el.value : editing_cell.value;
    }, [editing_cell]);

    return {
        edit_mode,
        editing_cell,
        dirty_cells,
        is_dirty,
        toggle_edit_mode,
        set_edit_mode,
        start_editing,
        confirm_edit,
        cancel_edit,
        clear_dirty,
        get_display_value,
        get_active_editor_value,
    };
}
