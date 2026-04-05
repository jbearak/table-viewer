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

export function format_selection_for_clipboard(rows: (CellData | null)[][], range: SelectionRange, merges: MergeRange[], show_formatting: boolean): string {
    const n = normalize_range(range);
    function cell_text(cell: CellData | null): string {
        if (!cell) return '';
        if (show_formatting) return cell.formatted;
        return cell.raw !== null ? String(cell.raw) : '';
    }
    const hidden = new Set<string>();
    for (const m of merges) {
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r === m.startRow && c === m.startCol) continue;
                hidden.add(`${r}:${c}`);
            }
        }
    }
    const output_rows: string[] = [];
    for (let r = n.start_row; r <= n.end_row; r++) {
        const row = rows[r];
        const cells: string[] = [];
        for (let c = n.start_col; c <= n.end_col; c++) {
            if (hidden.has(`${r}:${c}`)) { cells.push(''); }
            else { cells.push(cell_text(row?.[c] ?? null)); }
        }
        output_rows.push(cells.join('\t'));
    }
    return output_rows.join('\n');
}

export type Direction = 'up' | 'down' | 'left' | 'right';

// Invariant: row/col must be a merge anchor or a non-merged cell (never an interior merged cell).
// The use_selection hook enforces this by always resolving to anchors on click/navigate.
export function move_active_cell(row: number, col: number, direction: Direction, row_count: number, col_count: number, merges: MergeRange[]): { row: number; col: number } {
    const current_merge = merges.find((m) => m.startRow === row && m.startCol === col);
    let next_row = row;
    let next_col = col;
    switch (direction) {
        case 'up': next_row = row - 1; break;
        case 'down': next_row = current_merge ? current_merge.endRow + 1 : row + 1; break;
        case 'left': next_col = col - 1; break;
        case 'right': next_col = current_merge ? current_merge.endCol + 1 : col + 1; break;
    }
    next_row = Math.max(0, Math.min(next_row, row_count - 1));
    next_col = Math.max(0, Math.min(next_col, col_count - 1));
    return resolve_merge_anchor(next_row, next_col, merges);
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
