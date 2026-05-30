import { describe, it, expect } from 'vitest';
import { MergeIndex } from '../webview/merge-index';
import type { MergeRange } from '../types';

// Mirrors merged.xlsx: a horizontal merge across row 0 cols 0-2 ("Merged
// Header") and a vertical merge down col 0 rows 2-3 ("Tall"), plus a synthetic
// 2D merge so the mixed rowSpan×colSpan case is covered.
const merges: MergeRange[] = [
    { startRow: 0, startCol: 0, endRow: 0, endCol: 2 }, // horizontal
    { startRow: 2, startCol: 0, endRow: 3, endCol: 0 }, // vertical
    { startRow: 5, startCol: 1, endRow: 6, endCol: 2 }, // 2D
];

describe('MergeIndex', () => {
    it('is_anchor returns the entry at a merge top-left, null elsewhere', () => {
        const idx = new MergeIndex(merges);
        const h = idx.is_anchor(0, 0);
        expect(h).not.toBeNull();
        expect(h!.colSpan).toBe(3);
        expect(h!.rowSpan).toBe(1);
        expect(h!.horizontalOnly).toBe(true);

        // A covered cell is not an anchor.
        expect(idx.is_anchor(0, 1)).toBeNull();
        // A plain cell is not an anchor.
        expect(idx.is_anchor(1, 1)).toBeNull();
    });

    it('classifies vertical and 2D merges as not horizontalOnly', () => {
        const idx = new MergeIndex(merges);
        const v = idx.is_anchor(2, 0)!;
        expect(v.rowSpan).toBe(2);
        expect(v.colSpan).toBe(1);
        expect(v.horizontalOnly).toBe(false);

        const d = idx.is_anchor(5, 1)!;
        expect(d.rowSpan).toBe(2);
        expect(d.colSpan).toBe(2);
        expect(d.horizontalOnly).toBe(false);
    });

    it('is_covered is true for interior cells, false for anchors and plain cells', () => {
        const idx = new MergeIndex(merges);
        expect(idx.is_covered(0, 1)).toBe(true); // covered by horizontal anchor
        expect(idx.is_covered(0, 2)).toBe(true);
        expect(idx.is_covered(3, 0)).toBe(true); // covered by vertical anchor
        expect(idx.is_covered(6, 2)).toBe(true); // covered by 2D anchor

        expect(idx.is_covered(0, 0)).toBe(false); // anchor itself
        expect(idx.is_covered(2, 0)).toBe(false); // anchor itself
        expect(idx.is_covered(1, 1)).toBe(false); // plain cell
    });

    it('entry_at returns the containing merge for any cell inside it', () => {
        const idx = new MergeIndex(merges);
        expect(idx.entry_at(0, 2)!.startCol).toBe(0);
        expect(idx.entry_at(3, 0)!.startRow).toBe(2);
        expect(idx.entry_at(6, 1)!.startRow).toBe(5);
        expect(idx.entry_at(1, 1)).toBeNull();
    });

    it('anchor_of resolves covered cells to the anchor, plain cells to themselves', () => {
        const idx = new MergeIndex(merges);
        expect(idx.anchor_of(0, 2)).toEqual({ row: 0, col: 0 });
        expect(idx.anchor_of(3, 0)).toEqual({ row: 2, col: 0 });
        expect(idx.anchor_of(6, 2)).toEqual({ row: 5, col: 1 });
        expect(idx.anchor_of(1, 1)).toEqual({ row: 1, col: 1 });
    });

    it('entries exposes every merge with computed spans', () => {
        const idx = new MergeIndex(merges);
        expect(idx.entries).toHaveLength(3);
        const vertical_and_2d = idx.entries.filter((e) => !e.horizontalOnly);
        expect(vertical_and_2d).toHaveLength(2);
    });

    it('handles an empty merge list', () => {
        const idx = new MergeIndex([]);
        expect(idx.is_anchor(0, 0)).toBeNull();
        expect(idx.entry_at(0, 0)).toBeNull();
        expect(idx.is_covered(0, 0)).toBe(false);
        expect(idx.anchor_of(4, 7)).toEqual({ row: 4, col: 7 });
        expect(idx.entries).toEqual([]);
    });
});
