import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { create_file_state_store } from '../state';
import type { PerFileState } from '../types';

function context_with(initial: Record<string, unknown>) {
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
    return {
        context,
        value: () => stored as Record<string, unknown>,
        update,
    };
}

describe('FileStateStore recency', () => {
    it('serializes a successful get touch before a following write', async () => {
        const backing = context_with({
            '/a': { activeSheetIndex: 0 },
            '/b': { activeSheetIndex: 1 },
        });
        const store = create_file_state_store(backing.context, () => 2);

        expect(store.get('/a')).toEqual({ activeSheetIndex: 0 });
        await store.set('/c', { activeSheetIndex: 2 });

        expect(Object.keys(backing.value())).toEqual(['/a', '/c']);
        expect(backing.update).toHaveBeenCalledTimes(2);
    });

    it('aborts an asynchronous transaction without a durable write', async () => {
        const backing = context_with({ '/a': { activeSheetIndex: 2 } });
        const store = create_file_state_store(backing.context);

        const result = await store.transaction!('/a', async () => ({ type: 'abort' }));

        expect(result).toBe('abort');
        expect(backing.value()['/a']).toEqual({ activeSheetIndex: 2 });
        expect(backing.update).not.toHaveBeenCalled();
    });

    it('commits an asynchronous transaction from the latest queued state', async () => {
        const backing = context_with({ '/a': { activeSheetIndex: 1 } });
        const store = create_file_state_store(backing.context);
        const result = await store.transaction!('/a', async (current) => ({
            type: 'commit',
            state: { ...(current as PerFileState), activeSheetIndex: 4 },
        }));

        expect(result).toBe('commit');
        expect(backing.value()['/a']).toMatchObject({ activeSheetIndex: 4 });
        expect(backing.update).toHaveBeenCalledTimes(1);
    });

    it('runs atomic updates after a queued recency touch', async () => {
        const backing = context_with({
            '/a': { transforms: [{ sort: [], filters: [] }] },
        });
        const store = create_file_state_store(backing.context);
        store.get('/a');
        await store.update!('/a', (current) => ({
            ...(current as PerFileState),
            activeSheetIndex: 3,
        }));

        expect(backing.value()['/a']).toMatchObject({ activeSheetIndex: 3 });
    });
});
