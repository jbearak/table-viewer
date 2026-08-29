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

    it('writes explicit pending formatting against a known observed side', () => {
        const payload = collect_save_payload(new Map([
            ['0:0', {
                value: 'current',
                base: 'original',
                valueRuns: { runs: [{ text: 'current' }] },
                observedBase: {
                    value: 'current',
                    runs: {
                        runs: [{ text: 'current', style: { bold: true as const } }],
                    },
                },
            }],
        ]));

        expect(payload.status).toBe('ready');
        if (payload.status !== 'ready') throw new Error('expected ready');
        expect(payload.edits).toEqual({ '0:0': 'current' });
    });

    it('emits a same-value move destination so provenance reaches the writer', () => {
        const payload = collect_save_payload(new Map([[
            '2:3',
            { value: 'same', base: 'same', movedFrom: { row: 0, col: 1, order: 1 } },
        ]]));
        if (payload.status !== 'ready') throw new Error('expected ready');
        expect(payload.edits).toEqual({ '2:3': 'same' });
        expect(payload.dirtyEdits['2:3']?.movedFrom).toEqual({ row: 0, col: 1, order: 1 });
    });
});

describe('collect_save_payload — hyperlink edits', () => {
    const link = { kind: 'external', target: 'https://a.test/' } as const;

    it('emits no text edit for a link-only entry but carries its link exactly', () => {
        const payload = collect_save_payload(new Map([
            ['0:0', { value: 'same', base: 'same', link, baseLink: null }],
        ]));
        if (payload.status !== 'ready') throw new Error('expected ready');
        // The whole point: rewriting an unedited cell's `<c>` as inlineStr
        // would lose the original XML for a cell the user never retyped.
        expect(payload.edits).toEqual({});
        expect(payload.dirtyEdits['0:0']).toEqual({
            value: 'same',
            base: 'same',
            link,
            baseLink: null,
        });
    });

    it('emits both dimensions when text and link changed together', () => {
        const payload = collect_save_payload(new Map([
            ['1:1', { value: 'new', base: 'old', link, baseLink: null }],
        ]));
        if (payload.status !== 'ready') throw new Error('expected ready');
        expect(payload.edits).toEqual({ '1:1': 'new' });
        expect(payload.dirtyEdits['1:1']).toEqual({
            value: 'new',
            base: 'old',
            link,
            baseLink: null,
        });
    });

    it('writes a retained value dimension after the observed file text moves', () => {
        const payload = collect_save_payload(new Map([
            ['1:1', {
                value: 'A',
                base: 'A',
                link,
                baseLink: null,
                observedBase: { value: 'C', link: null },
                retainValue: true as const,
            }],
        ]));
        if (payload.status !== 'ready') throw new Error('expected ready');
        expect(payload.edits).toEqual({ '1:1': 'A' });
    });

    it('does not turn a true link-only entry into a text write after observation', () => {
        const payload = collect_save_payload(new Map([
            ['1:1', {
                value: 'A',
                base: 'A',
                link,
                baseLink: null,
                observedBase: { value: 'C', link: null },
            }],
        ]));
        if (payload.status !== 'ready') throw new Error('expected ready');
        expect(payload.edits).toEqual({});
    });

    it('carries a clear (link: null against a linked base)', () => {
        const payload = collect_save_payload(new Map([
            ['2:0', { value: 'x', base: 'x', link: null, baseLink: link }],
        ]));
        if (payload.status !== 'ready') throw new Error('expected ready');
        expect(payload.edits).toEqual({});
        expect(payload.dirtyEdits['2:0']).toEqual({
            value: 'x',
            base: 'x',
            link: null,
            baseLink: link,
        });
    });
});
