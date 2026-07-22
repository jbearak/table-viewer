import { describe, expect, it } from 'vitest';
import { CELL_HIGHLIGHT_COLORS, highlight_label, highlight_rgba } from '../webview/highlight-theme';

describe('highlight theme', () => {
    it('provides the approved normal semantic palette', () => {
        expect(CELL_HIGHLIGHT_COLORS).toEqual(['yellow', 'green', 'blue', 'pink']);
        expect(CELL_HIGHLIGHT_COLORS.map((color) => highlight_rgba(color, false))).toEqual([
            'rgba(255, 193, 7, 0.24)',
            'rgba(46, 160, 67, 0.22)',
            'rgba(33, 150, 243, 0.22)',
            'rgba(233, 30, 99, 0.20)',
        ]);
    });

    it('uses stronger high-contrast variants and accessible labels', () => {
        for (const color of CELL_HIGHLIGHT_COLORS) {
            expect(highlight_rgba(color, true)).toMatch(/0\.38\)$/);
            expect(highlight_label(color)).toBe(color[0].toUpperCase() + color.slice(1));
        }
    });
});
