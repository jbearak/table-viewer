import { describe, it, expect } from 'vitest';
import {
    collect_exact_dirty_edits,
    collect_save_edits,
} from '../webview/csv-save-model';

const dirty = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([k, v]) => [k, { value: v, base: '' }]));

describe('collect_save_edits', () => {
    it('maps committed dirty entries to their values', () => {
        const out = collect_save_edits(dirty({ '0:0': 'A', '1:2': 'B' }), null);
        expect(out).toEqual({ '0:0': 'A', '1:2': 'B' });
    });

    it('is empty when nothing is dirty and no editor is open', () => {
        expect(collect_save_edits(new Map(), null)).toEqual({});
    });

    it('folds an open editor whose value differs from the original', () => {
        const out = collect_save_edits(dirty({ '0:0': 'A' }), {
            key: '2:3',
            value: 'live',
            original: 'orig',
        });
        expect(out).toEqual({ '0:0': 'A', '2:3': 'live' });
    });

    it('overrides a committed value with the open editor live value', () => {
        const out = collect_save_edits(dirty({ '0:0': 'old' }), {
            key: '0:0',
            value: 'newer',
            original: 'orig',
        });
        expect(out).toEqual({ '0:0': 'newer' });
    });

    it('drops the key when the open editor value reverts to the original', () => {
        // The cell is committed-dirty, but the user typed it back to its
        // persisted value; that in-progress revert must not be saved.
        const out = collect_save_edits(dirty({ '0:0': 'A' }), {
            key: '0:0',
            value: 'orig',
            original: 'orig',
        });
        expect(out).toEqual({});
    });
});

describe('collect_exact_dirty_edits', () => {
    it('preserves committed bases and folds the open overlay with its exact base', () => {
        const exact = collect_exact_dirty_edits(new Map([
            ['0:0', { value: 'committed', base: 'committed-base' }],
        ]), {
            key: '1:2',
            value: 'overlay',
            original: 'overlay-base',
        });

        expect(exact).toEqual({
            '0:0': { value: 'committed', base: 'committed-base' },
            '1:2': { value: 'overlay', base: 'overlay-base' },
        });
    });

    it('refuses acceptance while any conflict base is unresolved', () => {
        expect(collect_exact_dirty_edits(new Map([
            ['0:0', { value: 'draft', base: '', base_pending: true }],
        ]), null)).toBeUndefined();
    });
});
