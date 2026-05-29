import { describe, it, expect } from 'vitest';
import { MergeIndex } from '../webview/merge-index';
import type { MergeRange } from '../types';
import {
    block_font,
    block_text,
    block_intersects_region,
    overlay_block_rect,
    overlay_entries,
} from '../webview/merge-overlay-model';
import type { RenderedCell } from '../data-source/interface';

// Same fixture as the cell-renderer / merge-index tests:
// horizontal header, vertical "Tall", 2D "Box".
const merges: MergeRange[] = [
    { startRow: 0, startCol: 0, endRow: 0, endCol: 2 }, // horizontal (rowSpan 1)
    { startRow: 2, startCol: 0, endRow: 3, endCol: 0 }, // vertical (rowSpan 2)
    { startRow: 5, startCol: 1, endRow: 6, endCol: 2 }, // 2D (rowSpan 2)
];
const idx = new MergeIndex(merges);

describe('overlay_entries', () => {
    it('keeps only multi-row merges (vertical + 2D), dropping horizontal-only', () => {
        const entries = overlay_entries(idx.entries);
        // The horizontal header (rowSpan 1) is handled by native span, not the overlay.
        expect(entries).toHaveLength(2);
        const starts = entries.map((e) => `${e.startRow}:${e.startCol}`).sort();
        expect(starts).toEqual(['2:0', '5:1']);
        expect(entries.every((e) => e.rowSpan > 1)).toBe(true);
    });
});

describe('block_intersects_region', () => {
    const vertical = overlay_entries(idx.entries).find((e) => e.startRow === 2)!;

    it('is true when the block sits inside the visible region', () => {
        // Region rows 0..9, cols 0..4.
        expect(
            block_intersects_region(vertical, { x: 0, y: 0, width: 5, height: 10 })
        ).toBe(true);
    });

    it('is true when only the bottom of the block peeks into the region', () => {
        // Region starts at row 3 (block spans rows 2..3).
        expect(
            block_intersects_region(vertical, { x: 0, y: 3, width: 5, height: 10 })
        ).toBe(true);
    });

    it('is false when the region is entirely below the block', () => {
        expect(
            block_intersects_region(vertical, { x: 0, y: 4, width: 5, height: 10 })
        ).toBe(false);
    });

    it('is false when the region is scrolled past the block columns', () => {
        // Block col 0 only; region starts at col 1.
        expect(
            block_intersects_region(vertical, { x: 1, y: 0, width: 5, height: 10 })
        ).toBe(false);
    });
});

describe('overlay_block_rect', () => {
    it('unions the top-left and bottom-right cell bounds and subtracts the origin', () => {
        // Cells in client coords; overlay canvas origin at (100, 50).
        const top_left = { x: 110, y: 86, width: 80, height: 24 };
        const bottom_right = { x: 110, y: 110, width: 80, height: 24 };
        const rect = overlay_block_rect(top_left, bottom_right, { x: 100, y: 50 });
        expect(rect).toEqual({ x: 10, y: 36, width: 80, height: 48 });
    });

    it('spans multiple columns by extending to the bottom-right cell right edge', () => {
        const top_left = { x: 200, y: 100, width: 60, height: 24 };
        const bottom_right = { x: 260, y: 124, width: 90, height: 24 };
        const rect = overlay_block_rect(top_left, bottom_right, { x: 0, y: 0 });
        // Width = (260 + 90) - 200 = 150; height = (124 + 24) - 100 = 48.
        expect(rect).toEqual({ x: 200, y: 100, width: 150, height: 48 });
    });
});

describe('block_font', () => {
    it('falls back to the bare size when neither bold nor italic', () => {
        expect(block_font(false, false, 'Arial')).toBe('13px Arial');
    });

    it('encodes bold (600) and italic with the family appended', () => {
        expect(block_font(true, false, 'Arial')).toBe('600 13px Arial');
        expect(block_font(false, true, 'Arial')).toBe('italic 13px Arial');
        expect(block_font(true, true, 'Arial')).toBe('italic 600 13px Arial');
    });
});

describe('block_text', () => {
    const num: RenderedCell = { raw: '3.14159', formatted: '3.14', bold: false, italic: false };

    it('uses the formatted value when show_formatting is on', () => {
        expect(block_text(num, true)).toBe('3.14');
    });

    it('uses the raw value when show_formatting is off', () => {
        expect(block_text(num, false)).toBe('3.14159');
    });
});
