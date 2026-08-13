import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { compare_authority } from '../authority-order';
import {
    create_keyed_authority_store,
    type KeyedFileStatePersistence,
    type KeyedStateReadTransaction,
    type KeyedStateWriteTransaction,
} from '../state';
import { file_state_store_contract } from './file-state-store-contract';
import {
    create_memento_file_state_store,
    create_memento_keyed_file_state_persistence,
} from './helpers/memento-file-state';
import { sheet_edits } from './pending-edits-helper';

function context_with(initial: unknown) {
    let stored: unknown = initial;
    let failNextWrite = false;
    const update = vi.fn(async (_key: string, value: unknown) => {
        if (failNextWrite) {
            failNextWrite = false;
            throw new Error('injected write failure');
        }
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
        value: () => stored as any,
        set: (value: unknown) => { stored = structuredClone(value); },
        failNextWrite: () => { failNextWrite = true; },
        update,
    };
}

function instrument_payload_io(persistence: KeyedFileStatePersistence) {
    const counts = { reads: 0, writes: 0 };
    const readTx = (tx: KeyedStateReadTransaction): KeyedStateReadTransaction => ({
        ...tx,
        read_entry(path) {
            counts.reads += 1;
            return tx.read_entry(path);
        },
    });
    const writeTx = (tx: KeyedStateWriteTransaction): KeyedStateWriteTransaction => ({
        ...tx,
        read_entry(path) {
            counts.reads += 1;
            return tx.read_entry(path);
        },
        write_entry(value) {
            counts.writes += 1;
            tx.write_entry(value);
        },
    });
    const wrapped: KeyedFileStatePersistence = {
        ...persistence,
        read_transaction: (body) => persistence.read_transaction((tx) => body(readTx(tx))),
        write_transaction: (kind, body) => persistence.write_transaction(
            kind,
            (tx) => body(writeTx(tx)),
        ),
    };
    return { counts, wrapped, reset: () => { counts.reads = 0; counts.writes = 0; } };
}

file_state_store_contract('Memento test-fixture medium', () => {
    const backing = context_with({});
    return {
        create: (max = 10_000) => create_memento_file_state_store(backing.context, () => max),
        createIndependent: (max = 10_000) => create_memento_file_state_store(backing.context, () => max),
        seedEnvelope: (envelope) => backing.set(envelope),
        inspect: () => backing.value(),
        failNextWrite: async () => {
            backing.failNextWrite();
            return async () => {};
        },
    };
});

describe('FileStateStore versioned state', () => {
    it('commits an exact revision and rejects a stale compare-and-set', async () => {
        const backing = context_with({});
        const store = create_memento_file_state_store(backing.context);
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
        const store = create_memento_file_state_store(context_with({}).context);
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

    it('invokes CAS validation exactly once before every stale guard', async () => {
        const store = create_memento_file_state_store(context_with({}).context);
        await store.stage_authority_transaction('/a', {
            id: 'physical', kind: 'physical', ordinal: 1,
            expectedStateRevision: 0, expectedCommitSequence: 0,
            physicalDigest: 'digest',
        });
        const finalized = await store.finalize_authority_transaction('/a', 'physical');
        if (finalized.type !== 'finalized') throw new Error('authority setup failed');

        const stale_revision_validator = vi.fn(() => true);
        await expect(store.compare_and_set(
            '/a',
            -1,
            { activeSheetIndex: 1 },
            stale_revision_validator,
            { expectedAuthorityRevision: finalized.authority.authorityRevision },
        )).resolves.toMatchObject({ type: 'conflict', authority: finalized.authority });
        expect(stale_revision_validator).toHaveBeenCalledOnce();

        const stale_authority_validator = vi.fn(() => true);
        await expect(store.compare_and_set(
            '/a',
            finalized.snapshot.revision,
            { activeSheetIndex: 2 },
            stale_authority_validator,
            { expectedAuthorityRevision: 0 },
        )).resolves.toMatchObject({ type: 'conflict', authority: finalized.authority });
        expect(stale_authority_validator).toHaveBeenCalledOnce();

        const stale_component_validator = vi.fn(() => true);
        await expect(store.compare_and_set(
            '/a',
            finalized.snapshot.revision,
            { activeSheetIndex: 3 },
            stale_component_validator,
            {
                expectedAuthorityRevision: finalized.authority.authorityRevision,
                expectedPhysicalRevision: 0,
                expectedProjectionRevision: finalized.authority.projectionRevision,
            },
        )).resolves.toMatchObject({ type: 'conflict', authority: finalized.authority });
        expect(stale_component_validator).toHaveBeenCalledOnce();
    });

    it('gives validator throws precedence and conflicts every non-pass value', async () => {
        const store = create_memento_file_state_store(context_with({}).context);
        const thrown = new Error('validator failed');
        await expect(store.compare_and_set(
            '/a',
            -1,
            { activeSheetIndex: 1 },
            () => { throw thrown; },
            { expectedAuthorityRevision: 99 },
        )).rejects.toBe(thrown);

        for (const value of [false, null, 0, 'true', Promise.resolve(true), { then() {} }]) {
            const validator = vi.fn(() => value as never);
            await expect(store.compare_and_set(
                '/a',
                0,
                { activeSheetIndex: 2 },
                validator,
            )).resolves.toMatchObject({ type: 'conflict' });
            expect(validator).toHaveBeenCalledOnce();
        }
        expect((await store.read('/a')).state).toEqual({});
    });

    it('returns the current snapshot and authority on every CAS outcome', async () => {
        const store = create_memento_file_state_store(context_with({}).context);
        const committed = await store.compare_and_set('/a', 0, { activeSheetIndex: 1 });
        expect(committed).toEqual({
            type: 'committed',
            snapshot: { state: { activeSheetIndex: 1 }, revision: 1 },
            authority: {
                commitSequence: 0,
                authorityRevision: 0,
                physicalRevision: 0,
                projectionRevision: 0,
            },
        });
        await store.stage_authority_transaction('/a', {
            id: 'projection', kind: 'projection', ordinal: 1,
            expectedStateRevision: 1, expectedCommitSequence: 0,
        });
        const finalized = await store.finalize_authority_transaction('/a', 'projection');
        if (finalized.type !== 'finalized') throw new Error('authority setup failed');
        await expect(store.compare_and_set('/a', 0, { activeSheetIndex: 2 }))
            .resolves.toEqual({
                type: 'conflict',
                snapshot: finalized.snapshot,
                authority: finalized.authority,
            });
    });

    it('shares one explicit runtime queue and close drains independently queued work', async () => {
        const backing = context_with({});
        const base = create_memento_keyed_file_state_persistence(backing.context);
        const peer = create_memento_keyed_file_state_persistence(backing.context);
        expect(peer.runtime_key).toBe(base.runtime_key);
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        let markFirstEntered!: () => void;
        const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
        let firstWrite = true;
        const held: KeyedFileStatePersistence = {
            ...base,
            async write_transaction(kind, body) {
                if (firstWrite) {
                    firstWrite = false;
                    markFirstEntered();
                    await firstGate;
                }
                return base.write_transaction(kind, body);
            },
        };
        let secondTransactionBegan = false;
        const observed: KeyedFileStatePersistence = {
            ...peer,
            write_transaction(kind, body) {
                secondTransactionBegan = true;
                return peer.write_transaction(kind, body);
            },
        };
        const first = create_keyed_authority_store(held);
        const second = create_keyed_authority_store(observed);

        const firstWritePromise = first.compare_and_set('/first', 0, { activeSheetIndex: 1 });
        await firstEntered;
        const secondWritePromise = second.compare_and_set('/second', 0, { activeSheetIndex: 2 });
        let closeResolved = false;
        const closePromise = base.close().then(() => { closeResolved = true; });
        const postCloseRead = second.read('/rejected');
        expect(secondTransactionBegan).toBe(false);
        expect(closeResolved).toBe(false);
        await expect(postCloseRead).rejects.toThrow('File-state persistence is closed.');

        releaseFirst();
        await Promise.all([firstWritePromise, secondWritePromise, closePromise]);
        expect(secondTransactionBegan).toBe(true);
        expect(closeResolved).toBe(true);
        await expect(first.compare_and_set('/late', 0, { activeSheetIndex: 3 }))
            .rejects.toThrow('File-state persistence is closed.');
    });

    it('avoids entry payload I/O for touch and stage-only mutations', async () => {
        const backing = context_with({});
        const measured = instrument_payload_io(
            create_memento_keyed_file_state_persistence(backing.context),
        );
        const store = create_keyed_authority_store(measured.wrapped);
        await store.compare_and_set('/large', 0, {
            activeSheetIndex: 1,
            futureCompatibleLeaf: { payload: 'x'.repeat(100_000) },
        } as any);

        measured.reset();
        await store.touch('/large');
        expect(measured.counts).toEqual({ reads: 0, writes: 0 });

        measured.reset();
        await store.stage_authority_transaction('/large', {
            id: 'stage', kind: 'projection', ordinal: 1,
            expectedStateRevision: 1, expectedCommitSequence: 0,
        });
        expect(measured.counts).toEqual({ reads: 0, writes: 0 });

        measured.reset();
        await store.discard_authority_transaction('/large', 'stage');
        expect(measured.counts).toEqual({ reads: 0, writes: 0 });

        await store.stage_authority_transaction('/large', {
            id: 'stale', kind: 'projection', ordinal: 2,
            expectedStateRevision: 1, expectedCommitSequence: 0,
        });
        measured.reset();
        await store.cleanup_authority_transactions('/large', Date.now() + 25 * 60 * 60 * 1000);
        expect(measured.counts).toEqual({ reads: 0, writes: 0 });
        expect((await store.read('/large')).state).toMatchObject({ activeSheetIndex: 1 });
    });

    it('rejects thenable keyed transaction callbacks without committing mutations', async () => {
        const backing = context_with({});
        const persistence = create_memento_keyed_file_state_persistence(backing.context);
        await expect(persistence.read_transaction(
            (() => Promise.resolve('async')) as never,
        )).rejects.toThrow('transaction callbacks must be synchronous');
        await expect(persistence.write_transaction('compareAndSet', (tx) => {
            tx.set_updated_at(123);
            return { then() {} } as never;
        })).rejects.toThrow('transaction callbacks must be synchronous');
        expect(backing.update).not.toHaveBeenCalled();
        expect(backing.value()).toEqual({});
        await persistence.close();
    });

    it('round-trips complete entries through the keyed Memento transaction port', async () => {
        const backing = context_with({});
        const persistence = create_memento_keyed_file_state_persistence(backing.context);
        const written = await persistence.write_transaction('compareAndSet', (tx) => {
            const revision = tx.allocate_revision();
            tx.set_updated_at(123);
            tx.write_entry({
                entry: {
                    path: '/keyed',
                    stateRevision: revision,
                    stateJson: JSON.stringify({ activeSheetIndex: 3 }),
                    hasPendingEdits: false,
                    authority: {
                        commitSequence: 2,
                        authorityRevision: 1,
                        physicalRevision: 1,
                        projectionRevision: 0,
                        physicalDigest: 'digest',
                    },
                    recencyOrder: 1n,
                    updatedAtMs: 123,
                    recoveryEntryId: '/keyed',
                },
                stages: [{
                    id: 'stage', kind: 'projection', ordinal: 3,
                    expectedStateRevision: revision,
                    expectedCommitSequence: 2,
                    createdAt: 100,
                }],
            });
            return revision;
        });
        expect(written).toBe(1);
        expect(backing.value()).toEqual({
            format: 'tableViewer.fileState.v1',
            nextRevision: 2,
            absenceRevision: 0,
            updatedAt: 123,
            entries: {
                '/keyed': {
                    revision: 1,
                    state: { activeSheetIndex: 3 },
                    authority: {
                        commitSequence: 2,
                        authorityRevision: 1,
                        physicalRevision: 1,
                        projectionRevision: 0,
                        physicalDigest: 'digest',
                    },
                    stages: {
                        stage: {
                            id: 'stage', kind: 'projection', ordinal: 3,
                            expectedStateRevision: 1,
                            expectedCommitSequence: 2,
                            createdAt: 100,
                        },
                    },
                    updatedAt: 123,
                },
            },
        });
        await expect(persistence.read_transaction((tx) => tx.read_entry('/keyed')))
            .resolves.toMatchObject({
                entry: {
                    path: '/keyed',
                    stateRevision: 1,
                    stateJson: JSON.stringify({ activeSheetIndex: 3 }),
                    hasPendingEdits: false,
                    recencyOrder: 1n,
                },
                stages: [{ id: 'stage', createdAt: 100 }],
            });
        await persistence.close();
    });

    it('stages transaction-owned lease changes until persistence succeeds', async () => {
        const backing = context_with({});
        const persistence = create_memento_keyed_file_state_persistence(backing.context);

        backing.failNextWrite();
        await expect(persistence.write_transaction('lease', (tx) => {
            tx.insert_lease('exact-lease', '/alias');
            expect(tx.entry_is_leased_here('/alias')).toBe(true);
            tx.set_updated_at(1);
        })).rejects.toThrow('injected write failure');
        await expect(persistence.read_transaction((tx) => tx.entry_is_leased_here('/alias')))
            .resolves.toBe(false);

        await persistence.write_transaction('lease', (tx) => {
            tx.insert_lease('exact-lease', '/alias');
            tx.set_updated_at(2);
        });
        backing.failNextWrite();
        await expect(persistence.write_transaction('canonicalize', (tx) => {
            tx.move_leases(['/alias'], '/canonical');
            expect(tx.entry_is_leased_here('/alias')).toBe(false);
            expect(tx.entry_is_leased_here('/canonical')).toBe(true);
            tx.set_updated_at(3);
        })).rejects.toThrow('injected write failure');
        await expect(persistence.read_transaction((tx) => ({
            alias: tx.entry_is_leased_here('/alias'),
            canonical: tx.entry_is_leased_here('/canonical'),
        }))).resolves.toEqual({ alias: true, canonical: false });

        backing.failNextWrite();
        await expect(persistence.write_transaction('releaseLease', (tx) => {
            expect(tx.delete_lease('different-lease')).toBe(false);
            expect(tx.delete_lease('exact-lease')).toBe(true);
            expect(tx.entry_is_leased_here('/alias')).toBe(false);
            tx.set_updated_at(4);
        })).rejects.toThrow('injected write failure');
        await expect(persistence.read_transaction((tx) => tx.entry_is_leased_here('/alias')))
            .resolves.toBe(true);

        await persistence.write_transaction('releaseLease', (tx) => {
            expect(tx.delete_lease('exact-lease')).toBe(true);
        });
        await persistence.write_transaction('releaseLease', (tx) => {
            expect(tx.delete_lease('exact-lease')).toBe(false);
        });
        await expect(persistence.read_transaction((tx) => tx.entry_is_leased_here('/alias')))
            .resolves.toBe(false);
        await persistence.close();
    });

    it('passes one exact random lease id through backend insertion and release', async () => {
        const backing = context_with({});
        const base = create_memento_keyed_file_state_persistence(backing.context);
        const events: Array<{
            kind: string;
            operation: 'insert' | 'move' | 'delete';
            leaseId?: string;
            path?: string;
            sourcePaths?: readonly string[];
        }> = [];
        const persistence: KeyedFileStatePersistence = {
            ...base,
            write_transaction: (kind, body) => base.write_transaction(kind, (tx) => body({
                ...tx,
                insert_lease(leaseId, path) {
                    tx.insert_lease(leaseId, path);
                    expect(tx.entry_is_leased_here(path)).toBe(true);
                    events.push({ kind, operation: 'insert', leaseId, path });
                },
                move_leases(sourcePaths, destinationPath) {
                    tx.move_leases(sourcePaths, destinationPath);
                    events.push({
                        kind,
                        operation: 'move',
                        sourcePaths: [...sourcePaths],
                        path: destinationPath,
                    });
                },
                delete_lease(leaseId) {
                    events.push({ kind, operation: 'delete', leaseId });
                    return tx.delete_lease(leaseId);
                },
            })),
        };
        const store = create_keyed_authority_store(persistence, () => 1);
        const alias = 'C:\\Data\\leased.csv';
        const canonical = 'c:\\data\\leased.csv';
        await store.compare_and_set(alias, 0, { activeSheetIndex: 1 });

        const lease = await store.lease_entry!(alias, (path) => path.toLowerCase());
        const insertion = events.find((event) => event.operation === 'insert');
        expect(insertion).toMatchObject({ kind: 'lease', path: alias });
        expect(insertion?.leaseId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );

        await store.canonicalize_path!(canonical, (path) => path.toLowerCase());
        expect(events).toContainEqual({
            kind: 'canonicalize',
            operation: 'move',
            sourcePaths: [alias],
            path: canonical,
        });
        await lease.release();
        expect(events.at(-1)).toEqual({
            kind: 'releaseLease',
            operation: 'delete',
            leaseId: insertion?.leaseId,
        });
        await base.close();
    });

    it('uses transaction-visible backend leases for retention protection', async () => {
        const backing = context_with({});
        const base = create_memento_keyed_file_state_persistence(backing.context);
        const persistence: KeyedFileStatePersistence = {
            ...base,
            read_transaction: (body) => base.read_transaction((tx) => body({
                ...tx,
                entry_is_leased_here: (path) => path === '/backend-owned' || tx.entry_is_leased_here(path),
            })),
            write_transaction: (kind, body) => base.write_transaction(kind, (tx) => body({
                ...tx,
                entry_is_leased_here: (path) => path === '/backend-owned' || tx.entry_is_leased_here(path),
            })),
        };
        const store = create_keyed_authority_store(persistence, () => 1);
        await store.compare_and_set('/backend-owned', 0, { activeSheetIndex: 1 });
        await store.compare_and_set('/ordinary', 0, { activeSheetIndex: 2 });
        await store.compare_and_set('/newest', 0, { activeSheetIndex: 3 });

        expect((await store.read('/backend-owned')).state).toEqual({ activeSheetIndex: 1 });
        expect((await store.read('/ordinary')).state).toEqual({});
        expect((await store.read('/newest')).state).toEqual({ activeSheetIndex: 3 });
        await base.close();
    });

    it('derives pending-edit metadata and protects pending rows from retention', async () => {
        const backing = context_with({});
        const store = create_memento_file_state_store(backing.context, () => 1);
        await store.compare_and_set('/pending', 0, {
            pendingEdits: sheet_edits({ '0:0': { value: 'next', base: 'old' } }),
        });
        const keyed = create_memento_keyed_file_state_persistence(backing.context);
        await expect(keyed.read_transaction((tx) => tx.read_entry_metadata('/pending')))
            .resolves.toMatchObject({ hasPendingEdits: true });

        await store.compare_and_set('/ordinary-a', 0, { activeSheetIndex: 1 });
        await store.compare_and_set('/ordinary-b', 0, { activeSheetIndex: 2 });
        expect(backing.value().entries['/pending']).toBeDefined();
        expect(backing.value().entries['/ordinary-a']).toBeUndefined();
        await expect(keyed.read_transaction((tx) => tx.read_entry_metadata('/ordinary-b')))
            .resolves.toMatchObject({ hasPendingEdits: false });

        const copied = await store.copy_entry_if_absent!(
            '/pending',
            '/pending-copy',
            'pending-copy',
        );
        expect(copied.type).toBe('copied');
        await expect(keyed.read_transaction((tx) => tx.read_entry_metadata('/pending-copy')))
            .resolves.toMatchObject({ hasPendingEdits: true });

        const copy_snapshot = await store.read('/pending-copy');
        const authority = await store.read_authority('/pending-copy');
        await store.stage_authority_transaction('/pending-copy', {
            id: 'clear-pending', kind: 'projection', ordinal: 1,
            expectedStateRevision: copy_snapshot.revision,
            expectedCommitSequence: authority.commitSequence,
            nextState: { activeSheetIndex: 4 },
        });
        await store.finalize_authority_transaction('/pending-copy', 'clear-pending');
        await expect(keyed.read_transaction((tx) => tx.read_entry_metadata('/pending-copy')))
            .resolves.toMatchObject({ hasPendingEdits: false });
        await keyed.close();
    });

    it('repairs imported pending-edit metadata during canonicalization', async () => {
        const alias = 'C:\\Data\\Pending.csv';
        const canonical = 'c:\\data\\pending.csv';
        const backing = context_with({
            format: 'tableViewer.fileState.v1',
            nextRevision: 2,
            absenceRevision: 0,
            entries: {
                [alias]: {
                    revision: 1,
                    state: { pendingEdits: sheet_edits({ '0:0': 'value' }) },
                    hasPendingEdits: false,
                },
            },
        });
        const store = create_memento_file_state_store(backing.context);
        await store.canonicalize_path!(canonical, (path) => path.toLowerCase());
        const keyed = create_memento_keyed_file_state_persistence(backing.context);
        await expect(keyed.read_transaction((tx) => tx.read_entry_metadata(canonical)))
            .resolves.toMatchObject({ hasPendingEdits: true });
        await keyed.close();
    });

    it('clears copy provenance when absent-target canonicalization allocates a revision', async () => {
        const backing = context_with({});
        const base = create_memento_keyed_file_state_persistence(backing.context);
        const persistence: KeyedFileStatePersistence = {
            ...base,
            canonicalization_revision_policy: 'allocate-revision-when-target-absent',
        };
        const store = create_keyed_authority_store(persistence);
        const source = '/source';
        const alias = 'C:\\Data\\copied.csv';
        const canonical = 'c:\\data\\copied.csv';
        await store.compare_and_set(source, 0, { activeSheetIndex: 3 });
        await store.copy_entry_if_absent!(source, alias, 'copy-id');
        const aliasRevision = (await store.read(alias)).revision;

        await store.canonicalize_path!(canonical, (path) => path.toLowerCase());
        expect((await store.read(canonical)).revision).not.toBe(aliasRevision);
        await expect(store.copy_entry_if_absent!(source, canonical, 'copy-id'))
            .resolves.toMatchObject({ type: 'destinationExists' });
        expect(backing.value().entries[canonical].copyProvenance).toBeUndefined();
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
        const store = create_memento_file_state_store(context);

        await expect(store.compare_and_set(
            '/a',
            0,
            { activeSheetIndex: 1 },
        )).rejects.toThrow('update failed');
        expect((await store.read('/a')).state).toEqual({});
        expect(stored).toEqual({});
    });

    it('atomically canonicalizes aliases without overwriting canonical state', async () => {
        const store = create_memento_file_state_store(context_with({}).context);
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
        const store = create_memento_file_state_store(backing.context);
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

    it('rejects divergent alias authority without overwriting either complete entry', async () => {
        const alias = 'C:\\Data\\Divergent.xlsx';
        const canonical = 'c:\\data\\divergent.xlsx';
        const backing = context_with({
            format: 'tableViewer.fileState.v1',
            nextRevision: 30,
            absenceRevision: 0,
            entries: {
                [alias]: {
                    revision: 20,
                    state: { activeSheetIndex: 6 },
                    authority: {
                        commitSequence: 6,
                        authorityRevision: 1,
                        physicalRevision: 1,
                        projectionRevision: 0,
                        physicalDigest: 'A',
                    },
                },
                [canonical]: {
                    revision: 21,
                    state: { activeSheetIndex: 5 },
                    authority: {
                        commitSequence: 5,
                        authorityRevision: 5,
                        physicalRevision: 5,
                        projectionRevision: 0,
                        physicalDigest: 'B',
                    },
                },
            },
        });
        const store = create_memento_file_state_store(backing.context);

        await expect(store.canonicalize_path!(canonical, (key) => key.toLowerCase()))
            .rejects.toThrow('Cannot canonicalize divergent durable file authority.');

        expect((await store.read(alias)).state).toEqual({ activeSheetIndex: 6 });
        expect(await store.read_authority(alias)).toMatchObject({
            commitSequence: 6,
            physicalRevision: 1,
            physicalDigest: 'A',
        });
        expect((await store.read(canonical)).state).toEqual({ activeSheetIndex: 5 });
        expect(await store.read_authority(canonical)).toMatchObject({
            commitSequence: 5,
            physicalRevision: 5,
            physicalDigest: 'B',
        });
    });

    it('copies a complete legacy entry into a provider key without deleting the source', async () => {
        const legacy = '/same/provider.xlsx';
        const provider = 'tableViewer.resource.v1:["memfs","workspace","/provider.xlsx",""]';
        const backing = context_with({
            format: 'tableViewer.fileState.v1',
            nextRevision: 8,
            absenceRevision: 0,
            entries: {
                [legacy]: {
                    revision: 4,
                    state: { activeSheetIndex: 3 },
                    authority: {
                        commitSequence: 2,
                        authorityRevision: 1,
                        physicalRevision: 1,
                        projectionRevision: 0,
                        physicalDigest: 'legacy-digest',
                    },
                    stages: {
                        recovery: {
                            id: 'recovery', kind: 'physical', ordinal: 3,
                            expectedStateRevision: 4, expectedCommitSequence: 2,
                            physicalDigest: 'next-digest', createdAt: Date.now(),
                        },
                    },
                },
            },
        });
        const store = create_memento_file_state_store(backing.context);
        await expect(store.copy_entry_if_absent!(legacy, provider, 'provider-copy'))
            .resolves.toMatchObject({
                type: 'copied',
                source: { revision: 4 },
                destination: { revision: 8 },
            });
        await expect(store.copy_entry_if_absent!(legacy, provider, 'provider-copy'))
            .resolves.toMatchObject({
                type: 'copied',
                source: { revision: 4 },
                destination: { revision: 8 },
            });
        await expect(store.copy_entry_if_absent!(legacy, provider, 'unrelated-copy'))
            .resolves.toMatchObject({
                type: 'destinationExists',
                destination: { revision: 8 },
            });

        expect(backing.value().entries[provider]).toMatchObject({
            revision: 8,
            state: { activeSheetIndex: 3 },
            authority: backing.value().entries[legacy].authority,
            stages: {
                recovery: { expectedStateRevision: 8 },
            },
            copyProvenance: {
                id: 'provider-copy',
                sourcePath: legacy,
                sourceRevision: 4,
            },
        });
        expect(await store.read_authority(provider)).toMatchObject({
            commitSequence: 2,
            physicalDigest: 'legacy-digest',
        });
        expect((await store.inspect_authority_transaction(provider, 'recovery')).stagePresent)
            .toBe(true);
        await expect(store.finalize_authority_transaction(provider, 'recovery'))
            .resolves.toMatchObject({
                type: 'finalized',
                authority: {
                    commitSequence: 3,
                    physicalRevision: 2,
                    physicalDigest: 'next-digest',
                },
            });

        const atomic_provider = `${provider}:atomic`;
        const lease = await store.lease_entry!(
            atomic_provider,
            (key) => key,
            legacy,
            'lease-copy',
        );
        expect(backing.value().entries[atomic_provider]).toMatchObject({
            revision: 9,
            state: { activeSheetIndex: 3 },
            authority: backing.value().entries[legacy].authority,
            stages: {
                recovery: { expectedStateRevision: 9 },
            },
            copyProvenance: {
                id: 'lease-copy',
                sourcePath: legacy,
                sourceRevision: 4,
            },
        });
        expect(backing.value().entries[legacy]).toBeDefined();
        await lease.release();
    });

    it('allocates a destination revision that fences pre-copy absence CAS', async () => {
        const source = '/legacy-revision-zero.xlsx';
        const destination = '/provider-revision-fence.xlsx';
        const backing = context_with({
            format: 'tableViewer.fileState.v1',
            nextRevision: 1,
            absenceRevision: 0,
            entries: {
                [source]: {
                    revision: 0,
                    state: { activeSheetIndex: 4 },
                },
            },
        });
        const store = create_memento_file_state_store(backing.context);
        const stale_destination = await store.read(destination);
        expect(stale_destination.revision).toBe(0);

        await expect(store.copy_entry_if_absent!(source, destination, 'revision-fence-copy'))
            .resolves.toMatchObject({
                type: 'copied',
                source: { revision: 0 },
                destination: { revision: 1 },
            });
        await expect(store.compare_and_set(
            destination,
            stale_destination.revision,
            { activeSheetIndex: 9 },
        )).resolves.toMatchObject({
            type: 'conflict',
            snapshot: {
                revision: 1,
                state: { activeSheetIndex: 4 },
            },
        });
    });

    it('does not materialize a destination when an atomic copy source is absent', async () => {
        const backing = context_with({});
        const store = create_memento_file_state_store(backing.context);

        await expect(store.copy_entry_if_absent!(
            '/absent-source.xlsx',
            '/absent-destination.xlsx',
            'absent-copy',
        )).resolves.toMatchObject({
            type: 'sourceAbsent',
            source: { state: {}, revision: 0 },
            destination: { state: {}, revision: 0 },
        });

        expect(backing.value().entries?.['/absent-destination.xlsx']).toBeUndefined();
        await store.compare_and_set('/absent-source.xlsx', 0, { activeSheetIndex: 3 });
        await expect(store.copy_entry_if_absent!(
            '/absent-source.xlsx',
            '/absent-destination.xlsx',
            'later-copy',
        )).resolves.toMatchObject({ type: 'copied' });
        expect((await store.read('/absent-destination.xlsx')).state)
            .toEqual({ activeSheetIndex: 3 });
    });

    it('discovers a lone legacy alias during canonicalization', async () => {
        const store = create_memento_file_state_store(context_with({}).context);
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
        const store = create_memento_file_state_store(backing.context);
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
        const reconstructed = create_memento_file_state_store(backing.context);
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
        const reopened = create_memento_file_state_store(backing.context);
        expect(await reopened.read_authority!('/book')).toEqual(finalized.authority);
    });

    it('keeps fresh invisible stages and cleans them without semantic revision changes', async () => {
        const backing = context_with({});
        const store = create_memento_file_state_store(backing.context);
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
        expect(Object.keys(backing.value().entries['/book'].stages)).toHaveLength(10);
        expect(await store.read('/book')).toEqual({ state: {}, revision: 0 });
        await store.cleanup_authority_transactions!(
            '/book',
            Date.now() + 2 * 24 * 60 * 60 * 1000,
        );
        expect(backing.value().entries['/book'].stages).toBeUndefined();
        expect(await store.read('/book')).toEqual({ state: {}, revision: 0 });
    });

    it('does not bump physical or state revision for a same-digest state-less commit', async () => {
        const store = create_memento_file_state_store(context_with({}).context);
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

    it('orders complete authority vectors without rejecting sequence-only advances', () => {
        const basis = {
            commitSequence: 4,
            authorityRevision: 3,
            physicalRevision: 2,
            projectionRevision: 1,
            physicalDigest: 'same',
        };
        expect(compare_authority({ ...basis, commitSequence: 5 }, basis)).toBe('dominates');
        expect(compare_authority(basis, { ...basis, commitSequence: 5 })).toBe('dominated');
        expect(compare_authority({
            ...basis,
            commitSequence: 5,
            physicalRevision: 1,
        }, basis)).toBe('divergent');
        expect(compare_authority({ ...basis, physicalDigest: 'other' }, basis)).toBe('divergent');
        expect(compare_authority(basis, structuredClone(basis))).toBe('equal');
    });

    it('keeps live leased entries through LRU churn and evicts them after release', async () => {
        const backing = context_with({});
        const store = create_memento_file_state_store(backing.context, () => 1);
        const lease = await store.lease_entry!('/live', (key) => key);
        await store.compare_and_set('/live', 0, { activeSheetIndex: 1 });
        await store.compare_and_set('/old', 0, { activeSheetIndex: 2 });
        const newest = await store.read('/new');
        await store.compare_and_set('/new', newest.revision, { activeSheetIndex: 3 });

        expect(Object.keys(backing.value().entries)).toEqual(['/live', '/new']);
        expect((await store.read('/live')).state).toEqual({ activeSheetIndex: 1 });
        await lease.release();
        expect(Object.keys(backing.value().entries)).toEqual(['/new']);
    });

    it('keeps a fresh recovery stage non-evictable through LRU churn', async () => {
        const backing = context_with({});
        const store = create_memento_file_state_store(backing.context, () => 1);
        await store.stage_authority_transaction('/recovery', {
            id: 'recovery-stage',
            kind: 'physical',
            ordinal: 1,
            expectedStateRevision: 0,
            expectedCommitSequence: 0,
            physicalDigest: 'recovered',
        });
        await store.compare_and_set('/old', 0, { activeSheetIndex: 1 });
        const newest = await store.read('/new');
        await store.compare_and_set('/new', newest.revision, { activeSheetIndex: 2 });

        expect(Object.keys(backing.value().entries)).toEqual(['/recovery', '/new']);
        const inspection = await store.inspect_authority_transaction('/recovery', 'recovery-stage');
        expect(inspection.stagePresent).toBe(true);
        expect((await store.finalize_authority_transaction('/recovery', 'recovery-stage')).type)
            .toBe('finalized');
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
        const store = create_memento_file_state_store(context);
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
        const store = create_memento_file_state_store(backing.context, () => 2);

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
        const store = create_memento_file_state_store(backing.context);

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
            updatedAt: expect.any(Number),
            entries: {
                '/a': {
                    revision: 0,
                    state: { activeSheetIndex: 3 },
                    touchedAt: expect.any(Number),
                },
            },
        });
    });

    it('rejects a stale absent revision after create and eviction', async () => {
        const backing = context_with({});
        const store = create_memento_file_state_store(backing.context, () => 1);
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
        const store = create_memento_file_state_store(backing.context, () => 1);
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
        const store = create_memento_file_state_store(backing.context, () => 3);
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
            'updatedAt',
        ]);
        expect(JSON.stringify(envelope)).not.toContain('/file-0"');
        expect(envelope.absenceRevision).toBeGreaterThan(0);
    });

    it('shares serialization across stores backed by the same memento', async () => {
        const backing = context_with({});
        const first = create_memento_file_state_store(backing.context);
        const second = create_memento_file_state_store(backing.context);
        const [left, right] = await Promise.all([
            first.compare_and_set('/a', 0, { activeSheetIndex: 1 }),
            second.compare_and_set('/a', 0, { activeSheetIndex: 2 }),
        ]);

        expect([left.type, right.type].sort()).toEqual(['committed', 'conflict']);
    });

    it('exposes no callback-based asynchronous reducer API', () => {
        const store = create_memento_file_state_store(context_with({}).context);
        expect(Object.keys(store).sort()).toEqual([
            'canonicalize_path',
            'cleanup_authority_transactions',
            'compare_and_set',
            'copy_entry_if_absent',
            'discard_authority_transaction',
            'finalize_authority_transaction',
            'inspect_authority_transaction',
            'lease_entry',
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
        const store = create_memento_file_state_store(context);

        await expect(store.compare_and_set('/a', 0, { activeSheetIndex: 1 }))
            .rejects.toThrow('write failed');
        const second = await store.compare_and_set('/a', 0, { activeSheetIndex: 2 });
        const read = await store.read('/a');

        expect(second.type).toBe('committed');
        expect(read).toEqual({ state: { activeSheetIndex: 2 }, revision: 1 });
    });
});
