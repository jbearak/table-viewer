import type { MergeRange } from '../types';
import {
    type SelectionRange,
    normalize_range,
    expand_range_for_merges,
    resolve_merge_anchor,
} from './selection';

/**
 * Structural mirror of Glide's `Rectangle` in **cell coordinates**: `x` is the
 * first column, `y` the first row, `width`/`height` the cell counts. Kept as a
 * local interface (not imported from Glide) so this module stays pure and
 * unit-testable without the canvas runtime; Glide's `Rectangle` is structurally
 * assignable.
 */
export interface CellRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Make a Glide selection merge-aware. Given Glide's anchor `cell` (`[col, row]`)
 * and selected `range`, returns the equivalent anchor + rectangle after:
 *  - resolving the anchor to its merge's top-left (so clicking any covered cell
 *    anchors on the merge), and
 *  - growing the rectangle to fully contain every merge it overlaps (to a
 *    fixpoint), so a merge always selects as one logical block.
 *
 * Pure data in/out — the grid shell feeds the result back into the controlled
 * `gridSelection` so the visible selection snaps to whole merges.
 */
export function expand_glide_selection(
    cell: readonly [number, number],
    range: CellRect,
    merges: MergeRange[],
): { cell: [number, number]; range: CellRect } {
    const [col, row] = cell;
    const raw: SelectionRange = {
        start_row: range.y,
        start_col: range.x,
        end_row: range.y + range.height - 1,
        end_col: range.x + range.width - 1,
    };
    const expanded = expand_range_for_merges(raw, merges);
    const anchor = resolve_merge_anchor(row, col, merges);
    const n = normalize_range(expanded);
    return {
        cell: [anchor.col, anchor.row],
        range: {
            x: n.start_col,
            y: n.start_row,
            width: n.end_col - n.start_col + 1,
            height: n.end_row - n.start_row + 1,
        },
    };
}
