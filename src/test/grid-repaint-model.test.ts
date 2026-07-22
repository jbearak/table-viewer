import { describe, it, expect } from 'vitest';
import {
    changed_highlight_keys,
    changed_tint_keys,
    visible_highlight_damage,
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
        const damage = visible_highlight_damage(
            s('10:2', '11:1', '99:2'),
            { x: 0, y: 5, width: 2, height: 2 },
            (source_column) => source_column === 2 ? 1 : undefined,
            (display_row) => display_row === 5 ? 10 : display_row === 6 ? 11 : undefined,
        );
        expect(damage).toEqual([{ cell: [1, 5] }]);
    });

    it('ignores offscreen rows, hidden columns, and malformed keys', () => {
        expect(visible_highlight_damage(
            s('2:3', 'bad'),
            { x: 0, y: 0, width: 3, height: 2 },
            () => undefined,
            (row) => row,
        )).toEqual([]);
    });
});
