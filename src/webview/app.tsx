import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { WorkbookData, PerFileState, HostMessage } from '../types';
import { Toolbar } from './toolbar';
import { SheetTabs } from './sheet-tabs';
import { Table } from './table';
import { ContextMenu, type MenuItem } from './context-menu';
import {
    clamp_sheet_index,
    normalize_per_file_state,
    trim_sheet_state_array,
} from './sheet-state';
import { vscode_api, use_state_sync } from './use-state-sync';
import { use_selection } from './use-selection';
import { use_editing } from './use-editing';
import { normalize_range } from './selection';
import { measure_column_fit_width } from './measure-column';
import { auto_resize_row_after_edit } from './auto-resize-row';
import './styles.css';

export function App(): React.JSX.Element {
    const [workbook, set_workbook] = useState<WorkbookData | null>(null);
    const [active_sheet_index, set_active_sheet_index] = useState(0);
    const [show_formatting, set_show_formatting] = useState(true);
    const [vertical_tabs, set_vertical_tabs] = useState(false);
    const [column_widths, set_column_widths] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    const [row_heights, set_row_heights] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    const [auto_fit_active, set_auto_fit_active] = useState<boolean[]>([]);
    const [auto_fit_snapshot, set_auto_fit_snapshot] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    const [truncation_message, set_truncation_message] = useState<string | null>(null);
    const [preview_mode, set_preview_mode] = useState(false);
    const [csv_editable, set_csv_editable] = useState(false);
    const [csv_editing_supported, set_csv_editing_supported] = useState(false);
    const [initial_pending_edits, set_initial_pending_edits] = useState<Record<string, string | { value: string; base: string }> | undefined>(undefined);
    const [toolbar_edit_state, set_toolbar_edit_state] = useState<{ edit_mode: boolean; is_dirty: boolean }>({ edit_mode: false, is_dirty: false });
    const editing_ref = useRef<{ toggle_edit_mode: () => void; handle_toggle: () => void }>({ toggle_edit_mode: () => {}, handle_toggle: () => {} });

    const handle_edit_mode_change = useCallback((edit_mode: boolean, is_dirty: boolean) => {
        set_toolbar_edit_state({ edit_mode, is_dirty });
    }, []);

    const scroll_ref = useRef<HTMLDivElement | null>(null);
    const table_ref = useRef<HTMLTableElement | null>(null);
    const state_ref = useRef<PerFileState>({});
    const scroll_positions_ref = useRef<
        ({ top: number; left: number } | undefined)[]
    >([]);
    const auto_fit_active_ref = useRef<boolean[]>([]);
    const auto_fit_snapshot_ref = useRef<
        (Record<number, number> | undefined)[]
    >([]);
    const last_reported_preview_row_ref = useRef<number | null>(null);

    const { persist_debounced, persist_immediate } =
        use_state_sync(state_ref);

    useEffect(() => {
        auto_fit_active_ref.current = auto_fit_active;
    }, [auto_fit_active]);

    useEffect(() => {
        auto_fit_snapshot_ref.current = auto_fit_snapshot;
    }, [auto_fit_snapshot]);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;

            if (msg.type === 'workbookData') {
                set_workbook(msg.data);
                auto_fit_active_ref.current = [];
                auto_fit_snapshot_ref.current = [];
                set_auto_fit_active([]);
                set_auto_fit_snapshot([]);
                const s = normalize_per_file_state(
                    msg.state,
                    msg.data.sheets.map((sheet) => sheet.name)
                );
                set_active_sheet_index(s.activeSheetIndex ?? 0);
                set_column_widths(s.columnWidths ?? []);
                set_row_heights(s.rowHeights ?? []);
                scroll_positions_ref.current = s.scrollPosition ?? [];

                const tab_orient =
                    s.tabOrientation ?? null;
                set_vertical_tabs(
                    tab_orient !== null
                        ? tab_orient === 'vertical'
                        : msg.defaultTabOrientation === 'vertical'
                );
                last_reported_preview_row_ref.current = null;
                state_ref.current = s;
                set_truncation_message(msg.truncationMessage ?? null);
                set_preview_mode(msg.previewMode ?? false);
                set_csv_editable(msg.csvEditable ?? false);
                set_csv_editing_supported(msg.csvEditingSupported ?? false);
                set_initial_pending_edits(s.pendingEdits);

                requestAnimationFrame(() => {
                    const pos =
                        scroll_positions_ref.current[s.activeSheetIndex ?? 0];
                    if (pos && scroll_ref.current) {
                        scroll_ref.current.scrollTop = pos.top;
                        scroll_ref.current.scrollLeft = pos.left;
                    } else if (scroll_ref.current) {
                        scroll_ref.current.scrollTop = 0;
                        scroll_ref.current.scrollLeft = 0;
                    }
                });
            }

            if (msg.type === 'reload') {
                set_workbook(msg.data);
                auto_fit_active_ref.current = [];
                auto_fit_snapshot_ref.current = [];
                set_auto_fit_active([]);
                set_auto_fit_snapshot([]);
                const sheet_count = msg.data.sheets.length;

                set_column_widths((prev) =>
                    trim_sheet_state_array(prev, sheet_count)
                );
                set_row_heights((prev) =>
                    trim_sheet_state_array(prev, sheet_count)
                );
                scroll_positions_ref.current = trim_sheet_state_array(
                    scroll_positions_ref.current,
                    sheet_count
                );

                const next_active_sheet_index = clamp_sheet_index(
                    active_sheet_index,
                    sheet_count
                );
                set_active_sheet_index(next_active_sheet_index);

                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: trim_sheet_state_array(
                        state_ref.current.columnWidths,
                        sheet_count
                    ),
                    rowHeights: trim_sheet_state_array(
                        state_ref.current.rowHeights,
                        sheet_count
                    ),
                    scrollPosition: trim_sheet_state_array(
                        state_ref.current.scrollPosition,
                        sheet_count
                    ),
                    activeSheetIndex: next_active_sheet_index,
                };
                last_reported_preview_row_ref.current = null;
                set_truncation_message(msg.truncationMessage ?? null);
                if (msg.csvEditable !== undefined) {
                    set_csv_editable(msg.csvEditable);
                }
                if (msg.csvEditingSupported !== undefined) {
                    set_csv_editing_supported(msg.csvEditingSupported);
                }
                persist_immediate();
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [active_sheet_index, persist_immediate]);

    useEffect(() => {
        vscode_api.postMessage({ type: 'ready' });
    }, []);

    useEffect(() => {
        if (!preview_mode) return;

        const handler = (event: MessageEvent) => {
            const msg = event.data;
            if (msg.type === 'scrollToRow' && typeof msg.row === 'number') {
                const table = table_ref.current;
                const scroller = scroll_ref.current;
                if (!table || !scroller) return;

                const rows = table.querySelectorAll('tbody tr');
                const target_row = rows[msg.row] as HTMLElement | undefined;
                if (target_row) {
                    const row_rect = target_row.getBoundingClientRect();
                    const scroller_rect = scroller.getBoundingClientRect();
                    scroller.scrollTop += row_rect.top - scroller_rect.top;
                }
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [preview_mode]);

    useEffect(() => {
        if (!preview_mode) return;
        const scroller = scroll_ref.current;
        if (!scroller) return;

        let raf_id: number | null = null;

        const report_visible_row = () => {
            if (raf_id !== null) return;
            raf_id = requestAnimationFrame(() => {
                raf_id = null;
                const table = table_ref.current;
                if (!table) return;

                const rows = table.querySelectorAll('tbody tr');
                const scroller_top = scroller.getBoundingClientRect().top;
                let visible_row = 0;

                for (let i = 0; i < rows.length; i++) {
                    const row_rect = (rows[i] as HTMLElement).getBoundingClientRect();
                    if (row_rect.bottom > scroller_top) {
                        visible_row = i;
                        break;
                    }
                }

                if (last_reported_preview_row_ref.current === visible_row) {
                    return;
                }
                last_reported_preview_row_ref.current = visible_row;
                vscode_api.postMessage({ type: 'visibleRowChanged', row: visible_row });
            });
        };

        scroller.addEventListener('scroll', report_visible_row, { passive: true });
        return () => {
            scroller.removeEventListener('scroll', report_visible_row);
            if (raf_id !== null) cancelAnimationFrame(raf_id);
        };
    }, [preview_mode]);

    useEffect(() => {
        const el = scroll_ref.current;
        if (!el) return;

        const on_scroll = () => {
            scroll_positions_ref.current[active_sheet_index] = {
                top: el.scrollTop,
                left: el.scrollLeft,
            };
            state_ref.current = {
                ...state_ref.current,
                scrollPosition: [...scroll_positions_ref.current],
            };
            persist_debounced();
        };

        el.addEventListener('scroll', on_scroll, { passive: true });
        return () => el.removeEventListener('scroll', on_scroll);
    }, [active_sheet_index, persist_debounced]);

    const handle_sheet_select = useCallback(
        (sheet_index: number) => {
            if (scroll_ref.current) {
                scroll_positions_ref.current[active_sheet_index] = {
                    top: scroll_ref.current.scrollTop,
                    left: scroll_ref.current.scrollLeft,
                };
            }
            set_active_sheet_index(sheet_index);
            state_ref.current = {
                ...state_ref.current,
                activeSheetIndex: sheet_index,
                scrollPosition: [...scroll_positions_ref.current],
            };
            persist_immediate();

            requestAnimationFrame(() => {
                const pos = scroll_positions_ref.current[sheet_index];
                if (pos && scroll_ref.current) {
                    scroll_ref.current.scrollTop = pos.top;
                    scroll_ref.current.scrollLeft = pos.left;
                } else if (scroll_ref.current) {
                    scroll_ref.current.scrollTop = 0;
                    scroll_ref.current.scrollLeft = 0;
                }
            });
        },
        [active_sheet_index, persist_immediate]
    );

    const handle_toggle_formatting = useCallback(() => {
        set_show_formatting((prev) => !prev);
    }, []);

    const handle_toggle_tab_orientation = useCallback(() => {
        set_vertical_tabs((prev) => {
            const next = !prev;
            state_ref.current = {
                ...state_ref.current,
                tabOrientation: next ? 'vertical' : 'horizontal',
            };
            persist_immediate();
            return next;
        });
    }, [persist_immediate]);

    const deactivate_auto_fit_for_sheet = useCallback((sheet_index: number) => {
        const is_active = auto_fit_active_ref.current[sheet_index];
        const has_snapshot =
            auto_fit_snapshot_ref.current[sheet_index] !== undefined;

        if (!is_active && !has_snapshot) return;

        if (is_active) {
            set_auto_fit_active((prev) => {
                if (!prev[sheet_index]) return prev;
                const next = [...prev];
                next[sheet_index] = false;
                auto_fit_active_ref.current = next;
                return next;
            });
        }

        if (has_snapshot) {
            set_auto_fit_snapshot((prev) => {
                if (prev[sheet_index] === undefined) return prev;
                const next = [...prev];
                next[sheet_index] = undefined;
                auto_fit_snapshot_ref.current = next;
                return next;
            });
        }
    }, []);

    const handle_column_resize = useCallback(
        (col: number, width: number) => {
            set_column_widths((prev) => {
                const next = [...prev];
                const sheet_widths = { ...(next[active_sheet_index] ?? {}) };
                sheet_widths[col] = width;
                next[active_sheet_index] = sheet_widths;
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: [...next],
                };
                persist_immediate();
                return next;
            });
            // Deactivate auto-fit if it was active (keep current widths, discard snapshot)
            deactivate_auto_fit_for_sheet(active_sheet_index);
        },
        [active_sheet_index, persist_immediate, deactivate_auto_fit_for_sheet]
    );

    const handle_auto_size = useCallback(
        (col: number) => {
            const table = table_ref.current;
            if (!table) return;
            const sheet = workbook?.sheets[active_sheet_index];
            if (!sheet) return;
            const width = measure_column_fit_width(table, col, sheet.merges);
            handle_column_resize(col, width);
        },
        [workbook, active_sheet_index, handle_column_resize]
    );

    const handle_toggle_auto_fit = useCallback(() => {
        if (auto_fit_active[active_sheet_index]) {
            // Deactivate: restore snapshotted widths
            const snapshot = auto_fit_snapshot[active_sheet_index];
            set_column_widths((prev) => {
                const next = [...prev];
                next[active_sheet_index] = snapshot;
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: [...next],
                };
                persist_immediate();
                return next;
            });
            set_auto_fit_active((prev) => {
                const next = [...prev];
                next[active_sheet_index] = false;
                auto_fit_active_ref.current = next;
                return next;
            });
            set_auto_fit_snapshot((prev) => {
                const next = [...prev];
                next[active_sheet_index] = undefined;
                auto_fit_snapshot_ref.current = next;
                return next;
            });
        } else {
            // Activate: snapshot current widths, then auto-fit all columns
            const current_widths = column_widths[active_sheet_index];
            // undefined means no custom widths were set — restoring it
            // returns the sheet to default (browser-determined) widths
            set_auto_fit_snapshot((prev) => {
                const next = [...prev];
                next[active_sheet_index] = current_widths
                    ? { ...current_widths }
                    : undefined;
                auto_fit_snapshot_ref.current = next;
                return next;
            });

            const table = table_ref.current;
            const sheet = workbook?.sheets[active_sheet_index];
            if (table && sheet) {
                set_column_widths((prev) => {
                    const next = [...prev];
                    const new_widths: Record<number, number> = {};
                    for (let c = 0; c < sheet.columnCount; c++) {
                        new_widths[c] = measure_column_fit_width(
                            table,
                            c,
                            sheet.merges
                        );
                    }
                    next[active_sheet_index] = new_widths;
                    state_ref.current = {
                        ...state_ref.current,
                        columnWidths: [...next],
                    };
                    persist_immediate();
                    return next;
                });
            }

            set_auto_fit_active((prev) => {
                const next = [...prev];
                next[active_sheet_index] = true;
                auto_fit_active_ref.current = next;
                return next;
            });
        }
    }, [
        active_sheet_index,
        auto_fit_active,
        auto_fit_snapshot,
        column_widths,
        workbook,
        persist_immediate,
    ]);

    const handle_row_resize = useCallback(
        (row: number, height: number) => {
            set_row_heights((prev) => {
                const next = [...prev];
                const sheet_heights = { ...(next[active_sheet_index] ?? {}) };
                sheet_heights[row] = height;
                next[active_sheet_index] = sheet_heights;
                state_ref.current = {
                    ...state_ref.current,
                    rowHeights: [...next],
                };
                persist_immediate();
                return next;
            });
        },
        [active_sheet_index, persist_immediate]
    );

    const handle_column_resize_batch = useCallback(
        (updates: { col: number; width: number }[]) => {
            set_column_widths((prev) => {
                const next = [...prev];
                const sheet_widths = { ...(next[active_sheet_index] ?? {}) };
                for (const { col, width } of updates) {
                    sheet_widths[col] = width;
                }
                next[active_sheet_index] = sheet_widths;
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: [...next],
                };
                persist_immediate();
                return next;
            });
            deactivate_auto_fit_for_sheet(active_sheet_index);
        },
        [active_sheet_index, persist_immediate, deactivate_auto_fit_for_sheet]
    );

    const handle_row_resize_batch = useCallback(
        (updates: { row: number; height: number }[]) => {
            set_row_heights((prev) => {
                const next = [...prev];
                const sheet_heights = { ...(next[active_sheet_index] ?? {}) };
                for (const { row, height } of updates) {
                    sheet_heights[row] = height;
                }
                next[active_sheet_index] = sheet_heights;
                state_ref.current = {
                    ...state_ref.current,
                    rowHeights: [...next],
                };
                persist_immediate();
                return next;
            });
        },
        [active_sheet_index, persist_immediate]
    );

    if (!workbook) {
        return <div className="loading">Loading...</div>;
    }
    const current_sheet = workbook.sheets[active_sheet_index];

    if (!current_sheet) {
        return <div className="loading">No sheets found</div>;
    }

    const sheet_names = workbook.sheets.map((s) => s.name);
    const has_multiple_sheets = workbook.sheets.length > 1;
    const effective_vertical_tabs = vertical_tabs && has_multiple_sheets;

    return (
        <div className={`viewer ${effective_vertical_tabs ? 'vertical-tabs' : ''}`}>
            <Toolbar
                show_formatting={show_formatting}
                on_toggle_formatting={handle_toggle_formatting}
                show_formatting_button={workbook.hasFormatting}
                vertical_tabs={vertical_tabs}
                on_toggle_tab_orientation={handle_toggle_tab_orientation}
                show_vertical_tabs_button={has_multiple_sheets}
                auto_fit_active={auto_fit_active[active_sheet_index] ?? false}
                on_toggle_auto_fit={handle_toggle_auto_fit}
                edit_mode={toolbar_edit_state.edit_mode}
                is_dirty={toolbar_edit_state.is_dirty}
                on_toggle_edit_mode={() => editing_ref.current.handle_toggle()}
                show_edit_button={csv_editable}
            />
            {truncation_message && (
                <div className="truncation-banner">{truncation_message}{csv_editing_supported && !csv_editable ? '. Editing is disabled for truncated files.' : ''}</div>
            )}
            {effective_vertical_tabs ? (
                <div className="content-area">
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        vertical={true}
                    />
                    <TableWithSelection
                        key={active_sheet_index}
                        sheet={current_sheet}
                        show_formatting={show_formatting}
                        column_widths={
                            column_widths[active_sheet_index] ?? {}
                        }
                        row_heights={
                            row_heights[active_sheet_index] ?? {}
                        }
                        on_column_resize={handle_column_resize}
                        on_column_resize_batch={handle_column_resize_batch}
                        on_auto_size={handle_auto_size}
                        on_row_resize={handle_row_resize}
                        on_row_resize_batch={handle_row_resize_batch}
                        scroll_ref={scroll_ref}
                        table_ref={table_ref}
                        csv_editable={csv_editable}
                        initial_pending_edits={initial_pending_edits}
                        on_edit_mode_change={handle_edit_mode_change}
                        editing_ref={editing_ref}
                    />
                </div>
            ) : (
                <>
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        vertical={false}
                    />
                    <TableWithSelection
                        key={active_sheet_index}
                        sheet={current_sheet}
                        show_formatting={show_formatting}
                        column_widths={
                            column_widths[active_sheet_index] ?? {}
                        }
                        row_heights={
                            row_heights[active_sheet_index] ?? {}
                        }
                        on_column_resize={handle_column_resize}
                        on_column_resize_batch={handle_column_resize_batch}
                        on_auto_size={handle_auto_size}
                        on_row_resize={handle_row_resize}
                        on_row_resize_batch={handle_row_resize_batch}
                        scroll_ref={scroll_ref}
                        table_ref={table_ref}
                        csv_editable={csv_editable}
                        initial_pending_edits={initial_pending_edits}
                        on_edit_mode_change={handle_edit_mode_change}
                        editing_ref={editing_ref}
                    />
                </>
            )}
        </div>
    );
}

interface TableWithSelectionProps {
    sheet: import('../types').SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_column_resize_batch: (updates: { col: number; width: number }[]) => void;
    on_auto_size: (col: number) => void;
    on_row_resize: (row: number, height: number) => void;
    on_row_resize_batch: (updates: { row: number; height: number }[]) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
    table_ref: React.RefObject<HTMLTableElement | null>;
    csv_editable: boolean;
    initial_pending_edits?: Record<string, string | { value: string; base: string }>;
    on_edit_mode_change: (edit_mode: boolean, is_dirty: boolean) => void;
    editing_ref: React.MutableRefObject<{ toggle_edit_mode: () => void; handle_toggle: () => void }>;
}

function TableWithSelection({
    sheet,
    show_formatting,
    column_widths,
    row_heights,
    on_column_resize,
    on_column_resize_batch,
    on_auto_size,
    on_row_resize,
    on_row_resize_batch,
    scroll_ref,
    table_ref,
    csv_editable,
    initial_pending_edits,
    on_edit_mode_change,
    editing_ref,
}: TableWithSelectionProps): React.JSX.Element {
    const sel = use_selection(sheet, show_formatting);
    const editing = use_editing(sheet.rows, sheet.rowCount, sheet.columnCount, initial_pending_edits);

    const [conflict_banner_dismissed, set_conflict_banner_dismissed] = useState(false);

    // Reset banner dismissal only when conflicts first appear (0 → >0)
    const prev_conflict_count = useRef(0);
    useEffect(() => {
        if (editing.conflicted_keys.size > 0 && prev_conflict_count.current === 0) {
            set_conflict_banner_dismissed(false);
        }
        prev_conflict_count.current = editing.conflicted_keys.size;
    }, [editing.conflicted_keys.size]);

    const show_conflict_banner = editing.conflicted_keys.size > 0 && !conflict_banner_dismissed;

    // Exit edit mode when CSV editing becomes disabled (e.g., file truncated on reload)
    useEffect(() => {
        if (!csv_editable && editing.edit_mode) {
            editing.clear_dirty();
            editing.set_edit_mode(false);
        }
    }, [csv_editable, editing.edit_mode, editing.clear_dirty, editing.set_edit_mode]);

    // Report edit state up to App for toolbar
    useEffect(() => {
        on_edit_mode_change(editing.edit_mode, editing.is_dirty);
    }, [editing.edit_mode, editing.is_dirty, on_edit_mode_change]);

    // Cache dirty edits to extension state so they survive tab close
    useEffect(() => {
        if (editing.is_dirty) {
            const edits: Record<string, { value: string; base: string }> = {};
            editing.dirty_cells.forEach((entry, key) => { edits[key] = entry; });
            vscode_api.postMessage({ type: 'pendingEditsChanged', edits });
        } else {
            vscode_api.postMessage({ type: 'pendingEditsChanged', edits: null });
        }
    }, [editing.dirty_cells, editing.is_dirty]);

    // Register ref for toolbar toggle
    useEffect(() => {
        editing_ref.current = {
            toggle_edit_mode: editing.toggle_edit_mode,
            handle_toggle: () => {
                // Check if there's an in-progress cell edit with changes
                const active_value = editing.get_active_editor_value();
                const has_active_changes = active_value !== null && editing.editing_cell && (() => {
                    const { row, col } = editing.editing_cell!;
                    const cell = sheet.rows[row]?.[col];
                    const original = cell !== null ? String(cell?.raw ?? '') : '';
                    return active_value !== original;
                })();

                if (editing.edit_mode && (editing.is_dirty || has_active_changes)) {
                    vscode_api.postMessage({ type: 'showSaveDialog' });
                } else {
                    editing.toggle_edit_mode();
                }
            },
        };
    }, [editing.toggle_edit_mode, editing.edit_mode, editing.is_dirty, editing.editing_cell, editing.get_active_editor_value, editing_ref, sheet.rows]);

    // Track pending action after save completes
    const pending_after_save_ref = useRef<'none' | 'exit_edit_mode'>('none');
    // Snapshot of dirty keys sent in the current save, so we only clear those on success
    const saved_dirty_keys_ref = useRef<Set<string>>(new Set());
    // Safety timeout to reset save_in_flight_ref if saveResult never arrives
    const save_timeout_ref = useRef<ReturnType<typeof setTimeout> | null>(null);

    const set_save_in_flight = useCallback((value: boolean) => {
        editing.save_in_flight_ref.current = value;
        if (save_timeout_ref.current !== null) {
            clearTimeout(save_timeout_ref.current);
            save_timeout_ref.current = null;
        }
        if (value) {
            save_timeout_ref.current = setTimeout(() => {
                editing.save_in_flight_ref.current = false;
                save_timeout_ref.current = null;
            }, 10_000);
        }
    }, [editing.save_in_flight_ref]);

    // Confirm active cell editor and collect edits for saving
    const collect_edits_for_save = useCallback(() => {
        // Confirm the active cell if one is being edited
        const active_value = editing.get_active_editor_value();
        if (active_value !== null) {
            editing.confirm_edit(active_value);
        }
        // Collect dirty cells (may include the just-confirmed cell after state settles)
        const edits: Record<string, string> = {};
        editing.dirty_cells.forEach((entry, key) => {
            edits[key] = entry.value;
        });
        // Also include the just-confirmed cell if it hasn't settled into dirty_cells yet
        if (active_value !== null && editing.editing_cell) {
            const { row, col } = editing.editing_cell;
            const cell = sheet.rows[row]?.[col];
            const original = cell !== null ? String(cell?.raw ?? '') : '';
            if (active_value !== original) {
                edits[`${row}:${col}`] = active_value;
            } else {
                delete edits[`${row}:${col}`];
            }
        }
        return edits;
    }, [editing, sheet.rows]);

    // Handle Cmd+S for saving
    useEffect(() => {
        if (!editing.edit_mode) return;
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault();
                const edits = collect_edits_for_save();
                if (Object.keys(edits).length > 0) {
                    pending_after_save_ref.current = 'none';
                    saved_dirty_keys_ref.current = new Set(Object.keys(edits));
                    set_save_in_flight(true);
                    vscode_api.postMessage({ type: 'saveCsv', edits });
                }
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [editing.edit_mode, collect_edits_for_save, set_save_in_flight]);

    // Handle saveResult and saveDialogResult messages
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data;
            if (msg.type === 'saveResult') {
                set_save_in_flight(false);
                if (msg.success) {
                    editing.clear_dirty_keys(saved_dirty_keys_ref.current);
                    saved_dirty_keys_ref.current = new Set();
                    if (pending_after_save_ref.current === 'exit_edit_mode') {
                        editing.toggle_edit_mode();
                    }
                }
                pending_after_save_ref.current = 'none';
            }
            if (msg.type === 'saveDialogResult') {
                if (msg.choice === 'save') {
                    const edits = collect_edits_for_save();
                    if (Object.keys(edits).length > 0) {
                        pending_after_save_ref.current = 'exit_edit_mode';
                        saved_dirty_keys_ref.current = new Set(Object.keys(edits));
                        set_save_in_flight(true);
                        vscode_api.postMessage({ type: 'saveCsv', edits });
                    } else {
                        editing.toggle_edit_mode();
                    }
                } else if (msg.choice === 'discard') {
                    editing.clear_dirty();
                    editing.toggle_edit_mode();
                }
                // 'cancel' — do nothing
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [editing.clear_dirty, editing.clear_dirty_keys, editing.toggle_edit_mode, collect_edits_for_save, set_save_in_flight]);

    // Handle confirm with navigation
    const handle_confirm_edit = useCallback((value: string, advance: 'down' | 'right' | 'none') => {
        if (!editing.editing_cell) return;
        const { row, col } = editing.editing_cell;
        editing.confirm_edit(value);

        // After re-render, auto-resize the row if the new content needs more space
        if (value.includes('\n') && table_ref.current) {
            requestAnimationFrame(() => {
                if (table_ref.current) {
                    auto_resize_row_after_edit(table_ref.current, row, row_heights, on_row_resize);
                }
            });
        }

        if (advance === 'down' && row < sheet.rowCount - 1) {
            sel.select_cell(row + 1, col);
            setTimeout(() => editing.start_editing(row + 1, col), 0);
        } else if (advance === 'right' && col < sheet.columnCount - 1) {
            sel.select_cell(row, col + 1);
            setTimeout(() => editing.start_editing(row, col + 1), 0);
        } else {
            scroll_ref.current?.focus();
        }
    }, [editing, sel, sheet.rowCount, sheet.columnCount, table_ref, row_heights, on_row_resize, scroll_ref]);

    const handle_column_resize = useCallback(
        (col: number, width: number) => {
            if (sel.selection) {
                const range = normalize_range(sel.selection.range);
                if (col >= range.start_col && col <= range.end_col && range.start_col !== range.end_col) {
                    for (let c = range.start_col; c <= range.end_col; c++) {
                        on_column_resize(c, width);
                    }
                    return;
                }
            }
            on_column_resize(col, width);
        },
        [sel.selection, on_column_resize]
    );

    const handle_auto_size = useCallback(
        (col: number) => {
            if (sel.selection) {
                const range = normalize_range(sel.selection.range);
                if (col >= range.start_col && col <= range.end_col && range.start_col !== range.end_col) {
                    for (let c = range.start_col; c <= range.end_col; c++) {
                        on_auto_size(c);
                    }
                    return;
                }
            }
            on_auto_size(col);
        },
        [sel.selection, on_auto_size]
    );

    const menu_items: MenuItem[] = [];
    if (sel.context_menu) {
        if (csv_editable) {
            menu_items.push({
                label: 'Edit cell',
                on_click: () => {
                    const { row, col } = sel.context_menu!;
                    if (!editing.edit_mode) {
                        editing.set_edit_mode(true);
                    }
                    editing.force_start_editing(row, col);
                },
            });
        }
        if (editing.dirty_cells.has(`${sel.context_menu.row}:${sel.context_menu.col}`)) {
            menu_items.push({
                label: 'Discard edit',
                on_click: () => {
                    const { row, col } = sel.context_menu!;
                    editing.discard_edit(`${row}:${col}`);
                },
            });
        }
        menu_items.push({
            label: 'Copy cell',
            on_click: () =>
                sel.copy_cell(sel.context_menu!.row, sel.context_menu!.col),
        });
        if (sel.is_multi_cell) {
            menu_items.push({
                label: 'Copy selection',
                on_click: () => sel.copy_selection(),
            });
        }
        menu_items.push({
            label: 'Select row',
            on_click: () => sel.select_row(sel.context_menu!.row),
        });
        menu_items.push({
            label: 'Select column',
            on_click: () => sel.select_column(sel.context_menu!.col),
        });
        menu_items.push({
            label: 'Select all',
            on_click: () => sel.select_all(),
        });
    }

    return (
        <>
            {show_conflict_banner && (
                <div className="conflict-banner">
                    <span>
                        File changed externally. {editing.conflicted_keys.size} edit{editing.conflicted_keys.size !== 1 ? 's' : ''} may be affected — highlighted cells show conflicts.
                    </span>
                    <span className="conflict-banner-actions">
                        <button onClick={() => set_conflict_banner_dismissed(true)}>Keep All</button>
                        <button onClick={() => { editing.discard_conflicted(); }}>Discard Conflicted</button>
                        <button onClick={() => { editing.cancel_edit(); editing.clear_dirty(); editing.set_edit_mode(false); }}>Discard All</button>
                    </span>
                </div>
            )}
            <Table
                sheet={sheet}
                show_formatting={show_formatting}
                column_widths={column_widths}
                row_heights={row_heights}
                on_column_resize={handle_column_resize}
                on_column_resize_batch={on_column_resize_batch}
                on_auto_size={handle_auto_size}
                on_row_resize={on_row_resize}
                on_row_resize_batch={on_row_resize_batch}
                scroll_ref={scroll_ref}
                table_ref={table_ref}
                selection={sel.selection}
                on_cell_mouse_down={(row, col, e) => {
                    if (editing.editing_cell) {
                        const value = editing.get_active_editor_value() ?? editing.editing_cell.value;
                        editing.confirm_edit(value);
                    }
                    sel.on_cell_mouse_down(row, col, e);
                }}
                on_cell_mouse_move={sel.on_cell_mouse_move}
                on_cell_mouse_up={sel.on_cell_mouse_up}
                on_context_menu={sel.on_context_menu}
                on_key_down={(e) => {
                    if (e.key === 'Enter' && !editing.editing_cell && csv_editable && sel.selection) {
                        e.preventDefault();
                        const { anchor_row, anchor_col } = sel.selection;
                        if (!editing.edit_mode) {
                            editing.set_edit_mode(true);
                        }
                        editing.force_start_editing(anchor_row, anchor_col);
                        return;
                    }
                    sel.on_key_down(e);
                }}
                editing_cell={editing.editing_cell}
                dirty_cells={editing.dirty_cells}
                conflicted_keys={editing.conflicted_keys}
                edit_mode={editing.edit_mode}
                on_double_click={(r, c) => {
                    if (editing.edit_mode) editing.start_editing(r, c);
                }}
                on_confirm_edit={handle_confirm_edit}
                on_cancel_edit={() => {
                    editing.cancel_edit();
                    scroll_ref.current?.focus();
                }}
                get_display_value={editing.get_display_value}
            />
            {sel.context_menu && (
                <ContextMenu
                    x={sel.context_menu.x}
                    y={sel.context_menu.y}
                    items={menu_items}
                    on_dismiss={sel.dismiss_context_menu}
                />
            )}
        </>
    );
}
