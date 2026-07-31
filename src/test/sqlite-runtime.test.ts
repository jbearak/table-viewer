import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteFileStateError } from '../sqlite-file-state-errors';
import {
    type SqliteDesktopFileStateIdentity,
} from '../sqlite-file-state-schema';
import {
    acquire_sqlite_exclusive_recovery_gate,
    initialize_sqlite_database_no_clobber,
    inspect_sqlite_recovery_gate,
    open_existing_sqlite_database,
} from '../sqlite-open-recovery';
import {
    open_sqlite_runtime,
    sqlite_safe_integer,
    type SqliteRuntimeHandle,
    type SqliteRuntimeHooks,
} from '../sqlite-runtime';

let tempDirectory: string;
let runtimeHandles: SqliteRuntimeHandle[];
let temporaryLinks: string[];

const identity: SqliteDesktopFileStateIdentity = {
    productKind: 'desktop',
    databaseId: 'desktop-database',
    storageEnvironmentId: 'desktop-environment',
};

function databasePath(): string {
    return path.join(tempDirectory, 'file-state.sqlite3');
}

async function initialize(): Promise<void> {
    const result = await initialize_sqlite_database_no_clobber(
        databasePath(),
        identity,
        { appliedAtMs: 1, appVersion: '0.7.0' },
    );
    await result.database.close();
}

async function openRuntime(hooks?: SqliteRuntimeHooks): Promise<SqliteRuntimeHandle> {
    const runtime = await open_sqlite_runtime(databasePath(), {
        identity,
        clientKind: 'vitest',
        clientVersion: '0.7.0',
        hooks,
    });
    runtimeHandles.push(runtime);
    return runtime;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function inspectionDatabase(): DatabaseSync {
    const database = new DatabaseSync(databasePath(), {
        enableDoubleQuotedStringLiterals: false,
        timeout: 0,
    });
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA trusted_schema = OFF');
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA secure_delete = ON');
    return database;
}

function marker(database: DatabaseSync, sessionId: string): {
    sequence: bigint;
    operationId: unknown;
    operationKind: unknown;
} | undefined {
    const statement = database.prepare(`SELECT last_committed_sequence,
        last_operation_id, last_operation_kind
        FROM writer_sessions WHERE writer_session_id = ?`);
    statement.setReadBigInts(true);
    const row = statement.get(sessionId);
    return row && {
        sequence: row.last_committed_sequence as bigint,
        operationId: row.last_operation_id,
        operationKind: row.last_operation_kind,
    };
}

beforeEach(async () => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-sqlite-runtime-'));
    runtimeHandles = [];
    temporaryLinks = [];
    await initialize();
});

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(runtimeHandles.map((runtime) => runtime.close()));
    for (const link of temporaryLinks) fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('SQLite path-interned runtime', () => {
    it('interns the resolved path, connection lifetime, queue, and writer session', async () => {
        const first = await openRuntime();
        const second = await open_sqlite_runtime(path.join(tempDirectory, '.', 'file-state.sqlite3'), {
            identity,
            clientKind: 'another-local-client',
            clientVersion: '0.7.0',
        });
        runtimeHandles.push(second);

        expect(second.runtime_key).toBe(first.runtime_key);
        expect(second.writer_session_id).toBe(first.writer_session_id);
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toHaveLength(1);

        const database = inspectionDatabase();
        expect(marker(database, first.writer_session_id)?.sequence).toBe(0n);
        await first.close();
        await expect(first.read_transaction(() => undefined)).rejects.toThrow('handle is closed');
        expect(marker(database, second.writer_session_id)?.sequence).toBe(0n);
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toHaveLength(1);

        await second.close();
        expect(marker(database, second.writer_session_id)).toBeUndefined();
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toHaveLength(0);
        database.close();
    });

    it('preserves an adopted connection while an existing runtime finishes closing', async () => {
        const closeStarted = deferred();
        const allowClose = deferred();
        const firstOpened = await open_existing_sqlite_database(databasePath());
        const first = await open_sqlite_runtime(databasePath(), {
            identity,
            clientKind: 'vitest',
            clientVersion: '0.7.0',
            openConnection: async () => ({
                ...firstOpened,
                closeDatabase: () => firstOpened.closeDatabase(),
                async close() {
                    closeStarted.resolve();
                    await allowClose.promise;
                    await firstOpened.close();
                },
            }),
        });
        runtimeHandles.push(first);

        const closing = first.close();
        await closeStarted.promise;
        const adoptedOpened = await open_existing_sqlite_database(databasePath());
        let adoptedClosed = false;
        const adopted = {
            ...adoptedOpened,
            closeDatabase: () => adoptedOpened.closeDatabase(),
            async close() {
                adoptedClosed = true;
                await adoptedOpened.close();
            },
        };
        const reopening = open_sqlite_runtime(databasePath(), {
            identity,
            clientKind: 'vitest',
            clientVersion: '0.7.0',
            adoptedConnection: adopted,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(adoptedClosed).toBe(false);

        allowClose.resolve();
        await closing;
        const second = await reopening;
        runtimeHandles.push(second);
        expect(adoptedClosed).toBe(false);
        await expect(second.read_transaction((tx) => tx.prepare('SELECT 1 AS value').get()?.value))
            .resolves.toBe(1n);
    });

    it('interns symlink aliases by the final filesystem-resolved path', async () => {
        const first = await openRuntime();
        const aliasDirectory = `${tempDirectory}-alias`;
        fs.symlinkSync(tempDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');
        temporaryLinks.push(aliasDirectory);
        const second = await open_sqlite_runtime(path.join(aliasDirectory, 'file-state.sqlite3'), {
            identity,
            clientKind: 'alias-client',
            clientVersion: '0.7.0',
        });
        runtimeHandles.push(second);
        expect(second.canonical_path).toBe(first.canonical_path);
        expect(second.runtime_key).toBe(first.runtime_key);
        expect(second.writer_session_id).toBe(first.writer_session_id);
    });

    it('sanitizes canonical-parent realpath failures without leaking native paths or causes', async () => {
        const nativeMessage = `realpath failed for ${tempDirectory}`;
        vi.spyOn(fs.realpathSync, 'native').mockImplementationOnce(() => {
            const error = new Error(nativeMessage) as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
        });
        try {
            await open_sqlite_runtime(databasePath(), {
                identity,
                clientKind: 'vitest',
                clientVersion: '0.7.0',
            });
            throw new Error('expected sanitized failure');
        } catch (error) {
            expect(error).toBeInstanceOf(SqliteFileStateError);
            expect((error as Error).message).not.toContain(tempDirectory);
            expect((error as Error).message).not.toContain(nativeMessage);
            expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
        }
    });

    it('applies and verifies the complete connection policy and bigint reads', async () => {
        const runtime = await openRuntime();
        const policy = await runtime.read_transaction((tx) => ({
            foreignKeys: tx.safe_integer(tx.prepare('PRAGMA foreign_keys').get()?.foreign_keys),
            trustedSchema: tx.safe_integer(tx.prepare('PRAGMA trusted_schema').get()?.trusted_schema),
            synchronous: tx.safe_integer(tx.prepare('PRAGMA synchronous').get()?.synchronous),
            secureDelete: tx.safe_integer(tx.prepare('PRAGMA secure_delete').get()?.secure_delete),
            journalMode: tx.prepare('PRAGMA journal_mode').get()?.journal_mode,
            generationType: typeof tx.prepare(
                'SELECT coordination_generation FROM state_meta WHERE singleton = 1',
            ).get()?.coordination_generation,
        }));
        expect(policy).toEqual({
            foreignKeys: 1,
            trustedSchema: 0,
            synchronous: 2,
            secureDelete: 1,
            journalMode: 'delete',
            generationType: 'bigint',
        });
        expect(sqlite_safe_integer(9_007_199_254_740_991n)).toBe(Number.MAX_SAFE_INTEGER);
        expect(() => sqlite_safe_integer(9_007_199_254_740_992n)).toThrow(SqliteFileStateError);
    });

    it('enforces read-only deferred transactions at the database level', async () => {
        const runtime = await openRuntime();
        await expect(runtime.read_transaction((tx) => tx.prepare(
            'UPDATE state_meta SET store_updated_at_ms = 9 WHERE singleton = 1',
        ).run())).rejects.toThrow();
        await expect(runtime.read_transaction((tx) => tx.prepare(
            'SELECT store_updated_at_ms FROM state_meta WHERE singleton = 1',
        ).get()?.store_updated_at_ms)).resolves.toBeNull();
    });

    it('faults and rolls back when a read callback disables query_only and writes', async () => {
        const runtime = await openRuntime();
        await expect(runtime.read_transaction((tx) => {
            tx.prepare('PRAGMA query_only = OFF').get();
            tx.prepare('UPDATE state_meta SET store_updated_at_ms = 9 WHERE singleton = 1').run();
        })).rejects.toMatchObject({ category: 'protocol' });
        await expect(runtime.read_transaction(() => undefined))
            .rejects.toMatchObject({ category: 'protocol' });

        const database = inspectionDatabase();
        expect(database.prepare(
            'SELECT store_updated_at_ms FROM state_meta WHERE singleton = 1',
        ).get()?.store_updated_at_ms).toBeNull();
        database.close();
    });

    it('rejects policy tampering and reapplies the complete runtime policy', async () => {
        const runtime = await openRuntime();
        await expect(runtime.write_transaction('policy-tamper', (tx) => {
            tx.prepare('PRAGMA secure_delete = OFF').get();
        })).rejects.toMatchObject({ category: 'protocol' });

        await expect(runtime.read_transaction((tx) => ({
            foreignKeys: tx.safe_integer(tx.prepare('PRAGMA foreign_keys').get()?.foreign_keys),
            trustedSchema: tx.safe_integer(tx.prepare('PRAGMA trusted_schema').get()?.trusted_schema),
            synchronous: tx.safe_integer(tx.prepare('PRAGMA synchronous').get()?.synchronous),
            secureDelete: tx.safe_integer(tx.prepare('PRAGMA secure_delete').get()?.secure_delete),
            queryOnly: tx.safe_integer(tx.prepare('PRAGMA query_only').get()?.query_only),
            journalMode: tx.prepare('PRAGMA journal_mode').get()?.journal_mode,
        }))).resolves.toEqual({
            foreignKeys: 1,
            trustedSchema: 0,
            synchronous: 2,
            secureDelete: 1,
            queryOnly: 1,
            journalMode: 'delete',
        });
    });

    it('faults on unexpected WAL without a journal-mode transition or WAL evidence mutation', async () => {
        const opened = await open_existing_sqlite_database(databasePath());
        const exec = vi.spyOn(opened.database, 'exec');
        let walBefore: Buffer | undefined;
        const runtime = await open_sqlite_runtime(databasePath(), {
            identity,
            clientKind: 'vitest',
            clientVersion: '0.7.0',
            adoptedConnection: opened,
            hooks: {
                onEvent(event) {
                    if (event !== 'after-commit') return;
                    expect(opened.database.prepare(
                        'PRAGMA journal_mode = WAL',
                    ).get()?.journal_mode).toBe('wal');
                    opened.database.prepare(`UPDATE state_meta SET store_updated_at_ms = 77
                        WHERE singleton = 1`).run();
                    walBefore = fs.readFileSync(`${databasePath()}-wal`);
                },
            },
        });
        runtimeHandles.push(runtime);

        await expect(runtime.write_transaction('unexpected-wal', (tx) => {
            tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 66
                WHERE singleton = 1`).run();
        })).rejects.toMatchObject({ category: 'protocol' });
        expect(exec.mock.calls.some(([sql]) => /PRAGMA\s+journal_mode\s*=/.test(sql))).toBe(false);
        expect(opened.database.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
        expect(fs.readFileSync(`${databasePath()}-wal`)).toEqual(walBefore);
        await expect(runtime.read_transaction(() => undefined))
            .rejects.toMatchObject({ category: 'protocol' });
    });

    it('runs deferred reads in one coherent snapshot', async () => {
        const runtime = await openRuntime();
        const result = await runtime.read_transaction((tx) => {
            const before = tx.safe_integer(tx.prepare(
                'SELECT next_revision FROM state_meta WHERE singleton = 1',
            ).get()?.next_revision);
            const outside = inspectionDatabase();
            expect(() => outside.prepare(
                'UPDATE state_meta SET next_revision = next_revision + 1 WHERE singleton = 1',
            ).run()).toThrow();
            outside.close();
            const after = tx.safe_integer(tx.prepare(
                'SELECT next_revision FROM state_meta WHERE singleton = 1',
            ).get()?.next_revision);
            return { before, after };
        });
        expect(result).toEqual({ before: 1, after: 1 });
    });

    it('rejects thenables, invokes a callback once, and recovers the queue after callback failure', async () => {
        const runtime = await openRuntime();
        let calls = 0;
        await expect(runtime.write_transaction('thenable', () => {
            calls += 1;
            return Promise.resolve('not synchronous') as unknown as string;
        })).rejects.toThrow(TypeError);
        expect(calls).toBe(1);

        const callbackError = new Error('callback failed');
        await expect(runtime.write_transaction('throwing', () => {
            calls += 1;
            throw callbackError;
        })).rejects.toBe(callbackError);

        await expect(runtime.write_transaction('recovered', (tx) => {
            calls += 1;
            tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 10
                WHERE singleton = 1 AND store_updated_at_ms IS NULL`).run();
            return 'ok';
        })).resolves.toBe('ok');
        expect(calls).toBe(3);
    });

    it('tracks changes executed through returning statements, not only run()', async () => {
        const runtime = await openRuntime();
        await runtime.write_transaction('returning-change', (tx) => {
            expect(tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 11
                WHERE singleton = 1 RETURNING store_updated_at_ms`).get()?.store_updated_at_ms).toBe(11n);
        });
        const database = inspectionDatabase();
        expect(marker(database, runtime.writer_session_id)?.sequence).toBe(1n);
        database.close();
    });

    it('leaves the writer marker unchanged for no-op transactions', async () => {
        const runtime = await openRuntime();
        await runtime.write_transaction('no-op', (tx) => {
            tx.prepare('UPDATE state_meta SET store_updated_at_ms = 1 WHERE singleton = 2').run();
        });
        const database = inspectionDatabase();
        expect(marker(database, runtime.writer_session_id)).toEqual({
            sequence: 0n,
            operationId: null,
            operationKind: null,
        });
        database.close();
    });

    it('rolls back an injected failure after BEGIN and lets the queue recover', async () => {
        let failAfterBegin = true;
        let callbackRan = false;
        const runtime = await openRuntime({
            onEvent(event) {
                if (event === 'after-write-begin' && failAfterBegin) {
                    failAfterBegin = false;
                    throw new Error('after begin fault');
                }
            },
        });
        await expect(runtime.write_transaction('after-begin-fault', () => {
            callbackRan = true;
        })).rejects.toBeInstanceOf(SqliteFileStateError);
        expect(callbackRan).toBe(false);
        await expect(runtime.write_transaction('queue-recovered', (tx) => {
            tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 12
                WHERE singleton = 1`).run();
        })).resolves.toBeUndefined();
    });

    it('reconciles a successful commit whose response was lost without replaying the callback', async () => {
        let callbackCalls = 0;
        let loseResponse = true;
        const runtime = await openRuntime({
            commit(commit) {
                commit();
                if (loseResponse) {
                    loseResponse = false;
                    throw new Error('lost commit response');
                }
            },
        });
        await expect(runtime.write_transaction('ambiguous-success', (tx) => {
            callbackCalls += 1;
            tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 20
                WHERE singleton = 1`).run();
            return 'committed-result';
        })).resolves.toBe('committed-result');
        expect(callbackCalls).toBe(1);

        const database = inspectionDatabase();
        const durable = marker(database, runtime.writer_session_id);
        expect(durable?.sequence).toBe(1n);
        expect(durable?.operationKind).toBe('ambiguous-success');
        database.close();

        await expect(runtime.read_transaction((tx) => tx.safe_integer(tx.prepare(
            'SELECT store_updated_at_ms FROM state_meta WHERE singleton = 1',
        ).get()?.store_updated_at_ms))).resolves.toBe(20);
    });

    it('reconciles under its retained reader token while exclusive recovery waits normally', async () => {
        const reconcileOpenStarted = deferred();
        const allowFreshOpen = deferred();
        let loseResponse = true;
        const runtime = await open_sqlite_runtime(databasePath(), {
            identity,
            clientKind: 'vitest',
            clientVersion: '0.7.0',
            async openConnection(canonicalPath) {
                const opened = await open_existing_sqlite_database(canonicalPath);
                return {
                    ...opened,
                    async replaceConnection(options) {
                        reconcileOpenStarted.resolve();
                        await allowFreshOpen.promise;
                        return opened.replaceConnection(options);
                    },
                };
            },
            hooks: {
                commit(commit) {
                    commit();
                    if (loseResponse) {
                        loseResponse = false;
                        throw new Error('lost commit response');
                    }
                },
            },
        });
        runtimeHandles.push(runtime);

        const write = runtime.write_transaction('continuous-reconcile-gate', (tx) => {
            tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 21
                WHERE singleton = 1`).run();
        });
        await reconcileOpenStarted.promise;
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toHaveLength(1);

        const recoveryWaiting = deferred();
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath(), {
            onEvent(event) {
                if (event === 'exclusive-waiting-for-readers') recoveryWaiting.resolve();
            },
        });
        const draining = exclusive.waitForReaders();
        await recoveryWaiting.promise;
        expect(exclusive.listReaderTokenIds()).toHaveLength(1);
        expect(inspect_sqlite_recovery_gate(databasePath()).exclusiveIntentTokenId).toBe(exclusive.tokenId);

        allowFreshOpen.resolve();
        await expect(write).resolves.toBeUndefined();
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            exclusiveIntentTokenId: exclusive.tokenId,
            readerTokenIds: [expect.any(String)],
        });

        let drained = false;
        void draining.then(() => { drained = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        await runtime.close();
        await draining;
        expect(exclusive.listReaderTokenIds()).toEqual([]);
        await exclusive.release();
    });

    it('sanitizes spoofed SqliteFileStateError names during indeterminate reconciliation', async () => {
        const nativeMessage = `spoofed reconciliation at ${databasePath()}`;
        const fake = Object.assign(new Error(nativeMessage), {
            name: 'SqliteFileStateError',
            category: 'readonly',
            metadata: { operation: nativeMessage },
        });
        const runtime = await open_sqlite_runtime(databasePath(), {
            identity,
            clientKind: 'vitest',
            clientVersion: '0.7.0',
            async openConnection(canonicalPath) {
                const opened = await open_existing_sqlite_database(canonicalPath);
                return {
                    ...opened,
                    async replaceConnection() {
                        await opened.close();
                        throw fake;
                    },
                };
            },
            hooks: {
                commit(commit) {
                    commit();
                    throw new Error('lost response');
                },
            },
        });
        runtimeHandles.push(runtime);

        try {
            await runtime.write_transaction('spoofed-reconcile', (tx) => {
                tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 22
                    WHERE singleton = 1`).run();
            });
            throw new Error('expected reconciliation failure');
        } catch (error) {
            expect(error).toBeInstanceOf(SqliteFileStateError);
            expect(error).not.toBe(fake);
            expect((error as SqliteFileStateError).category).toBe('commit');
            expect((error as Error).message).not.toContain(nativeMessage);
            expect(JSON.stringify((error as SqliteFileStateError).metadata)).not.toContain(nativeMessage);
            expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
        }
    });

    it('recognizes an exact previous healthy marker as a known rollback without replay', async () => {
        let callbackCalls = 0;
        let injectRollback = true;
        const runtime = await openRuntime({
            commit(commit, rollback) {
                if (injectRollback) {
                    injectRollback = false;
                    rollback();
                    throw new Error('ambiguous rollback response');
                }
                commit();
            },
        });
        await expect(runtime.write_transaction('ambiguous-rollback', (tx) => {
            callbackCalls += 1;
            tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 30
                WHERE singleton = 1`).run();
        })).rejects.toBeInstanceOf(SqliteFileStateError);
        expect(callbackCalls).toBe(1);

        await expect(runtime.read_transaction((tx) => tx.prepare(
            'SELECT store_updated_at_ms FROM state_meta WHERE singleton = 1',
        ).get()?.store_updated_at_ms)).resolves.toBeNull();
        await expect(runtime.write_transaction('later-success', (tx) => {
            tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 31
                WHERE singleton = 1`).run();
        })).resolves.toBeUndefined();
    });

    it('faults on an indeterminate advanced marker and blocks queued and later operations', async () => {
        let sabotage = true;
        let queuedCallbackRan = false;
        let runtime!: SqliteRuntimeHandle;
        runtime = await openRuntime({
            commit(commit) {
                commit();
                if (!sabotage) return;
                sabotage = false;
                const database = inspectionDatabase();
                database.prepare(`UPDATE writer_sessions
                    SET last_committed_sequence = last_committed_sequence + 1,
                        last_operation_id = 'foreign-operation',
                        last_operation_kind = 'foreign-kind'
                    WHERE writer_session_id = ?`).run(runtime.writer_session_id);
                database.close();
                throw new Error('lost response after marker sabotage');
            },
        });

        const first = runtime.write_transaction('indeterminate', (tx) => {
            tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 40
                WHERE singleton = 1`).run();
        });
        const queued = runtime.read_transaction(() => {
            queuedCallbackRan = true;
            return 'overtook';
        });
        await expect(first).rejects.toMatchObject({ category: 'commit' });
        await expect(queued).rejects.toMatchObject({ category: 'commit' });
        expect(queuedCallbackRan).toBe(false);
        await expect(runtime.read_transaction(() => undefined)).rejects.toMatchObject({ category: 'commit' });
    });

    it('faults when the fresh reconciliation connection cannot open', async () => {
        let loseResponse = true;
        const runtime = await open_sqlite_runtime(databasePath(), {
            identity,
            clientKind: 'vitest',
            clientVersion: '0.7.0',
            async openConnection(canonicalPath) {
                const opened = await open_existing_sqlite_database(canonicalPath, {
                    validate(database) {
                        database.prepare('SELECT 1').get();
                    },
                });
                return {
                    ...opened,
                    async replaceConnection() {
                        await opened.close();
                        throw new Error('reconciliation open failed');
                    },
                };
            },
            hooks: {
                commit(commit) {
                    commit();
                    if (loseResponse) {
                        loseResponse = false;
                        throw new Error('lost response');
                    }
                },
            },
        });
        runtimeHandles.push(runtime);
        await expect(runtime.write_transaction('unreadable-reconcile', (tx) => {
            tx.prepare(`UPDATE state_meta SET store_updated_at_ms = 50
                WHERE singleton = 1`).run();
        })).rejects.toMatchObject({ category: 'commit' });
        await expect(runtime.write_transaction('blocked', () => undefined))
            .rejects.toMatchObject({ category: 'commit' });
    });

    it('rechecks generation after taking the registration writer lock', async () => {
        await expect(open_sqlite_runtime(databasePath(), {
            identity,
            clientKind: 'vitest',
            clientVersion: '0.7.0',
            hooks: {
                onEvent(event) {
                    if (event !== 'before-session-register') return;
                    const database = inspectionDatabase();
                    database.prepare(`UPDATE state_meta
                        SET coordination_generation = coordination_generation + 1
                        WHERE singleton = 1`).run();
                    database.close();
                },
            },
        })).rejects.toMatchObject({ category: 'protocol' });

        const database = inspectionDatabase();
        expect(database.prepare('SELECT count(*) AS count FROM writer_sessions').get()?.count).toBe(0);
        database.close();
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toHaveLength(0);
    });

    it('rechecks generation after BEGIN IMMEDIATE and fences an old runtime', async () => {
        const runtime = await openRuntime();
        const database = inspectionDatabase();
        database.prepare(`UPDATE state_meta
            SET coordination_generation = coordination_generation + 1
            WHERE singleton = 1`).run();
        database.close();

        let callbackRan = false;
        await expect(runtime.write_transaction('old-generation', () => {
            callbackRan = true;
        })).rejects.toMatchObject({ category: 'protocol' });
        expect(callbackRan).toBe(false);
    });

    it('rejects incompatible validation contracts for an interned path', async () => {
        await openRuntime();
        await expect(open_sqlite_runtime(databasePath(), {
            identity: { ...identity, coordinationGeneration: 1 },
            clientKind: 'vitest',
            clientVersion: '0.7.0',
        })).rejects.toMatchObject({ category: 'protocol' });
        await expect(open_sqlite_runtime(databasePath(), {
            identity,
            clientKind: 'vitest',
            clientVersion: '0.7.0',
            requiresPendingEditRecovery: true,
        })).rejects.toMatchObject({ category: 'protocol' });
    });

    it('closes the connection and releases the reader token when final cleanup injection throws', async () => {
        const runtime = await openRuntime({
            onEvent(event) {
                if (event === 'before-final-cleanup') throw new Error('cleanup hook fault');
            },
        });
        await expect(runtime.close()).resolves.toBeUndefined();
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toHaveLength(0);
    });

    it('closes the connection and releases the reader token even when a close hook throws', async () => {
        const runtime = await openRuntime({
            onEvent(event) {
                if (event === 'before-connection-close') throw new Error('close hook fault');
            },
        });
        await expect(runtime.close()).rejects.toThrow('close hook fault');
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toHaveLength(0);
    });

    it('best-effort deletes session-owned leases only at final close', async () => {
        const first = await openRuntime();
        const second = await openRuntime();
        await first.write_transaction('lease', (tx) => {
            tx.prepare(`INSERT INTO entry_leases (
                lease_id, writer_session_id, current_entry_path,
                acquired_at_ms, acquired_generation
            ) VALUES ('lease-id', ?, '/entry.csv', 1, 1)`).run(first.writer_session_id);
        });
        await first.close();
        const database = inspectionDatabase();
        expect(database.prepare('SELECT count(*) AS count FROM entry_leases').get()?.count).toBe(1);
        await second.close();
        expect(database.prepare('SELECT count(*) AS count FROM entry_leases').get()?.count).toBe(0);
        database.close();
    });
});
