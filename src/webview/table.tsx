import React, { useCallback, useRef } from 'react';
import { get_raw_cell_text } from '../cell-display';
import type { SheetData, CellData, MergeRange } from '../types';
import { type SelectionState, normalize_range, is_cell_in_range } from './selection';

interface TableProps {
    sheet: SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_row_resize: (row: number, height: number) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
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
    on_row_resize,
    scroll_ref,
    selection,
    on_cell_mouse_down,
    on_cell_mouse_move,
    on_cell_mouse_up,
    on_context_menu,
    on_key_down,
}: TableProps): React.JSX.Element {
    const merge_map = build_merge_map(sheet.merges);

    const resize_handle_row = new Map<number, number>();
    for (let c = 0; c < sheet.columnCount; c++) {
        for (let r = 0; r < sheet.rows.length; r++) {
            const entry = merge_map.get(`${r}:${c}`);
            if (entry !== 'hidden') {
                resize_handle_row.set(c, r);
                break;
            }
        }
    }

    const sel_range = selection ? normalize_range(selection.range) : null;

    return (
        <div
            className="table-container"
            ref={scroll_ref as React.LegacyRef<HTMLDivElement>}
            tabIndex={0}
            onKeyDown={on_key_down}
            onMouseUp={on_cell_mouse_up}
        >
            <table className="data-table">
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

                                const show_resize_handle =
                                    resize_handle_row.get(c) === r;

                                const selected = is_cell_in_range(
                                    r,
                                    c,
                                    sel_range
                                );
                                const is_anchor =
                                    selection !== null &&
                                    r === selection.anchor_row &&
                                    c === selection.anchor_col;

                                const class_names = [
                                    selected ? 'selected' : '',
                                    is_anchor ? 'active-cell' : '',
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
                                            ...(column_widths[c]
                                                ? {
                                                      width: `${column_widths[c]}px`,
                                                      minWidth: `${column_widths[c]}px`,
                                                  }
                                                : undefined),
                                            ...(show_resize_handle
                                                ? {
                                                      position:
                                                          'relative',
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
                                        {show_resize_handle && (
                                            <ColumnResizeHandle
                                                col={c}
                                                on_resize={
                                                    on_column_resize
                                                }
                                            />
                                        )}
                                        <CellContent
                                            cell={cell}
                                            show_formatting={
                                                show_formatting
                                            }
                                        />
                                    </td>
                                );
                            })}
                            <RowResizeHandle
                                row={r}
                                on_resize={on_row_resize}
                            />
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
}

function ColumnResizeHandle({
    col,
    on_resize,
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

            const handle_mouse_move = (move_e: MouseEvent) => {
                const new_width = Math.max(
                    40,
                    start_width + move_e.clientX - start_x
                );
                td.style.width = `${new_width}px`;
                td.style.minWidth = `${new_width}px`;
            };

            const handle_mouse_up = (up_e: MouseEvent) => {
                dragging_ref.current = false;
                document.removeEventListener('mousemove', handle_mouse_move);
                document.removeEventListener('mouseup', handle_mouse_up);
                const final_width = Math.max(
                    40,
                    start_width + up_e.clientX - start_x
                );
                on_resize(col, final_width);
            };

            document.addEventListener('mousemove', handle_mouse_move);
            document.addEventListener('mouseup', handle_mouse_up);
        },
        [col, on_resize]
    );

    return (
        <div
            className="col-resize-handle"
            onMouseDown={handle_mouse_down}
        />
    );
}

interface RowResizeHandleProps {
    row: number;
    on_resize: (row: number, height: number) => void;
}

function RowResizeHandle({
    row,
    on_resize,
}: RowResizeHandleProps): React.JSX.Element {
    const handle_mouse_down = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            const tr = (e.target as HTMLElement).closest('tr')!;
            const start_y = e.clientY;
            const start_height = tr.offsetHeight;

            const handle_mouse_move = (move_e: MouseEvent) => {
                const new_height = Math.max(
                    20,
                    start_height + move_e.clientY - start_y
                );
                tr.style.height = `${new_height}px`;
            };

            const handle_mouse_up = (up_e: MouseEvent) => {
                document.removeEventListener('mousemove', handle_mouse_move);
                document.removeEventListener('mouseup', handle_mouse_up);
                const final_height = Math.max(
                    20,
                    start_height + up_e.clientY - start_y
                );
                on_resize(row, final_height);
            };

            document.addEventListener('mousemove', handle_mouse_move);
            document.addEventListener('mouseup', handle_mouse_up);
        },
        [row, on_resize]
    );

    return (
        <td style={{ padding: 0, width: 0, border: 'none', position: 'relative' }}>
            <div
                className="row-resize-handle"
                onMouseDown={handle_mouse_down}
            />
        </td>
    );
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
