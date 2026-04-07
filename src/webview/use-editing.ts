import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { CellData } from '../types';

export interface EditingCell {
    row: number;
    col: number;
    value: string;
}

export interface DirtyEntry {
    value: string;
    base: string;
}

function is_entry_conflicted(key: string, entry: DirtyEntry, rows: (CellData | null)[][]): boolean {
    const [r, c] = key.split(':').map(Number);
    const cell = rows[r]?.[c];
    const current_base = cell !== null ? String(cell?.raw ?? '') : '';
    return current_base !== entry.base;
}

export function use_editing(
    rows: (CellData | null)[][],
    row_count: number,
    col_count: number,
    initial_edits?: Record<string, string | DirtyEntry>
) {
    const [edit_mode, set_edit_mode] = useState(
        () => initial_edits !== undefined && Object.keys(initial_edits).length > 0
    );
    const [editing_cell, set_editing_cell] = useState<EditingCell | null>(null);
    const [dirty_cells, set_dirty_cells] = useState<Map<string, DirtyEntry>>(
        () => initial_edits ? new Map(
            Object.entries(initial_edits).map(([k, v]) =>
                [k, typeof v === 'object' && v !== null ? v as DirtyEntry : { value: v, base: '' }]
            )
        ) : new Map()
    );

    const is_dirty = dirty_cells.size > 0;

    const toggle_edit_mode = useCallback(() => {
        set_edit_mode(prev => !prev);
        set_editing_cell(null);
    }, []);

    const begin_editing = useCallback((row: number, col: number) => {
        const key = `${row}:${col}`;
        const dirty_entry = dirty_cells.get(key);
        if (dirty_entry !== undefined) {
            set_editing_cell({ row, col, value: dirty_entry.value });
            return;
        }
        const cell = rows[row]?.[col];
        const value = cell !== null ? String(cell?.raw ?? '') : '';
        set_editing_cell({ row, col, value });
    }, [rows, dirty_cells]);

    const start_editing = useCallback((row: number, col: number) => {
        if (!edit_mode) return;
        begin_editing(row, col);
    }, [edit_mode, begin_editing]);

    // Like start_editing but bypasses the edit_mode check.
    // Used when entering edit mode and starting editing in the same tick.
    const force_start_editing = useCallback((row: number, col: number) => {
        begin_editing(row, col);
    }, [begin_editing]);

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
            next.set(key, { value: new_value, base: original });
            return next;
        });
    }, [editing_cell, rows]);

    const cancel_edit = useCallback(() => {
        set_editing_cell(null);
    }, []);

    const clear_dirty = useCallback(() => {
        set_dirty_cells(new Map());
    }, []);

    const clear_dirty_keys = useCallback((keys: Set<string>) => {
        set_dirty_cells(prev => {
            const next = new Map(prev);
            for (const key of keys) next.delete(key);
            return next;
        });
    }, []);

    const get_display_value = useCallback((row: number, col: number): string | null => {
        const entry = dirty_cells.get(`${row}:${col}`);
        return entry?.value ?? null;
    }, [dirty_cells]);

    const discard_edit = useCallback((key: string) => {
        set_dirty_cells(prev => {
            if (!prev.has(key)) return prev;
            const next = new Map(prev);
            next.delete(key);
            return next;
        });
    }, []);

    const discard_conflicted = useCallback(() => {
        set_dirty_cells(prev => {
            const next = new Map<string, DirtyEntry>();
            for (const [key, entry] of prev) {
                if (!is_entry_conflicted(key, entry, rows)) {
                    next.set(key, entry);
                }
            }
            return next;
        });
    }, [rows]);

    const conflicted_keys = useMemo(() => {
        const keys = new Set<string>();
        for (const [key, entry] of dirty_cells) {
            if (is_entry_conflicted(key, entry, rows)) {
                keys.add(key);
            }
        }
        return keys;
    }, [dirty_cells, rows]);

    // Flag set before posting saveCsv so the rows-change effect can distinguish
    // save-triggered reloads from external file changes.
    const save_in_flight_ref = useRef(false);

    // Reset editing state when rows change externally (e.g., file reload).
    // When a save is in flight the reload comes from our own write — preserve edit mode.
    const prev_rows_ref = useRef(rows);
    useEffect(() => {
        if (prev_rows_ref.current !== rows && edit_mode) {
            if (save_in_flight_ref.current) {
                // Save-triggered reload: close any open editor but keep edit mode
                set_editing_cell(null);
            } else {
                // External reload: close active editor but preserve dirty edits
                // so the user doesn't silently lose unsaved work.
                set_editing_cell(null);
            }
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
        force_start_editing,
        confirm_edit,
        cancel_edit,
        clear_dirty,
        clear_dirty_keys,
        save_in_flight_ref,
        get_display_value,
        get_active_editor_value,
        conflicted_keys,
        discard_edit,
        discard_conflicted,
    };
}
