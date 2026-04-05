import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { WorkbookData, PerFileState, HostMessage } from '../types';
import { Toolbar } from './toolbar';
import { SheetTabs } from './sheet-tabs';
import { Table } from './table';
import { vscode_api, use_state_sync } from './use-state-sync';
import './styles.css';

export function App(): React.JSX.Element {
    const [workbook, set_workbook] = useState<WorkbookData | null>(null);
    const [active_sheet, set_active_sheet] = useState<string>('');
    const [show_formatting, set_show_formatting] = useState(true);
    const [vertical_tabs, set_vertical_tabs] = useState(false);
    const [column_widths, set_column_widths] = useState<
        Record<string, Record<number, number>>
    >({});
    const [row_heights, set_row_heights] = useState<
        Record<string, Record<number, number>>
    >({});

    const scroll_ref = useRef<HTMLDivElement | null>(null);
    const state_ref = useRef<PerFileState>({});
    const scroll_positions_ref = useRef<
        Record<string, { top: number; left: number }>
    >({});

    const { persist_debounced, persist_immediate } =
        use_state_sync(state_ref);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;

            if (msg.type === 'workbookData') {
                set_workbook(msg.data);

                const s = msg.state;
                const first_sheet =
                    msg.data.sheets[0]?.name ?? '';
                const sheet_name = s.activeSheet ?? first_sheet;
                set_active_sheet(sheet_name);
                set_column_widths(s.columnWidths ?? {});
                set_row_heights(s.rowHeights ?? {});
                scroll_positions_ref.current =
                    s.scrollPosition ?? {};

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
                        scroll_positions_ref.current[sheet_name];
                    if (pos && scroll_ref.current) {
                        scroll_ref.current.scrollTop = pos.top;
                        scroll_ref.current.scrollLeft = pos.left;
                    }
                });
            }

            if (msg.type === 'reload') {
                set_workbook(msg.data);

                const new_names = new Set(
                    msg.data.sheets.map((s) => s.name)
                );

                // Clear persisted state for removed sheets
                const clean_record = <T,>(
                    rec: Record<string, T>
                ): Record<string, T> => {
                    const result: Record<string, T> = {};
                    for (const key of Object.keys(rec)) {
                        if (new_names.has(key)) result[key] = rec[key];
                    }
                    return result;
                };

                set_column_widths((prev) => clean_record(prev));
                set_row_heights((prev) => clean_record(prev));
                scroll_positions_ref.current = clean_record(
                    scroll_positions_ref.current
                );

                set_active_sheet((prev) => {
                    if (new_names.has(prev)) return prev;
                    return msg.data.sheets[0]?.name ?? '';
                });

                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: clean_record(
                        state_ref.current.columnWidths ?? {}
                    ),
                    rowHeights: clean_record(
                        state_ref.current.rowHeights ?? {}
                    ),
                    scrollPosition: clean_record(
                        state_ref.current.scrollPosition ?? {}
                    ),
                    activeSheet: new_names.has(
                        state_ref.current.activeSheet ?? ''
                    )
                        ? state_ref.current.activeSheet
                        : msg.data.sheets[0]?.name,
                };
                persist_immediate();
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [persist_immediate]);

    useEffect(() => {
        vscode_api.postMessage({ type: 'ready' });
    }, []);

    useEffect(() => {
        const el = scroll_ref.current;
        if (!el) return;

        const on_scroll = () => {
            scroll_positions_ref.current[active_sheet] = {
                top: el.scrollTop,
                left: el.scrollLeft,
            };
            state_ref.current = {
                ...state_ref.current,
                scrollPosition: { ...scroll_positions_ref.current },
            };
            persist_debounced();
        };

        el.addEventListener('scroll', on_scroll, { passive: true });
        return () => el.removeEventListener('scroll', on_scroll);
    }, [active_sheet, persist_debounced]);

    const handle_sheet_select = useCallback(
        (name: string) => {
            if (scroll_ref.current) {
                scroll_positions_ref.current[active_sheet] = {
                    top: scroll_ref.current.scrollTop,
                    left: scroll_ref.current.scrollLeft,
                };
            }

            set_active_sheet(name);
            state_ref.current = {
                ...state_ref.current,
                activeSheet: name,
                scrollPosition: { ...scroll_positions_ref.current },
            };
            persist_immediate();

            requestAnimationFrame(() => {
                const pos = scroll_positions_ref.current[name];
                if (pos && scroll_ref.current) {
                    scroll_ref.current.scrollTop = pos.top;
                    scroll_ref.current.scrollLeft = pos.left;
                } else if (scroll_ref.current) {
                    scroll_ref.current.scrollTop = 0;
                    scroll_ref.current.scrollLeft = 0;
                }
            });
        },
        [active_sheet, persist_immediate]
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
                const sheet_widths = { ...(prev[active_sheet] ?? {}) };
                sheet_widths[col] = width;
                const next = { ...prev, [active_sheet]: sheet_widths };
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: next,
                };
                persist_immediate();
                return next;
            });
        },
        [active_sheet, persist_immediate]
    );

    const handle_row_resize = useCallback(
        (row: number, height: number) => {
            set_row_heights((prev) => {
                const sheet_heights = { ...(prev[active_sheet] ?? {}) };
                sheet_heights[row] = height;
                const next = { ...prev, [active_sheet]: sheet_heights };
                state_ref.current = {
                    ...state_ref.current,
                    rowHeights: next,
                };
                persist_immediate();
                return next;
            });
        },
        [active_sheet, persist_immediate]
    );

    if (!workbook) {
        return <div className="loading">Loading...</div>;
    }

    const current_sheet = workbook.sheets.find(
        (s) => s.name === active_sheet
    );

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
                        active_sheet={active_sheet}
                        on_select={handle_sheet_select}
                        vertical={true}
                    />
                    <Table
                        sheet={current_sheet}
                        show_formatting={show_formatting}
                        column_widths={
                            column_widths[active_sheet] ?? {}
                        }
                        row_heights={
                            row_heights[active_sheet] ?? {}
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
                        active_sheet={active_sheet}
                        on_select={handle_sheet_select}
                        vertical={false}
                    />
                    <Table
                        sheet={current_sheet}
                        show_formatting={show_formatting}
                        column_widths={
                            column_widths[active_sheet] ?? {}
                        }
                        row_heights={
                            row_heights[active_sheet] ?? {}
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
