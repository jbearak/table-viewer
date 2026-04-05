import { describe, it, expect } from 'vitest';
import {
    normalize_range,
    is_cell_in_range,
    expand_range_for_merges,
    resolve_merge_anchor,
    move_active_cell,
    format_selection_for_clipboard,
    type SelectionRange,
} from '../webview/selection';
import type { MergeRange, CellData } from '../types';

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
