import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { create_file_state_store } from '../state';

function context_with(initial: unknown) {
    let stored: unknown = initial;
    const update = vi.fn(async (_key: string, value: unknown) => {
        stored = structuredClone(value);
    });
    const context = {
        globalState: {
            get: (_key: string, fallback: unknown) => stored ?? fallback,
            update,
        },
    } as unknown as ExtensionContext;
    return { context, value: () => stored as any, update };
}

describe('FileStateStore versioned state', () => {
    it('commits an exact revision and rejects a stale compare-and-set', async () => {
        const backing = context_with({});
        const store = create_file_state_store(backing.context);
        const initial = await store.read('/a');

        const committed = await store.compare_and_set(
            '/a',
            initial.revision,
            { activeSheetIndex: 1 },
        );
        const conflict = await store.compare_and_set(
            '/a',
            initial.revision,
            { activeSheetIndex: 2 },
        );

        expect(committed).toMatchObject({
            type: 'committed',
            snapshot: { revision: 1, state: { activeSheetIndex: 1 } },
        });
        expect(conflict).toMatchObject({
            type: 'conflict',
            snapshot: { revision: 1, state: { activeSheetIndex: 1 } },
        });
        expect((await store.read('/a')).state).toEqual({ activeSheetIndex: 1 });
    });

    it('checks a synchronous authority fence at the CAS commit point', async () => {
        const store = create_file_state_store(context_with({}).context);
        const initial = await store.read('/a');
        const result = await store.compare_and_set(
            '/a',
            initial.revision,
            { activeSheetIndex: 1 },
            () => false,
        );

        expect(result.type).toBe('conflict');
        expect((await store.read('/a')).state).toEqual({});

        const async_fence = await store.compare_and_set(
            '/a',
            initial.revision,
            { activeSheetIndex: 2 },
            (async () => true) as unknown as () => boolean,
        );
        expect(async_fence.type).toBe('conflict');
        expect((await store.read('/a')).state).toEqual({});
    });

    it('leaves no staged state when the single durable update fails', async () => {
        let stored: unknown = {};
        const context = {
            globalState: {
                get: (_key: string, fallback: unknown) => stored ?? fallback,
                async update() {
                    throw new Error('update failed');
                },
            },
        } as unknown as ExtensionContext;
        const store = create_file_state_store(context);

        await expect(store.compare_and_set(
            '/a',
            0,
            { activeSheetIndex: 1 },
        )).rejects.toThrow('update failed');
        expect((await store.read('/a')).state).toEqual({});
        expect(stored).toEqual({});
    });

    it('atomically canonicalizes aliases without overwriting canonical state', async () => {
        const store = create_file_state_store(context_with({}).context);
        await store.compare_and_set('C:\\Data\\Book.xlsx', 0, { activeSheetIndex: 1 });
        await store.compare_and_set('c:\\data\\book.xlsx', 0, { activeSheetIndex: 2 });

        await store.canonicalize_path!(
            'c:\\data\\book.xlsx',
            (key) => key.toLowerCase(),
        );

        expect((await store.read('c:\\data\\book.xlsx')).state)
            .toEqual({ activeSheetIndex: 2 });
        expect((await store.read('C:\\Data\\Book.xlsx')).state).toEqual({});
    });

    it('keeps canonical alias state and authority from one durable entry pair', async () => {
        const backing = context_with({
            format: 'tableViewer.fileState.v1',
            nextRevision: 20,
            absenceRevision: 0,
            entries: {
                'C:\\Data\\Pair.xlsx': {
                    revision: 15,
                    state: { activeSheetIndex: 1 },
                    authority: {
                        commitSequence: 2,
                        authorityRevision: 2,
                        physicalRevision: 2,
                        projectionRevision: 0,
                        physicalDigest: 'old',
                    },
                },
                'c:\\data\\pair.xlsx': {
                    revision: 5,
                    state: { activeSheetIndex: 7 },
                    authority: {
                        commitSequence: 9,
                        authorityRevision: 9,
                        physicalRevision: 4,
                        projectionRevision: 5,
                        physicalDigest: 'new',
                    },
                },
            },
        });
        const store = create_file_state_store(backing.context);
        await store.canonicalize_path!(
            'c:\\data\\pair.xlsx',
            (key) => key.toLowerCase(),
        );
        expect((await store.read('c:\\data\\pair.xlsx')).state)
            .toEqual({ activeSheetIndex: 7 });
        expect(await store.read_authority!('c:\\data\\pair.xlsx')).toMatchObject({
            commitSequence: 9,
            physicalDigest: 'new',
        });
    });

    it('discovers a lone legacy alias during canonicalization', async () => {
        const store = create_file_state_store(context_with({}).context);
        await store.compare_and_set('C:\\Data\\Legacy.xlsx', 0, { activeSheetIndex: 4 });

        await store.canonicalize_path!(
            'c:\\data\\legacy.xlsx',
            (key) => key.toLowerCase(),
        );

        expect((await store.read('c:\\data\\legacy.xlsx')).state)
            .toEqual({ activeSheetIndex: 4 });
        expect((await store.read('C:\\Data\\Legacy.xlsx')).state).toEqual({});
    });

    it('keeps staged authority state invisible and finalizes state plus authority atomically', async () => {
        const backing = context_with({});
        const store = create_file_state_store(backing.context);
        const initial = await store.read('/book');
        await expect(store.stage_authority_transaction!('/book', {
            id: 'physical:1',
            kind: 'physical',
            ordinal: 1,
            expectedStateRevision: initial.revision,
            expectedCommitSequence: 0,
            nextState: { activeSheetIndex: 2 },
            physicalDigest: 'digest-a',
        })).resolves.toEqual({ type: 'staged' });

        expect(await store.read('/book')).toEqual(initial);
        const reconstructed = create_file_state_store(backing.context);
        expect(await reconstructed.read('/book')).toEqual(initial);
        expect(await reconstructed.read_authority!('/book')).toMatchObject({
            commitSequence: 0,
            authorityRevision: 0,
        });

        const finalized = await reconstructed.finalize_authority_transaction!(
            '/book',
            'physical:1',
        );
        expect(finalized).toMatchObject({
            type: 'finalized',
            snapshot: { state: { activeSheetIndex: 2 }, revision: 1 },
            authority: {
                commitSequence: 1,
                authorityRevision: 1,
                physicalRevision: 1,
                projectionRevision: 0,
                physicalDigest: 'digest-a',
            },
        });
        expect(await store.read('/book')).toMatchObject({
            state: { activeSheetIndex: 2 },
            revision: 1,
        });
        const reopened = create_file_state_store(backing.context);
        expect(await reopened.read_authority!('/book')).toEqual(finalized.authority);
    });

    it('bounds and cleans abandoned invisible stages without semantic revision changes', async () => {
        const backing = context_with({});
        const store = create_file_state_store(backing.context);
        for (let index = 0; index < 10; index++) {
            await store.stage_authority_transaction!('/book', {
                id: `stage:${index}`,
                kind: 'physical',
                ordinal: index,
                expectedStateRevision: 0,
                expectedCommitSequence: 0,
                physicalDigest: String(index),
            });
        }
        expect(Object.keys(backing.value().entries['/book'].stages)).toHaveLength(8);
        expect(await store.read('/book')).toEqual({ state: {}, revision: 0 });
        await store.cleanup_authority_transactions!(
            '/book',
            Date.now() + 2 * 24 * 60 * 60 * 1000,
        );
        expect(backing.value().entries['/book'].stages).toBeUndefined();
        expect(await store.read('/book')).toEqual({ state: {}, revision: 0 });
    });

    it('does not bump physical or state revision for a same-digest state-less commit', async () => {
        const store = create_file_state_store(context_with({}).context);
        await store.stage_authority_transaction!('/book', {
            id: 'first', kind: 'physical', ordinal: 1,
            expectedStateRevision: 0, expectedCommitSequence: 0,
            physicalDigest: 'same',
        });
        const first = await store.finalize_authority_transaction!('/book', 'first');
        if (first.type !== 'finalized') throw new Error('first finalize failed');
        await store.stage_authority_transaction!('/book', {
            id: 'second', kind: 'physical', ordinal: 2,
            expectedStateRevision: first.snapshot.revision,
            expectedCommitSequence: first.authority.commitSequence,
            physicalDigest: 'same',
        });
        const second = await store.finalize_authority_transaction!('/book', 'second');
        expect(second).toMatchObject({
            type: 'finalized',
            snapshot: { revision: first.snapshot.revision },
            authority: {
                commitSequence: 2,
                authorityRevision: 1,
                physicalRevision: 1,
                projectionRevision: 0,
            },
        });
    });

    it('leaves old visible state and authority when finalization update fails', async () => {
        let stored: unknown = {};
        let updates = 0;
        const context = {
            globalState: {
                get: (_key: string, fallback: unknown) => stored ?? fallback,
                async update(_key: string, value: unknown) {
                    updates += 1;
                    if (updates === 2) throw new Error('finalize failed');
                    stored = structuredClone(value);
                },
            },
        } as unknown as ExtensionContext;
        const store = create_file_state_store(context);
        await store.stage_authority_transaction!('/book', {
            id: 'staged', kind: 'projection', ordinal: 1,
            expectedStateRevision: 0, expectedCommitSequence: 0,
            nextState: { activeSheetIndex: 3 },
        });
        await expect(store.finalize_authority_transaction!('/book', 'staged'))
            .rejects.toThrow('finalize failed');
        expect(await store.read('/book')).toEqual({ state: {}, revision: 0 });
        expect(await store.read_authority!('/book')).toMatchObject({
            commitSequence: 0,
            authorityRevision: 0,
        });
    });

    it('keeps recency touches independent from semantic revisions', async () => {
        const backing = context_with({
            format: 'tableViewer.fileState.v1',
            entries: {
                '/a': { revision: 4, state: { activeSheetIndex: 0 } },
                '/b': { revision: 2, state: { activeSheetIndex: 1 } },
            },
        });
        const store = create_file_state_store(backing.context, () => 2);

        const before = await store.read('/a');
        await store.touch('/a');
        const after = await store.read('/a');
        const committed = await store.compare_and_set(
            '/c',
            0,
            { activeSheetIndex: 2 },
        );

        expect(before.revision).toBe(4);
        expect(after.revision).toBe(4);
        expect(committed.type).toBe('committed');
        expect(Object.keys(backing.value().entries)).toEqual(['/a', '/c']);
    });

    it('decodes legacy bare records as revision zero and lazily envelopes them', async () => {
        const backing = context_with({ '/a': { activeSheetIndex: 3 } });
        const store = create_file_state_store(backing.context);

        expect(await store.read('/a')).toEqual({
            state: { activeSheetIndex: 3 },
            revision: 0,
        });
        expect(backing.update).not.toHaveBeenCalled();

        await store.touch('/a');
        expect(backing.value()).toEqual({
            format: 'tableViewer.fileState.v1',
            nextRevision: 1,
            absenceRevision: 0,
            entries: {
                '/a': { revision: 0, state: { activeSheetIndex: 3 } },
            },
        });
    });

    it('rejects a stale absent revision after create and eviction', async () => {
        const backing = context_with({});
        const store = create_file_state_store(backing.context, () => 1);
        const stale = await store.read('/a');
        await store.compare_and_set('/a', stale.revision, { activeSheetIndex: 1 });
        await store.compare_and_set('/b', 0, { activeSheetIndex: 2 });

        const result = await store.compare_and_set(
            '/a',
            stale.revision,
            { activeSheetIndex: 3 },
        );

        expect(result.type).toBe('conflict');
        expect(result.snapshot.revision).toBeGreaterThan(stale.revision);
    });

    it('rejects old absence bases across create, evict, and recreate cycles', async () => {
        const backing = context_with({});
        const store = create_file_state_store(backing.context, () => 1);
        const original_absence = await store.read('/a');
        await store.compare_and_set('/a', original_absence.revision, { activeSheetIndex: 1 });
        const b = await store.read('/b');
        await store.compare_and_set('/b', b.revision, { activeSheetIndex: 2 });
        const recreated_basis = await store.read('/a');
        await store.compare_and_set('/a', recreated_basis.revision, { activeSheetIndex: 3 });
        const c = await store.read('/c');
        await store.compare_and_set('/c', c.revision, { activeSheetIndex: 4 });

        const stale = await store.compare_and_set(
            '/a',
            original_absence.revision,
            { activeSheetIndex: 5 },
        );

        expect(stale.type).toBe('conflict');
        expect(stale.snapshot.revision).toBeGreaterThan(original_absence.revision);
    });

    it('keeps persisted eviction metadata bounded under path churn', async () => {
        const backing = context_with({});
        const store = create_file_state_store(backing.context, () => 3);
        for (let index = 0; index < 200; index++) {
            const path = `/file-${index}`;
            const basis = await store.read(path);
            const result = await store.compare_and_set(path, basis.revision, {
                activeSheetIndex: index,
            });
            expect(result.type).toBe('committed');
        }

        const envelope = backing.value();
        expect(Object.keys(envelope.entries)).toHaveLength(3);
        expect(Object.keys(envelope).sort()).toEqual([
            'absenceRevision',
            'entries',
            'format',
            'nextRevision',
        ]);
        expect(JSON.stringify(envelope)).not.toContain('/file-0"');
        expect(envelope.absenceRevision).toBeGreaterThan(0);
    });

    it('shares serialization across stores backed by the same memento', async () => {
        const backing = context_with({});
        const first = create_file_state_store(backing.context);
        const second = create_file_state_store(backing.context);
        const [left, right] = await Promise.all([
            first.compare_and_set('/a', 0, { activeSheetIndex: 1 }),
            second.compare_and_set('/a', 0, { activeSheetIndex: 2 }),
        ]);

        expect([left.type, right.type].sort()).toEqual(['committed', 'conflict']);
    });

    it('exposes no callback-based asynchronous reducer API', () => {
        const store = create_file_state_store(context_with({}).context);
        expect(Object.keys(store).sort()).toEqual([
            'canonicalize_path',
            'cleanup_authority_transactions',
            'compare_and_set',
            'discard_authority_transaction',
            'finalize_authority_transaction',
            'inspect_authority_transaction',
            'read',
            'read_authority',
            'stage_authority_transaction',
            'touch',
        ]);
    });

    it('linearizes queued reads and writes and continues after write failure', async () => {
        let stored: unknown = {};
        let fail_once = true;
        const context = {
            globalState: {
                get: (_key: string, fallback: unknown) => stored ?? fallback,
                update: vi.fn(async (_key: string, value: unknown) => {
                    if (fail_once) {
                        fail_once = false;
                        throw new Error('write failed');
                    }
                    stored = structuredClone(value);
                }),
            },
        } as unknown as ExtensionContext;
        const store = create_file_state_store(context);

        await expect(store.compare_and_set('/a', 0, { activeSheetIndex: 1 }))
            .rejects.toThrow('write failed');
        const second = await store.compare_and_set('/a', 0, { activeSheetIndex: 2 });
        const read = await store.read('/a');

        expect(second.type).toBe('committed');
        expect(read).toEqual({ state: { activeSheetIndex: 2 }, revision: 1 });
    });
});
