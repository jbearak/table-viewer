import { describe, it, expect } from 'vitest';
import { MergeIndex } from '../webview/merge-index';
import type { MergeRange } from '../types';

// Mirrors merged.xlsx: a horizontal merge across row 0 cols 0-2 ("Merged
// Header") and a vertical merge down col 0 rows 2-3 ("Tall"), plus a synthetic
// 2D merge so the mixed rows×cols case is covered.
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
        expect(h!.endCol).toBe(2);
        expect(h!.endRow).toBe(0);

        // A covered cell is not an anchor.
        expect(idx.is_anchor(0, 1)).toBeNull();
        // A plain cell is not an anchor.
        expect(idx.is_anchor(1, 1)).toBeNull();
    });

    it('is_anchor carries the bounds of vertical and 2D merges', () => {
        const idx = new MergeIndex(merges);
        const v = idx.is_anchor(2, 0)!;
        expect(v.endRow).toBe(3);
        expect(v.endCol).toBe(0);

        const d = idx.is_anchor(5, 1)!;
        expect(d.endRow).toBe(6);
        expect(d.endCol).toBe(2);
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

    it('handles an empty merge list', () => {
        const idx = new MergeIndex([]);
        expect(idx.is_anchor(0, 0)).toBeNull();
        expect(idx.is_covered(0, 0)).toBe(false);
    });
});
