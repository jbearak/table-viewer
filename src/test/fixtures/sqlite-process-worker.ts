import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { categorize_sqlite_file_state_error } from '../../sqlite-file-state-errors';
import { open_sqlite_file_state_store } from '../../sqlite-file-state-persistence';
import {
    acquire_sqlite_exclusive_recovery_gate,
    acquire_sqlite_shared_reader_gate,
    initialize_sqlite_database_no_clobber,
    inspect_sqlite_recovery_gate,
    install_recognized_sqlite_candidate_no_clobber,
    inventory_sqlite_basename,
    preserve_sqlite_basename_set,
    reclaim_stale_sqlite_exclusive_intent,
    resume_sqlite_basename_preservation,
    type SqliteExclusiveRecoveryGate,
    type SqliteOpenedDatabase,
    type SqliteOpenRecoveryEvent,
    type SqliteSharedReaderGate,
} from '../../sqlite-open-recovery';
import type {
    AuthorityFileStateStore,
    FileStateLease,
    KeyedFileStatePersistence,
} from '../../state';
import type { SqliteRuntimeEvent, SqliteRuntimeHooks } from '../../sqlite-runtime';

interface WorkerOptions {
    readonly mode?: 'store' | 'raw' | 'recovery';
    readonly maxStoredFiles?: number;
    readonly readyEventName?: string;
    readonly ambiguousCommit?: {
        readonly reconciliationReleasePath: string;
    };
}

interface WorkerRequest {
    readonly id: number;
    readonly command: string;
    readonly payload: any;
}

const databasePath = process.env.TABLE_VIEWER_SQLITE_WORKER_DATABASE;
if (!databasePath) throw new Error('Missing SQLite worker database path.');
const options = JSON.parse(process.env.TABLE_VIEWER_SQLITE_WORKER_OPTIONS ?? '{}') as WorkerOptions;
const leases = new Map<string, FileStateLease>();
const runtimeEvents: SqliteRuntimeEvent[] = [];
const barriers = new Map<string, () => void>();
let store: AuthorityFileStateStore | undefined;
let persistence: KeyedFileStatePersistence | undefined;
let closeStore: (() => Promise<void>) | undefined;
let rawDatabase: DatabaseSync | undefined;
let recoveryGate: SqliteSharedReaderGate | SqliteExclusiveRecoveryGate | undefined;
let recoveryDatabase: SqliteOpenedDatabase | undefined;
let ambiguousCommitPending = options.ambiguousCommit !== undefined;
let reconciliationReadySent = false;

function send(message: unknown): void {
    if (!process.send) throw new Error('SQLite worker IPC is unavailable.');
    process.send(message);
}

async function crossBarrier(barrierId: string, name: string, occurrence?: number): Promise<void> {
    if (barriers.has(barrierId)) throw new Error(`Duplicate barrier: ${barrierId}`);
    const released = new Promise<void>((resolve) => barriers.set(barrierId, resolve));
    send({
        type: 'event',
        name: 'barrier',
        value: { barrierId, name, ...(occurrence === undefined ? {} : { occurrence }) },
    });
    await released;
    barriers.delete(barrierId);
}

function recoveryHooks(payload: any): { onEvent(event: SqliteOpenRecoveryEvent): Promise<void> } | undefined {
    if (typeof payload.pauseEvent !== 'string' || typeof payload.barrierId !== 'string') return undefined;
    const pauseOccurrence = payload.pauseOccurrence ?? 1;
    if (!Number.isSafeInteger(pauseOccurrence) || pauseOccurrence < 1) {
        throw new Error('Recovery pause occurrence must be a positive safe integer.');
    }
    let occurrence = 0;
    return {
        async onEvent(event) {
            if (event !== payload.pauseEvent) return;
            occurrence += 1;
            if (occurrence === pauseOccurrence) {
                await crossBarrier(payload.barrierId, event, occurrence);
            }
        },
    };
}

const recoveryIdentity = {
    productKind: 'desktop' as const,
    databaseId: `test-database:${databasePath}`,
    storageEnvironmentId: `test-environment:${databasePath}`,
};

function serializeError(error: unknown): {
    name: string;
    message: string;
    category?: string;
    operation?: string;
} {
    const value = error instanceof Error ? error : new Error(String(error));
    const metadata = value as Error & {
        category?: unknown;
        operation?: unknown;
        metadata?: { operation?: unknown };
    };
    const operation = typeof metadata.operation === 'string'
        ? metadata.operation
        : metadata.metadata?.operation;
    return {
        name: value.name,
        message: value.message,
        ...(typeof metadata.category === 'string' ? { category: metadata.category } : {}),
        ...(typeof operation === 'string' ? { operation } : {}),
    };
}

function openRaw(readOnly = false, timeout = 0): DatabaseSync {
    const database = new DatabaseSync(databasePath as string, {
        readOnly,
        timeout,
        enableDoubleQuotedStringLiterals: false,
    });
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA trusted_schema = OFF');
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA secure_delete = ON');
    return database;
}

function waitForObservableFile(filePath: string): void {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(filePath)) {
        if (Date.now() >= deadline) throw new Error('Timed out polling reconciliation release file.');
    }
}

function runtimeHooks(): SqliteRuntimeHooks | undefined {
    if (!options.ambiguousCommit) return undefined;
    return {
        onEvent(event) {
            runtimeEvents.push(event);
            if (event !== 'before-reconcile-open' || reconciliationReadySent) return;
            reconciliationReadySent = true;
            send({ type: 'event', name: 'reconciliation-ready' });
            waitForObservableFile(options.ambiguousCommit?.reconciliationReleasePath as string);
        },
        commit(commit) {
            commit();
            if (!ambiguousCommitPending) return;
            ambiguousCommitPending = false;
            throw new Error('injected lost commit response');
        },
    };
}

async function initialize(): Promise<void> {
    if ((options.mode ?? 'store') !== 'store') return;
    const opened = await open_sqlite_file_state_store(databasePath as string, {
        identity: {
            productKind: 'desktop',
            databaseId: `test-database:${databasePath}`,
            storageEnvironmentId: `test-environment:${databasePath}`,
        },
        migration: { appliedAtMs: 1, appVersion: 'sqlite-multiprocess-test' },
        clientKind: 'sqlite-process-worker',
        clientVersion: 'sqlite-multiprocess-test',
        hooks: runtimeHooks(),
        timeoutMs: 5_000,
    }, () => options.maxStoredFiles ?? 10_000);
    store = opened.store;
    persistence = opened.persistence;
    closeStore = opened.close;
}

function requireStore(): AuthorityFileStateStore {
    if (!store) throw new Error('This worker was not opened in store mode.');
    return store;
}

function canonicalKey(kind: string | undefined): (filePath: string) => string {
    if (kind === 'lowercase') return (filePath) => filePath.toLowerCase();
    return (filePath) => filePath;
}

async function handle(command: string, payload: any): Promise<unknown> {
    switch (command) {
        case 'read':
            return requireStore().read(payload.path);
        case 'readAuthority':
            return requireStore().read_authority(payload.path);
        case 'cas':
            if (typeof payload.barrierId === 'string') {
                await crossBarrier(payload.barrierId, payload.barrierName ?? 'before-cas');
            }
            return requireStore().compare_and_set(
                payload.path,
                payload.expectedRevision,
                payload.state,
                undefined,
                payload.basis,
            );
        case 'stage':
            return requireStore().stage_authority_transaction(payload.path, payload.stage);
        case 'finalize':
            return requireStore().finalize_authority_transaction(payload.path, payload.stageId);
        case 'canonicalize':
            await requireStore().canonicalize_path?.(
                payload.canonicalPath,
                canonicalKey(payload.keyKind),
            );
            return null;
        case 'lease': {
            const lease = await requireStore().lease_entry?.(
                payload.canonicalPath,
                canonicalKey(payload.keyKind),
                payload.copyFromIfAbsent,
                payload.copyId,
            );
            if (!lease) throw new Error('Lease API is unavailable.');
            leases.set(payload.handleId, lease);
            return null;
        }
        case 'releaseLease': {
            const lease = leases.get(payload.handleId);
            if (!lease) throw new Error('Unknown lease handle.');
            await lease.release();
            leases.delete(payload.handleId);
            return null;
        }
        case 'ambiguousCasWithQueuedRead': {
            runtimeEvents.length = 0;
            const committed = requireStore().compare_and_set(
                payload.path,
                payload.expectedRevision,
                payload.state,
            );
            const queued = requireStore().read(payload.path);
            const [commitResult, readResult] = await Promise.all([committed, queued]);
            return { commitResult, readResult, runtimeEvents };
        }
        case 'rawBeginWrite': {
            rawDatabase = openRaw(false, 5_000);
            rawDatabase.exec('BEGIN IMMEDIATE');
            rawDatabase.prepare(payload.sql).run(...(payload.parameters ?? []));
            send({ type: 'event', name: 'write-uncommitted' });
            return null;
        }
        case 'rawCommit':
            rawDatabase?.exec('COMMIT');
            rawDatabase?.close();
            rawDatabase = undefined;
            return null;
        case 'rawBeginSnapshot': {
            rawDatabase = openRaw(false, 5_000);
            rawDatabase.exec('PRAGMA query_only = ON; BEGIN');
            const row = rawDatabase.prepare(payload.sql).get(...(payload.parameters ?? []));
            send({ type: 'event', name: 'snapshot-open', value: row });
            return row;
        }
        case 'rawFinishSnapshot': {
            const row = rawDatabase?.prepare(payload.sql).get(...(payload.parameters ?? []));
            rawDatabase?.exec('COMMIT');
            rawDatabase?.close();
            rawDatabase = undefined;
            return row;
        }
        case 'rawHoldWriteLock':
            rawDatabase = openRaw(false, 0);
            rawDatabase.exec('BEGIN IMMEDIATE');
            send({ type: 'event', name: 'write-lock-held' });
            return null;
        case 'rawRollback':
            rawDatabase?.exec('ROLLBACK');
            rawDatabase?.close();
            rawDatabase = undefined;
            return null;
        case 'rawCategorizeContention': {
            const database = openRaw(false, 0);
            try {
                database.exec('BEGIN IMMEDIATE');
                database.exec('ROLLBACK');
                return { category: 'none' };
            } catch (error) {
                const categorized = categorize_sqlite_file_state_error(error, { operation: 'probe-contention' });
                return { category: categorized.category };
            } finally {
                database.close();
            }
        }
        case 'rawCategorizeCorruption': {
            const database = new DatabaseSync(payload.path, {
                readOnly: true,
                timeout: 0,
                enableDoubleQuotedStringLiterals: false,
            });
            try {
                database.prepare('SELECT * FROM sqlite_schema').all();
                return { category: 'none' };
            } catch (error) {
                const categorized = categorize_sqlite_file_state_error(error, { operation: 'probe-corruption' });
                return { category: categorized.category };
            } finally {
                database.close();
            }
        }
        case 'releaseBarrier': {
            const release = barriers.get(payload.barrierId);
            if (!release) throw new Error(`Unknown barrier: ${payload.barrierId}`);
            release();
            return null;
        }
        case 'recoveryAcquireReader':
            recoveryGate = await acquire_sqlite_shared_reader_gate(
                databasePath as string,
                recoveryHooks(payload),
            );
            return { tokenId: recoveryGate.tokenId };
        case 'recoveryAcquireExclusive':
            recoveryGate = await acquire_sqlite_exclusive_recovery_gate(
                databasePath as string,
                recoveryHooks(payload),
            );
            return { tokenId: recoveryGate.tokenId };
        case 'recoveryWaitReaders':
            if (recoveryGate?.kind !== 'exclusive-recovery') throw new Error('Exclusive gate is unavailable.');
            await recoveryGate.waitForReaders();
            return null;
        case 'recoveryInspect':
            return inspect_sqlite_recovery_gate(databasePath as string);
        case 'recoveryReleaseGate':
            await recoveryGate?.release();
            recoveryGate = undefined;
            return null;
        case 'recoveryReclaimReader':
            if (recoveryGate?.kind !== 'exclusive-recovery') throw new Error('Exclusive gate is unavailable.');
            await recoveryGate.reclaimStaleReaderToken(payload.tokenId, { allProcessesClosed: true });
            return null;
        case 'recoveryReclaimExclusive':
            await reclaim_stale_sqlite_exclusive_intent(
                databasePath as string,
                payload.tokenId,
                { allProcessesClosed: true },
            );
            return null;
        case 'recoveryInitialize': {
            if (payload.exclusive) {
                recoveryGate = await acquire_sqlite_exclusive_recovery_gate(databasePath as string);
                await recoveryGate.waitForReaders();
            }
            const initialized = await initialize_sqlite_database_no_clobber(
                databasePath as string,
                recoveryIdentity,
                { appliedAtMs: 1, appVersion: 'sqlite-process-worker' },
                {
                    ...recoveryHooks(payload),
                    ...(recoveryGate ? { gate: recoveryGate } : {}),
                },
            );
            recoveryDatabase = initialized.database;
            return {
                installed: initialized.installed,
                wonInstallation: initialized.wonInstallation,
                tokenId: recoveryGate?.tokenId,
            };
        }
        case 'recoveryResumeCandidate': {
            if (recoveryGate?.kind !== 'exclusive-recovery') {
                recoveryGate = await acquire_sqlite_exclusive_recovery_gate(databasePath as string);
                await recoveryGate.waitForReaders();
            }
            const inventory = await inventory_sqlite_basename(databasePath as string);
            const candidate = inventory.candidates[0];
            if (!candidate) throw new Error('No initialization candidate is available.');
            const resumed = await install_recognized_sqlite_candidate_no_clobber(
                databasePath as string,
                path.join(path.dirname(databasePath as string), candidate.name),
                recoveryIdentity,
                { gate: recoveryGate, ...recoveryHooks(payload) },
            );
            recoveryDatabase = resumed.database;
            return { installed: resumed.installed, tokenId: recoveryGate.tokenId };
        }
        case 'recoveryPreserve': {
            if (recoveryGate?.kind !== 'exclusive-recovery') {
                recoveryGate = await acquire_sqlite_exclusive_recovery_gate(databasePath as string);
                await recoveryGate.waitForReaders();
            }
            const result = await preserve_sqlite_basename_set(databasePath as string, {
                gate: recoveryGate,
                ...recoveryHooks(payload),
            });
            return { ...result, tokenId: recoveryGate.tokenId };
        }
        case 'recoveryResumePreserve': {
            if (recoveryGate?.kind !== 'exclusive-recovery') {
                recoveryGate = await acquire_sqlite_exclusive_recovery_gate(databasePath as string);
                await recoveryGate.waitForReaders();
            }
            const result = await resume_sqlite_basename_preservation(databasePath as string, {
                gate: recoveryGate,
                ...recoveryHooks(payload),
            });
            return { ...result, tokenId: recoveryGate.tokenId };
        }
        case 'close':
            if (rawDatabase) {
                try { rawDatabase.exec('ROLLBACK'); } catch { /* Best effort for test shutdown. */ }
                rawDatabase.close();
                rawDatabase = undefined;
            }
            await closeStore?.();
            closeStore = undefined;
            await recoveryDatabase?.close();
            recoveryDatabase = undefined;
            await recoveryGate?.release();
            recoveryGate = undefined;
            return null;
        default:
            throw new Error(`Unknown SQLite worker command: ${command}`);
    }
}

process.on('message', (request: WorkerRequest) => {
    void handle(request.command, request.payload).then(
        (value) => {
            send({ type: 'result', id: request.id, value });
            if (request.command === 'close') process.disconnect?.();
        },
        (error) => send({ type: 'error', id: request.id, error: serializeError(error) }),
    );
});

void initialize().then(
    () => {
        send({ type: 'ready', pid: process.pid });
        if (options.readyEventName) send({ type: 'event', name: options.readyEventName });
    },
    (error) => {
        process.stderr.write(`${serializeError(error).message}\n`);
        process.exitCode = 1;
        process.disconnect?.();
    },
);
