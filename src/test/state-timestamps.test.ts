import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    create_authority_store,
    type FileStatePersistenceMedium,
} from '../state';

function memory_medium(initial: unknown = {}) {
    let stored: unknown = structuredClone(initial);
    const medium: FileStatePersistenceMedium = {
        runtime_key: {},
        read: () => stored,
        write: async (envelope) => {
            stored = structuredClone(envelope);
        },
    };
    return { medium, value: () => stored as any };
}

describe('shared state store recency timestamps', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
    });
    afterEach(() => vi.useRealTimers());

    it('stamps entry.updatedAt and envelope.updatedAt on a CAS commit', async () => {
        const backing = memory_medium();
        const store = create_authority_store(backing.medium);

        await store.compare_and_set('/a', 0, { activeSheetIndex: 1 });

        expect(backing.value().updatedAt).toBe(1_000_000);
        expect(backing.value().entries['/a'].updatedAt).toBe(1_000_000);

        vi.setSystemTime(2_000_000);
        await store.compare_and_set('/a', 1, { activeSheetIndex: 2 });
        expect(backing.value().updatedAt).toBe(2_000_000);
        expect(backing.value().entries['/a'].updatedAt).toBe(2_000_000);
    });

    it('stamps updatedAt on authority finalize even without a state change', async () => {
        const backing = memory_medium();
        const store = create_authority_store(backing.medium);
        await store.stage_authority_transaction('/a', {
            id: 'stage', kind: 'physical', ordinal: 1,
            expectedStateRevision: 0, expectedCommitSequence: 0,
            physicalDigest: 'digest',
        });

        vi.setSystemTime(3_000_000);
        const finalized = await store.finalize_authority_transaction('/a', 'stage');

        expect(finalized.type).toBe('finalized');
        expect(backing.value().entries['/a'].updatedAt).toBe(3_000_000);
        expect(backing.value().updatedAt).toBe(3_000_000);
    });

    it('stamps touchedAt on touch without moving updatedAt or the revision', async () => {
        const backing = memory_medium();
        const store = create_authority_store(backing.medium);
        await store.compare_and_set('/a', 0, { activeSheetIndex: 1 });

        vi.setSystemTime(5_000_000);
        await store.touch('/a');

        const entry = backing.value().entries['/a'];
        expect(entry.touchedAt).toBe(5_000_000);
        expect(entry.updatedAt).toBe(1_000_000);
        expect(entry.revision).toBe(1);
        expect(backing.value().updatedAt).toBe(5_000_000);
    });

    it('preserves touchedAt across a durable CAS mutation', async () => {
        const backing = memory_medium();
        const store = create_authority_store(backing.medium);
        await store.compare_and_set('/a', 0, { activeSheetIndex: 1 });
        vi.setSystemTime(5_000_000);
        await store.touch('/a');

        vi.setSystemTime(6_000_000);
        await store.compare_and_set('/a', 1, { activeSheetIndex: 2 });

        const entry = backing.value().entries['/a'];
        expect(entry.touchedAt).toBe(5_000_000);
        expect(entry.updatedAt).toBe(6_000_000);
    });

    it('stamps updatedAt on a copied destination entry', async () => {
        const backing = memory_medium();
        const store = create_authority_store(backing.medium);
        await store.compare_and_set('/source', 0, { activeSheetIndex: 1 });

        vi.setSystemTime(7_000_000);
        await store.copy_entry_if_absent!('/source', '/destination', 'copy-id');

        expect(backing.value().entries['/destination'].updatedAt).toBe(7_000_000);
        expect(backing.value().entries['/source'].updatedAt).toBe(1_000_000);
    });

    it('never regresses store or entry timestamps when the clock moves backward', async () => {
        const backing = memory_medium();
        const store = create_authority_store(backing.medium);
        vi.setSystemTime(2_000_000);
        await store.compare_and_set('/a', 0, { activeSheetIndex: 1 });

        vi.setSystemTime(1_000_000);
        await store.compare_and_set('/a', 1, { activeSheetIndex: 2 });
        await store.touch('/a');

        expect(backing.value().updatedAt).toBe(2_000_000);
        expect(backing.value().entries['/a'].updatedAt).toBe(2_000_000);
        expect(backing.value().entries['/a'].touchedAt).toBe(1_000_000);

        vi.setSystemTime(500_000);
        await store.touch('/a');
        expect(backing.value().entries['/a'].touchedAt).toBe(1_000_000);
        expect(backing.value().updatedAt).toBe(2_000_000);
    });

    it('does not stamp conflicts or missing-discard no-ops', async () => {
        const backing = memory_medium();
        const store = create_authority_store(backing.medium);
        await store.compare_and_set('/a', 0, { activeSheetIndex: 1 });
        const writes_before = structuredClone(backing.value());

        vi.setSystemTime(4_000_000);
        await store.compare_and_set('/a', 0, { activeSheetIndex: 2 });
        await store.discard_authority_transaction('/a', 'missing');

        expect(backing.value()).toEqual(writes_before);
    });

    it('uses one captured timestamp per queued copy and preserves inherited touch time', async () => {
        const backing = memory_medium();
        const store = create_authority_store(backing.medium);
        vi.setSystemTime(2_000_000);
        await store.compare_and_set('/source', 0, { activeSheetIndex: 1 });
        vi.setSystemTime(3_000_000);
        await store.touch('/source');

        vi.setSystemTime(1_000_000);
        await store.copy_entry_if_absent!('/source', '/destination', 'copy');

        expect(backing.value().entries['/destination'].updatedAt).toBe(1_000_000);
        expect(backing.value().entries['/destination'].touchedAt).toBe(3_000_000);
        expect(backing.value().updatedAt).toBe(3_000_000);
    });

    it('updates the store timestamp for stage, discard, and stale cleanup mutations', async () => {
        const backing = memory_medium();
        const store = create_authority_store(backing.medium);
        vi.setSystemTime(2_000_000);
        await store.stage_authority_transaction('/a', {
            id: 'discarded', kind: 'physical', ordinal: 1,
            expectedStateRevision: 0, expectedCommitSequence: 0,
        });
        expect(backing.value().updatedAt).toBe(2_000_000);

        vi.setSystemTime(3_000_000);
        await store.discard_authority_transaction('/a', 'discarded');
        expect(backing.value().updatedAt).toBe(3_000_000);

        vi.setSystemTime(4_000_000);
        await store.stage_authority_transaction('/a', {
            id: 'stale', kind: 'physical', ordinal: 2,
            expectedStateRevision: 0, expectedCommitSequence: 0,
        });
        await store.cleanup_authority_transactions(
            '/ignored',
            4_000_000 + 24 * 60 * 60 * 1000 + 1,
        );
        expect(backing.value().updatedAt)
            .toBe(4_000_000 + 24 * 60 * 60 * 1000 + 1);
    });

    it('reads old envelopes without timestamps and fills them in on the next write', async () => {
        const backing = memory_medium({
            format: 'tableViewer.fileState.v1',
            nextRevision: 5,
            absenceRevision: 0,
            entries: {
                '/legacy': { revision: 4, state: { activeSheetIndex: 2 } },
            },
        });
        const store = create_authority_store(backing.medium);

        expect(await store.read('/legacy')).toEqual({
            state: { activeSheetIndex: 2 },
            revision: 4,
        });
        expect(backing.value().updatedAt).toBeUndefined();

        vi.setSystemTime(8_000_000);
        await store.compare_and_set('/legacy', 4, { activeSheetIndex: 3 });

        expect(backing.value().updatedAt).toBe(8_000_000);
        expect(backing.value().entries['/legacy'].updatedAt).toBe(8_000_000);
        expect(backing.value().format).toBe('tableViewer.fileState.v1');
    });
});
