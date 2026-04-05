import React, { useCallback, useRef } from 'react';
import type { SheetData, CellData, MergeRange } from '../types';

interface TableProps {
    sheet: SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_row_resize: (row: number, height: number) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
}

export function Table({
    sheet,
    show_formatting,
    column_widths,
    row_heights,
    on_column_resize,
    on_row_resize,
    scroll_ref,
}: TableProps): React.JSX.Element {
    const merge_map = build_merge_map(sheet.merges);

    return (
        <div className="table-container" ref={scroll_ref as React.LegacyRef<HTMLDivElement>}>
            <table className="data-table">
                <tbody>
                    {sheet.rows.map((row, r) => (
                        <tr
                            key={r}
                            style={
                                row_heights[r]
                                    ? { height: `${row_heights[r]}px` }
                                    : undefined
                            }
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

                                return (
                                    <td
                                        key={c}
                                        {...span_props}
                                        style={
                                            column_widths[c]
                                                ? {
                                                      width: `${column_widths[c]}px`,
                                                      minWidth: `${column_widths[c]}px`,
                                                  }
                                                : undefined
                                        }
                                    >
                                        {r === 0 && (
                                            <ColumnResizeHandle
                                                col={c}
                                                on_resize={on_column_resize}
                                            />
                                        )}
                                        <CellContent
                                            cell={cell}
                                            show_formatting={show_formatting}
                                        />
                                    </td>
                                );
                            })}
                            <RowResizeIndicator
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
        : (cell.raw !== null ? String(cell.raw) : '');

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

interface RowResizeIndicatorProps {
    row: number;
    on_resize: (row: number, height: number) => void;
}

function RowResizeIndicator({
    row,
    on_resize,
}: RowResizeIndicatorProps): React.JSX.Element {
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
