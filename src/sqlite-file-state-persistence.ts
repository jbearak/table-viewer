import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    create_coordinated_keyed_authority_store,
    drain_keyed_state_runtime,
    type CoordinatedAuthorityFileStateStore,
    type CoordinatedKeyedFileStatePersistence,
} from './state';
import {
    initialize_sqlite_database_no_clobber,
    type SqliteInitializeOptions,
} from './sqlite-open-recovery';
import {
    categorize_sqlite_file_state_error,
    sqlite_file_state_error,
} from './sqlite-file-state-errors';
import type {
    SqliteFileStateIdentity,
    SqliteFileStateMigrationOptions,
} from './sqlite-file-state-schema';
import {
    open_sqlite_runtime,
    type SqliteRuntimeHandle,
    type SqliteRuntimeHooks,
    type SqliteWriteTransactionContext,
} from './sqlite-runtime';
import {
    create_sqlite_file_state_read_repository,
    create_sqlite_file_state_write_repository,
    SqliteFileStateRepository,
} from './sqlite-file-state-repository';

export interface SqliteFileStatePersistenceOptions {
    readonly identity: SqliteFileStateIdentity;
    readonly migration: SqliteFileStateMigrationOptions;
    readonly clientKind: string;
    readonly clientVersion: string;
    readonly supportedProtocol?: number;
    readonly requiresPendingEditRecovery?: boolean;
    readonly timeoutMs?: number;
    readonly now?: () => number;
    readonly randomId?: () => string;
    readonly hooks?: SqliteRuntimeHooks;
    readonly initialization?: SqliteInitializeOptions;
}

export interface OpenedSqliteFileStateStore {
    readonly store: CoordinatedAuthorityFileStateStore;
    readonly persistence: CoordinatedKeyedFileStatePersistence;
    close(): Promise<void>;
}

function supported_protocol(options: SqliteFileStatePersistenceOptions): number | undefined {
    const configured = options.supportedProtocol;
    const initialization = options.initialization?.supportedProtocol;
    if (configured !== undefined && initialization !== undefined
        && configured !== initialization) {
        throw sqlite_file_state_error('protocol', {
            operation: 'supported-protocol-configuration',
            protocol: configured,
        });
    }
    return configured ?? initialization;
}

/** Adapt one runtime handle to the keyed semantic persistence port. */
export function create_sqlite_file_state_persistence_from_runtime(
    runtime: SqliteRuntimeHandle,
    options: {
        readonly now?: () => number;
        readonly supportsRecoveryRecords?: boolean;
    } = {},
): CoordinatedKeyedFileStatePersistence {
    let closePromise: Promise<void> | undefined;
    const now = options.now ?? Date.now;
    const repository = (tx: SqliteWriteTransactionContext) => (
        new SqliteFileStateRepository(tx, {
            writerSessionId: runtime.writer_session_id,
            now,
        })
    );
    const persistence: CoordinatedKeyedFileStatePersistence = {
        runtime_key: runtime.runtime_key,
        canonicalization_revision_policy: 'allocate-revision-when-target-absent',
        supports_recovery_records: options.supportsRecoveryRecords ?? false,
        read_transaction: (body) => runtime.read_transaction((tx) => body(
            create_sqlite_file_state_read_repository(tx, {
                writerSessionId: runtime.writer_session_id,
                now,
            }),
        )),
        write_transaction: (kind, body) => runtime.write_transaction(kind, (tx) => body(
            create_sqlite_file_state_write_repository(tx, {
                writerSessionId: runtime.writer_session_id,
                now,
            }),
        )),
        async acquire_edit_session(canonicalPath, canonicalKey, hostLock) {
            if (!canonicalPath || !hostLock.hostLockId || !hostLock.physicalResourceLockKey) {
                return { type: 'unsupportedIdentity' } as const;
            }
            if (!await hostLock.verify()) return { type: 'busy' } as const;
            return runtime.async_write_transaction('acquireEditSession', async (tx) => {
                const repo = repository(tx);
                const aliases = repo.scan_entry_metadata().filter((entry) => (
                    entry.path === canonicalPath || canonicalKey(entry.path) === canonicalPath
                ));
                if (aliases.some((entry) => entry.path !== canonicalPath)) {
                    return { type: 'unsupportedIdentity' } as const;
                }
                const existing = repo.read_edit_session(canonicalPath);
                if (existing) {
                    if (existing.ownerWriterSessionId === runtime.writer_session_id
                        && existing.hostLockId === hostLock.hostLockId
                        && existing.physicalResourceLockKey === hostLock.physicalResourceLockKey) {
                        if (!await hostLock.verify()) return { type: 'busy' } as const;
                        return {
                            type: 'acquired',
                            session: {
                                editSessionId: existing.editSessionId,
                                ownershipGeneration: existing.ownershipGeneration,
                            },
                        } as const;
                    }
                    return { type: 'busy' } as const;
                }
                const conflicting = tx.prepare(`SELECT 1 AS present FROM edit_sessions
                    WHERE physical_resource_lock_key = ? OR host_lock_id = ? LIMIT 1`).get(
                    hostLock.physicalResourceLockKey,
                    hostLock.hostLockId,
                );
                if (conflicting) return { type: 'busy' } as const;
                if (!await hostLock.verify()) return { type: 'busy' } as const;
                const timestamp = now();
                if (!repo.read_entry_metadata(canonicalPath)) {
                    const absenceRevision = repo.metadata().absenceRevision;
                    repo.insert_empty_entry({
                        path: canonicalPath,
                        stateRevision: absenceRevision,
                        hasPendingEdits: false,
                        authority: {
                            commitSequence: 0,
                            authorityRevision: 0,
                            physicalRevision: 0,
                            projectionRevision: 0,
                        },
                        recencyOrder: repo.allocate_recency_order(),
                        recoveryEntryId: canonicalPath,
                        authorityStageCount: 0,
                    });
                    repo.set_updated_at(timestamp);
                }
                const session = {
                    editSessionId: randomUUID(),
                    ownershipGeneration: repo.allocate_ownership_generation(),
                };
                repo.insert_edit_session({
                    entryPath: canonicalPath,
                    physicalResourceLockKey: hostLock.physicalResourceLockKey,
                    hostLockId: hostLock.hostLockId,
                    ownerWriterSessionId: runtime.writer_session_id,
                    ...session,
                    acquiredAtMs: timestamp,
                    lastConfirmedAtMs: timestamp,
                });
                return { type: 'acquired', session } as const;
            });
        },
        release_edit_session(_filePath, session) {
            return runtime.write_transaction('releaseEditSession', (tx) => {
                const repo = repository(tx);
                const current = repo.read_edit_session_by_identity(
                    session.editSessionId,
                    session.ownershipGeneration,
                );
                if (!current) return;
                if (current.ownerWriterSessionId !== runtime.writer_session_id) {
                    throw sqlite_file_state_error('contention', { operation: 'edit-session-release' });
                }
                if (!repo.delete_edit_session(
                    current.entryPath,
                    session.editSessionId,
                    session.ownershipGeneration,
                )) {
                    throw sqlite_file_state_error('contention', { operation: 'edit-session-release' });
                }
            });
        },
        close(): Promise<void> {
            closePromise ??= drain_keyed_state_runtime(runtime.runtime_key)
                .then(() => runtime.close());
            return closePromise;
        },
    };
    return persistence;
}

/**
 * Initialize without clobbering an existing database, then transfer the same
 * gated connection into the process-local runtime interned by canonical path.
 */
export async function open_sqlite_file_state_persistence(
    databasePath: string,
    options: SqliteFileStatePersistenceOptions,
): Promise<CoordinatedKeyedFileStatePersistence> {
    try {
        await fs.promises.mkdir(path.dirname(path.resolve(databasePath)), {
            recursive: true,
            mode: 0o700,
        });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EROFS') {
            throw sqlite_file_state_error('readonly', { operation: 'persistence-directory-create' });
        }
        throw categorize_sqlite_file_state_error(error, { operation: 'persistence-directory-create' });
    }
    const supportedProtocol = supported_protocol(options);
    const initialized = await initialize_sqlite_database_no_clobber(
        databasePath,
        options.identity,
        options.migration,
        {
            ...options.initialization,
            timeoutMs: options.timeoutMs,
            supportedProtocol,
        },
    );
    const runtime = await open_sqlite_runtime(initialized.database.canonicalPath, {
        identity: options.identity,
        adoptedConnection: initialized.database,
        clientKind: options.clientKind,
        clientVersion: options.clientVersion,
        supportedProtocol,
        requiresPendingEditRecovery: options.requiresPendingEditRecovery,
        timeoutMs: options.timeoutMs,
        now: options.now,
        randomId: options.randomId,
        hooks: options.hooks,
    });
    return create_sqlite_file_state_persistence_from_runtime(runtime, {
        now: options.now,
        supportsRecoveryRecords: options.requiresPendingEditRecovery,
    });
}

export async function recover_stale_sqlite_coordination(
    databasePath: string,
    options: SqliteFileStatePersistenceOptions,
    confirmation: { readonly allProcessesClosed: true },
): Promise<number> {
    if (confirmation.allProcessesClosed !== true) {
        throw sqlite_file_state_error('recovery', { operation: 'coordination-reclaim-confirmation' });
    }
    const supportedProtocol = supported_protocol(options);
    const initialized = await initialize_sqlite_database_no_clobber(
        databasePath,
        options.identity,
        options.migration,
        {
            ...options.initialization,
            timeoutMs: options.timeoutMs,
            supportedProtocol,
        },
    );
    const database = initialized.database.database;
    try {
        database.exec('BEGIN IMMEDIATE');
        try {
            const statement = database.prepare(`SELECT coordination_generation
                FROM state_meta WHERE singleton = 1`);
            statement.setReadBigInts(true);
            const value = statement.get()?.coordination_generation;
            const generation = typeof value === 'bigint' ? Number(value) : value;
            if (!Number.isSafeInteger(generation) || (generation as number) < 1
                || (generation as number) >= Number.MAX_SAFE_INTEGER - 1) {
                throw sqlite_file_state_error('counter', { operation: 'coordination-generation' });
            }
            const next = (generation as number) + 1;
            database.prepare(`UPDATE state_meta SET coordination_generation = ?
                WHERE singleton = 1 AND coordination_generation = ?`).run(next, generation as number);
            database.exec(`DELETE FROM entry_leases;
                DELETE FROM edit_sessions;
                DELETE FROM writer_sessions
                    WHERE writer_session_id NOT IN (
                        SELECT owner_writer_session_id FROM edit_sessions
                    )`);
            database.exec('COMMIT');
            return next;
        } catch (error) {
            try { database.exec('ROLLBACK'); } catch { /* Preserve recovery failure. */ }
            throw error;
        }
    } finally {
        await initialized.database.close();
    }
}

/** Coordinated owner of one canonical database; both products open through here. */
export async function open_sqlite_file_state_store(
    databasePath: string,
    options: SqliteFileStatePersistenceOptions,
    getMaxStoredFiles?: () => number,
): Promise<OpenedSqliteFileStateStore> {
    const persistence = await open_sqlite_file_state_persistence(databasePath, options);
    const store = create_coordinated_keyed_authority_store(persistence, getMaxStoredFiles);
    return {
        store,
        persistence,
        close: () => persistence.close(),
    };
}
