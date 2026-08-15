import { describe, it, expect } from 'vitest';
import {
    changed_highlight_keys,
    changed_tint_keys,
    offscreen_anchor_merge_damage,
    source_key_damage,
    visible_source_key_damage,
} from '../webview/grid-repaint-model';

const s = (...keys: string[]): Set<string> => new Set(keys);

describe('changed_tint_keys', () => {
    it('returns keys added to the dirty set', () => {
        const out = changed_tint_keys(s('1:1'), s('1:1', '2:2'), s(), s());
        expect([...out]).toEqual(['2:2']);
    });

    it('returns keys removed from the dirty set (bulk discard / save-clear)', () => {
        const out = changed_tint_keys(s('1:1', '2:2', '3:3'), s('1:1'), s(), s());
        expect([...out].sort()).toEqual(['2:2', '3:3']);
    });

    it('returns keys whose conflict status changed (reload drift)', () => {
        const out = changed_tint_keys(s('1:1'), s('1:1'), s(), s('1:1'));
        expect([...out]).toEqual(['1:1']);
    });

    it('unions dirty and conflict changes without duplicates', () => {
        const out = changed_tint_keys(s('1:1'), s('2:2'), s(), s('2:2'));
        expect([...out].sort()).toEqual(['1:1', '2:2']);
    });

    it('returns an empty set when nothing changed', () => {
        const out = changed_tint_keys(s('1:1'), s('1:1'), s('3:3'), s('3:3'));
        expect(out.size).toBe(0);
    });
});

describe('highlight repaint', () => {
    it('detects additions, removals, and recolors', () => {
        expect([...changed_highlight_keys(
            { '1:1': 'yellow', '2:2': 'green' },
            { '1:1': 'blue', '3:3': 'pink' },
        )].sort()).toEqual(['1:1', '2:2', '3:3']);
    });

    it('maps source keys through visible transformed rows and columns', () => {
        const damage = visible_source_key_damage(
            s('10:2', '11:1', '99:2'),
            { x: 0, y: 5, width: 2, height: 2 },
            (source_column) => source_column === 2 ? 1 : undefined,
            (display_row) => display_row === 5 ? 10 : display_row === 6 ? 11 : undefined,
        );
        expect(damage).toEqual([{ cell: [1, 5] }]);
    });

    it('ignores offscreen rows, hidden columns, and malformed keys', () => {
        expect(visible_source_key_damage(
            s('2:3', 'bad'),
            { x: 0, y: 0, width: 3, height: 2 },
            () => undefined,
            (row) => row,
        )).toEqual([]);
    });
});

describe('offscreen_anchor_merge_damage', () => {
    // A tall merge anchored at [x:1, y:2], reaching rows 2-9.
    const tall = { x: 1, y: 2, width: 1, height: 8 };
    const viewport = { x: 0, y: 5, width: 3, height: 10 };

    it('damages a visible cell of a merge whose changed anchor is above the viewport', () => {
        expect(offscreen_anchor_merge_damage(s('2:1'), viewport, [tall]))
            .toEqual([{ cell: [1, 5] }]);
    });

    it('ignores merges whose anchor key did not change', () => {
        expect(offscreen_anchor_merge_damage(s('3:1', '2:0'), viewport, [tall]))
            .toEqual([]);
    });

    it('ignores merges fully above or starting inside the viewport', () => {
        const above = { x: 1, y: 0, width: 1, height: 5 }; // ends at row 4 < 5
        const inside = { x: 1, y: 6, width: 1, height: 4 }; // anchor visible
        expect(offscreen_anchor_merge_damage(
            s('0:1', '6:1'),
            viewport,
            [above, inside],
        )).toEqual([]);
    });

    it('ignores merges scrolled off horizontally', () => {
        const off_right = { x: 9, y: 2, width: 2, height: 8 };
        expect(offscreen_anchor_merge_damage(s('2:9'), viewport, [off_right]))
            .toEqual([]);
    });

    it('ignores single-row merges fully above the viewport', () => {
        const wide = { x: 0, y: 2, width: 3, height: 1 };
        expect(offscreen_anchor_merge_damage(s('2:0'), viewport, [wide]))
            .toEqual([]);
    });

    it('damages a horizontal merge whose changed anchor is left of the viewport', () => {
        // Anchor at column 0, block spanning columns 0-3, viewport starts at column 2.
        const wide = { x: 0, y: 6, width: 4, height: 1 };
        expect(offscreen_anchor_merge_damage(
            s('6:0'),
            { x: 2, y: 5, width: 3, height: 10 },
            [wide],
        )).toEqual([{ cell: [2, 6] }]);
    });

    it('damages a 2D merge whose anchor is above and left of the viewport', () => {
        const block = { x: 0, y: 2, width: 4, height: 8 };
        expect(offscreen_anchor_merge_damage(
            s('2:0'),
            { x: 2, y: 5, width: 3, height: 10 },
            [block],
        )).toEqual([{ cell: [2, 5] }]);
    });

    it('leaves merges with a visible anchor to the visible-cell scan', () => {
        const block = { x: 2, y: 6, width: 2, height: 3 };
        expect(offscreen_anchor_merge_damage(
            s('6:2'),
            { x: 0, y: 5, width: 5, height: 10 },
            [block],
        )).toEqual([]);
    });

    it('clamps the damaged cell into the viewport', () => {
        // Anchor column left of the viewport, block reaching into it.
        const wide_tall = { x: 0, y: 2, width: 4, height: 8 };
        expect(offscreen_anchor_merge_damage(
            s('2:0'),
            { x: 2, y: 5, width: 3, height: 10 },
            [wide_tall],
        )).toEqual([{ cell: [2, 5] }]);
    });
});

describe('source_key_damage', () => {
    it('combines the visible-cell scan with the off-screen-anchor repair', () => {
        // Identity source==display mapping; key "6:1" hits the visible scan,
        // key "2:1" only surfaces through the merge repair (anchor above top).
        const tall = { x: 1, y: 2, width: 1, height: 8 };
        const out = source_key_damage(
            s('6:1', '2:1'),
            { x: 0, y: 5, width: 3, height: 10 },
            (c) => c,
            (r) => r,
            [tall],
        );
        expect(out).toEqual([{ cell: [1, 6] }, { cell: [1, 5] }]);
    });
});
