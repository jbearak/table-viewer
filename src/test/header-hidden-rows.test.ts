import { describe, expect, it } from 'vitest';
import {
    first_non_hidden_source_row,
    hidden_row_difference,
    hidden_rows_after_header_change,
    hidden_rows_before_header,
    in_range_rows,
} from '../header-hidden-rows';

const LIMIT = 1_000;
const base = { hide: [], show: [], sourceRowCount: 10, limit: LIMIT } as const;

describe('the hidden rows a header target leaves', () => {
    it('removes the rows to show and adds the rows to hide', () => {
        expect(hidden_rows_after_header_change([1, 4, 7], { ...base, show: [4], hide: [2] }))
            .toEqual([1, 2, 7]);
    });

    it('leaves the set as it is when the target names no rows', () => {
        expect(hidden_rows_after_header_change([7, 1], base)).toEqual([1, 7]);
        expect(hidden_rows_after_header_change(undefined, base)).toEqual([]);
    });

    it('drops rows at or past the end of the worksheet, from the set and from the rows to hide', () => {
        expect(hidden_rows_after_header_change([3, 10, 42], { ...base, hide: [9, 10, 99] }))
            .toEqual([3, 9]);
    });

    it('takes duplicates and unsorted input', () => {
        expect(hidden_rows_after_header_change([5, 5, 2], { ...base, hide: [8, 8, 0], show: [2, 2] }))
            .toEqual([0, 5, 8]);
    });

    it('with a header row: every row above it, the row itself out, and the hidden rows below kept', () => {
        expect(hidden_rows_after_header_change([1, 3, 6], { ...base, headerSourceRow: 3 }))
            .toEqual([0, 1, 2, 6]);
    });

    it('with a header row and rows to show above it: they stay hidden, because the header needs them', () => {
        expect(hidden_rows_after_header_change([0, 1, 2], { ...base, show: [0, 1, 2], headerSourceRow: 2 }))
            .toEqual([0, 1]);
    });

    it('showing every row under a header at row 0 leaves nothing hidden', () => {
        expect(hidden_rows_after_header_change([0, 1, 2], { ...base, show: [0, 1, 2], headerSourceRow: 0 }))
            .toEqual([]);
    });

    it('refuses a header row the worksheet does not have', () => {
        expect(hidden_rows_after_header_change([], { ...base, headerSourceRow: 10 })).toBeUndefined();
    });

    it('with no header row to use: accepted only when every row is hidden', () => {
        const all = { ...base, sourceRowCount: 3 };
        expect(hidden_rows_after_header_change([], { ...all, hide: [0, 1, 2], headerSourceRow: null }))
            .toEqual([0, 1, 2]);
        expect(hidden_rows_after_header_change([0, 1, 2], { ...all, headerSourceRow: null }))
            .toEqual([0, 1, 2]);
        expect(hidden_rows_after_header_change([], { ...all, hide: [0, 2], headerSourceRow: null }))
            .toBeUndefined();
    });

    it('refuses a set past the limit, with and without a header row', () => {
        const many = Array.from({ length: 6 }, (_unused, row) => row + 2);
        const small = { ...base, limit: 5 };
        expect(hidden_rows_after_header_change([], { ...small, hide: many })).toBeUndefined();
        expect(hidden_rows_after_header_change([], { ...small, headerSourceRow: 6 })).toBeUndefined();
        expect(hidden_rows_after_header_change([], { ...small, headerSourceRow: 5 }))
            .toEqual([0, 1, 2, 3, 4]);
    });
});

describe('the helpers a header change shares', () => {
    it('reduces rows to unique integers the worksheet has, ascending', () => {
        expect(in_range_rows([4, 1.5, -1, 4, 9, 2, Number.NaN], 5)).toEqual([2, 4]);
        expect(in_range_rows(undefined, 5)).toEqual([]);
    });

    it('finds the first row that is not hidden', () => {
        expect(first_non_hidden_source_row(4, [0, 1])).toBe(2);
        expect(first_non_hidden_source_row(4, [1])).toBe(0);
        expect(first_non_hidden_source_row(2, [0, 1])).toBeUndefined();
        expect(first_non_hidden_source_row(0, undefined)).toBeUndefined();
    });

    it("a gesture's promotion still refuses a header row that is itself hidden", () => {
        expect(hidden_rows_before_header([2], 2, 10, LIMIT)).toBeUndefined();
        expect(hidden_rows_before_header([5], 2, 10, LIMIT)).toEqual([0, 1, 5]);
    });

    it('names the rows two sets differ by', () => {
        expect(hidden_row_difference([0, 1, 5], [1, 2])).toEqual({ hidden: [2], shown: [0, 5] });
    });
});
