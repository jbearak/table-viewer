import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    create_keyed_authority_store,
    drain_keyed_state_runtime,
    type AuthorityFileStateStore,
    type KeyedFileStatePersistence,
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
} from './sqlite-runtime';
import {
    create_sqlite_file_state_read_repository,
    create_sqlite_file_state_write_repository,
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
    readonly store: AuthorityFileStateStore;
    readonly persistence: KeyedFileStatePersistence;
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
): KeyedFileStatePersistence {
    let closePromise: Promise<void> | undefined;
    const now = options.now ?? Date.now;
    const persistence: KeyedFileStatePersistence = {
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
): Promise<KeyedFileStatePersistence> {
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
                DELETE FROM writer_sessions`);
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

/** Owner of one canonical database; both products open through here. */
export async function open_sqlite_file_state_store(
    databasePath: string,
    options: SqliteFileStatePersistenceOptions,
    getMaxStoredFiles?: () => number,
): Promise<OpenedSqliteFileStateStore> {
    const persistence = await open_sqlite_file_state_persistence(databasePath, options);
    const store = create_keyed_authority_store(persistence, getMaxStoredFiles);
    return {
        store,
        persistence,
        close: () => persistence.close(),
    };
}
