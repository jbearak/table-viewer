import { describe, it, expect } from 'vitest';
import { row_boundary_hit, next_row_height } from '../webview/row-resize-model';
import { MIN_ROW_HEIGHT_PX } from '../webview/row-heights';

describe('row_boundary_hit', () => {
    // Hovered cell at client y=100, height=24 (bottom border at y=124).
    it('targets the hovered row when near its bottom border', () => {
        const hit = row_boundary_hit(5, 100, 24, 22, 4);
        expect(hit).toEqual({ row: 5, boundary_y: 124 });
    });

    it('targets the previous row when near the top border', () => {
        // Top border of row 5 == bottom border of row 4, sitting at y=100.
        const hit = row_boundary_hit(5, 100, 24, 2, 4);
        expect(hit).toEqual({ row: 4, boundary_y: 100 });
    });

    it('never targets above row 0 (top border is the header)', () => {
        expect(row_boundary_hit(0, 36, 24, 1, 4)).toBeNull();
    });

    it('is null in the cell interior (away from both borders)', () => {
        expect(row_boundary_hit(5, 100, 24, 12, 4)).toBeNull();
    });

    it('uses the bottom border when exactly on the tolerance edge', () => {
        // height - localY === tolerance → still a hit on the bottom.
        const hit = row_boundary_hit(2, 50, 24, 20, 4);
        expect(hit).toEqual({ row: 2, boundary_y: 74 });
    });
});

describe('next_row_height', () => {
    it('adds the drag delta to the starting height', () => {
        expect(next_row_height(24, 30)).toBe(54);
    });

    it('clamps to the minimum row height when dragged too small', () => {
        expect(next_row_height(24, -100)).toBe(MIN_ROW_HEIGHT_PX);
    });

    it('passes large growths through', () => {
        expect(next_row_height(24, 100)).toBe(124);
    });
});
