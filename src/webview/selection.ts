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

export function resolve_merge_anchor(row: number, col: number, merges: MergeRange[]): { row: number; col: number } {
    for (const m of merges) {
        if (row >= m.startRow && row <= m.endRow && col >= m.startCol && col <= m.endCol) {
            return { row: m.startRow, col: m.startCol };
        }
    }
    return { row, col };
}

export function expand_range_for_merges(range: SelectionRange, merges: MergeRange[]): SelectionRange {
    let n = normalize_range(range);
    let changed = true;
    while (changed) {
        changed = false;
        for (const m of merges) {
            const overlaps = m.startRow <= n.end_row && m.endRow >= n.start_row && m.startCol <= n.end_col && m.endCol >= n.start_col;
            if (overlaps) {
                const expanded = {
                    start_row: Math.min(n.start_row, m.startRow),
                    start_col: Math.min(n.start_col, m.startCol),
                    end_row: Math.max(n.end_row, m.endRow),
                    end_col: Math.max(n.end_col, m.endCol),
                };
                if (expanded.start_row !== n.start_row || expanded.start_col !== n.start_col || expanded.end_row !== n.end_row || expanded.end_col !== n.end_col) {
                    n = expanded;
                    changed = true;
                }
            }
        }
    }
    return n;
}
