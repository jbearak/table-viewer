import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { WorkbookData, PerFileState, HostMessage } from '../types';
import { Toolbar } from './toolbar';
import { SheetTabs } from './sheet-tabs';
import { Table } from './table';
import {
    clamp_sheet_index,
    normalize_per_file_state,
    trim_sheet_state_array,
} from './sheet-state';
import { vscode_api, use_state_sync } from './use-state-sync';
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

    const scroll_ref = useRef<HTMLDivElement | null>(null);
    const state_ref = useRef<PerFileState>({});
    const scroll_positions_ref = useRef<
        ({ top: number; left: number } | undefined)[]
    >([]);

    const { persist_debounced, persist_immediate } =
        use_state_sync(state_ref);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;

            if (msg.type === 'workbookData') {
                set_workbook(msg.data);
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
                state_ref.current = s;

                requestAnimationFrame(() => {
                    const pos =
                        scroll_positions_ref.current[s.activeSheetIndex ?? 0];
                    if (pos && scroll_ref.current) {
                        scroll_ref.current.scrollTop = pos.top;
                        scroll_ref.current.scrollLeft = pos.left;
                    }
                });
            }

            if (msg.type === 'reload') {
                set_workbook(msg.data);
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
        },
        [active_sheet_index, persist_immediate]
    );

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

    if (!workbook) {
        return <div className="loading">Loading...</div>;
    }
    const current_sheet = workbook.sheets[active_sheet_index];

    if (!current_sheet) {
        return <div className="loading">No sheets found</div>;
    }

    const sheet_names = workbook.sheets.map((s) => s.name);

    return (
        <div className={`viewer ${vertical_tabs ? 'vertical-tabs' : ''}`}>
            <Toolbar
                show_formatting={show_formatting}
                on_toggle_formatting={handle_toggle_formatting}
                vertical_tabs={vertical_tabs}
                on_toggle_tab_orientation={
                    handle_toggle_tab_orientation
                }
            />
            {vertical_tabs ? (
                <div className="content-area">
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        vertical={true}
                    />
                    <Table
                        sheet={current_sheet}
                        show_formatting={show_formatting}
                        column_widths={
                            column_widths[active_sheet_index] ?? {}
                        }
                        row_heights={
                            row_heights[active_sheet_index] ?? {}
                        }
                        on_column_resize={handle_column_resize}
                        on_row_resize={handle_row_resize}
                        scroll_ref={scroll_ref}
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
                    <Table
                        sheet={current_sheet}
                        show_formatting={show_formatting}
                        column_widths={
                            column_widths[active_sheet_index] ?? {}
                        }
                        row_heights={
                            row_heights[active_sheet_index] ?? {}
                        }
                        on_column_resize={handle_column_resize}
                        on_row_resize={handle_row_resize}
                        scroll_ref={scroll_ref}
                    />
                </>
            )}
        </div>
    );
}
