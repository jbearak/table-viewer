import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsvCustomDocument } from '../csv-custom-document';
import type { FileStateCompareAndSetResult } from '../state';
import type { PerFileState } from '../types';
import { attach_viewer, csv_table_profile } from '../viewer-controller';
import type { WorkbookSnapshot } from '../viewer-snapshot';
import { SQLITE_PREPARED_INSTALL_STATE_KEY } from '../sqlite-file-state-repository';
import {
    initialize_sqlite_file_state_schema,
    SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION,
    type SqliteDesktopFileStateIdentity,
} from '../sqlite-file-state-schema';
import {
    build_sqlite_process_worker,
    SqliteChildProcess,
} from './helpers/sqlite-child-process';
import {
    open_vscode_cosmetic_state_database,
    VSCODE_COSMETIC_STATE_BUSY_TIMEOUT_MS,
    VSCODE_COSMETIC_STATE_DATABASE_NAME,
    VSCODE_COSMETIC_STATE_FALLBACK_WARNING,
    VSCODE_COSMETIC_STATE_IDENTITY,
    vscode_cosmetic_state_database_path,
} from '../vscode-cosmetic-state-database';
import { fake_viewer_host } from './mocks/host-ports';
import * as vscode_mock from './mocks/vscode';

let tempDirectory: string;

beforeEach(() => {
    vscode_mock.__reset();
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-vscode-cosmetic-'));
});

afterEach(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

function openOptions(warn = vi.fn()) {
    return {
        storageDirectory: tempDirectory,
        appVersion: '0.7.0',
        warn,
    };
}

async function expect_forged_at_rest_fallback(
    mutate: (database: DatabaseSync, sourcePath: string, sourceRevision: number) => void,
): Promise<void> {
    const sourcePath = 'file:///forged-source.csv';
    const destinationPath = 'provider:memfs:/forged-destination.csv';
    const initialized = await open_vscode_cosmetic_state_database(openOptions());
    const committed = await initialized.store.compare_and_set(sourcePath, 0, {
        activeSheetIndex: 1,
    });
    expect(committed.type).toBe('committed');
    await initialized.close();

    const database = new DatabaseSync(initialized.databasePath, {
        enableDoubleQuotedStringLiterals: false,
    });
    try {
        mutate(database, sourcePath, committed.snapshot.revision);
    } finally {
        database.close();
    }
    const candidatePath = `${initialized.databasePath}.init-candidate.retained`;
    fs.writeFileSync(candidatePath, 'retained-candidate-evidence');
    const mainBefore = fs.readFileSync(initialized.databasePath);
    const candidateBefore = fs.readFileSync(candidatePath);
    const warn = vi.fn();

    const reopened = await open_vscode_cosmetic_state_database(openOptions(warn));
    try {
        expect(reopened.mode).toBe('memory');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(VSCODE_COSMETIC_STATE_FALLBACK_WARNING);
        await expect(reopened.store.copy_entry_if_absent?.(
            sourcePath,
            destinationPath,
            'forged-copy',
        )).resolves.toMatchObject({ type: 'sourceAbsent' });
        expect(await reopened.store.read(destinationPath)).toEqual({ state: {}, revision: 0 });
    } finally {
        await reopened.close();
    }

    expect(fs.readFileSync(initialized.databasePath)).toEqual(mainBefore);
    expect(fs.readFileSync(candidatePath)).toEqual(candidateBefore);
}

describe('VS Code cosmetic SQLite foundation', () => {
    it('derives one normalized database path beneath an absolute global-storage root', () => {
        expect(vscode_cosmetic_state_database_path(path.join(tempDirectory, '.', 'nested', '..')))
            .toBe(path.join(tempDirectory, VSCODE_COSMETIC_STATE_DATABASE_NAME));
        expect(() => vscode_cosmetic_state_database_path('relative/global-storage'))
            .toThrow(TypeError);
    });

    it('forwards the production timeout and owns the cosmetic durability policy', async () => {
        const observed: Array<{
            timeoutMs?: number;
            requiresPendingEditRecovery?: boolean;
            initialization?: { directoryDurabilityPolicy?: string };
        }> = [];
        const openStore = (async (_databasePath: string, sqliteOptions: typeof observed[number]) => {
            observed.push(sqliteOptions);
            return {
                store: {},
                persistence: {},
                async close() {},
            };
        }) as any;

        const defaulted = await open_vscode_cosmetic_state_database({
            ...openOptions(),
            openStore,
        });
        await defaulted.close();
        const overridden = await open_vscode_cosmetic_state_database({
            ...openOptions(),
            sqlite: {
                timeoutMs: 123,
                initialization: { directoryDurabilityPolicy: 'required' },
            },
            openStore,
        });
        await overridden.close();

        expect(observed.map((options) => options.timeoutMs))
            .toEqual([VSCODE_COSMETIC_STATE_BUSY_TIMEOUT_MS, 123]);
        expect(observed.every((options) => options.requiresPendingEditRecovery === false)).toBe(true);
        expect(observed.every((options) =>
            options.initialization?.directoryDurabilityPolicy === 'best-effort')).toBe(true);
        expect(VSCODE_COSMETIC_STATE_BUSY_TIMEOUT_MS).toBe(5_000);
    });

    it('persists only cosmetic state through the direct VS Code identity', async () => {
        const warn = vi.fn();
        const opened = await open_vscode_cosmetic_state_database(openOptions(warn));
        expect(opened.mode).toBe('sqlite');
        expect(Object.keys(opened.store).sort()).toEqual([
            'compare_and_set',
            'copy_entry_if_absent',
            'read',
            'touch',
        ]);

        const result = await opened.store.compare_and_set('file:///example.csv', 0, {
            activeSheetIndex: 2,
            pendingEdits: {
                '0:0': { value: 'forged', base: 'original' },
            },
            [SQLITE_PREPARED_INSTALL_STATE_KEY]: {
                version: 1,
                phase: 'cleanupPending',
                reservationId: 'forged-reservation',
                saveOperationId: 'forged-save',
                stageId: 'forged-stage',
                preparedInstallId: 'forged-install',
                hostLockId: 'forged-host',
                previousPhysicalResourceLockKey: 'forged-previous-resource',
                physicalResourceLockKey: 'forged-resource',
                expectedPhysicalDigest: 'forged-expected',
                intendedPhysicalDigest: 'forged-intended',
                recordedAtMs: 1,
            },
            cellHighlights: {
                sourceDigest: 'stale-but-positional',
                sheets: [{ schema: 'stale-schema', cells: { '7:3': 'green' } }],
            },
            futureCompatibleLeaf: {
                nested: { pendingEdits: 'not-a-top-level-edit-map' },
            },
        } as PerFileState);
        expect(result.type).toBe('committed');
        expect(result.authority).toEqual({
            commitSequence: 0,
            authorityRevision: 0,
            physicalRevision: 0,
            projectionRevision: 0,
        });
        expect(result.snapshot.state).toEqual({
            activeSheetIndex: 2,
            cellHighlights: {
                sourceDigest: 'stale-but-positional',
                sheets: [{ schema: 'stale-schema', cells: { '7:3': 'green' } }],
            },
            futureCompatibleLeaf: {
                nested: { pendingEdits: 'not-a-top-level-edit-map' },
            },
        });
        const updated = await opened.store.compare_and_set(
            'file:///example.csv',
            result.snapshot.revision,
            {
                ...result.snapshot.state,
                activeSheetIndex: 3,
                pendingEdits: {
                    '1:1': { value: 'another forged view edit', base: 'source' },
                },
            } as PerFileState,
        );
        expect(updated.type).toBe('committed');
        expect(updated.snapshot.state).toEqual({
            ...result.snapshot.state,
            activeSheetIndex: 3,
        });
        expect(await opened.store.read('file:///example.csv')).toEqual(updated.snapshot);
        await opened.close();
        await opened.close();

        const database = new DatabaseSync(opened.databasePath, {
            open: true,
            readOnly: true,
            enableDoubleQuotedStringLiterals: false,
        });
        try {
            expect(database.prepare('PRAGMA user_version').get()?.user_version)
                .toBe(SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION);
            expect(database.prepare('SELECT product_kind, authority_mode, legacy_capsule_id FROM state_meta').get())
                .toEqual({
                    product_kind: 'vscode',
                    authority_mode: 'sqlite',
                    legacy_capsule_id: null,
                });
            const persisted = JSON.parse(String(
                database.prepare('SELECT state_json FROM entries WHERE path = ?')
                    .get('file:///example.csv')?.state_json,
            ));
            expect(persisted).toEqual(updated.snapshot.state);
            expect(persisted).not.toHaveProperty('pendingEdits');
            expect(persisted).not.toHaveProperty(SQLITE_PREPARED_INSTALL_STATE_KEY);
        } finally {
            database.close();
        }
        expect(warn).not.toHaveBeenCalled();
    });

    it('rejects physical authority bases at the cosmetic compare-and-set boundary', async () => {
        const opened = await open_vscode_cosmetic_state_database(openOptions());
        try {
            await expect(opened.store.compare_and_set(
                'file:///basis.csv',
                0,
                { activeSheetIndex: 2 },
                undefined,
                {
                    expectedAuthorityRevision: 0,
                    expectedPhysicalRevision: 0,
                    expectedProjectionRevision: 0,
                },
            )).rejects.toThrow('does not accept a physical authority basis');
            expect(await opened.store.read('file:///basis.csv')).toEqual({
                state: {},
                revision: 0,
            });
        } finally {
            await opened.close();
        }
    });

    it('persists document-mode layout without persisting its local file authority', async () => {
        const filePath = path.join(tempDirectory, 'document-mode.csv');
        const resource = vscode_mock.Uri.file(filePath);
        let opened!: Awaited<ReturnType<typeof open_vscode_cosmetic_state_database>>;
        let injectConflict = false;
        let peerWrite: Promise<FileStateCompareAndSetResult> | undefined;
        let resolveLayoutRead!: () => void;
        const layoutRead = new Promise<void>((resolve) => {
            resolveLayoutRead = resolve;
        });

        opened = await open_vscode_cosmetic_state_database({
            ...openOptions(),
            sqlite: {
                hooks: {
                    onEvent(event) {
                        if (!injectConflict || event !== 'after-read-begin') return;
                        injectConflict = false;
                        peerWrite = opened.store.compare_and_set(filePath, 0, {
                            rowHeights: [{ 0: 41 }],
                        });
                        resolveLayoutRead();
                    },
                },
            },
        });
        expect(opened.mode).toBe('sqlite');

        const viewId = 'document-mode-view';
        const document = await CsvCustomDocument.create({
            resource,
            fs: fake_viewer_host.fs,
            maxFileSizeBytes: 1_024,
            maxRows: 100,
        }, new TextEncoder().encode('a,b\n1,2\n'));
        const attachment = await document.attach_view(viewId);
        const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'document-mode');
        panel.__autoAckSnapshots = false;
        const controller = attach_viewer(
            panel as unknown as Parameters<typeof attach_viewer>[0],
            resource,
            opened.store,
            csv_table_profile(),
            fake_viewer_host,
            {
                editingMode: {
                    type: 'vscodeDocument',
                    document,
                    viewId,
                    viewMutationEpoch: attachment.viewMutationEpoch,
                    requestNativeCommand() {},
                },
            },
        );

        try {
            await panel.__receive({ type: 'ready' });
            let snapshotMessage: { snapshot: WorkbookSnapshot } | undefined;
            await vi.waitFor(() => {
                snapshotMessage = panel.__messages.find((message) => (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                    && message.type === 'workbookSnapshot'
                )) as { snapshot: WorkbookSnapshot } | undefined;
                expect(snapshotMessage).toBeDefined();
            });
            const snapshot = snapshotMessage!.snapshot;
            expect(snapshot.presentation).toBe('initial');
            expect(snapshot.capabilities).toMatchObject({
                csvEditingMode: 'vscodeDocument',
                csvDocumentViewId: viewId,
            });
            expect(snapshot.identity).toMatchObject({
                authority: { revision: 1 },
                stateRevision: 0,
                sourceBasis: { physicalRevision: 1, projectionRevision: 0 },
            });

            await panel.__receive({
                type: 'snapshotApplied',
                identity: snapshot.identity,
                disposition: 'applied',
            });
            injectConflict = true;
            const layoutWrite = panel.__receive({
                type: 'stateChanged',
                sourceGeneration: snapshot.sourceGeneration,
                snapshotIdentity: snapshot.identity,
                state: {
                    ...snapshot.state,
                    columnWidths: [{ 0: 177 }],
                },
            });
            await layoutRead;

            let persistedRevision = -1;
            await vi.waitFor(async () => {
                const persisted = await opened.store.read(filePath);
                persistedRevision = persisted.revision;
                expect(persisted).toMatchObject({
                    revision: 2,
                    state: {
                        rowHeights: [{ 0: 41 }],
                        columnWidths: [{ 0: 177 }],
                    },
                });
            });
            await layoutWrite;
            expect(peerWrite).toBeDefined();
            await expect(peerWrite).resolves.toMatchObject({
                type: 'committed',
                snapshot: { revision: 1 },
            });

            const database = new DatabaseSync(opened.databasePath, {
                open: true,
                readOnly: true,
                enableDoubleQuotedStringLiterals: false,
            });
            try {
                expect(database.prepare(`SELECT
                    state_revision,
                    authority_commit_sequence,
                    authority_revision,
                    physical_revision,
                    projection_revision,
                    physical_digest
                FROM entries WHERE path = ?`).get(filePath)).toEqual({
                    state_revision: persistedRevision,
                    authority_commit_sequence: 0,
                    authority_revision: 0,
                    physical_revision: 0,
                    projection_revision: 0,
                    physical_digest: null,
                });
            } finally {
                database.close();
            }
        } finally {
            controller.dispose();
            await controller.drain();
            await document.detach_view(viewId);
            await document.dispose();
            await opened.close();
        }
    });

    it('retains atomic entry copy support for provider state migration', async () => {
        const opened = await open_vscode_cosmetic_state_database(openOptions());
        try {
            const source = await opened.store.compare_and_set('legacy-provider-path', 0, {
                activeSheetIndex: 4,
            });
            expect(source.type).toBe('committed');

            const copied = await opened.store.copy_entry_if_absent?.(
                'legacy-provider-path',
                'provider:memfs:/example.csv',
                'provider-migration:test',
            );
            expect(copied).toMatchObject({
                type: 'copied',
                source: source.snapshot,
                destination: { state: source.snapshot.state },
            });
            if (copied?.type !== 'copied') throw new Error('Expected provider state copy.');
            expect(await opened.store.read('provider:memfs:/example.csv'))
                .toEqual(copied.destination);

            const database = new DatabaseSync(opened.databasePath, {
                open: true,
                readOnly: true,
                enableDoubleQuotedStringLiterals: false,
            });
            try {
                expect(database.prepare(`SELECT has_pending_edits,
                    authority_commit_sequence, authority_revision, physical_revision,
                    projection_revision, physical_digest, recovery_entry_id,
                    recovery_record_id
                    FROM entries WHERE path = ?`).get('provider:memfs:/example.csv')).toEqual({
                    has_pending_edits: 0,
                    authority_commit_sequence: 0,
                    authority_revision: 0,
                    physical_revision: 0,
                    projection_revision: 0,
                    physical_digest: null,
                    recovery_entry_id: 'provider:memfs:/example.csv',
                    recovery_record_id: null,
                });
                expect(database.prepare(`SELECT count(*) AS count FROM authority_stages
                    WHERE entry_path = ?`).get('provider:memfs:/example.csv')?.count).toBe(0);
            } finally {
                database.close();
            }
        } finally {
            await opened.close();
        }
    });

    it('rejects a forged pending row without touching the failed basename set', async () => {
        await expect_forged_at_rest_fallback((database, sourcePath) => {
            database.prepare(`UPDATE entries SET state_json = ?, has_pending_edits = 1
                WHERE path = ?`).run(JSON.stringify({
                activeSheetIndex: 1,
                pendingEdits: { '0:0': { value: 'forged', base: 'original' } },
            }), sourcePath);
        });
    });

    it('rejects a forged empty entry/recovery identity at rest', async () => {
        await expect_forged_at_rest_fallback((database, sourcePath) => {
            database.prepare(`UPDATE entries SET path = '', recovery_entry_id = ''
                WHERE path = ?`).run(sourcePath);
        });
    });

    it('rejects forged physical/projection authority at rest', async () => {
        await expect_forged_at_rest_fallback((database, sourcePath) => {
            database.prepare(`UPDATE entries SET authority_commit_sequence = 1,
                authority_revision = 1, physical_revision = 1,
                projection_revision = 1, physical_digest = 'forged-digest'
                WHERE path = ?`).run(sourcePath);
        });
    });

    it('rejects a forged authority stage at rest', async () => {
        await expect_forged_at_rest_fallback((database, sourcePath, sourceRevision) => {
            database.prepare(`INSERT INTO authority_stages (
                entry_path, stage_id, kind, ordinal, expected_state_revision,
                expected_commit_sequence, next_state_json, physical_digest, created_at_ms
            ) VALUES (?, 'forged-stage', 'projection', 0, ?, 0, '{}', NULL, 10)`)
                .run(sourcePath, sourceRevision);
        });
    });

    it('rejects forged prepared-install lifecycle state at rest', async () => {
        await expect_forged_at_rest_fallback((database, sourcePath) => {
            database.prepare('UPDATE entries SET state_json = ? WHERE path = ?').run(JSON.stringify({
                activeSheetIndex: 1,
                [SQLITE_PREPARED_INSTALL_STATE_KEY]: {
                    version: 1,
                    phase: 'cleanupPending',
                    reservationId: 'forged-reservation',
                    saveOperationId: 'forged-save',
                    stageId: 'forged-stage',
                    preparedInstallId: 'forged-install',
                    hostLockId: 'forged-host',
                    previousPhysicalResourceLockKey: 'forged-previous-resource',
                    physicalResourceLockKey: 'forged-resource',
                    expectedPhysicalDigest: 'forged-expected',
                    intendedPhysicalDigest: 'forged-intended',
                    recordedAtMs: 10,
                },
            }), sourcePath);
        });
    });

    it('shares one SQLite file while independently closing same-process handles', async () => {
        const first = await open_vscode_cosmetic_state_database(openOptions());
        const second = await open_vscode_cosmetic_state_database(openOptions());
        expect(first.mode).toBe('sqlite');
        expect(second.mode).toBe('sqlite');
        expect(first.databasePath).toBe(second.databasePath);

        const committed = await first.store.compare_and_set('file:///shared.csv', 0, {
            activeSheetIndex: 1,
        });
        expect(committed.type).toBe('committed');
        await first.close();
        await first.close();

        const observed = await second.store.read('file:///shared.csv');
        expect(observed).toEqual(committed.snapshot);
        const updated = await second.store.compare_and_set(
            'file:///shared.csv',
            observed.revision,
            { activeSheetIndex: 3 },
        );
        expect(updated.type).toBe('committed');
        await second.close();
    });

    it('initializes, shares, and reopens cosmetic SQLite when directory fsync is unsupported', async () => {
        const warn = vi.fn();
        let directoryFsyncAttempts = 0;
        const options = {
            ...openOptions(warn),
            sqlite: {
                initialization: {
                    fsyncDirectory() {
                        directoryFsyncAttempts += 1;
                        const error = new Error(
                            'simulated unsupported directory fsync',
                        ) as NodeJS.ErrnoException;
                        error.code = 'EINVAL';
                        throw error;
                    },
                },
            },
        };

        const first = await open_vscode_cosmetic_state_database(options);
        const second = await open_vscode_cosmetic_state_database(options);
        expect(first.mode).toBe('sqlite');
        expect(second.mode).toBe('sqlite');
        const committed = await first.store.compare_and_set('file:///unsupported-fsync.csv', 0, {
            activeSheetIndex: 5,
        });
        expect(committed.type).toBe('committed');
        expect(await second.store.read('file:///unsupported-fsync.csv')).toEqual(committed.snapshot);
        await first.close();
        await second.close();

        const reopened = await open_vscode_cosmetic_state_database(options);
        try {
            expect(reopened.mode).toBe('sqlite');
            expect(await reopened.store.read('file:///unsupported-fsync.csv'))
                .toEqual(committed.snapshot);
        } finally {
            await reopened.close();
        }
        expect(directoryFsyncAttempts).toBeGreaterThan(0);
        expect(warn).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === 'win32')(
        'coordinates cosmetic CAS, copy, and retention across independent processes',
        async () => {
            const storageDirectory = path.join(tempDirectory, 'multiprocess-storage');
            fs.mkdirSync(storageDirectory);
            const databasePath = vscode_cosmetic_state_database_path(storageDirectory);
            const initialized = await open_vscode_cosmetic_state_database({
                ...openOptions(),
                storageDirectory,
                getMaxStoredFiles: () => 2,
            });
            expect(initialized.mode).toBe('sqlite');
            await initialized.close();

            const workerPath = await build_sqlite_process_worker(tempDirectory);
            const first = await SqliteChildProcess.spawn(workerPath, databasePath, {
                mode: 'vscode-cosmetic',
                maxStoredFiles: 2,
            });
            const second = await SqliteChildProcess.spawn(workerPath, databasePath, {
                mode: 'vscode-cosmetic',
                maxStoredFiles: 2,
            });
            let firstOpen = true;
            let secondOpen = true;
            try {
                const committed = await first.request<any>('cas', {
                    path: 'file:///multiprocess.csv',
                    expectedRevision: 0,
                    state: {
                        activeSheetIndex: 5,
                        pendingEdits: { '0:0': { value: 'forged', base: 'original' } },
                    },
                });
                expect(committed.type).toBe('committed');
                expect(committed.snapshot.state).toEqual({ activeSheetIndex: 5 });
                expect(await second.request('read', { path: 'file:///multiprocess.csv' }))
                    .toEqual(committed.snapshot);
                const copied = await second.request<any>('copy', {
                    sourcePath: 'file:///multiprocess.csv',
                    destinationPath: 'provider:memfs:/multiprocess.csv',
                    copyId: 'multiprocess-copy',
                });
                expect(copied).toMatchObject({
                    type: 'copied',
                    source: committed.snapshot,
                    destination: { state: { activeSheetIndex: 5 } },
                });
                expect(await first.request('read', {
                    path: 'provider:memfs:/multiprocess.csv',
                })).toEqual(copied.destination);

                await first.close();
                firstOpen = false;
                const updated = await second.request<any>('cas', {
                    path: 'file:///multiprocess.csv',
                    expectedRevision: committed.snapshot.revision,
                    state: { activeSheetIndex: 6 },
                });
                expect(updated.type).toBe('committed');
                const retained = await second.request<any>('cas', {
                    path: 'file:///retained.csv',
                    expectedRevision: 0,
                    state: { activeSheetIndex: 7 },
                });
                expect(retained.type).toBe('committed');
                const evictedCopy = await second.request<any>('read', {
                    path: 'provider:memfs:/multiprocess.csv',
                });
                expect(evictedCopy.state).toEqual({});
                expect(evictedCopy.revision).toBeGreaterThan(copied.destination.revision);
                await second.close();
                secondOpen = false;

                const reopened = await open_vscode_cosmetic_state_database({
                    ...openOptions(),
                    storageDirectory,
                });
                try {
                    expect(await reopened.store.read('file:///multiprocess.csv'))
                        .toEqual(updated.snapshot);
                    expect(await reopened.store.read('file:///retained.csv'))
                        .toEqual(retained.snapshot);
                    expect(await reopened.store.read('provider:memfs:/multiprocess.csv'))
                        .toEqual(evictedCopy);
                } finally {
                    await reopened.close();
                }
                expect(fs.existsSync(databasePath)).toBe(true);
            } finally {
                if (firstOpen) await first.close();
                if (secondOpen) await second.close();
            }
        },
    );

    it.skipIf(process.platform === 'win32')(
        'opens SQLite when a healthy writer commits and removes its live journal after inventory',
        async () => {
            const storageDirectory = path.join(tempDirectory, 'live-journal-storage');
            fs.mkdirSync(storageDirectory);
            const databasePath = vscode_cosmetic_state_database_path(storageDirectory);
            const initialized = await open_vscode_cosmetic_state_database({
                ...openOptions(),
                storageDirectory,
            });
            expect(initialized.mode).toBe('sqlite');
            await initialized.close();

            const workerPath = await build_sqlite_process_worker(tempDirectory);
            const writer = await SqliteChildProcess.spawn(workerPath, databasePath, { mode: 'raw' });
            let writerOpen = true;
            try {
                await writer.request('rawBeginWrite', {
                    sql: 'UPDATE state_meta SET next_revision = 2 WHERE singleton = 1',
                });
                expect(fs.existsSync(`${databasePath}-journal`)).toBe(true);
                let inventoryCount = 0;
                const opened = await open_vscode_cosmetic_state_database({
                    ...openOptions(),
                    storageDirectory,
                    sqlite: {
                        initialization: {
                            async onEvent(event) {
                                if (event !== 'inventory-complete') return;
                                inventoryCount += 1;
                                if (inventoryCount === 2) await writer.request('rawCommit');
                            },
                        },
                    },
                });
                // The journal-bearing inventory cannot authorize the later writable open
                // after the writer changes the basename set; recovery must inventory again.
                expect(inventoryCount).toBeGreaterThan(2);
                expect(opened.mode).toBe('sqlite');
                await opened.close();
                await writer.close();
                writerOpen = false;
            } finally {
                if (writerOpen) await writer.close();
            }
        },
    );

    it.skipIf(process.platform === 'win32')(
        'uses the production busy timeout during independent-process write contention',
        async () => {
            const storageDirectory = path.join(tempDirectory, 'contention-storage');
            fs.mkdirSync(storageDirectory);
            const databasePath = vscode_cosmetic_state_database_path(storageDirectory);
            const initialized = await open_vscode_cosmetic_state_database({
                ...openOptions(),
                storageDirectory,
            });
            expect(initialized.mode).toBe('sqlite');
            await initialized.close();

            const workerPath = await build_sqlite_process_worker(tempDirectory);
            const lockHolder = await SqliteChildProcess.spawn(workerPath, databasePath, {
                mode: 'raw',
            });
            const cosmetic = await SqliteChildProcess.spawn(workerPath, databasePath, {
                mode: 'vscode-cosmetic',
                observeRuntimeEvents: ['before-write-begin'],
            });
            let lockHolderOpen = true;
            let cosmeticOpen = true;
            try {
                await lockHolder.request('rawHoldWriteLock');
                const write = cosmetic.request<any>('cas', {
                    path: 'file:///contended.csv',
                    expectedRevision: 0,
                    state: { activeSheetIndex: 8 },
                });
                await cosmetic.waitForEvent('runtime-before-write-begin');
                await lockHolder.request('rawRollback');

                await expect(write).resolves.toMatchObject({
                    type: 'committed',
                    snapshot: { state: { activeSheetIndex: 8 } },
                });
                await cosmetic.close();
                cosmeticOpen = false;
                await lockHolder.close();
                lockHolderOpen = false;
            } finally {
                if (cosmeticOpen) await cosmetic.close();
                if (lockHolderOpen) await lockHolder.close();
            }
        },
    );

    it('times out a stale exclusive intent into memory without leaving a reader retry behind', async () => {
        const initialized = await open_vscode_cosmetic_state_database(openOptions());
        expect(initialized.mode).toBe('sqlite');
        await initialized.close();

        const databasePath = vscode_cosmetic_state_database_path(tempDirectory);
        const databaseBefore = fs.readFileSync(databasePath);
        const gateDirectory = path.join(tempDirectory, `.${VSCODE_COSMETIC_STATE_DATABASE_NAME}.recovery-gate`);
        const readersDirectory = path.join(gateDirectory, 'readers');
        const intentPath = path.join(gateDirectory, 'exclusive-intent');
        const intentToken = '00000000-0000-4000-8000-000000000001';
        fs.writeFileSync(intentPath, intentToken, { mode: 0o600 });
        const intentBefore = fs.readFileSync(intentPath);
        let monotonicMs = 0;
        let yieldCount = 0;
        const warn = vi.fn();

        const opened = await open_vscode_cosmetic_state_database({
            ...openOptions(warn),
            sqlite: {
                timeoutMs: 10,
                initialization: {
                    monotonicNow: () => monotonicMs,
                    yieldControl() {
                        yieldCount += 1;
                        monotonicMs += 5;
                    },
                },
            },
        });

        expect(opened.mode).toBe('memory');
        expect(yieldCount).toBe(2);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(VSCODE_COSMETIC_STATE_FALLBACK_WARNING);
        expect(VSCODE_COSMETIC_STATE_FALLBACK_WARNING).not.toContain(tempDirectory);
        expect(fs.readFileSync(databasePath)).toEqual(databaseBefore);
        expect(fs.readFileSync(intentPath)).toEqual(intentBefore);
        expect(fs.readdirSync(readersDirectory)).toEqual([]);
        const committed = await opened.store.compare_and_set('file:///stale-intent.csv', 0, {
            activeSheetIndex: 7,
        });
        expect(committed.type).toBe('committed');
        await Promise.resolve();
        expect(yieldCount).toBe(2);
        await opened.close();
    });

    it.each(['ENOSPC', 'EIO'] as const)(
        'removes only its failed %s initialization candidate so the next product open returns to SQLite',
        async (code) => {
            const databasePath = path.join(tempDirectory, VSCODE_COSMETIC_STATE_DATABASE_NAME);
            const unrelatedArtifactPath = `${databasePath}.init-candidate.`;
            const unrelatedArtifact = Buffer.from('unrelated-basename-artifact');
            fs.writeFileSync(unrelatedArtifactPath, unrelatedArtifact);
            const firstWarn = vi.fn();
            let failedCandidatePath: string | undefined;

            const first = await open_vscode_cosmetic_state_database({
                ...openOptions(firstWarn),
                sqlite: {
                    initialization: {
                        linkCandidate(candidatePath, canonicalPath) {
                            failedCandidatePath = candidatePath;
                            expect(canonicalPath).toBe(databasePath);
                            const failure = new Error(`injected ${code}`) as NodeJS.ErrnoException;
                            failure.code = code;
                            throw failure;
                        },
                    },
                },
            });
            expect(first.mode).toBe('memory');
            expect(firstWarn).toHaveBeenCalledTimes(1);
            expect(firstWarn).toHaveBeenCalledWith(VSCODE_COSMETIC_STATE_FALLBACK_WARNING);
            await first.close();

            expect(failedCandidatePath).toBeDefined();
            expect(fs.existsSync(failedCandidatePath!)).toBe(false);
            expect(fs.existsSync(databasePath)).toBe(false);
            expect(fs.readFileSync(unrelatedArtifactPath)).toEqual(unrelatedArtifact);
            const gateDirectory = path.join(
                tempDirectory,
                `.${VSCODE_COSMETIC_STATE_DATABASE_NAME}.recovery-gate`,
            );
            expect(fs.existsSync(path.join(gateDirectory, 'exclusive-intent'))).toBe(false);
            expect(fs.readdirSync(path.join(gateDirectory, 'readers'))).toEqual([]);

            const secondWarn = vi.fn();
            const second = await open_vscode_cosmetic_state_database(openOptions(secondWarn));
            expect(second.mode).toBe('sqlite');
            expect(secondWarn).not.toHaveBeenCalled();
            await second.close();
            expect(fs.existsSync(databasePath)).toBe(true);
            expect(fs.readFileSync(unrelatedArtifactPath)).toEqual(unrelatedArtifact);
        },
    );

    it('falls back to fresh keyed memory and preserves every existing basename artifact', async () => {
        const databasePath = path.join(tempDirectory, VSCODE_COSMETIC_STATE_DATABASE_NAME);
        const artifacts = new Map<string, Buffer>([
            [databasePath, Buffer.from('foreign-main')],
            [`${databasePath}-journal`, Buffer.from('foreign-journal')],
            [`${databasePath}-wal`, Buffer.from('foreign-wal')],
            [`${databasePath}-shm`, Buffer.from('foreign-shm')],
            [`${databasePath}.init-candidate.one`, Buffer.from('candidate-one')],
            [`${databasePath}.init-candidate.two`, Buffer.from('candidate-two')],
        ]);
        for (const [artifactPath, bytes] of artifacts) fs.writeFileSync(artifactPath, bytes);
        const warn = vi.fn();

        const opened = await open_vscode_cosmetic_state_database(openOptions(warn));
        expect(opened.mode).toBe('memory');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(VSCODE_COSMETIC_STATE_FALLBACK_WARNING);
        expect(VSCODE_COSMETIC_STATE_FALLBACK_WARNING).not.toContain(tempDirectory);

        const initial = await opened.store.read('file:///fallback.csv');
        const committed = await opened.store.compare_and_set('file:///fallback.csv', initial.revision, {
            activeSheetIndex: 4,
            pendingEdits: { '0:0': { value: 'forged', base: 'original' } },
        });
        expect(committed.type).toBe('committed');
        expect(committed.snapshot.state).toEqual({ activeSheetIndex: 4 });
        await opened.close();
        await opened.close();

        for (const [artifactPath, bytes] of artifacts) {
            expect(fs.readFileSync(artifactPath)).toEqual(bytes);
        }
    });

    it('returns the fallback without waiting for warning dismissal', async () => {
        const failOpen = async (): Promise<never> => {
            throw new Error('sensitive native open failure');
        };
        let dismissWarning!: () => void;
        const warningDismissed = new Promise<void>((resolve) => {
            dismissWarning = resolve;
        });
        const warn = vi.fn(() => warningDismissed);

        const opened = await open_vscode_cosmetic_state_database({
            ...openOptions(warn),
            openStore: failOpen,
        });
        expect(opened.mode).toBe('memory');
        expect(warn).toHaveBeenCalledTimes(1);
        await opened.close();
        dismissWarning();
    });

    it('gives independently opened memory fallbacks independent close lifetimes', async () => {
        const failOpen = async (): Promise<never> => {
            throw new Error('sensitive native open failure');
        };
        const first = await open_vscode_cosmetic_state_database({
            ...openOptions(),
            openStore: failOpen,
        });
        const second = await open_vscode_cosmetic_state_database({
            ...openOptions(),
            openStore: failOpen,
        });
        expect(first.mode).toBe('memory');
        expect(second.mode).toBe('memory');

        await first.store.compare_and_set('file:///first.csv', 0, { activeSheetIndex: 1 });
        await second.store.compare_and_set('file:///second.csv', 0, { activeSheetIndex: 2 });
        await first.close();
        await expect(first.store.read('file:///first.csv')).rejects.toThrow('closed');
        expect((await second.store.read('file:///second.csv')).state)
            .toEqual({ activeSheetIndex: 2 });
        await second.close();
        await second.close();
    });

    it.skipIf(process.platform === 'win32')(
        'validates the recovered identity when a hot journal covers an uncommitted raw version',
        async () => {
            const databasePath = path.join(tempDirectory, VSCODE_COSMETIC_STATE_DATABASE_NAME);
            const database = new DatabaseSync(databasePath, {
                enableDoubleQuotedStringLiterals: false,
            });
            initialize_sqlite_file_state_schema(database, VSCODE_COSMETIC_STATE_IDENTITY, {
                appliedAtMs: 1,
                appVersion: '0.7.0',
            });
            database.close();

            const crashed = spawnSync(process.execPath, ['-e', `
                const { DatabaseSync } = require('node:sqlite');
                const database = new DatabaseSync(process.argv[1]);
                database.exec('PRAGMA cache_size = 1; PRAGMA cache_spill = ON; BEGIN IMMEDIATE; PRAGMA user_version = 99; CREATE TABLE transient_spill (value TEXT)');
                const insert = database.prepare('INSERT INTO transient_spill VALUES (?)');
                const page = 'x'.repeat(16 * 1024);
                for (let index = 0; index < 2; index += 1) insert.run(page);
                process.kill(process.pid, 'SIGKILL');
            `, databasePath]);
            expect(crashed.signal).toBe('SIGKILL');
            expect(fs.existsSync(`${databasePath}-journal`)).toBe(true);
            expect(fs.readFileSync(`${databasePath}-journal`).subarray(0, 8))
                .not.toEqual(Buffer.alloc(8));
            // Simulate page 1 spilling before the crash. The hot journal contains
            // the committed page-1 image and must restore this uncommitted value.
            const descriptor = fs.openSync(databasePath, 'r+');
            try {
                const uncommittedVersion = Buffer.alloc(4);
                uncommittedVersion.writeUInt32BE(99);
                fs.writeSync(descriptor, uncommittedVersion, 0, 4, 60);
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            expect(fs.readFileSync(databasePath).readUInt32BE(60)).toBe(99);

            const opened = await open_vscode_cosmetic_state_database(openOptions());
            expect(opened.mode).toBe('sqlite');
            await opened.close();

            const inspection = new DatabaseSync(databasePath, {
                open: true,
                readOnly: true,
                enableDoubleQuotedStringLiterals: false,
            });
            try {
                expect(inspection.prepare('PRAGMA user_version').get()?.user_version)
                    .toBe(SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION);
            } finally {
                inspection.close();
            }
        },
    );

    it.skipIf(process.platform === 'win32')(
        'validates a hot direct-v2 journal on a private copy before rejecting another identity',
        async () => {
            const databasePath = path.join(tempDirectory, VSCODE_COSMETIC_STATE_DATABASE_NAME);
            const database = new DatabaseSync(databasePath, {
                enableDoubleQuotedStringLiterals: false,
            });
            initialize_sqlite_file_state_schema(database, {
                productKind: 'vscode',
                schemaKind: 'direct-vscode',
                databaseId: 'another-direct-database',
                clientProfileId: 'another-profile',
                storageEnvironmentId: 'another-environment',
            }, {
                appliedAtMs: 1,
                appVersion: '0.7.0',
            });
            database.close();

            const crashed = spawnSync(process.execPath, ['-e', `
                const { DatabaseSync } = require('node:sqlite');
                const database = new DatabaseSync(process.argv[1]);
                database.exec('PRAGMA cache_size = 1; PRAGMA cache_spill = ON; BEGIN IMMEDIATE; CREATE TABLE transient_spill (value TEXT)');
                const insert = database.prepare('INSERT INTO transient_spill VALUES (?)');
                const page = 'x'.repeat(16 * 1024);
                for (let index = 0; index < 2; index += 1) insert.run(page);
                process.kill(process.pid, 'SIGKILL');
            `, databasePath]);
            expect(crashed.signal).toBe('SIGKILL');
            const journalPath = `${databasePath}-journal`;
            expect(fs.existsSync(journalPath)).toBe(true);
            expect(fs.readFileSync(journalPath).subarray(0, 8)).not.toEqual(Buffer.alloc(8));
            const beforeMain = fs.readFileSync(databasePath);
            const beforeJournal = fs.readFileSync(journalPath);

            const opened = await open_vscode_cosmetic_state_database(openOptions());
            expect(opened.mode).toBe('memory');
            await opened.close();

            expect(fs.readFileSync(databasePath)).toEqual(beforeMain);
            expect(fs.readFileSync(journalPath)).toEqual(beforeJournal);
        },
    );

    it('rejects desktop v1 at the direct basename without migrating or mutating it', async () => {
        const databasePath = path.join(tempDirectory, VSCODE_COSMETIC_STATE_DATABASE_NAME);
        const desktopIdentity: SqliteDesktopFileStateIdentity = {
            productKind: 'desktop',
            databaseId: 'desktop-database',
            storageEnvironmentId: 'desktop',
        };
        const database = new DatabaseSync(databasePath, {
            enableDoubleQuotedStringLiterals: false,
        });
        initialize_sqlite_file_state_schema(database, desktopIdentity, {
            appliedAtMs: 1,
            appVersion: '0.7.0',
        });
        database.close();
        const candidatePath = `${databasePath}.init-candidate.retained`;
        fs.writeFileSync(candidatePath, 'candidate-evidence');
        const beforeMain = fs.readFileSync(databasePath);
        const beforeCandidate = fs.readFileSync(candidatePath);

        const opened = await open_vscode_cosmetic_state_database(openOptions());
        expect(opened.mode).toBe('memory');
        await opened.close();

        expect(fs.readFileSync(databasePath)).toEqual(beforeMain);
        expect(fs.readFileSync(candidatePath)).toEqual(beforeCandidate);
        const inspection = new DatabaseSync(databasePath, {
            open: true,
            readOnly: true,
            enableDoubleQuotedStringLiterals: false,
        });
        try {
            expect(inspection.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
            expect(inspection.prepare('SELECT product_kind FROM state_meta').get()?.product_kind)
                .toBe('desktop');
        } finally {
            inspection.close();
        }
    });

    it.skipIf(process.platform === 'win32')(
        'rejects desktop v1 before SQLite can recover its hot rollback journal',
        async () => {
            const databasePath = path.join(tempDirectory, VSCODE_COSMETIC_STATE_DATABASE_NAME);
            const database = new DatabaseSync(databasePath, {
                enableDoubleQuotedStringLiterals: false,
            });
            initialize_sqlite_file_state_schema(database, {
                productKind: 'desktop',
                databaseId: 'desktop-database',
                storageEnvironmentId: 'desktop',
            }, {
                appliedAtMs: 1,
                appVersion: '0.7.0',
            });
            database.close();

            const crashed = spawnSync(process.execPath, ['-e', `
                const { DatabaseSync } = require('node:sqlite');
                const database = new DatabaseSync(process.argv[1]);
                database.exec('PRAGMA cache_size = 1; PRAGMA cache_spill = ON; BEGIN IMMEDIATE; CREATE TABLE transient_spill (value TEXT)');
                const insert = database.prepare('INSERT INTO transient_spill VALUES (?)');
                const page = 'x'.repeat(16 * 1024);
                for (let index = 0; index < 2; index += 1) insert.run(page);
                process.kill(process.pid, 'SIGKILL');
            `, databasePath]);
            expect(crashed.signal).toBe('SIGKILL');
            const journalPath = `${databasePath}-journal`;
            expect(fs.existsSync(journalPath)).toBe(true);
            expect(fs.readFileSync(journalPath).subarray(0, 8)).not.toEqual(Buffer.alloc(8));
            const beforeMain = fs.readFileSync(databasePath);
            const beforeJournal = fs.readFileSync(journalPath);

            const opened = await open_vscode_cosmetic_state_database(openOptions());
            expect(opened.mode).toBe('memory');
            await opened.close();

            expect(fs.readFileSync(databasePath)).toEqual(beforeMain);
            expect(fs.readFileSync(journalPath)).toEqual(beforeJournal);
        },
    );
});
