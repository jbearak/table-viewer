import { describe, it, expect } from 'vitest';
import { changed_tint_keys } from '../webview/grid-repaint-model';

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
