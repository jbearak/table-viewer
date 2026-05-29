import { describe, it, expect } from 'vitest';
import {
    DEFAULT_ROW_HEIGHT_PX,
    MIN_ROW_HEIGHT_PX,
    clamp_row_height,
    natural_row_height,
    row_height,
    set_row_height,
    span_height,
} from '../webview/row-heights';

describe('row-heights', () => {
    it('row_height returns the override when present, default otherwise', () => {
        expect(row_height({}, 5)).toBe(DEFAULT_ROW_HEIGHT_PX);
        expect(row_height({ 5: 60 }, 5)).toBe(60);
        expect(row_height({ 5: 60 }, 6)).toBe(DEFAULT_ROW_HEIGHT_PX);
    });

    it('row_height honors a caller-supplied default', () => {
        expect(row_height({}, 0, 30)).toBe(30);
        expect(row_height({ 0: 50 }, 0, 30)).toBe(50);
    });

    it('span_height sums inclusive row heights with mixed overrides', () => {
        // rows 2,3,4 — row 3 overridden to 40, others default (24).
        expect(span_height({ 3: 40 }, 2, 4)).toBe(24 + 40 + 24);
    });

    it('span_height of a single row equals that row height', () => {
        expect(span_height({ 7: 33 }, 7, 7)).toBe(33);
        expect(span_height({}, 7, 7)).toBe(DEFAULT_ROW_HEIGHT_PX);
    });

    it('clamp_row_height enforces the minimum', () => {
        expect(clamp_row_height(5)).toBe(MIN_ROW_HEIGHT_PX);
        expect(clamp_row_height(MIN_ROW_HEIGHT_PX)).toBe(MIN_ROW_HEIGHT_PX);
        expect(clamp_row_height(100)).toBe(100);
    });

    it('set_row_height returns a new record, clamped, without mutating input', () => {
        const before = { 1: 30 };
        const after = set_row_height(before, 2, 8);
        expect(after).toEqual({ 1: 30, 2: MIN_ROW_HEIGHT_PX });
        expect(before).toEqual({ 1: 30 }); // unchanged
    });

    it('set_row_height overwrites an existing override', () => {
        expect(set_row_height({ 4: 30 }, 4, 80)).toEqual({ 4: 80 });
    });

    describe('natural_row_height', () => {
        it('returns the default height for single-line text', () => {
            expect(natural_row_height('hello', 18, 6)).toBe(DEFAULT_ROW_HEIGHT_PX);
        });

        it('treats empty text as a single line', () => {
            expect(natural_row_height('', 18, 6)).toBe(DEFAULT_ROW_HEIGHT_PX);
        });

        it('grows with each explicit newline', () => {
            expect(natural_row_height('a\nb', 18, 6)).toBe(2 * 18 + 6);
            expect(natural_row_height('a\nb\nc', 18, 6)).toBe(3 * 18 + 6);
        });

        it('counts a trailing newline as an extra line', () => {
            expect(natural_row_height('a\n', 18, 6)).toBe(2 * 18 + 6);
        });

        it('honors custom line height and padding', () => {
            expect(natural_row_height('a\nb', 30, 10)).toBe(2 * 30 + 10);
        });

        it('never returns below the default height', () => {
            // Tiny line metrics still clamp up to the default single-row height.
            expect(natural_row_height('a\nb', 5, 0)).toBe(DEFAULT_ROW_HEIGHT_PX);
        });
    });
});
