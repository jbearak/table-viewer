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

/** Adapt one runtime handle to the keyed semantic persistence port. */
export function create_sqlite_file_state_persistence_from_runtime(
    runtime: SqliteRuntimeHandle,
    options: { readonly now?: () => number } = {},
): KeyedFileStatePersistence {
    let closePromise: Promise<void> | undefined;
    return {
        runtime_key: runtime.runtime_key,
        canonicalization_revision_policy: 'allocate-revision-when-target-absent',
        read_transaction: (body) => runtime.read_transaction((tx) => body(
            create_sqlite_file_state_read_repository(tx, {
                writerSessionId: runtime.writer_session_id,
                now: options.now,
            }),
        )),
        write_transaction: (kind, body) => runtime.write_transaction(kind, (tx) => body(
            create_sqlite_file_state_write_repository(tx, {
                writerSessionId: runtime.writer_session_id,
                now: options.now,
            }),
        )),
        close(): Promise<void> {
            closePromise ??= drain_keyed_state_runtime(runtime.runtime_key)
                .then(() => runtime.close());
            return closePromise;
        },
    };
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
    const initialized = await initialize_sqlite_database_no_clobber(
        databasePath,
        options.identity,
        options.migration,
        {
            timeoutMs: options.timeoutMs,
            ...options.initialization,
        },
    );
    const runtime = await open_sqlite_runtime(initialized.database.canonicalPath, {
        identity: options.identity,
        adoptedConnection: initialized.database,
        clientKind: options.clientKind,
        clientVersion: options.clientVersion,
        supportedProtocol: options.supportedProtocol,
        requiresPendingEditRecovery: options.requiresPendingEditRecovery,
        timeoutMs: options.timeoutMs,
        now: options.now,
        randomId: options.randomId,
        hooks: options.hooks,
    });
    return create_sqlite_file_state_persistence_from_runtime(runtime, { now: options.now });
}

/** Unwired owner used by backend tests; products deliberately do not call this in PR2. */
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

