import type { MergeRange } from '../types';

export interface BoundaryGroups {
    /** For each column boundary (right edge of col c), the set of rows where that boundary is exposed. */
    col_boundary_groups: Map<number, Set<number>>;
    /** For each row boundary (bottom edge of row r), the set of columns where that boundary is exposed. */
    row_boundary_groups: Map<number, Set<number>>;
}

/**
 * Precompute which rows/columns share each resize boundary.
 *
 * A column boundary at `c` is "exposed" on row `r` if the cell occupying
 * column `c` on row `r` ends at column `c` (i.e., `c` is the rightmost
 * column of that cell). Interior boundaries of a colspan are NOT exposed.
 *
 * Same logic transposed for row boundaries.
 */
export function build_boundary_groups(
    row_count: number,
    col_count: number,
    merges: MergeRange[]
): BoundaryGroups {
    type MergeEntry = 'hidden' | { rowSpan: number; colSpan: number };
    const merge_map = new Map<string, MergeEntry>();

    for (const m of merges) {
        merge_map.set(`${m.startRow}:${m.startCol}`, {
            rowSpan: m.endRow - m.startRow + 1,
            colSpan: m.endCol - m.startCol + 1,
        });
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r === m.startRow && c === m.startCol) continue;
                merge_map.set(`${r}:${c}`, 'hidden');
            }
        }
    }

    const col_boundary_groups = new Map<number, Set<number>>();
    const row_boundary_groups = new Map<number, Set<number>>();

    for (let c = 0; c < col_count; c++) {
        col_boundary_groups.set(c, new Set());
    }
    for (let r = 0; r < row_count; r++) {
        row_boundary_groups.set(r, new Set());
    }

    for (let r = 0; r < row_count; r++) {
        for (let c = 0; c < col_count; c++) {
            const entry = merge_map.get(`${r}:${c}`);
            if (entry === 'hidden') continue;

            const col_span = entry ? entry.colSpan : 1;
            const row_span = entry ? entry.rowSpan : 1;

            const right_boundary = c + col_span - 1;
            for (let ri = r; ri < r + row_span; ri++) {
                col_boundary_groups.get(right_boundary)!.add(ri);
            }

            const bottom_boundary = r + row_span - 1;
            for (let ci = c; ci < c + col_span; ci++) {
                row_boundary_groups.get(bottom_boundary)!.add(ci);
            }
        }
    }

    return { col_boundary_groups, row_boundary_groups };
}
