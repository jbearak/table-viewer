import { describe, it, expect } from 'vitest';
import {
    normalize_range,
    is_cell_in_range,
    type SelectionRange,
} from '../webview/selection';

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
