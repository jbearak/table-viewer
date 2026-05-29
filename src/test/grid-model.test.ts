import { describe, it, expect } from 'vitest';
import {
    PAGE_SIZE,
    get_needed_page_starts,
    clamp_column_width,
    column_letter,
    build_grid_columns,
    MIN_COLUMN_WIDTH_PX,
    MAX_COLUMN_WIDTH_PX,
    DEFAULT_COLUMN_WIDTH_PX,
} from '../webview/grid-model';

describe('get_needed_page_starts', () => {
    it('returns the single page covering a sub-page range', () => {
        expect(get_needed_page_starts(0, PAGE_SIZE - 1)).toEqual([0]);
    });

    it('returns every page-aligned start intersecting the range', () => {
        // PAGE_SIZE=100: rows 50..150 span pages starting at 0 and 100.
        expect(get_needed_page_starts(50, 150)).toEqual([0, 100]);
    });

    it('aligns a mid-page start down to its page boundary', () => {
        expect(get_needed_page_starts(250, 250)).toEqual([200]);
    });

    it('clamps a negative start to 0', () => {
        expect(get_needed_page_starts(-10, 5)).toEqual([0]);
    });

    it('returns [] for an inverted range', () => {
        expect(get_needed_page_starts(10, 5)).toEqual([]);
    });
});

describe('clamp_column_width', () => {
    it('clamps below the minimum', () => {
        expect(clamp_column_width(1)).toBe(MIN_COLUMN_WIDTH_PX);
    });
    it('clamps above the maximum', () => {
        expect(clamp_column_width(99999)).toBe(MAX_COLUMN_WIDTH_PX);
    });
    it('passes through an in-range width', () => {
        expect(clamp_column_width(150)).toBe(150);
    });
});

describe('column_letter', () => {
    it('maps single-letter columns', () => {
        expect(column_letter(0)).toBe('A');
        expect(column_letter(25)).toBe('Z');
    });
    it('maps double-letter columns', () => {
        expect(column_letter(26)).toBe('AA');
        expect(column_letter(27)).toBe('AB');
        expect(column_letter(701)).toBe('ZZ');
    });
    it('maps triple-letter columns', () => {
        expect(column_letter(702)).toBe('AAA');
    });
});

describe('build_grid_columns', () => {
    it('builds one SizedGridColumn per column with lettered titles', () => {
        const cols = build_grid_columns(3, {});
        expect(cols.length).toBe(3);
        expect(cols.map((c) => c.title)).toEqual(['A', 'B', 'C']);
        expect(cols.every((c) => c.width === DEFAULT_COLUMN_WIDTH_PX)).toBe(true);
    });

    it('applies persisted widths (clamped) by column index', () => {
        const cols = build_grid_columns(2, { 0: 200, 1: 5 });
        expect(cols[0].width).toBe(200);
        expect(cols[1].width).toBe(MIN_COLUMN_WIDTH_PX); // 5 clamped up
    });
});
