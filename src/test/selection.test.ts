import { describe, it, expect } from 'vitest';
import {
    normalize_range,
    is_cell_in_range,
    expand_range_for_merges,
    resolve_merge_anchor,
    type SelectionRange,
} from '../webview/selection';
import type { MergeRange } from '../types';

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
