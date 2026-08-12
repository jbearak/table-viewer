import { describe, it, expect } from 'vitest';
import { collect_save_payload } from '../webview/csv-save-model';

const dirty = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([k, v]) => [k, { value: v, base: '' }]));

describe('collect_save_payload', () => {
    it('maps committed dirty entries to values and exact bases', () => {
        const payload = collect_save_payload(dirty({ '0:0': 'A', '1:2': 'B' }));

        expect(payload).toEqual({
            status: 'ready',
            edits: { '0:0': 'A', '1:2': 'B' },
            dirtyEdits: {
                '0:0': { value: 'A', base: '' },
                '1:2': { value: 'B', base: '' },
            },
        });
    });

    it('is empty when nothing is dirty', () => {
        expect(collect_save_payload(new Map())).toEqual({
            status: 'ready',
            edits: {},
            dirtyEdits: {},
        });
    });

    it('assembles immutable value and exact-base payloads together', () => {
        const payload = collect_save_payload(new Map([
            ['0:0', { value: 'committed', base: 'committed-base' }],
        ]));

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
        ]))).toEqual({
            status: 'blocked',
            reason: 'unresolvedBases',
        });
    });
});
