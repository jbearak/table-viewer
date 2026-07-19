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
            'compare_and_set',
            'read',
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
