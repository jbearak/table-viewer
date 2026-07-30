import { describe, expect, it, vi } from 'vitest';
import type { AuthorityFileStateStore } from '../state';

export interface FileStateStoreContractFixture {
    create(maxStoredFiles?: number): AuthorityFileStateStore;
    createIndependent(maxStoredFiles?: number): AuthorityFileStateStore;
    seedEnvelope(envelope: unknown): Promise<void> | void;
    persistedValue(): any;
    failNextWrite(): Promise<() => Promise<void>>;
}

export interface FileStateStoreContractCapabilities {
    /** Later coordinated backends override this when durable ownership is implemented. */
    readonly editOwner?: boolean;
    /** Later remote backends override this when recovery records are implemented. */
    readonly recoveryRecord?: boolean;
    /** Backends that allocate a fresh revision when canonicalizing an absent target. */
    readonly allocateRevisionWhenCanonicalTargetAbsent?: boolean;
}

/** Reusable public semantic contract for keyed persistence backends. */
export function file_state_store_contract(
    name: string,
    fixture: () => FileStateStoreContractFixture,
    capabilities: FileStateStoreContractCapabilities = {},
): void {
    describe(`${name} keyed file-state semantic contract`, () => {
        it('exposes the required authority store surface and permits capabilities', () => {
            const store = fixture().create();
            for (const method of [
                'read',
                'compare_and_set',
                'touch',
                'read_authority',
                'stage_authority_transaction',
                'finalize_authority_transaction',
                'inspect_authority_transaction',
                'discard_authority_transaction',
                'cleanup_authority_transactions',
            ] as const) {
                expect(store[method]).toEqual(expect.any(Function));
            }
        });

        it('shares one runtime queue and allocates one winning revision', async () => {
            const backend = fixture();
            const first = backend.create();
            const second = backend.createIndependent();

            const [left, right] = await Promise.all([
                first.compare_and_set('/shared', 0, { activeSheetIndex: 1 }),
                second.compare_and_set('/shared', 0, { activeSheetIndex: 2 }),
            ]);

            expect([left.type, right.type].sort()).toEqual(['committed', 'conflict']);
            expect((await first.read('/shared')).revision).toBe(1);
        });

        it('captures proposals before queue admission and preserves unknown leaves', async () => {
            const backend = fixture();
            const store = backend.create();
            const proposed = {
                activeSheetIndex: 1,
                cellHighlights: {
                    sourceDigest: 'digest',
                    sheets: [{ schema: 'sheet', cells: { '0:0': 'yellow' } }],
                },
                futureCompatibleLeaf: { nested: ['kept'] },
            } as any;
            const write = store.compare_and_set('/proposal', 0, proposed);
            proposed.activeSheetIndex = 9;
            proposed.futureCompatibleLeaf.nested[0] = 'changed';

            await expect(write).resolves.toMatchObject({
                type: 'committed',
                snapshot: {
                    state: {
                        activeSheetIndex: 1,
                        cellHighlights: {
                    sourceDigest: 'digest',
                    sheets: [{ schema: 'sheet', cells: { '0:0': 'yellow' } }],
                },
                        futureCompatibleLeaf: { nested: ['kept'] },
                    },
                },
            });
            await expect(store.copy_entry_if_absent!(
                '/proposal',
                '/proposal-copy',
                'unknown-leaf-copy',
            )).resolves.toMatchObject({ type: 'copied' });
            expect((await store.read('/proposal-copy')).state).toMatchObject({
                cellHighlights: {
                    sourceDigest: 'digest',
                    sheets: [{ schema: 'sheet', cells: { '0:0': 'yellow' } }],
                },
                futureCompatibleLeaf: { nested: ['kept'] },
            });
        });

        it('validates exactly once before stale and unsupported durable guards', async () => {
            const backend = fixture();
            const store = backend.create();
            await store.compare_and_set('/guarded', 0, { activeSheetIndex: 1 });
            const validate = vi.fn(() => true);

            const stale = await store.compare_and_set(
                '/guarded',
                0,
                { activeSheetIndex: 2 },
                validate,
                { expectedAuthorityRevision: 0 },
            );
            expect(stale.type).toBe('conflict');
            expect(validate).toHaveBeenCalledOnce();

            if (!capabilities.editOwner) {
                const unsupported = vi.fn(() => true);
                await expect(store.compare_and_set(
                    '/guarded',
                    1,
                    { activeSheetIndex: 3 },
                    unsupported,
                    {
                        expectedAuthorityRevision: 0,
                        editOwner: { editSessionId: 'unsupported', ownershipGeneration: 1 },
                    },
                )).resolves.toMatchObject({ type: 'conflict' });
                expect(unsupported).toHaveBeenCalledOnce();
            }
            if (!capabilities.recoveryRecord) {
                for (const recoveryRecordId of ['unsupported', '']) {
                    await expect(store.compare_and_set(
                        '/guarded',
                        1,
                        { activeSheetIndex: 4 },
                        () => true,
                        { expectedAuthorityRevision: 0, recoveryRecordId },
                    )).resolves.toMatchObject({ type: 'conflict' });
                }
            }
        });

        it('rejects malformed known leaves before queue admission', async () => {
            const backend = fixture();
            const store = backend.create();
            expect(() => store.compare_and_set(
                '/malformed',
                0,
                { activeSheetIndex: -1 } as any,
            )).toThrow('activeSheetIndex');
            expect(await store.read('/malformed')).toEqual({ state: {}, revision: 0 });
        });

        it('reads valid legacy record-shaped layout leaves without rewriting them', async () => {
            const backend = fixture();
            const legacy = {
                '/legacy': {
                    columnWidths: { Sheet1: { 0: 120 } },
                    rowHeights: { Sheet1: { 1: 24 } },
                    scrollPosition: { Sheet1: { top: 2, left: 3 } },
                    activeSheet: 'Sheet1',
                    futureCompatibleLeaf: { nested: ['preserve exactly'] },
                },
            };
            await backend.seedEnvelope(legacy);
            const before = structuredClone(backend.persistedValue());
            const store = backend.create();
            await expect(store.read('/legacy')).resolves.toEqual({
                revision: 0,
                state: legacy['/legacy'],
            });
            expect(backend.persistedValue()).toEqual(before);
        });

        it('defaults only absent legacy authority and rejects malformed present authority without rewrite', async () => {
            const entry = {
                revision: 1,
                state: { activeSheetIndex: 1 },
            };
            const legacyBackend = fixture();
            await legacyBackend.seedEnvelope({
                format: 'tableViewer.fileState.v1',
                nextRevision: 2,
                absenceRevision: 0,
                entries: { '/legacy': entry },
            });
            const legacyStore = legacyBackend.create();
            await expect(legacyStore.read_authority('/legacy')).resolves.toEqual({
                commitSequence: 0,
                authorityRevision: 0,
                physicalRevision: 0,
                projectionRevision: 0,
            });

            for (const authority of [
                null,
                1,
                [],
                { commitSequence: 0 },
                {
                    commitSequence: 0,
                    authorityRevision: 0,
                    physicalRevision: 0,
                    projectionRevision: 0,
                    physicalDigest: 1,
                },
            ]) {
                const backend = fixture();
                await backend.seedEnvelope({
                    format: 'tableViewer.fileState.v1',
                    nextRevision: 2,
                    absenceRevision: 0,
                    entries: { '/malformed': { ...entry, authority } },
                });
                const before = structuredClone(backend.persistedValue());
                const store = backend.create();
                await expect(store.read('/malformed')).rejects.toThrow();
                await expect(store.compare_and_set(
                    '/malformed',
                    1,
                    { activeSheetIndex: 2 },
                )).rejects.toThrow();
                expect(backend.persistedValue()).toEqual(before);
            }
        });

        it('rejects malformed nested known leaves', async () => {
            const backend = fixture();
            const store = backend.create();
            for (const state of [
                { columnWidths: [42] },
                { scrollPosition: [{ top: 'bad', left: 0 }] },
                { transforms: [{ sort: [{}], filters: [] }] },
                { columnVisibility: [{ hiddenColumns: ['bad'] }] },
                { cellHighlights: {} },
                { pendingEdits: { '-1:0': 'bad' } },
                { pendingEdits: { '01:0': 'bad' } },
                { pendingEdits: { '9007199254740992:0': 'bad' } },
                {
                    cellHighlights: {
                        sourceDigest: 'digest',
                        sheets: [{ schema: 'sheet', cells: { '0:01': 'yellow' } }],
                    },
                },
                {
                    cellHighlights: {
                        sourceDigest: 'digest',
                        sheets: [{ schema: 'sheet', cells: { '0:9007199254740992': 'yellow' } }],
                    },
                },
            ]) {
                expect(() => store.compare_and_set('/nested', 0, state as any)).toThrow();
            }
        });

        it('rejects every non-canonical or unsafe persisted cell key', async () => {
            const backend = fixture();
            const store = backend.create();
            const invalidKeys = [
                '', '0', ':', ':0', '0:', '0:0:0', '00:0', '0:00',
                '+1:0', '-1:0', '1.0:0', '0:1e2', '0: 1', ' 0:1',
                `${Number.MAX_SAFE_INTEGER + 1}:0`,
                `0:${Number.MAX_SAFE_INTEGER + 1}`,
            ];
            for (const key of invalidKeys) {
                expect(() => store.compare_and_set('/invalid-pending-key', 0, {
                    pendingEdits: { [key]: 'value' },
                } as any)).toThrow('pendingEdits');
                expect(() => store.compare_and_set('/invalid-highlight-key', 0, {
                    cellHighlights: {
                        sourceDigest: 'digest',
                        sheets: [{ schema: 'sheet', cells: { [key]: 'yellow' } }],
                    },
                } as any)).toThrow('cellHighlights');
            }
            expect(await store.read('/invalid-pending-key')).toEqual({ state: {}, revision: 0 });
            for (const [index, key] of [
                '0:0', `${Number.MAX_SAFE_INTEGER}:0`, `0:${Number.MAX_SAFE_INTEGER}`,
            ].entries()) {
                await expect(store.compare_and_set(`/valid-cell-key-${index}`, 0, {
                    pendingEdits: { [key]: 'value' },
                    cellHighlights: {
                        sourceDigest: 'digest',
                        sheets: [{ schema: 'sheet', cells: { [key]: 'yellow' } }],
                    },
                } as any)).resolves.toMatchObject({ type: 'committed' });
            }
        });

        it('canonicalizes empty pending maps to absence and protects real pending work', async () => {
            const backend = fixture();
            const store = backend.create(1);
            await store.compare_and_set('/empty', 0, { pendingEdits: {} });
            expect((await store.read('/empty')).state).toEqual({});
            await store.compare_and_set('/pending', 0, { pendingEdits: { '0:0': 'value' } });
            await store.compare_and_set('/ordinary', 0, { activeSheetIndex: 1 });

            expect((await store.read('/empty')).state).toEqual({});
            expect((await store.read('/pending')).state).toEqual({
                pendingEdits: { '0:0': 'value' },
            });
        });

        it('fails closed rather than deleting a pending canonicalization candidate', async () => {
            const backend = fixture();
            const store = backend.create();
            const alias = 'C:\\Data\\pending.csv';
            const canonical = 'c:\\data\\pending.csv';
            await store.compare_and_set(alias, 0, { pendingEdits: { '0:0': 'recover' } });
            await store.compare_and_set(canonical, 0, { activeSheetIndex: 2 });

            await expect(store.canonicalize_path!(canonical, (path) => path.toLowerCase()))
                .rejects.toThrow(/pending/i);
            expect((await store.read(alias)).state).toEqual({
                pendingEdits: { '0:0': 'recover' },
            });
            expect((await store.read(canonical)).state).toEqual({ activeSheetIndex: 2 });
        });

        it('replays copy provenance before consulting an evicted source', async () => {
            const backend = fixture();
            const store = backend.create(1);
            await store.compare_and_set('/source', 0, { activeSheetIndex: 3 });
            const copied = await store.copy_entry_if_absent!('/source', '/destination', 'copy-id');
            expect(copied.type).toBe('copied');
            const destinationLease = await store.lease_entry!('/destination', (path) => path);
            const churnBasis = await store.read('/churn');
            await store.compare_and_set('/churn', churnBasis.revision, { activeSheetIndex: 4 });

            await expect(store.copy_entry_if_absent!(
                '/source',
                '/destination',
                'copy-id',
            )).resolves.toMatchObject({
                type: 'copied',
                destination: { state: { activeSheetIndex: 3 } },
            });
            await destinationLease.release();
        });

        if (capabilities.allocateRevisionWhenCanonicalTargetAbsent) {
            it('clears copy provenance when absent-target canonicalization allocates a revision', async () => {
                const backend = fixture();
                const store = backend.create();
                const source = '/source';
                const alias = 'C:\\Data\\copied.csv';
                const canonical = 'c:\\data\\copied.csv';
                await store.compare_and_set(source, 0, { activeSheetIndex: 3 });
                await expect(store.copy_entry_if_absent!(source, alias, 'copy-id'))
                    .resolves.toMatchObject({ type: 'copied' });
                const aliasRevision = (await store.read(alias)).revision;

                await store.canonicalize_path!(canonical, (path) => path.toLowerCase());
                expect((await store.read(canonical)).revision).not.toBe(aliasRevision);
                await expect(store.copy_entry_if_absent!(source, canonical, 'copy-id'))
                    .resolves.toMatchObject({ type: 'destinationExists' });
            });
        }

        it('moves lease identity with canonicalization and releases exactly once', async () => {
            const backend = fixture();
            const first = backend.create(1);
            const second = backend.createIndependent(1);
            const alias = 'C:\\Data\\leased.csv';
            const canonical = 'c:\\data\\leased.csv';
            await first.compare_and_set(alias, 0, { activeSheetIndex: 1 });
            const lease = await first.lease_entry!(alias, (path) => path.toLowerCase());
            await second.canonicalize_path!(canonical, (path) => path.toLowerCase());
            const newerBasis = await second.read('/newer');
            await second.compare_and_set('/newer', newerBasis.revision, { activeSheetIndex: 2 });
            expect((await first.read(canonical)).state).toEqual({ activeSheetIndex: 1 });

            await lease.release();
            await lease.release();
            expect((await first.read(canonical)).state).toEqual({});
        });

        it('preserves concurrently admitted leases when canonicalization persistence fails', async () => {
            const backend = fixture();
            const store = backend.create(1);
            const alias = 'C:\\Data\\rollback-lease.csv';
            const canonical = 'c:\\data\\rollback-lease.csv';
            await store.compare_and_set(alias, 0, { activeSheetIndex: 1 });
            const aliasLease = await store.lease_entry!(alias, (path) => path.toLowerCase());
            const restore = await backend.failNextWrite();
            const otherLeasePromise = store.lease_entry!('/other', (path) => path);
            const failedCanonicalization = store.canonicalize_path!(
                canonical,
                (path) => path.toLowerCase(),
            );
            const otherLease = await otherLeasePromise;
            await expect(failedCanonicalization).rejects.toThrow();
            await restore();

            const otherBasis = await store.read('/other');
            await store.compare_and_set('/other', otherBasis.revision, { activeSheetIndex: 2 });
            const churnBasis = await store.read('/lease-churn');
            await store.compare_and_set('/lease-churn', churnBasis.revision, { activeSheetIndex: 3 });
            expect((await store.read(alias)).state).toEqual({ activeSheetIndex: 1 });
            expect((await store.read('/other')).state).toEqual({ activeSheetIndex: 2 });
            await otherLease.release();
            await aliasLease.release();
        });

        it('restores a failed lease release and permits an exact retry', async () => {
            const backend = fixture();
            const store = backend.create(1);
            await store.compare_and_set('/leased', 0, { activeSheetIndex: 1 });
            const lease = await store.lease_entry!('/leased', (path) => path);
            const pendingBasis = await store.read('/pending');
            await store.compare_and_set('/pending', pendingBasis.revision, {
                pendingEdits: { '0:0': 'protected' },
            });
            const newerBasis = await store.read('/newer');
            await store.compare_and_set('/newer', newerBasis.revision, { activeSheetIndex: 2 });

            const restore = await backend.failNextWrite();
            await expect(lease.release()).rejects.toThrow();
            await restore();
            expect((await store.read('/leased')).state).toEqual({ activeSheetIndex: 1 });

            await expect(lease.release()).resolves.toBeUndefined();
            await expect(lease.release()).resolves.toBeUndefined();
            expect((await store.read('/leased')).state).toEqual({});
            expect((await store.read('/pending')).state).toEqual({
                pendingEdits: { '0:0': 'protected' },
            });
        });

        it('consumes no revisions for conflicts or validator failures', async () => {
            const backend = fixture();
            const store = backend.create();
            await store.compare_and_set('/counter', 0, { activeSheetIndex: 1 });
            const nextRevision = backend.persistedValue().nextRevision;

            await store.compare_and_set('/counter', 0, { activeSheetIndex: 2 });
            await store.compare_and_set('/counter', 1, { activeSheetIndex: 3 }, () => false);
            await expect(store.compare_and_set(
                '/counter',
                1,
                { activeSheetIndex: 4 },
                () => { throw new Error('validator'); },
            )).rejects.toThrow('validator');
            expect(backend.persistedValue().nextRevision).toBe(nextRevision);
        });

        it('stages invisibly, finalizes atomically, and discards only existing stages', async () => {
            const backend = fixture();
            const store = backend.create();
            await expect(store.stage_authority_transaction('/authority', {
                id: 'projection',
                kind: 'projection',
                ordinal: 1,
                expectedStateRevision: 0,
                expectedCommitSequence: 0,
                nextState: { activeSheetIndex: 2 },
            })).resolves.toEqual({ type: 'staged' });
            expect(await store.read('/authority')).toEqual({ state: {}, revision: 0 });
            expect((await store.inspect_authority_transaction('/authority', 'projection')).stagePresent)
                .toBe(true);

            const finalized = await store.finalize_authority_transaction('/authority', 'projection');
            expect(finalized).toMatchObject({
                type: 'finalized',
                snapshot: { state: { activeSheetIndex: 2 }, revision: 1 },
                authority: {
                    commitSequence: 1,
                    authorityRevision: 1,
                    physicalRevision: 0,
                    projectionRevision: 1,
                },
            });
            const beforeMissingDiscard = structuredClone(backend.persistedValue());
            await store.discard_authority_transaction('/authority', 'missing');
            expect(backend.persistedValue()).toEqual(beforeMissingDiscard);
        });

        it('cleans stale source stages before installing replayable copy provenance', async () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(1_000_000);
                const backend = fixture();
                const store = backend.create();
                await store.compare_and_set('/stale-source', 0, { activeSheetIndex: 1 });
                await store.stage_authority_transaction('/stale-source', {
                    id: 'stale',
                    kind: 'physical',
                    ordinal: 1,
                    expectedStateRevision: 1,
                    expectedCommitSequence: 0,
                });
                vi.setSystemTime(1_000_000 + 24 * 60 * 60 * 1000 + 1);
                await expect(store.copy_entry_if_absent!(
                    '/stale-source',
                    '/stale-destination',
                    'stale-copy',
                )).resolves.toMatchObject({ type: 'copied' });
                expect((await store.inspect_authority_transaction(
                    '/stale-destination',
                    'stale',
                )).stagePresent).toBe(false);
                await expect(store.copy_entry_if_absent!(
                    '/stale-source',
                    '/stale-destination',
                    'stale-copy',
                )).resolves.toMatchObject({ type: 'copied' });
            } finally {
                vi.useRealTimers();
            }
        });

        it('applies validator precedence and every authority component guard', async () => {
            const backend = fixture();
            const store = backend.create();
            await store.compare_and_set('/guards', 0, { activeSheetIndex: 1 });
            await store.stage_authority_transaction('/guards', {
                id: 'physical', kind: 'physical', ordinal: 1,
                expectedStateRevision: 1, expectedCommitSequence: 0,
                physicalDigest: 'digest',
            });
            await store.finalize_authority_transaction('/guards', 'physical');
            await store.stage_authority_transaction('/guards', {
                id: 'projection', kind: 'projection', ordinal: 2,
                expectedStateRevision: 1, expectedCommitSequence: 1,
            });
            await store.finalize_authority_transaction('/guards', 'projection');
            const authority = await store.read_authority('/guards');

            for (const basis of [
                { expectedAuthorityRevision: authority.authorityRevision - 1 },
                {
                    expectedAuthorityRevision: authority.authorityRevision,
                    expectedPhysicalRevision: authority.physicalRevision - 1,
                },
                {
                    expectedAuthorityRevision: authority.authorityRevision,
                    expectedProjectionRevision: authority.projectionRevision - 1,
                },
            ]) {
                const validate = vi.fn(() => true);
                await expect(store.compare_and_set(
                    '/guards', 1, { activeSheetIndex: 2 }, validate, basis,
                )).resolves.toMatchObject({
                    type: 'conflict',
                    snapshot: { state: { activeSheetIndex: 1 }, revision: 1 },
                    authority,
                });
                expect(validate).toHaveBeenCalledOnce();
            }

            const thrown = new Error('validator wins');
            await expect(store.compare_and_set(
                '/guards', 0, { activeSheetIndex: 3 }, () => { throw thrown; },
                { expectedAuthorityRevision: -1 },
            )).rejects.toBe(thrown);
            for (const result of [false, null, 0, 'true', Promise.resolve(true)]) {
                await expect(store.compare_and_set(
                    '/guards', 1, { activeSheetIndex: 4 }, () => result as any,
                    { expectedAuthorityRevision: authority.authorityRevision },
                )).resolves.toMatchObject({ type: 'conflict' });
            }
            expect(await store.read('/guards')).toEqual({
                state: { activeSheetIndex: 1 }, revision: 1,
            });
        });

        it('fences global absence across copy, eviction, and recreation', async () => {
            const backend = fixture();
            const store = backend.create(1);
            const oldDestinationBasis = await store.read('/destination');
            await store.compare_and_set('/source', oldDestinationBasis.revision, { activeSheetIndex: 1 });
            const copied = await store.copy_entry_if_absent!('/source', '/destination', 'absence-copy');
            expect(copied).toMatchObject({ type: 'copied' });
            await expect(store.compare_and_set(
                '/destination', oldDestinationBasis.revision, { activeSheetIndex: 9 },
            )).resolves.toMatchObject({ type: 'conflict' });

            const oldMissingBasis = await store.read('/missing');
            await store.compare_and_set('/newer', oldMissingBasis.revision, { activeSheetIndex: 2 });
            await expect(store.compare_and_set(
                '/missing', oldMissingBasis.revision, { activeSheetIndex: 3 },
            )).resolves.toMatchObject({ type: 'conflict' });
            const freshMissingBasis = await store.read('/missing');
            await expect(store.compare_and_set(
                '/missing', freshMissingBasis.revision, { activeSheetIndex: 4 },
            )).resolves.toMatchObject({ type: 'committed' });
        });

        it('does not materialize an absent copy source and later permits the copy', async () => {
            const backend = fixture();
            const store = backend.create();
            await expect(store.copy_entry_if_absent!(
                '/missing-source', '/not-materialized', 'missing-copy',
            )).resolves.toMatchObject({ type: 'sourceAbsent' });
            expect(await store.read('/not-materialized')).toEqual({ state: {}, revision: 0 });
            await store.compare_and_set('/missing-source', 0, { activeSheetIndex: 1 });
            await expect(store.copy_entry_if_absent!(
                '/missing-source', '/not-materialized', 'missing-copy',
            )).resolves.toMatchObject({ type: 'copied' });
        });

        it('canonicalizes a lone alias but rejects complete authority divergence atomically', async () => {
            const backend = fixture();
            const store = backend.create();
            const alias = 'C:\\Data\\lone.xlsx';
            const canonical = 'c:\\data\\lone.xlsx';
            await store.compare_and_set(alias, 0, { activeSheetIndex: 1 });
            await store.canonicalize_path!(canonical, (path) => path.toLowerCase());
            expect((await store.read(canonical)).state).toEqual({ activeSheetIndex: 1 });
            expect((await store.read(alias)).state).toEqual({});

            const divergentBackend = fixture();
            const divergent = {
                format: 'tableViewer.fileState.v1',
                nextRevision: 4,
                absenceRevision: 0,
                entries: {
                    'C:\\Data\\divergent.xlsx': {
                        revision: 1,
                        state: { activeSheetIndex: 2 },
                        authority: {
                            commitSequence: 2, authorityRevision: 1,
                            physicalRevision: 1, projectionRevision: 0,
                            physicalDigest: 'alias',
                        },
                    },
                    'c:\\data\\divergent.xlsx': {
                        revision: 2,
                        state: { activeSheetIndex: 3 },
                        authority: {
                            commitSequence: 2, authorityRevision: 2,
                            physicalRevision: 2, projectionRevision: 0,
                            physicalDigest: 'canonical',
                        },
                    },
                },
            };
            await divergentBackend.seedEnvelope(divergent);
            const before = structuredClone(divergentBackend.persistedValue());
            const reconstructed = divergentBackend.createIndependent();
            await expect(reconstructed.canonicalize_path!(
                'c:\\data\\divergent.xlsx',
                (path) => path.toLowerCase(),
            )).rejects.toThrow(/divergent durable file authority/i);
            expect(divergentBackend.persistedValue()).toEqual(before);
        });

        it('keeps one complete canonical winner when an alias coexists', async () => {
            const backend = fixture();
            await backend.seedEnvelope({
                format: 'tableViewer.fileState.v1',
                nextRevision: 3,
                absenceRevision: 0,
                entries: {
                    'C:\\Data\\winner.xlsx': {
                        revision: 1,
                        state: { activeSheetIndex: 1 },
                        authority: {
                            commitSequence: 0, authorityRevision: 0,
                            physicalRevision: 0, projectionRevision: 0,
                        },
                    },
                    'c:\\data\\winner.xlsx': {
                        revision: 2,
                        state: { activeSheetIndex: 2 },
                        authority: {
                            commitSequence: 1, authorityRevision: 1,
                            physicalRevision: 0, projectionRevision: 1,
                        },
                    },
                },
            });
            const store = backend.create();
            await store.canonicalize_path!(
                'c:\\data\\winner.xlsx', (path) => path.toLowerCase(),
            );
            expect(await store.read('c:\\data\\winner.xlsx')).toEqual({
                state: { activeSheetIndex: 2 }, revision: 2,
            });
            expect(await store.read_authority('c:\\data\\winner.xlsx')).toMatchObject({
                commitSequence: 1, authorityRevision: 1, projectionRevision: 1,
            });
            expect((await store.read('C:\\Data\\winner.xlsx')).state).toEqual({});
        });

        it('copies complete state, authority, stages, and replay provenance', async () => {
            const backend = fixture();
            const store = backend.create();
            await store.compare_and_set('/complete-source', 0, {
                activeSheetIndex: 3,
                pendingEdits: { '0:0': 'pending' },
            });
            await store.stage_authority_transaction('/complete-source', {
                id: 'physical', kind: 'physical', ordinal: 1,
                expectedStateRevision: 1, expectedCommitSequence: 0,
                physicalDigest: 'digest',
            });
            await store.finalize_authority_transaction('/complete-source', 'physical');
            await store.stage_authority_transaction('/complete-source', {
                id: 'fresh-stage', kind: 'projection', ordinal: 2,
                expectedStateRevision: 1, expectedCommitSequence: 1,
            });

            const copied = await store.copy_entry_if_absent!(
                '/complete-source', '/complete-destination', 'complete-copy',
            );
            expect(copied).toMatchObject({
                type: 'copied',
                source: { state: { activeSheetIndex: 3 }, revision: 1 },
                destination: { state: { activeSheetIndex: 3 }, revision: 2 },
            });
            expect(await store.read_authority('/complete-destination'))
                .toEqual(await store.read_authority('/complete-source'));
            expect((await store.inspect_authority_transaction(
                '/complete-destination', 'fresh-stage',
            )).stagePresent).toBe(true);
            await expect(store.copy_entry_if_absent!(
                '/complete-source', '/complete-destination', 'complete-copy',
            )).resolves.toMatchObject({ type: 'copied' });
            await expect(store.copy_entry_if_absent!(
                '/complete-source', '/complete-destination', 'different-copy',
            )).resolves.toMatchObject({ type: 'destinationExists' });
            expect((await store.read('/complete-source')).state).toMatchObject({
                pendingEdits: { '0:0': 'pending' },
            });
        });

        it('does not treat empty recovery identifiers as absent', async () => {
            if (capabilities.recoveryRecord) return;
            const backend = fixture();
            const store = backend.create();
            await store.compare_and_set('/pending-source', 0, {
                pendingEdits: { '0:0': 'pending' },
            });

            await expect(store.copy_entry_if_absent!(
                '/pending-source',
                '/pending-destination',
                'empty-recovery-id',
                {
                    destinationRecoveryEntryId: '',
                    destinationRecoveryRecordId: '',
                },
            )).resolves.toMatchObject({ type: 'recoveryRequired' });
            await expect(store.read('/pending-destination')).resolves.toEqual({
                state: {}, revision: 0,
            });
        });

        it('preserves revisions for a same-digest state-less physical finalize', async () => {
            const backend = fixture();
            const store = backend.create();
            await store.stage_authority_transaction('/same-digest', {
                id: 'first', kind: 'physical', ordinal: 1,
                expectedStateRevision: 0, expectedCommitSequence: 0,
                physicalDigest: 'digest',
            });
            const first = await store.finalize_authority_transaction('/same-digest', 'first');
            if (first.type !== 'finalized') throw new Error('first finalize failed');
            await store.stage_authority_transaction('/same-digest', {
                id: 'second', kind: 'physical', ordinal: 2,
                expectedStateRevision: first.snapshot.revision,
                expectedCommitSequence: first.authority.commitSequence,
                physicalDigest: 'digest',
            });
            const second = await store.finalize_authority_transaction('/same-digest', 'second');
            expect(second).toMatchObject({
                type: 'finalized',
                snapshot: { revision: first.snapshot.revision },
                authority: {
                    commitSequence: first.authority.commitSequence + 1,
                    authorityRevision: first.authority.authorityRevision,
                    physicalRevision: first.authority.physicalRevision,
                },
            });
        });

        it('touches recency without changing semantic revision or entry updatedAt', async () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(1_000_000);
                const backend = fixture();
                const store = backend.create(2);
                await store.compare_and_set('/touched', 0, { activeSheetIndex: 1 });
                const otherBasis = await store.read('/other');
                await store.compare_and_set('/other', otherBasis.revision, { activeSheetIndex: 0 });
                const before = structuredClone(backend.persistedValue().entries['/touched']);
                vi.setSystemTime(2_000_000);
                await store.touch('/touched');
                const touched = backend.persistedValue().entries['/touched'];
                expect(touched.revision).toBe(before.revision);
                expect(touched.updatedAt).toBe(before.updatedAt);
                expect(touched.touchedAt).toBe(2_000_000);
                const newerBasis = await store.read('/newer');
                await store.compare_and_set('/newer', newerBasis.revision, { activeSheetIndex: 2 });
                expect((await store.read('/touched')).state).toEqual({ activeSheetIndex: 1 });
                expect((await store.read('/other')).state).toEqual({});
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps a fresh recovery stage non-evictable through retention churn', async () => {
            const backend = fixture();
            const store = backend.create(1);
            await store.stage_authority_transaction('/recoverable-stage', {
                id: 'fresh', kind: 'projection', ordinal: 1,
                expectedStateRevision: 0, expectedCommitSequence: 0,
                nextState: { activeSheetIndex: 1 },
            });
            for (let index = 0; index < 4; index += 1) {
                const basis = await store.read(`/ordinary-${index}`);
                await store.compare_and_set(
                    `/ordinary-${index}`, basis.revision, { activeSheetIndex: index },
                );
            }
            expect((await store.inspect_authority_transaction(
                '/recoverable-stage', 'fresh',
            )).stagePresent).toBe(true);
            await store.discard_authority_transaction('/recoverable-stage', 'fresh');
            const churnBasis = await store.read('/post-discard');
            await store.compare_and_set('/post-discard', churnBasis.revision, { activeSheetIndex: 9 });
            expect((await store.read('/recoverable-stage')).state).toEqual({});
        });

        it('retains stages through the exact freshness boundary and cleans them after it', async () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(1_000_000);
                const backend = fixture();
                const store = backend.create(1);
                await store.stage_authority_transaction('/boundary-stage', {
                    id: 'boundary', kind: 'projection', ordinal: 1,
                    expectedStateRevision: 0, expectedCommitSequence: 0,
                });
                await store.compare_and_set('/ordinary', 0, { activeSheetIndex: 1 });
                await store.cleanup_authority_transactions(
                    '/boundary-stage', 1_000_000 + 24 * 60 * 60 * 1000,
                );
                expect((await store.inspect_authority_transaction(
                    '/boundary-stage', 'boundary',
                )).stagePresent).toBe(true);
                await store.cleanup_authority_transactions(
                    '/boundary-stage', 1_000_000 + 24 * 60 * 60 * 1000 + 1,
                );
                expect((await store.inspect_authority_transaction(
                    '/boundary-stage', 'boundary',
                )).stagePresent).toBe(false);
            } finally {
                vi.useRealTimers();
            }
        });

        it('stamps stage, finalize, discard, and cleanup but not durable no-ops', async () => {
            vi.useFakeTimers();
            try {
                const backend = fixture();
                const store = backend.create();
                vi.setSystemTime(1_000_000);
                await store.stage_authority_transaction('/timestamp-authority', {
                    id: 'finalize', kind: 'projection', ordinal: 1,
                    expectedStateRevision: 0, expectedCommitSequence: 0,
                });
                expect(backend.persistedValue().updatedAt).toBe(1_000_000);
                vi.setSystemTime(2_000_000);
                await store.finalize_authority_transaction('/timestamp-authority', 'finalize');
                expect(backend.persistedValue().updatedAt).toBe(2_000_000);
                const beforeNoops = structuredClone(backend.persistedValue());
                await store.discard_authority_transaction('/timestamp-authority', 'missing');
                await store.compare_and_set('/timestamp-authority', -1, { activeSheetIndex: 9 });
                expect(backend.persistedValue()).toEqual(beforeNoops);

                vi.setSystemTime(3_000_000);
                await store.stage_authority_transaction('/timestamp-authority', {
                    id: 'discard', kind: 'projection', ordinal: 2,
                    expectedStateRevision: 0, expectedCommitSequence: 1,
                });
                vi.setSystemTime(4_000_000);
                await store.discard_authority_transaction('/timestamp-authority', 'discard');
                expect(backend.persistedValue().updatedAt).toBe(4_000_000);

                vi.setSystemTime(5_000_000);
                await store.stage_authority_transaction('/timestamp-authority', {
                    id: 'stale', kind: 'projection', ordinal: 3,
                    expectedStateRevision: 0, expectedCommitSequence: 1,
                });
                await store.cleanup_authority_transactions(
                    '/timestamp-authority', 5_000_000 + 24 * 60 * 60 * 1000 + 1,
                );
                expect(backend.persistedValue().updatedAt)
                    .toBe(5_000_000 + 24 * 60 * 60 * 1000 + 1);
            } finally {
                vi.useRealTimers();
            }
        });

        it('adds timestamps only on mutation and preserves touchedAt across CAS', async () => {
            vi.useFakeTimers();
            try {
                const backend = fixture();
                await backend.seedEnvelope({ '/legacy-time': { activeSheetIndex: 1 } });
                const store = backend.create();
                const beforeRead = structuredClone(backend.persistedValue());
                await store.read('/legacy-time');
                expect(backend.persistedValue()).toEqual(beforeRead);
                vi.setSystemTime(1_000_000);
                await store.touch('/legacy-time');
                vi.setSystemTime(2_000_000);
                await store.compare_and_set('/legacy-time', 0, { activeSheetIndex: 2 });
                const envelope = backend.persistedValue();
                expect(envelope.updatedAt).toBe(2_000_000);
                expect(envelope.entries['/legacy-time']).toMatchObject({
                    revision: 1,
                    updatedAt: 2_000_000,
                    touchedAt: 1_000_000,
                });
            } finally {
                vi.useRealTimers();
            }
        });

        it('uses non-regressing store timestamps and copy-time destination timestamps', async () => {
            vi.useFakeTimers();
            try {
                const backend = fixture();
                const store = backend.create();
                vi.setSystemTime(5_000_000);
                await store.compare_and_set('/time-source', 0, { activeSheetIndex: 1 });
                await store.touch('/time-source');
                vi.setSystemTime(4_000_000);
                await store.compare_and_set('/time-source', 1, { activeSheetIndex: 2 });
                await store.copy_entry_if_absent!('/time-source', '/time-copy', 'time-copy');
                const envelope = backend.persistedValue();
                expect(envelope.updatedAt).toBe(5_000_000);
                expect(envelope.entries['/time-source'].updatedAt).toBe(5_000_000);
                expect(envelope.entries['/time-source'].touchedAt).toBe(5_000_000);
                expect(envelope.entries['/time-copy'].updatedAt).toBe(4_000_000);
                expect(envelope.entries['/time-copy'].touchedAt).toBe(5_000_000);
            } finally {
                vi.useRealTimers();
            }
        });

        it('rolls back failed finalization and permits an exact retry', async () => {
            const backend = fixture();
            const store = backend.create();
            await store.stage_authority_transaction('/finalize-rollback', {
                id: 'stage', kind: 'projection', ordinal: 1,
                expectedStateRevision: 0, expectedCommitSequence: 0,
                nextState: { activeSheetIndex: 1 },
            });
            const before = structuredClone(backend.persistedValue());
            const restore = await backend.failNextWrite();
            await expect(store.finalize_authority_transaction('/finalize-rollback', 'stage'))
                .rejects.toThrow();
            await restore();
            expect(backend.persistedValue()).toEqual(before);
            expect((await store.inspect_authority_transaction(
                '/finalize-rollback', 'stage',
            )).stagePresent).toBe(true);
            await expect(store.finalize_authority_transaction('/finalize-rollback', 'stage'))
                .resolves.toMatchObject({ type: 'finalized', snapshot: { revision: 1 } });
        });

        it('rolls back failed persistence, consumes no revision, and recovers its queue', async () => {
            const backend = fixture();
            const store = backend.create();
            await store.compare_and_set('/rollback', 0, { activeSheetIndex: 1 });
            const restore = await backend.failNextWrite();
            await expect(store.compare_and_set('/rollback', 1, { activeSheetIndex: 2 }))
                .rejects.toThrow();
            await restore();

            expect(await store.read('/rollback')).toEqual({
                state: { activeSheetIndex: 1 },
                revision: 1,
            });
            await expect(store.compare_and_set('/rollback', 1, { activeSheetIndex: 3 }))
                .resolves.toMatchObject({ type: 'committed', snapshot: { revision: 2 } });
        });

        it('keeps persisted retention metadata bounded under path churn', async () => {
            const backend = fixture();
            const store = backend.create(3);
            for (let index = 0; index < 20; index += 1) {
                const path = `/churn-${index}`;
                const basis = await store.read(path);
                await store.compare_and_set(path, basis.revision, { activeSheetIndex: index });
            }
            const envelope = backend.persistedValue();
            expect(Object.keys(envelope.entries)).toHaveLength(3);
            expect(JSON.stringify(envelope)).not.toContain('churn-0');
            expect(envelope.absenceRevision).toBeGreaterThan(0);
        });

        it('fails revision allocation before the safe-integer sentinel', async () => {
            const backend = fixture();
            await backend.seedEnvelope({
                format: 'tableViewer.fileState.v1',
                nextRevision: Number.MAX_SAFE_INTEGER,
                absenceRevision: 0,
                entries: {},
            });
            const store = backend.create();
            await expect(store.compare_and_set('/exhausted', 0, { activeSheetIndex: 1 }))
                .rejects.toThrow(/exhausted/i);
            expect(backend.persistedValue()).toMatchObject({
                nextRevision: Number.MAX_SAFE_INTEGER,
                absenceRevision: 0,
                entries: {},
            });
        });
    });
}
