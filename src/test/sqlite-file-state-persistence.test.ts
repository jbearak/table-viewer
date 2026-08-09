import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    create_keyed_authority_store,
    type AuthorityFileStateStore,
    type KeyedFileStatePersistence,
    type KeyedStateReadTransaction,
    type KeyedStateWriteTransaction,
} from '../state';
import {
    open_sqlite_file_state_persistence,
    open_sqlite_file_state_store,
    recover_stale_sqlite_coordination,
} from '../sqlite-file-state-persistence';
import { SqliteFileStateError } from '../sqlite-file-state-errors';
import { inspect_sqlite_recovery_gate } from '../sqlite-open-recovery';
import { file_state_store_contract } from './file-state-store-contract';
import { SqliteTestDatabase } from './helpers/sqlite-test-database';

let tempDirectory: string;
let databaseCounter = 0;
let databases: SqliteTestDatabase[];

function freshDatabase(options: ConstructorParameters<typeof SqliteTestDatabase>[1] = {}) {
    const database = new SqliteTestDatabase(
        path.join(tempDirectory, `store-${databaseCounter++}`, 'file-state.sqlite3'),
        options,
    );
    databases.push(database);
    return database;
}

function deferredStore(
    database: SqliteTestDatabase,
    maxStoredFiles = 10_000,
): AuthorityFileStateStore {
    let opened: ReturnType<SqliteTestDatabase['openPersistence']> | undefined;
    const getOpened = (): ReturnType<SqliteTestDatabase['openPersistence']> => (
        opened ??= database.openPersistence()
    );
    const deferred: KeyedFileStatePersistence = {
        runtime_key: database.runtimeKey,
        canonicalization_revision_policy: 'allocate-revision-when-target-absent',
        read_transaction: (body) => getOpened().then((persistence) => persistence.read_transaction(body)),
        write_transaction: (kind, body) => getOpened().then((persistence) => (
            persistence.write_transaction(kind, body)
        )),
        close: async () => (await getOpened()).close(),
    };
    return create_keyed_authority_store(deferred, () => maxStoredFiles);
}

function instrumentPayloadIo(persistence: KeyedFileStatePersistence) {
    const counts = { reads: 0, writes: 0 };
    const readTx = (tx: KeyedStateReadTransaction): KeyedStateReadTransaction => ({
        ...tx,
        read_entry(entryPath) {
            counts.reads += 1;
            return tx.read_entry(entryPath);
        },
    });
    const writeTx = (tx: KeyedStateWriteTransaction): KeyedStateWriteTransaction => ({
        ...tx,
        read_entry(entryPath) {
            counts.reads += 1;
            return tx.read_entry(entryPath);
        },
        write_entry(value) {
            counts.writes += 1;
            tx.write_entry(value);
        },
    });
    return {
        counts,
        persistence: {
            ...persistence,
            read_transaction: (body) => persistence.read_transaction((tx) => body(readTx(tx))),
            write_transaction: (kind, body) => persistence.write_transaction(
                kind,
                (tx) => body(writeTx(tx)),
            ),
        } satisfies KeyedFileStatePersistence,
        reset() {
            counts.reads = 0;
            counts.writes = 0;
        },
    };
}

beforeEach(async () => {
    tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-sqlite-store-'));
    databases = [];
});

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(databases.map((database) => database.close()));
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
});

file_state_store_contract('SQLite backend', () => {
    const database = freshDatabase();
    return {
        create: (max = 10_000) => deferredStore(database, max),
        createIndependent: (max = 10_000) => deferredStore(database, max),
        seedEnvelope: (envelope) => database.seedEnvelope(envelope),
        inspect: () => database.inspect(),
        failNextWrite: () => database.failNextWrite(),
    };
}, {
    allocateRevisionWhenCanonicalTargetAbsent: true,
});

describe('SQLite file-state persistence', () => {
    it('opens through no-clobber initialization and exposes keyed authority', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        expect(opened.persistence.canonicalization_revision_policy)
            .toBe('allocate-revision-when-target-absent');
        expect(Object.keys(opened.store).sort()).toEqual([
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
        await opened.close();
    });

    it('uses one nondefault supported protocol for initialization, runtime, and stale recovery', async () => {
        const database = freshDatabase();
        await database.initialize();
        const direct = new DatabaseSync(database.databasePath);
        direct.prepare(`UPDATE state_meta SET min_reader_protocol = ?, max_reader_protocol = ?,
            min_writer_protocol = ?, max_writer_protocol = ? WHERE singleton = 1`).run(7, 7, 7, 7);
        direct.close();

        const options = { ...database.options, supportedProtocol: 7 };
        const opened = await open_sqlite_file_state_store(database.databasePath, options);
        await opened.close();
        await expect(recover_stale_sqlite_coordination(
            database.databasePath,
            options,
            { allProcessesClosed: true },
        )).resolves.toBe(2);

        await expect(open_sqlite_file_state_persistence(database.databasePath, {
            ...options,
            initialization: { supportedProtocol: 6 },
        })).rejects.toMatchObject({
            category: 'protocol',
            metadata: { operation: 'supported-protocol-configuration', protocol: 7 },
        });
    });

    it('transfers one continuous shared gate token into the interned runtime', async () => {
        const database = freshDatabase();
        let initializationToken: string | undefined;
        let runtimeToken: string | undefined;
        const persistence = await open_sqlite_file_state_persistence(database.databasePath, {
            ...database.options,
            initialization: {
                onEvent(event) {
                    if (event === 'winner-validated') {
                        [initializationToken] = inspect_sqlite_recovery_gate(
                            database.databasePath,
                        ).readerTokenIds;
                    }
                },
            },
            hooks: {
                onEvent(event) {
                    if (event === 'before-session-register') {
                        [runtimeToken] = inspect_sqlite_recovery_gate(
                            database.databasePath,
                        ).readerTokenIds;
                    }
                },
            },
        });
        expect(initializationToken).toBeDefined();
        expect(runtimeToken).toBe(initializationToken);
        expect(inspect_sqlite_recovery_gate(database.databasePath).readerTokenIds)
            .toEqual([initializationToken]);
        await persistence.close();
        expect(inspect_sqlite_recovery_gate(database.databasePath).readerTokenIds).toEqual([]);
    });

    it('closes the adopted database when runtime option validation fails', async () => {
        const database = freshDatabase();
        await expect(open_sqlite_file_state_persistence(database.databasePath, {
            ...database.options,
            clientKind: '',
        })).rejects.toThrow(TypeError);
        expect(inspect_sqlite_recovery_gate(database.databasePath).readerTokenIds).toEqual([]);
        new DatabaseSync(database.databasePath).close();
    });

    it('sanitizes public directory-creation failures', async () => {
        const database = freshDatabase();
        const nativeMessage = `permission denied: ${database.databasePath}`;
        vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce(Object.assign(new Error(nativeMessage), {
            code: 'EROFS',
        }));
        try {
            await open_sqlite_file_state_persistence(database.databasePath, database.options);
            throw new Error('expected sanitized failure');
        } catch (error) {
            expect(error).toBeInstanceOf(SqliteFileStateError);
            expect((error as SqliteFileStateError).category).toBe('readonly');
            expect((error as Error).message).not.toContain(database.databasePath);
            expect((error as Error).message).not.toContain(nativeMessage);
            expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
        }
    });

    it('keeps metadata-only operations free of entry payload I/O', async () => {
        const database = freshDatabase();
        const underlying = await database.openPersistence();
        const instrumented = instrumentPayloadIo(underlying);
        const store = create_keyed_authority_store(instrumented.persistence);
        await store.compare_and_set('/entry', 0, { activeSheetIndex: 1 });

        instrumented.reset();
        await store.read_authority('/entry');
        await store.touch!('/entry');
        await store.stage_authority_transaction('/entry', {
            id: 'stage',
            kind: 'projection',
            ordinal: 1,
            expectedStateRevision: 1,
            expectedCommitSequence: 0,
        });
        await store.discard_authority_transaction('/entry', 'stage');
        expect(instrumented.counts).toEqual({ reads: 0, writes: 0 });
    });

    it('scans metadata without decoding each logical state payload', async () => {
        const database = freshDatabase();
        const persistence = await database.openPersistence();
        const store = create_keyed_authority_store(persistence);
        await store.compare_and_set('/metadata.csv', 0, { activeSheetIndex: 1 });

        const direct = new DatabaseSync(database.databasePath);
        direct.prepare('UPDATE entries SET state_json = ? WHERE path = ?').run(
            JSON.stringify({ activeSheetIndex: 'invalid-logical-payload' }),
            '/metadata.csv',
        );
        direct.close();

        const [metadata] = await persistence.read_transaction((tx) => tx.scan_entry_metadata());
        expect(metadata).toMatchObject({ path: '/metadata.csv', stateRevision: 1 });
        await expect(persistence.read_transaction((tx) => tx.read_entry('/metadata.csv')))
            .rejects.toMatchObject({ category: 'malformed-state' });
        await persistence.close();
    });

    it('bounds ordinary payload reads and copy reads to requested entries', async () => {
        const database = freshDatabase();
        const underlying = await database.openPersistence();
        const instrumented = instrumentPayloadIo(underlying);
        const store = create_keyed_authority_store(instrumented.persistence);
        for (let index = 0; index < 25; index += 1) {
            await store.compare_and_set(`/entry-${index}`, 0, { activeSheetIndex: index });
        }

        instrumented.reset();
        await store.read('/entry-12');
        expect(instrumented.counts).toEqual({ reads: 1, writes: 0 });

        instrumented.reset();
        await store.compare_and_set('/entry-12', 13, { activeSheetIndex: 99 });
        expect(instrumented.counts).toEqual({ reads: 1, writes: 1 });

        instrumented.reset();
        await store.copy_entry_if_absent!('/entry-12', '/copy', 'bounded-copy');
        expect(instrumented.counts.reads).toBeLessThanOrEqual(3);
        expect(instrumented.counts.writes).toBe(1);
    });

    it('renormalizes recency transactionally before SQLite integer exhaustion', async () => {
        const database = freshDatabase();
        const store = deferredStore(database);
        await store.compare_and_set('/old', 0, { activeSheetIndex: 1 });
        await store.compare_and_set('/new', 0, { activeSheetIndex: 2 });
        const direct = new DatabaseSync(database.databasePath);
        direct.prepare('UPDATE state_meta SET next_recency_order = ? WHERE singleton = 1')
            .run(BigInt(Number.MAX_SAFE_INTEGER));
        direct.close();

        await store.touch!('/old');
        expect(Object.keys(database.inspect().entries)).toEqual(['/new', '/old']);
        expect((await store.read('/old')).revision).toBe(1);
    });

    it('drains semantic operations admitted before close', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const first = opened.store.compare_and_set('/first', 0, { activeSheetIndex: 1 });
        const second = opened.store.compare_and_set('/second', 0, { activeSheetIndex: 2 });
        const closing = opened.close();

        await expect(first).resolves.toMatchObject({ type: 'committed' });
        await expect(second).resolves.toMatchObject({ type: 'committed' });
        await expect(closing).resolves.toBeUndefined();
        expect(database.inspect().entries).toMatchObject({
            '/first': { revision: 1 },
            '/second': { revision: 2 },
        });
    });

    it('uses metadata, stage-age, and lease indexes without selecting state JSON', async () => {
        const database = freshDatabase();
        await database.initialize();
        const direct = new DatabaseSync(database.databasePath, { readOnly: true });
        const plans = [
            direct.prepare('EXPLAIN QUERY PLAN SELECT path FROM entries ORDER BY recency_order, path').all(),
            direct.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT entry_path
                FROM authority_stages INDEXED BY authority_stages_by_age
                WHERE created_at_ms < ?`).all(1000),
            direct.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM entry_leases
                WHERE current_entry_path = ? LIMIT 1`).all('/entry'),
        ].flat().map((row) => String(row.detail)).join('\n');
        direct.close();

        expect(plans).toContain('entries_by_recency');
        expect(plans).toContain('authority_stages_by_age');
        expect(plans).toContain('entry_leases_by_path');
        expect(plans).not.toContain('state_json');
    });
});
