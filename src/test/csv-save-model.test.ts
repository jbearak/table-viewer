import { describe, it, expect } from 'vitest';
import { collect_save_payload } from '../webview/csv-save-model';

const dirty = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([k, v]) => [k, { value: v, base: '' }]));

describe('collect_save_payload', () => {
    it('maps committed dirty entries to values and exact bases', () => {
        const payload = collect_save_payload(dirty({ '0:0': 'A', '1:2': 'B' }), null);

        expect(payload).toEqual({
            status: 'ready',
            edits: { '0:0': 'A', '1:2': 'B' },
            dirtyEdits: {
                '0:0': { value: 'A', base: '' },
                '1:2': { value: 'B', base: '' },
            },
        });
    });

    it('is empty when nothing is dirty and no editor is open', () => {
        expect(collect_save_payload(new Map(), null)).toEqual({
            status: 'ready',
            edits: {},
            dirtyEdits: {},
        });
    });

    it('folds an open editor whose value differs from the original', () => {
        const payload = collect_save_payload(dirty({ '0:0': 'A' }), {
            key: '2:3',
            value: 'live',
            original: 'orig',
        });

        expect(payload).toEqual({
            status: 'ready',
            edits: { '0:0': 'A', '2:3': 'live' },
            dirtyEdits: {
                '0:0': { value: 'A', base: '' },
                '2:3': { value: 'live', base: 'orig' },
            },
        });
    });

    it('overrides a committed value with the open editor live value', () => {
        expect(collect_save_payload(dirty({ '0:0': 'old' }), {
            key: '0:0',
            value: 'newer',
            original: 'orig',
        })).toEqual({
            status: 'ready',
            edits: { '0:0': 'newer' },
            dirtyEdits: { '0:0': { value: 'newer', base: 'orig' } },
        });
    });

    it('drops the key when the open editor value reverts to the original', () => {
        expect(collect_save_payload(dirty({ '0:0': 'A' }), {
            key: '0:0',
            value: 'orig',
            original: 'orig',
        })).toEqual({
            status: 'ready',
            edits: {},
            dirtyEdits: {},
        });
    });

    it('assembles immutable value and exact-base payloads together', () => {
        const payload = collect_save_payload(new Map([
            ['0:0', { value: 'committed', base: 'committed-base' }],
        ]), null);

        expect(Object.isFrozen(payload)).toBe(true);
        if (payload.status !== 'ready') throw new Error('expected ready');
        expect(Object.isFrozen(payload.edits)).toBe(true);
        expect(Object.isFrozen(payload.dirtyEdits)).toBe(true);
        expect(Object.isFrozen(payload.dirtyEdits['0:0'])).toBe(true);
    });

    it('returns a discriminated refusal without a partial payload', () => {
        expect(collect_save_payload(new Map([
            ['0:0', { value: 'ready', base: 'old' }],
            ['1:0', { value: 'pending', base: '', base_pending: true }],
        ]), null)).toEqual({
            status: 'blocked',
            reason: 'unresolvedBases',
        });
    });
});
