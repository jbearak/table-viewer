import React, { useCallback, useEffect, useRef, useState } from 'react';
import { get_raw_cell_text } from '../cell-display';
import type { SheetData, CellData, MergeRange } from '../types';
import { type SelectionState, normalize_range, is_cell_in_range } from './selection';
import { build_boundary_groups } from './boundary-groups';

interface TableProps {
    sheet: SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_auto_size: (col: number) => void;
    on_row_resize: (row: number, height: number) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
    table_ref: React.RefObject<HTMLTableElement | null>;
    selection: SelectionState | null;
    on_cell_mouse_down: (row: number, col: number, e: React.MouseEvent) => void;
    on_cell_mouse_move: (row: number, col: number) => void;
    on_cell_mouse_up: () => void;
    on_context_menu: (row: number, col: number, e: React.MouseEvent) => void;
    on_key_down: (e: React.KeyboardEvent) => void;
}

export function Table({
    sheet,
    show_formatting,
    column_widths,
    row_heights,
    on_column_resize,
    on_auto_size,
    on_row_resize,
    scroll_ref,
    table_ref,
    selection,
    on_cell_mouse_down,
    on_cell_mouse_move,
    on_cell_mouse_up,
    on_context_menu,
    on_key_down,
}: TableProps): React.JSX.Element {
    const merge_map = build_merge_map(sheet.merges);

    const { col_boundary_groups, row_boundary_groups } = build_boundary_groups(
        sheet.rows.length,
        sheet.columnCount,
        sheet.merges
    );

    const [active_col_boundary, set_active_col_boundary] = useState<number | null>(null);
    const [active_row_boundary, set_active_row_boundary] = useState<number | null>(null);

    const is_col_highlighted = useCallback(
        (r: number, c: number, col_span: number): boolean => {
            if (active_col_boundary === null) return false;
            const cell_right_boundary = c + col_span - 1;
            if (cell_right_boundary !== active_col_boundary) return false;
            const { first, last } = visible_range_ref.current;
            if (r < first || r > last) return false;
            const group = col_boundary_groups.get(active_col_boundary);
            return group !== undefined && group.has(r);
        },
        [active_col_boundary, col_boundary_groups]
    );

    const is_row_highlighted = useCallback(
        (r: number, c: number, row_span: number): boolean => {
            if (active_row_boundary === null) return false;
            const cell_bottom_boundary = r + row_span - 1;
            if (cell_bottom_boundary !== active_row_boundary) return false;
            const group = row_boundary_groups.get(active_row_boundary);
            return group !== undefined && group.has(c);
        },
        [active_row_boundary, row_boundary_groups]
    );

    const handle_col_hover_start = useCallback(
        (boundary_col: number) => set_active_col_boundary(boundary_col),
        []
    );
    const handle_col_hover_end = useCallback(
        () => set_active_col_boundary(null),
        []
    );
    const handle_row_hover_start = useCallback(
        (boundary_row: number) => set_active_row_boundary(boundary_row),
        []
    );
    const handle_row_hover_end = useCallback(
        () => set_active_row_boundary(null),
        []
    );

    const visible_range_ref = useRef<{ first: number; last: number }>({ first: 0, last: Infinity });
    const [, set_render_tick] = useState(0);

    // Recompute visible range when active boundary changes
    useEffect(() => {
        if (active_col_boundary === null && active_row_boundary === null) return;
        const scroll_el = scroll_ref.current;
        const table_el = table_ref.current;
        if (!scroll_el || !table_el) return;
        visible_range_ref.current = get_visible_row_range(scroll_el, table_el);
    }, [active_col_boundary, active_row_boundary]);

    // Update highlights on scroll during drag
    useEffect(() => {
        if (active_col_boundary === null && active_row_boundary === null) return;
        const scroll_el = scroll_ref.current;
        const table_el = table_ref.current;
        if (!scroll_el || !table_el) return;

        let raf_id: number | null = null;

        const on_scroll = () => {
            if (raf_id !== null) return;
            raf_id = requestAnimationFrame(() => {
                raf_id = null;
                visible_range_ref.current = get_visible_row_range(scroll_el, table_el);
                set_render_tick(t => t + 1);
            });
        };

        scroll_el.addEventListener('scroll', on_scroll, { passive: true });
        return () => {
            scroll_el.removeEventListener('scroll', on_scroll);
            if (raf_id !== null) cancelAnimationFrame(raf_id);
        };
    }, [active_col_boundary, active_row_boundary]);

    const sel_range = selection ? normalize_range(selection.range) : null;

    return (
        <div
            className="table-container"
            ref={scroll_ref as React.LegacyRef<HTMLDivElement>}
            tabIndex={0}
            onKeyDown={on_key_down}
            onMouseUp={on_cell_mouse_up}
        >
            <table className="data-table" ref={table_ref as React.LegacyRef<HTMLTableElement>}>
                <tbody>
                    {sheet.rows.map((row, r) => (
                        <tr
                            key={r}
                            style={{
                                position: 'relative',
                                ...(row_heights[r]
                                    ? { height: `${row_heights[r]}px` }
                                    : undefined),
                            }}
                        >
                            {row.map((cell, c) => {
                                const key = `${r}:${c}`;
                                const merge_info = merge_map.get(key);

                                if (merge_info === 'hidden') return null;

                                const span_props: {
                                    rowSpan?: number;
                                    colSpan?: number;
                                } = {};
                                if (merge_info) {
                                    span_props.rowSpan =
                                        merge_info.rowSpan;
                                    span_props.colSpan =
                                        merge_info.colSpan;
                                }

                                const selected = is_cell_in_range(
                                    r,
                                    c,
                                    sel_range
                                );
                                const is_anchor =
                                    selection !== null &&
                                    r === selection.anchor_row &&
                                    c === selection.anchor_col;

                                const col_span = span_props.colSpan ?? 1;
                                const row_span = span_props.rowSpan ?? 1;

                                const col_highlighted = is_col_highlighted(r, c, col_span);
                                const row_highlighted = is_row_highlighted(r, c, row_span);

                                const class_names = [
                                    selected ? 'selected' : '',
                                    is_anchor ? 'active-cell' : '',
                                    col_highlighted ? 'resize-col-highlight' : '',
                                    row_highlighted ? 'resize-row-highlight' : '',
                                ]
                                    .filter(Boolean)
                                    .join(' ');

                                return (
                                    <td
                                        key={c}
                                        {...span_props}
                                        className={
                                            class_names || undefined
                                        }
                                        style={{
                                            position: 'relative',
                                            ...(column_widths[c]
                                                ? {
                                                      width: `${column_widths[c]}px`,
                                                      minWidth: `${column_widths[c]}px`,
                                                  }
                                                : undefined),
                                        }}
                                        onMouseDown={(e) =>
                                            on_cell_mouse_down(r, c, e)
                                        }
                                        onMouseMove={() =>
                                            on_cell_mouse_move(r, c)
                                        }
                                        onContextMenu={(e) =>
                                            on_context_menu(r, c, e)
                                        }
                                    >
                                        <ColumnResizeHandle
                                            col={span_props.colSpan ? c + (span_props.colSpan - 1) : c}
                                            on_resize={on_column_resize}
                                            on_auto_size={on_auto_size}
                                            colspan_cols={span_props.colSpan && span_props.colSpan > 1
                                                ? Array.from({ length: span_props.colSpan }, (_, i) => c + i)
                                                : undefined}
                                            on_hover_start={handle_col_hover_start}
                                            on_hover_end={handle_col_hover_end}
                                        />
                                        <RowResizeHandle
                                            row={span_props.rowSpan ? r + (span_props.rowSpan - 1) : r}
                                            on_resize={on_row_resize}
                                            rowspan_rows={span_props.rowSpan && span_props.rowSpan > 1
                                                ? Array.from({ length: span_props.rowSpan }, (_, i) => r + i)
                                                : undefined}
                                            on_hover_start={handle_row_hover_start}
                                            on_hover_end={handle_row_hover_end}
                                        />
                                        <CellContent
                                            cell={cell}
                                            show_formatting={
                                                show_formatting
                                            }
                                        />
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function CellContent({
    cell,
    show_formatting,
}: {
    cell: CellData | null;
    show_formatting: boolean;
}): React.JSX.Element {
    if (!cell) return <></>;

    const text = show_formatting
        ? cell.formatted
        : get_raw_cell_text(cell.raw);

    let content: React.ReactNode = text;

    if (cell.bold && cell.italic) {
        content = <b><i>{text}</i></b>;
    } else if (cell.bold) {
        content = <b>{text}</b>;
    } else if (cell.italic) {
        content = <i>{text}</i>;
    }

    return <>{content}</>;
}

interface ColumnResizeHandleProps {
    col: number;
    on_resize: (col: number, width: number) => void;
    on_auto_size: (col: number) => void;
    colspan_cols?: number[];
    on_hover_start: (boundary_col: number) => void;
    on_hover_end: () => void;
}

function ColumnResizeHandle({
    col,
    on_resize,
    on_auto_size,
    colspan_cols,
    on_hover_start,
    on_hover_end,
}: ColumnResizeHandleProps): React.JSX.Element {
    const dragging_ref = useRef(false);

    const handle_mouse_down = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragging_ref.current = true;

            const start_x = e.clientX;
            const td = (e.target as HTMLElement).parentElement!;
            const start_width = td.offsetWidth;

            if (colspan_cols && colspan_cols.length > 1) {
                const handle_mouse_move = (move_e: MouseEvent) => {
                    const new_width = Math.max(
                        40 * colspan_cols.length,
                        start_width + move_e.clientX - start_x
                    );
                    td.style.width = `${new_width}px`;
                    td.style.minWidth = `${new_width}px`;
                };

                const handle_mouse_up = (up_e: MouseEvent) => {
                    dragging_ref.current = false;
                    document.removeEventListener('mousemove', handle_mouse_move);
                    document.removeEventListener('mouseup', handle_mouse_up);
                    const total_delta = up_e.clientX - start_x;
                    const per_col_delta = total_delta / colspan_cols.length;
                    const per_col_start = start_width / colspan_cols.length;
                    for (const c of colspan_cols) {
                        const final_width = Math.max(40, per_col_start + per_col_delta);
                        on_resize(c, final_width);
                    }
                    on_hover_end();
                };

                document.addEventListener('mousemove', handle_mouse_move);
                document.addEventListener('mouseup', handle_mouse_up);
            } else {
                const handle_mouse_move = (move_e: MouseEvent) => {
                    const new_width = Math.max(40, start_width + move_e.clientX - start_x);
                    td.style.width = `${new_width}px`;
                    td.style.minWidth = `${new_width}px`;
                };

                const handle_mouse_up = (up_e: MouseEvent) => {
                    dragging_ref.current = false;
                    document.removeEventListener('mousemove', handle_mouse_move);
                    document.removeEventListener('mouseup', handle_mouse_up);
                    const final_width = Math.max(40, start_width + up_e.clientX - start_x);
                    on_resize(col, final_width);
                    on_hover_end();
                };

                document.addEventListener('mousemove', handle_mouse_move);
                document.addEventListener('mouseup', handle_mouse_up);
            }
        },
        [col, on_resize, colspan_cols, on_hover_end]
    );

    const handle_double_click = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (colspan_cols && colspan_cols.length > 1) {
                for (const c of colspan_cols) {
                    on_auto_size(c);
                }
            } else {
                on_auto_size(col);
            }
        },
        [col, on_auto_size, colspan_cols]
    );

    return (
        <div
            className="col-resize-handle"
            onMouseDown={handle_mouse_down}
            onDoubleClick={handle_double_click}
            onMouseEnter={() => on_hover_start(col)}
            onMouseLeave={() => {
                if (!dragging_ref.current) on_hover_end();
            }}
        />
    );
}

interface RowResizeHandleProps {
    row: number;
    on_resize: (row: number, height: number) => void;
    rowspan_rows?: number[];
    on_hover_start: (boundary_row: number) => void;
    on_hover_end: () => void;
}

function RowResizeHandle({
    row,
    on_resize,
    rowspan_rows,
    on_hover_start,
    on_hover_end,
}: RowResizeHandleProps): React.JSX.Element {
    const dragging_ref = useRef(false);

    const handle_mouse_down = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragging_ref.current = true;
            const tr = (e.target as HTMLElement).closest('tr')!;
            const start_y = e.clientY;
            const start_height = tr.offsetHeight;

            if (rowspan_rows && rowspan_rows.length > 1) {
                const handle_mouse_move = (move_e: MouseEvent) => {
                    const new_height = Math.max(
                        20 * rowspan_rows.length,
                        start_height + move_e.clientY - start_y
                    );
                    tr.style.height = `${new_height}px`;
                };

                const handle_mouse_up = (up_e: MouseEvent) => {
                    dragging_ref.current = false;
                    document.removeEventListener('mousemove', handle_mouse_move);
                    document.removeEventListener('mouseup', handle_mouse_up);
                    const total_delta = up_e.clientY - start_y;
                    const per_row_delta = total_delta / rowspan_rows.length;
                    const per_row_start = start_height / rowspan_rows.length;
                    for (const r of rowspan_rows) {
                        const final_height = Math.max(20, per_row_start + per_row_delta);
                        on_resize(r, final_height);
                    }
                    on_hover_end();
                };

                document.addEventListener('mousemove', handle_mouse_move);
                document.addEventListener('mouseup', handle_mouse_up);
            } else {
                const handle_mouse_move = (move_e: MouseEvent) => {
                    const new_height = Math.max(20, start_height + move_e.clientY - start_y);
                    tr.style.height = `${new_height}px`;
                };

                const handle_mouse_up = (up_e: MouseEvent) => {
                    dragging_ref.current = false;
                    document.removeEventListener('mousemove', handle_mouse_move);
                    document.removeEventListener('mouseup', handle_mouse_up);
                    const final_height = Math.max(20, start_height + up_e.clientY - start_y);
                    on_resize(row, final_height);
                    on_hover_end();
                };

                document.addEventListener('mousemove', handle_mouse_move);
                document.addEventListener('mouseup', handle_mouse_up);
            }
        },
        [row, on_resize, rowspan_rows, on_hover_end]
    );

    return (
        <div
            className="row-resize-handle"
            onMouseDown={handle_mouse_down}
            onMouseEnter={() => on_hover_start(row)}
            onMouseLeave={() => {
                if (!dragging_ref.current) on_hover_end();
            }}
        />
    );
}

function get_visible_row_range(
    scroll_el: HTMLElement,
    table_el: HTMLTableElement
): { first: number; last: number } {
    const rows = table_el.querySelectorAll('tbody tr');
    if (rows.length === 0) return { first: 0, last: -1 };

    const scroll_top = scroll_el.scrollTop;
    const viewport_bottom = scroll_top + scroll_el.clientHeight;

    // Binary search for first visible row
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const row = rows[mid] as HTMLElement;
        if (row.offsetTop + row.offsetHeight < scroll_top) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    const first = lo;

    // Binary search for last visible row
    lo = first;
    hi = rows.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        const row = rows[mid] as HTMLElement;
        if (row.offsetTop > viewport_bottom) {
            hi = mid - 1;
        } else {
            lo = mid;
        }
    }
    const last = lo;

    return { first, last };
}

type MergeMapEntry =
    | 'hidden'
    | { rowSpan: number; colSpan: number };

function build_merge_map(
    merges: MergeRange[]
): Map<string, MergeMapEntry> {
    const map = new Map<string, MergeMapEntry>();

    for (const m of merges) {
        map.set(`${m.startRow}:${m.startCol}`, {
            rowSpan: m.endRow - m.startRow + 1,
            colSpan: m.endCol - m.startCol + 1,
        });

        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r === m.startRow && c === m.startCol) continue;
                map.set(`${r}:${c}`, 'hidden');
            }
        }
    }

    return map;
}
