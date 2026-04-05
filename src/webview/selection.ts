import type { CellData, MergeRange } from '../types';

export interface SelectionRange {
    start_row: number;
    start_col: number;
    end_row: number;
    end_col: number;
}

export interface SelectionState {
    range: SelectionRange;
    anchor_row: number;
    anchor_col: number;
}

export function normalize_range(range: SelectionRange): SelectionRange {
    return {
        start_row: Math.min(range.start_row, range.end_row),
        start_col: Math.min(range.start_col, range.end_col),
        end_row: Math.max(range.start_row, range.end_row),
        end_col: Math.max(range.start_col, range.end_col),
    };
}

export function is_cell_in_range(row: number, col: number, range: SelectionRange | null): boolean {
    if (!range) return false;
    const n = normalize_range(range);
    return row >= n.start_row && row <= n.end_row && col >= n.start_col && col <= n.end_col;
}
