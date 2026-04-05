// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, it, expect, afterEach } from 'vitest';
import {
    normalize_range,
    is_cell_in_range,
    expand_range_for_merges,
    resolve_merge_anchor,
    move_active_cell,
    format_selection_for_clipboard,
    type SelectionRange,
    type SelectionState,
} from '../webview/selection';
import { use_selection } from '../webview/use-selection';
import type { MergeRange, CellData, SheetData } from '../types';

describe('normalize_range', () => {
    it('returns top-left to bottom-right regardless of input order', () => {
        const range: SelectionRange = { start_row: 5, start_col: 3, end_row: 2, end_col: 1 };
        expect(normalize_range(range)).toEqual({ start_row: 2, start_col: 1, end_row: 5, end_col: 3 });
    });
    it('leaves already-normalized ranges unchanged', () => {
        const range: SelectionRange = { start_row: 0, start_col: 0, end_row: 3, end_col: 2 };
        expect(normalize_range(range)).toEqual(range);
    });
});

describe('is_cell_in_range', () => {
    const range: SelectionRange = { start_row: 1, start_col: 1, end_row: 3, end_col: 3 };
    it('returns true for cells inside the range', () => {
        expect(is_cell_in_range(2, 2, range)).toBe(true);
        expect(is_cell_in_range(1, 1, range)).toBe(true);
        expect(is_cell_in_range(3, 3, range)).toBe(true);
    });
    it('returns false for cells outside the range', () => {
        expect(is_cell_in_range(0, 0, range)).toBe(false);
        expect(is_cell_in_range(4, 2, range)).toBe(false);
        expect(is_cell_in_range(2, 4, range)).toBe(false);
    });
    it('returns false when range is null', () => {
        expect(is_cell_in_range(0, 0, null)).toBe(false);
    });
});

describe('expand_range_for_merges', () => {
    const merges: MergeRange[] = [
        { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
        { startRow: 5, startCol: 0, endRow: 5, endCol: 3 },
    ];
    it('expands range to include full merge when partially intersected', () => {
        const range: SelectionRange = { start_row: 0, start_col: 0, end_row: 1, end_col: 1 };
        expect(expand_range_for_merges(range, merges)).toEqual({ start_row: 0, start_col: 0, end_row: 2, end_col: 2 });
    });
    it('returns range unchanged when no merges intersect', () => {
        const range: SelectionRange = { start_row: 3, start_col: 3, end_row: 4, end_col: 4 };
        expect(expand_range_for_merges(range, merges)).toEqual(range);
    });
    it('cascades expansion when merges are adjacent', () => {
        const adjacent_merges: MergeRange[] = [
            { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
            { startRow: 2, startCol: 2, endRow: 3, endCol: 3 },
        ];
        const range: SelectionRange = { start_row: 1, start_col: 1, end_row: 1, end_col: 1 };
        expect(expand_range_for_merges(range, adjacent_merges)).toEqual({
            start_row: 1, start_col: 1, end_row: 3, end_col: 3,
        });
    });
    it('handles range already fully containing a merge', () => {
        const range: SelectionRange = { start_row: 0, start_col: 0, end_row: 3, end_col: 3 };
        expect(expand_range_for_merges(range, merges)).toEqual(range);
    });
});

describe('resolve_merge_anchor', () => {
    const merges: MergeRange[] = [{ startRow: 1, startCol: 1, endRow: 2, endCol: 2 }];
    it('returns merge anchor when clicking inside a merged cell', () => {
        expect(resolve_merge_anchor(2, 2, merges)).toEqual({ row: 1, col: 1 });
    });
    it('returns same position when not inside a merge', () => {
        expect(resolve_merge_anchor(0, 0, merges)).toEqual({ row: 0, col: 0 });
    });
});

describe('move_active_cell', () => {
    const row_count = 5;
    const col_count = 4;
    const no_merges: MergeRange[] = [];

    it('moves right', () => {
        expect(move_active_cell(0, 0, 'right', row_count, col_count, no_merges)).toEqual({ row: 0, col: 1 });
    });
    it('moves left', () => {
        expect(move_active_cell(0, 1, 'left', row_count, col_count, no_merges)).toEqual({ row: 0, col: 0 });
    });
    it('moves down', () => {
        expect(move_active_cell(0, 0, 'down', row_count, col_count, no_merges)).toEqual({ row: 1, col: 0 });
    });
    it('moves up', () => {
        expect(move_active_cell(1, 0, 'up', row_count, col_count, no_merges)).toEqual({ row: 0, col: 0 });
    });
    it('clamps at boundaries', () => {
        expect(move_active_cell(0, 0, 'up', row_count, col_count, no_merges)).toEqual({ row: 0, col: 0 });
        expect(move_active_cell(0, 0, 'left', row_count, col_count, no_merges)).toEqual({ row: 0, col: 0 });
        expect(move_active_cell(4, 3, 'down', row_count, col_count, no_merges)).toEqual({ row: 4, col: 3 });
        expect(move_active_cell(4, 3, 'right', row_count, col_count, no_merges)).toEqual({ row: 4, col: 3 });
    });
    it('skips over merged cells moving right', () => {
        const merges: MergeRange[] = [{ startRow: 0, startCol: 1, endRow: 0, endCol: 2 }];
        expect(move_active_cell(0, 0, 'right', row_count, col_count, merges)).toEqual({ row: 0, col: 1 });
        expect(move_active_cell(0, 1, 'right', row_count, col_count, merges)).toEqual({ row: 0, col: 3 });
    });
    it('skips over merged cells moving down', () => {
        const merges: MergeRange[] = [{ startRow: 1, startCol: 0, endRow: 2, endCol: 0 }];
        expect(move_active_cell(0, 0, 'down', row_count, col_count, merges)).toEqual({ row: 1, col: 0 });
        expect(move_active_cell(1, 0, 'down', row_count, col_count, merges)).toEqual({ row: 3, col: 0 });
    });
});

function cell(raw: string | number | null, formatted?: string): CellData {
    return { raw, formatted: formatted ?? String(raw ?? ''), bold: false, italic: false };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render_hook_harness(sheet: SheetData, show_formatting = true) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
        root!.render(React.createElement(HookHarness, { sheet, show_formatting }));
    });

    return {
        container,
        rerender(next_sheet: SheetData, next_show_formatting = show_formatting) {
            act(() => {
                root!.render(
                    React.createElement(HookHarness, {
                        sheet: next_sheet,
                        show_formatting: next_show_formatting,
                    })
                );
            });
        },
    };
}

function cleanup_hook_harness() {
    act(() => {
        root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
}

function dispatch_mouse_event(
    target: EventTarget,
    type: string,
    init: MouseEventInit = {}
) {
    act(() => {
        target.dispatchEvent(
            new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                ...init,
            })
        );
    });
}

function get_selection_state(host: ParentNode): SelectionState | null {
    const text = host.querySelector('[data-selection]')?.textContent ?? 'null';
    return JSON.parse(text) as SelectionState | null;
}

function get_context_menu_state(host: ParentNode): { row: number; col: number } | null {
    const text = host.querySelector('[data-context]')?.textContent ?? 'null';
    return JSON.parse(text) as { row: number; col: number } | null;
}

function get_clipboard_preview(host: ParentNode): string {
    return host.querySelector('[data-clipboard]')?.textContent ?? '';
}

function get_cell(host: ParentNode, row: number, col: number): HTMLButtonElement {
    const cell_button = host.querySelector(
        `[data-cell="${row}:${col}"]`
    );
    expect(cell_button).not.toBeNull();
    return cell_button as HTMLButtonElement;
}

function get_control(host: ParentNode, name: string): HTMLButtonElement {
    const control = host.querySelector(`[data-control="${name}"]`);
    expect(control).not.toBeNull();
    return control as HTMLButtonElement;
}

function make_sheet(
    rows: (CellData | null)[][],
    merges: MergeRange[] = [],
    name = 'Sheet 1'
): SheetData {
    return {
        name,
        rows,
        merges,
        rowCount: rows.length,
        columnCount: rows[0]?.length ?? 0,
    };
}

function HookHarness({
    sheet,
    show_formatting,
}: {
    sheet: SheetData;
    show_formatting: boolean;
}) {
    const selection = use_selection(sheet, show_formatting);

    return React.createElement(
        React.Fragment,
        null,
        React.createElement(
            'button',
            {
                type: 'button',
                'data-control': 'select-row',
                onClick: () => selection.select_row(1),
            },
            'Select row'
        ),
        React.createElement(
            'button',
            {
                type: 'button',
                'data-control': 'select-column',
                onClick: () => selection.select_column(2),
            },
            'Select column'
        ),
        React.createElement(
            'button',
            {
                type: 'button',
                'data-control': 'select-all',
                onClick: () => selection.select_all(),
            },
            'Select all'
        ),
        React.createElement(
            'div',
            {
                className: 'table-container',
                tabIndex: 0,
                onMouseUp: selection.on_cell_mouse_up,
            },
            sheet.rows.map((row, row_index) =>
                React.createElement(
                    'div',
                    { key: `row-${row_index}` },
                    row.map((cell_data, col_index) => {
                        if (cell_data === null) return null;
                        return React.createElement(
                            'button',
                            {
                                key: `cell-${row_index}-${col_index}`,
                                type: 'button',
                                'data-cell': `${row_index}:${col_index}`,
                                onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) =>
                                    selection.on_cell_mouse_down(
                                        row_index,
                                        col_index,
                                        event
                                    ),
                                onMouseMove: () =>
                                    selection.on_cell_mouse_move(
                                        row_index,
                                        col_index
                                    ),
                                onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) =>
                                    selection.on_context_menu(
                                        row_index,
                                        col_index,
                                        event
                                    ),
                            },
                            cell_data.formatted
                        );
                    })
                )
            )
        ),
        React.createElement(
            'pre',
            { 'data-selection': true },
            JSON.stringify(selection.selection)
        ),
        React.createElement(
            'pre',
            { 'data-context': true },
            JSON.stringify(selection.context_menu)
        ),
        React.createElement(
            'pre',
            { 'data-clipboard': true },
            selection.selection
                ? format_selection_for_clipboard(
                      sheet.rows,
                      selection.selection.range,
                      sheet.merges,
                      show_formatting
                  )
                : ''
        )
    );
}

describe('format_selection_for_clipboard', () => {
    const rows: (CellData | null)[][] = [
        [cell('A1'), cell('B1'), cell('C1')],
        [cell('A2'), cell('B2'), cell('C2')],
        [cell('A3'), cell('B3'), cell('C3')],
    ];
    it('formats single cell as plain text', () => {
        const range: SelectionRange = { start_row: 0, start_col: 0, end_row: 0, end_col: 0 };
        expect(format_selection_for_clipboard(rows, range, [], true)).toBe('A1');
    });
    it('formats multi-cell range as TSV', () => {
        const range: SelectionRange = { start_row: 0, start_col: 0, end_row: 1, end_col: 1 };
        expect(format_selection_for_clipboard(rows, range, [], true)).toBe('A1\tB1\nA2\tB2');
    });
    it('uses raw values when show_formatting is false', () => {
        const rows_with_fmt: (CellData | null)[][] = [[cell(42, '$42.00'), cell(100, '$100.00')]];
        const range: SelectionRange = { start_row: 0, start_col: 0, end_row: 0, end_col: 1 };
        expect(format_selection_for_clipboard(rows_with_fmt, range, [], false)).toBe('42\t100');
    });
    it('uses formatted values when show_formatting is true', () => {
        const rows_with_fmt: (CellData | null)[][] = [[cell(42, '$42.00'), cell(100, '$100.00')]];
        const range: SelectionRange = { start_row: 0, start_col: 0, end_row: 0, end_col: 1 };
        expect(format_selection_for_clipboard(rows_with_fmt, range, [], true)).toBe('$42.00\t$100.00');
    });
    it('handles null cells as empty strings', () => {
        const rows_with_null: (CellData | null)[][] = [[cell('A1'), null, cell('C1')]];
        const range: SelectionRange = { start_row: 0, start_col: 0, end_row: 0, end_col: 2 };
        expect(format_selection_for_clipboard(rows_with_null, range, [], true)).toBe('A1\t\tC1');
    });
    it('places merged cell value at top-left only, empty elsewhere', () => {
        const merged_rows: (CellData | null)[][] = [
            [cell('merged'), null, cell('C1')],
            [null, null, cell('C2')],
        ];
        const merges: MergeRange[] = [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }];
        const range: SelectionRange = { start_row: 0, start_col: 0, end_row: 1, end_col: 2 };
        expect(format_selection_for_clipboard(merged_rows, range, merges, true)).toBe('merged\t\tC1\n\t\tC2');
    });
});

describe('use_selection DOM flows', () => {
    afterEach(() => {
        cleanup_hook_harness();
    });

    it('finalizes drag selection when mouseup happens outside the table', () => {
        const rows: (CellData | null)[][] = [
            [cell('A1'), cell('B1'), cell('C1')],
            [cell('A2'), cell('Merged'), null],
            [cell('A3'), cell('B3'), cell('C3')],
        ];
        const merges: MergeRange[] = [
            { startRow: 1, startCol: 1, endRow: 1, endCol: 2 },
        ];
        const sheet = make_sheet(rows, merges);
        const rendered = render_hook_harness(sheet);

        dispatch_mouse_event(get_cell(rendered.container, 0, 0), 'mousedown', {
            button: 0,
        });
        dispatch_mouse_event(get_cell(rendered.container, 1, 1), 'mousemove');

        const expected_range = expand_range_for_merges(
            {
                start_row: 0,
                start_col: 0,
                end_row: 1,
                end_col: 1,
            },
            merges
        );

        expect(get_selection_state(rendered.container)).toMatchObject({
            range: expected_range,
            anchor_row: 0,
            anchor_col: 0,
            focus_row: 1,
            focus_col: 1,
        });
        expect(get_clipboard_preview(rendered.container)).toBe(
            format_selection_for_clipboard(rows, expected_range, merges, true)
        );

        dispatch_mouse_event(document, 'mouseup');
        dispatch_mouse_event(get_cell(rendered.container, 2, 0), 'mousemove');

        expect(get_selection_state(rendered.container)).toMatchObject({
            range: expected_range,
            anchor_row: 0,
            anchor_col: 0,
            focus_row: 1,
            focus_col: 1,
        });
    });

    it('resolves merged row, column, and select-all endpoints to visible cells', () => {
        const row_sheet = make_sheet(
            [
                [cell('Top'), cell('B1'), cell('C1'), cell('D1')],
                [null, cell('B2'), cell('Wide'), null],
                [cell('A3'), cell('B3'), cell('C3'), cell('D3')],
            ],
            [
                { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
                { startRow: 1, startCol: 2, endRow: 1, endCol: 3 },
            ],
            'Row sheet'
        );
        const row_rendered = render_hook_harness(row_sheet);

        dispatch_mouse_event(
            get_control(row_rendered.container, 'select-row'),
            'click'
        );

        expect(get_selection_state(row_rendered.container)).toMatchObject({
            range: { start_row: 0, start_col: 0, end_row: 1, end_col: 3 },
            anchor_row: 0,
            anchor_col: 0,
            focus_row: 1,
            focus_col: 2,
        });

        cleanup_hook_harness();

        const column_sheet = make_sheet(
            [
                [cell('A1'), cell('Wide'), null, cell('D1')],
                [cell('A2'), cell('B2'), cell('Tall'), cell('D2')],
                [cell('A3'), cell('B3'), null, cell('D3')],
            ],
            [
                { startRow: 0, startCol: 1, endRow: 0, endCol: 2 },
                { startRow: 1, startCol: 2, endRow: 2, endCol: 2 },
            ],
            'Column sheet'
        );
        const column_rendered = render_hook_harness(column_sheet);

        dispatch_mouse_event(
            get_control(column_rendered.container, 'select-column'),
            'click'
        );

        expect(get_selection_state(column_rendered.container)).toMatchObject({
            range: { start_row: 0, start_col: 1, end_row: 2, end_col: 2 },
            anchor_row: 0,
            anchor_col: 1,
            focus_row: 1,
            focus_col: 2,
        });

        cleanup_hook_harness();

        const all_sheet = make_sheet(
            [
                [cell('A1'), cell('B1'), cell('C1'), cell('D1')],
                [cell('A2'), cell('B2'), cell('C2'), cell('D2')],
                [cell('A3'), cell('B3'), cell('Wide end'), null],
            ],
            [{ startRow: 2, startCol: 2, endRow: 2, endCol: 3 }],
            'All sheet'
        );
        const all_rendered = render_hook_harness(all_sheet);

        dispatch_mouse_event(
            get_control(all_rendered.container, 'select-all'),
            'click'
        );

        expect(get_selection_state(all_rendered.container)).toMatchObject({
            range: { start_row: 0, start_col: 0, end_row: 2, end_col: 3 },
            anchor_row: 0,
            anchor_col: 0,
            focus_row: 2,
            focus_col: 2,
        });
    });

    it('clears selection and context menu when the sheet prop changes', () => {
        const first_sheet = make_sheet(
            [
                [cell('A1'), cell('B1')],
                [cell('A2'), cell('B2')],
            ],
            [],
            'First sheet'
        );
        const second_sheet = make_sheet(
            [
                [cell('X1'), cell('Y1')],
                [cell('X2'), cell('Y2')],
            ],
            [],
            'Second sheet'
        );
        const rendered = render_hook_harness(first_sheet);

        dispatch_mouse_event(get_cell(rendered.container, 0, 0), 'mousedown', {
            button: 0,
        });
        dispatch_mouse_event(get_cell(rendered.container, 0, 0), 'contextmenu', {
            button: 2,
            clientX: 100,
            clientY: 120,
        });

        expect(get_selection_state(rendered.container)).not.toBeNull();
        expect(get_context_menu_state(rendered.container)).toMatchObject({
            row: 0,
            col: 0,
        });

        rendered.rerender(second_sheet);

        expect(get_selection_state(rendered.container)).toBeNull();
        expect(get_context_menu_state(rendered.container)).toBeNull();
    });
});
