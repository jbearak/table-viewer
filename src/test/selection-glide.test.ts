import { describe, it, expect } from 'vitest';
import type { MergeRange } from '../types';
import { expand_glide_selection } from '../webview/selection-glide';

// Standard fixture shared with merge-index / merge-overlay-model tests.
const merges: MergeRange[] = [
    { startRow: 0, startCol: 0, endRow: 0, endCol: 2 }, // horizontal (rowSpan 1)
    { startRow: 2, startCol: 0, endRow: 3, endCol: 0 }, // vertical (rowSpan 2)
    { startRow: 5, startCol: 1, endRow: 6, endCol: 2 }, // 2D (rowSpan 2)
];

describe('expand_glide_selection', () => {
    it('leaves a plain single cell untouched', () => {
        const out = expand_glide_selection([4, 4], { x: 4, y: 4, width: 1, height: 1 }, merges);
        expect(out).toEqual({ cell: [4, 4], range: { x: 4, y: 4, width: 1, height: 1 } });
    });

    it('anchors and expands a click on a horizontal merge cover cell', () => {
        // Glide coords are [col, row]: col 2, row 0 is the last cell of the
        // horizontal merge {0,0..0,2}.
        const out = expand_glide_selection([2, 0], { x: 2, y: 0, width: 1, height: 1 }, merges);
        expect(out).toEqual({ cell: [0, 0], range: { x: 0, y: 0, width: 3, height: 1 } });
    });

    it('anchors and expands a click on a vertical merge cover cell', () => {
        // col 0, row 3 is the bottom of the vertical merge {2,0..3,0}.
        const out = expand_glide_selection([0, 3], { x: 0, y: 3, width: 1, height: 1 }, merges);
        expect(out).toEqual({ cell: [0, 2], range: { x: 0, y: 2, width: 1, height: 2 } });
    });

    it('anchors and expands a click on a 2D merge cover cell', () => {
        // col 2, row 6 is the bottom-right of the 2D merge {5,1..6,2}.
        const out = expand_glide_selection([2, 6], { x: 2, y: 6, width: 1, height: 1 }, merges);
        expect(out).toEqual({ cell: [1, 5], range: { x: 1, y: 5, width: 2, height: 2 } });
    });

    it('grows a drag rectangle to fully contain every merge it touches', () => {
        // Drag rows 0..3, cols 0..1: touches the horizontal merge (row 0, cols
        // 0..2) and the vertical merge (rows 2..3, col 0). Expands to cols 0..2.
        const out = expand_glide_selection([0, 0], { x: 0, y: 0, width: 2, height: 4 }, merges);
        expect(out).toEqual({ cell: [0, 0], range: { x: 0, y: 0, width: 3, height: 4 } });
    });

    it('is a no-op when there are no merges', () => {
        const out = expand_glide_selection([1, 1], { x: 1, y: 1, width: 2, height: 2 }, []);
        expect(out).toEqual({ cell: [1, 1], range: { x: 1, y: 1, width: 2, height: 2 } });
    });
});
