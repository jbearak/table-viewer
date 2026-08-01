import { randomUUID } from 'node:crypto';
import type {
    DatabaseSync,
    SQLInputValue,
    SQLOutputValue,
    StatementResultingChanges,
    StatementSync,
} from 'node:sqlite';
import {
    categorize_sqlite_file_state_error,
    sqlite_file_state_commit_error,
    sqlite_file_state_counter_error,
    sqlite_file_state_protocol_error,
    SqliteFileStateError,
} from './sqlite-file-state-errors';
import {
    SQLITE_FILE_STATE_PROTOCOL_VERSION,
    type SqliteFileStateIdentity,
} from './sqlite-file-state-schema';
import {
    open_existing_sqlite_database,
    resolve_sqlite_canonical_path,
    type SqliteOpenedDatabase,
} from './sqlite-open-recovery';
import {
    validate_sqlite_file_state_database,
    type ValidatedSqliteFileStateMetadata,
} from './sqlite-file-state-validation';

export type SqliteRuntimeEvent =
    | 'before-session-register'
    | 'after-session-register'
    | 'before-read-begin'
    | 'after-read-begin'
    | 'before-write-begin'
    | 'after-write-begin'
    | 'before-callback'
    | 'after-callback'
    | 'before-marker-update'
    | 'after-marker-update'
    | 'before-commit'
    | 'after-commit'
    | 'before-reconcile-open'
    | 'after-reconcile-open'
    | 'reconcile-committed'
    | 'reconcile-rolled-back'
    | 'reconcile-indeterminate'
    | 'before-final-cleanup'
    | 'after-final-cleanup'
    | 'before-connection-close'
    | 'after-connection-close';

export interface SqliteRuntimeHooks {
    /** Deterministic synchronous cut-point hook. Throw to inject a failure. */
    readonly onEvent?: (event: SqliteRuntimeEvent) => void;
    /**
     * Commit fault hook. It must call commit exactly once for a real commit. Calling
     * commit and then throwing simulates a lost successful response; throwing first
     * is a known rollback because the runtime has not invoked SQLite COMMIT.
     */
    readonly commit?: (commit: () => void, rollback: () => void) => void;
}

export interface SqliteRuntimeOptions {
    readonly identity: SqliteFileStateIdentity;
    readonly clientKind: string;
    readonly clientVersion: string;
    readonly supportedProtocol?: number;
    readonly requiresPendingEditRecovery?: boolean;
    readonly timeoutMs?: number;
    readonly now?: () => number;
    readonly randomId?: () => string;
    readonly hooks?: SqliteRuntimeHooks;
    /** Transfer an already-open, recovery-gated connection into a newly interned runtime. */
    readonly adoptedConnection?: SqliteOpenedDatabase;
    /** Injectable only for deterministic tests; production uses the recovery-gated opener. */
    readonly openConnection?: (canonicalPath: string) => Promise<SqliteOpenedDatabase>;
}

export interface SqlitePreparedStatement {
    get(...parameters: SQLInputValue[] | [Record<string, SQLInputValue>, ...SQLInputValue[]]):
        Record<string, SQLOutputValue> | undefined;
    all(...parameters: SQLInputValue[] | [Record<string, SQLInputValue>, ...SQLInputValue[]]):
        Record<string, SQLOutputValue>[];
    run(...parameters: SQLInputValue[] | [Record<string, SQLInputValue>, ...SQLInputValue[]]):
        StatementResultingChanges;
}

export interface SqliteReadTransactionContext {
    /** Every statement has readBigInts enabled before it can execute. */
    prepare(sql: string): SqlitePreparedStatement;
    safe_integer(value: unknown, name?: string, minimum?: number, maximum?: number): number;
}

export interface SqliteWriteTransactionContext extends SqliteReadTransactionContext {
    readonly changed: boolean;
    /** For changes made through an intentionally externalized primitive. */
    mark_changed(): void;
}

export interface SqliteRuntimeHandle {
    readonly runtime_key: object;
    readonly canonical_path: string;
    readonly writer_session_id: string;
    readonly coordination_generation: number;
    read_transaction<T>(body: (tx: SqliteReadTransactionContext) => T): Promise<T>;
    write_transaction<T>(kind: string, body: (tx: SqliteWriteTransactionContext) => T): Promise<T>;
    /** Dedicated executor for reservation-bound host I/O; generic callbacks remain synchronous. */
    async_write_transaction<T>(
        kind: string,
        body: (tx: SqliteWriteTransactionContext) => Promise<T>,
    ): Promise<T>;
    close(): Promise<void>;
}

interface SessionMarker {
    readonly sequence: number;
    readonly operationId?: string;
    readonly operationKind?: string;
}

interface RuntimeState {
    readonly canonicalPath: string;
    readonly options: NormalizedOptions;
    readonly runtimeKey: object;
    readonly writerSessionId: string;
    readonly generation: number;
    opened?: SqliteOpenedDatabase;
    marker: SessionMarker;
    pending: Promise<unknown>;
    references: number;
    admitting: boolean;
    fault?: SqliteFileStateError;
    closePromise?: Promise<void>;
}

interface NormalizedOptions extends SqliteRuntimeOptions {
    readonly supportedProtocol: number;
    readonly now: () => number;
    readonly randomId: () => string;
    readonly openConnection: (canonicalPath: string) => Promise<SqliteOpenedDatabase>;
}

interface OpeningRuntime {
    readonly promise: Promise<RuntimeState>;
    readonly options: NormalizedOptions;
}

const runtimeByPath = new Map<string, RuntimeState>();
const openingByPath = new Map<string, OpeningRuntime>();

function emit(runtime: RuntimeState, event: SqliteRuntimeEvent): void {
    runtime.options.hooks?.onEvent?.(event);
}

function assert_nonempty(value: string, name: string): void {
    if (value.length === 0) throw new TypeError(`${name} must not be empty.`);
}

function is_thenable(value: unknown): boolean {
    return value !== null
        && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as { then?: unknown }).then === 'function';
}

export function sqlite_safe_integer(
    value: unknown,
    name = 'integer',
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
): number {
    let numeric: number;
    if (typeof value === 'bigint') {
        if (value < BigInt(minimum) || value > BigInt(maximum)) {
            throw sqlite_file_state_counter_error({ operation: name });
        }
        numeric = Number(value);
    } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
        numeric = value;
    } else {
        throw sqlite_file_state_counter_error({ operation: name });
    }
    if (numeric < minimum || numeric > maximum) {
        throw sqlite_file_state_counter_error({ operation: name });
    }
    return numeric;
}

function prepared(database: DatabaseSync, sql: string, onChange?: () => void): SqlitePreparedStatement {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return {
        get(...parameters): Record<string, SQLOutputValue> | undefined {
            return statement.get(...parameters as Parameters<StatementSync['get']>);
        },
        all(...parameters): Record<string, SQLOutputValue>[] {
            return statement.all(...parameters as Parameters<StatementSync['all']>);
        },
        run(...parameters): StatementResultingChanges {
            const result = statement.run(...parameters as Parameters<StatementSync['run']>);
            if (sqlite_safe_integer(result.changes, 'statement changes') > 0) onChange?.();
            return result;
        },
    };
}

function total_changes(database: DatabaseSync): number {
    return sqlite_safe_integer(
        prepared(database, 'SELECT total_changes() AS value').get()?.value,
        'connection total changes',
    );
}

function pragma_integer(database: DatabaseSync, name: string): number {
    return sqlite_safe_integer(
        prepared(database, `PRAGMA ${name}`).get()?.[name],
        `PRAGMA ${name}`,
    );
}

function assert_connection_policy(database: DatabaseSync, queryOnly: 0 | 1): void {
    const journalMode = prepared(database, 'PRAGMA journal_mode').get()?.journal_mode;
    if (pragma_integer(database, 'foreign_keys') !== 1
        || pragma_integer(database, 'trusted_schema') !== 0
        || pragma_integer(database, 'synchronous') !== 2
        || pragma_integer(database, 'secure_delete') !== 1
        || pragma_integer(database, 'query_only') !== queryOnly
        || journalMode !== 'delete') {
        throw sqlite_file_state_protocol_error();
    }
}

function restore_connection_policy(runtime: RuntimeState, database: DatabaseSync): void {
    try {
        database.exec('PRAGMA query_only = OFF');
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('PRAGMA trusted_schema = OFF');
        database.exec('PRAGMA synchronous = FULL');
        database.exec('PRAGMA secure_delete = ON');
        assert_connection_policy(database, 0);
    } catch (error) {
        const fault = safe_error(error, 'connection-policy-restore');
        runtime.fault = fault;
        runtime.admitting = false;
        throw fault;
    }
}

function context_for(database: DatabaseSync, writable: boolean): SqliteWriteTransactionContext {
    let changed = false;
    const markChanged = (): void => { changed = true; };
    return {
        prepare: (sql) => prepared(database, sql, writable ? markChanged : undefined),
        safe_integer: sqlite_safe_integer,
        get changed(): boolean { return changed; },
        mark_changed(): void {
            if (!writable) throw new Error('Cannot mark a read transaction as changed.');
            markChanged();
        },
    };
}

function normalize_options(options: SqliteRuntimeOptions): NormalizedOptions {
    assert_nonempty(options.clientKind, 'clientKind');
    assert_nonempty(options.clientVersion, 'clientVersion');
    const supportedProtocol = options.supportedProtocol ?? SQLITE_FILE_STATE_PROTOCOL_VERSION;
    sqlite_safe_integer(supportedProtocol, 'supported protocol', 1);
    return {
        ...options,
        supportedProtocol,
        now: options.now ?? Date.now,
        randomId: options.randomId ?? randomUUID,
        openConnection: options.openConnection ?? ((databasePath) => open_existing_sqlite_database(
            databasePath,
            {
                timeoutMs: options.timeoutMs,
                validate(database) {
                    validate_sqlite_file_state_database(database, {
                        identity: options.identity,
                        supportedProtocol,
                        requiresPendingEditRecovery: options.requiresPendingEditRecovery,
                    });
                },
            },
        )),
    };
}

function identities_equal(left: SqliteFileStateIdentity, right: SqliteFileStateIdentity): boolean {
    if (left.productKind !== right.productKind
        || left.databaseId !== right.databaseId
        || left.storageEnvironmentId !== right.storageEnvironmentId
        || left.minReaderProtocol !== right.minReaderProtocol
        || left.maxReaderProtocol !== right.maxReaderProtocol
        || left.minWriterProtocol !== right.minWriterProtocol
        || left.maxWriterProtocol !== right.maxWriterProtocol
        || left.coordinationGeneration !== right.coordinationGeneration) return false;
    if (left.productKind === 'desktop' || right.productKind === 'desktop') {
        return left.productKind === right.productKind;
    }
    if (left.clientProfileId !== right.clientProfileId
        || left.legacy.capsuleId !== right.legacy.capsuleId
        || left.legacy.sourceFormat !== right.legacy.sourceFormat
        || left.legacy.sourceDigest !== right.legacy.sourceDigest
        || left.legacy.importClaimId !== right.legacy.importClaimId
        || left.legacy.sourceEntryCount !== right.legacy.sourceEntryCount
        || left.legacy.sourceNextRevision !== right.legacy.sourceNextRevision
        || left.legacy.sourceAbsenceRevision !== right.legacy.sourceAbsenceRevision
        || left.legacy.sourceUpdatedAtMs !== right.legacy.sourceUpdatedAtMs
        || left.legacy.importedAtMs !== right.legacy.importedAtMs
        || left.legacy.importerAppVersion !== right.legacy.importerAppVersion
        || left.legacy.sources.length !== right.legacy.sources.length) return false;
    const leftSources = [...left.legacy.sources].sort((a, b) => a.sourceOrdinal - b.sourceOrdinal);
    const rightSources = [...right.legacy.sources].sort((a, b) => a.sourceOrdinal - b.sourceOrdinal);
    return leftSources.every((source, index) => {
        const other = rightSources[index];
        return source.sourcePath === other.sourcePath
            && source.sourceOrdinal === other.sourceOrdinal
            && source.sourceStateRevision === other.sourceStateRevision
            && source.sourceKind === other.sourceKind
            && source.sourceHadPendingEdits === other.sourceHadPendingEdits;
    });
}

function validation_contract_equal(left: NormalizedOptions, right: NormalizedOptions): boolean {
    return identities_equal(left.identity, right.identity)
        && left.supportedProtocol === right.supportedProtocol
        && (left.requiresPendingEditRecovery ?? false) === (right.requiresPendingEditRecovery ?? false);
}

function same_identity(actual: Record<string, SQLOutputValue>, identity: SqliteFileStateIdentity): boolean {
    if (actual.database_id !== identity.databaseId
        || actual.storage_environment_id !== identity.storageEnvironmentId
        || actual.product_kind !== identity.productKind) return false;
    if (identity.productKind === 'desktop') return actual.client_profile_id === null;
    return actual.client_profile_id === identity.clientProfileId
        && actual.legacy_capsule_id === identity.legacy.capsuleId
        && actual.legacy_source_format === identity.legacy.sourceFormat
        && actual.legacy_source_digest === identity.legacy.sourceDigest
        && actual.legacy_import_claim_id === identity.legacy.importClaimId;
}

function assert_database_fences(runtime: RuntimeState, database: DatabaseSync): void {
    const meta = prepared(database, `SELECT database_id, client_profile_id,
        storage_environment_id, product_kind, journal_policy,
        legacy_capsule_id, legacy_source_format, legacy_source_digest,
        legacy_import_claim_id, min_reader_protocol, max_reader_protocol,
        min_writer_protocol, max_writer_protocol, coordination_generation
        FROM state_meta WHERE singleton = 1`).get();
    if (!meta || !same_identity(meta, runtime.options.identity) || meta.journal_policy !== 'delete') {
        throw sqlite_file_state_protocol_error({
            protocol: runtime.options.supportedProtocol,
            coordinationGeneration: runtime.generation,
        });
    }
    const protocol = runtime.options.supportedProtocol;
    const minReader = sqlite_safe_integer(meta.min_reader_protocol, 'minimum reader protocol', 1);
    const maxReader = sqlite_safe_integer(meta.max_reader_protocol, 'maximum reader protocol', 1);
    const minWriter = sqlite_safe_integer(meta.min_writer_protocol, 'minimum writer protocol', 1);
    const maxWriter = sqlite_safe_integer(meta.max_writer_protocol, 'maximum writer protocol', 1);
    const generation = sqlite_safe_integer(meta.coordination_generation, 'coordination generation', 1);
    if (protocol < minReader || protocol > maxReader
        || protocol < minWriter || protocol > maxWriter
        || generation !== runtime.generation) {
        throw sqlite_file_state_protocol_error({ protocol, coordinationGeneration: generation });
    }
}

function assert_runtime_fences(runtime: RuntimeState, database: DatabaseSync): void {
    assert_database_fences(runtime, database);
    const protocol = runtime.options.supportedProtocol;
    const session = prepared(database, `SELECT negotiated_protocol, opened_generation,
        last_committed_sequence, last_operation_id, last_operation_kind
        FROM writer_sessions WHERE writer_session_id = ?`).get(runtime.writerSessionId);
    if (!session
        || sqlite_safe_integer(session.negotiated_protocol, 'session protocol', 1) !== protocol
        || sqlite_safe_integer(session.opened_generation, 'session generation', 1) !== runtime.generation) {
        throw sqlite_file_state_protocol_error({
            protocol,
            coordinationGeneration: runtime.generation,
        });
    }
    const durableMarker = marker_from_row(session);
    if (!markers_equal(durableMarker, runtime.marker)) {
        throw sqlite_file_state_commit_error({ operation: 'writer-session-marker' });
    }
}

function marker_from_row(row: Record<string, SQLOutputValue>): SessionMarker {
    const sequence = sqlite_safe_integer(row.last_committed_sequence, 'last committed sequence');
    const operationId = row.last_operation_id;
    const operationKind = row.last_operation_kind;
    if (sequence === 0) {
        if (operationId !== null || operationKind !== null) {
            throw sqlite_file_state_commit_error({ operation: 'writer-session-marker' });
        }
        return { sequence };
    }
    if (typeof operationId !== 'string' || typeof operationKind !== 'string'
        || operationId.length === 0 || operationKind.length === 0) {
        throw sqlite_file_state_commit_error({ operation: 'writer-session-marker' });
    }
    return { sequence, operationId, operationKind };
}

function markers_equal(left: SessionMarker, right: SessionMarker): boolean {
    return left.sequence === right.sequence
        && left.operationId === right.operationId
        && left.operationKind === right.operationKind;
}

function rollback_preserving(database: DatabaseSync, original: unknown): never {
    try {
        database.exec('ROLLBACK');
    } catch {
        // Preserve the transaction failure that triggered rollback.
    }
    throw original;
}

function safe_error(error: unknown, operation: string): SqliteFileStateError {
    return categorize_sqlite_file_state_error(error, { operation });
}

function enqueue<T>(runtime: RuntimeState, operation: () => Promise<T>): Promise<T> {
    if (!runtime.admitting) {
        return Promise.reject(runtime.fault ?? new Error('SQLite runtime is closed.'));
    }
    const run = async (): Promise<T> => {
        if (runtime.fault) throw runtime.fault;
        return operation();
    };
    const result = runtime.pending.then(run, run);
    runtime.pending = result.then(() => undefined, () => undefined);
    return result;
}

function validate_opened(runtime: RuntimeState, opened: SqliteOpenedDatabase): ValidatedSqliteFileStateMetadata {
    return validate_sqlite_file_state_database(opened.database, {
        identity: runtime.options.identity,
        supportedProtocol: runtime.options.supportedProtocol,
        requiresPendingEditRecovery: runtime.options.requiresPendingEditRecovery,
    });
}

async function register_runtime(
    canonicalPath: string,
    options: NormalizedOptions,
): Promise<RuntimeState> {
    const opened = options.adoptedConnection ?? await options.openConnection(canonicalPath);
    const writerSessionId = options.randomId();
    assert_nonempty(writerSessionId, 'writerSessionId');
    const runtime: RuntimeState = {
        canonicalPath,
        options,
        runtimeKey: {},
        writerSessionId,
        generation: 0,
        opened,
        marker: { sequence: 0 },
        pending: Promise.resolve(),
        references: 0,
        admitting: true,
    };
    try {
        if (opened.canonicalPath !== canonicalPath) {
            throw sqlite_file_state_protocol_error({ operation: 'adopted-connection-path' });
        }
        const metadata = validate_opened(runtime, opened);
        (runtime as { generation: number }).generation = metadata.coordinationGeneration;
        emit(runtime, 'before-session-register');
        opened.database.exec('BEGIN IMMEDIATE');
        try {
            assert_database_fences(runtime, opened.database);
            const registeredAt = options.now();
            sqlite_safe_integer(registeredAt, 'session timestamp');
            prepared(opened.database, `INSERT INTO writer_sessions (
                writer_session_id, client_kind, client_version, negotiated_protocol,
                process_id, opened_at_ms, last_activity_at_ms, opened_generation,
                last_committed_sequence, last_operation_id, last_operation_kind
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`).run(
                writerSessionId,
                options.clientKind,
                options.clientVersion,
                options.supportedProtocol,
                process.pid,
                registeredAt,
                registeredAt,
                runtime.generation,
            );
            opened.database.exec('COMMIT');
        } catch (error) {
            rollback_preserving(opened.database, error);
        }
        emit(runtime, 'after-session-register');
        return runtime;
    } catch (error) {
        try { await opened.close(); } catch { /* Preserve the first failure. */ }
        throw safe_error(error, 'runtime-open');
    }
}

async function acquire_runtime(canonicalPath: string, options: SqliteRuntimeOptions): Promise<RuntimeState> {
    const normalized = normalize_options(options);
    let unusedAdopted = normalized.adoptedConnection;
    const closeUnusedAdopted = async (): Promise<void> => {
        const opened = unusedAdopted;
        unusedAdopted = undefined;
        if (opened) await opened.close();
    };
    for (;;) {
        const existing = runtimeByPath.get(canonicalPath);
        if (existing) {
            // A closing runtime no longer owns the next caller. Keep an adopted,
            // already-gated connection alive while close drains so the retry can
            // register it instead of accidentally reusing a connection we closed.
            if (existing.closePromise) {
                await existing.closePromise;
                continue;
            }
            await closeUnusedAdopted();
            if (!validation_contract_equal(existing.options, normalized)) {
                throw sqlite_file_state_protocol_error({ protocol: normalized.supportedProtocol });
            }
            if (existing.admitting && !existing.fault) {
                existing.references += 1;
                return existing;
            }
            throw existing.fault ?? new Error('SQLite runtime is not accepting references.');
        }
        let opening = openingByPath.get(canonicalPath);
        if (!opening) {
            opening = {
                options: normalized,
                promise: register_runtime(canonicalPath, normalized),
            };
            unusedAdopted = undefined;
            openingByPath.set(canonicalPath, opening);
        } else {
            await closeUnusedAdopted();
            if (!validation_contract_equal(opening.options, normalized)) {
                throw sqlite_file_state_protocol_error({ protocol: normalized.supportedProtocol });
            }
        }
        try {
            const runtime = await opening.promise;
            if (!runtimeByPath.has(canonicalPath)) runtimeByPath.set(canonicalPath, runtime);
            runtime.references += 1;
            return runtime;
        } finally {
            if (openingByPath.get(canonicalPath) === opening) openingByPath.delete(canonicalPath);
        }
    }
}

function read_transaction<T>(
    runtime: RuntimeState,
    body: (tx: SqliteReadTransactionContext) => T,
): Promise<T> {
    return enqueue(runtime, async () => {
        const database = runtime.opened?.database;
        if (!database) throw runtime.fault ?? new Error('SQLite runtime connection is unavailable.');
        database.exec('PRAGMA query_only = ON');
        try {
            emit(runtime, 'before-read-begin');
            try {
                database.exec('BEGIN');
                emit(runtime, 'after-read-begin');
                assert_runtime_fences(runtime, database);
                assert_connection_policy(database, 1);
            } catch (error) {
                try { database.exec('ROLLBACK'); } catch { /* Preserve the first failure. */ }
                throw safe_error(error, 'read-transaction');
            }
            const changesBefore = total_changes(database);
            let result: T;
            try {
                emit(runtime, 'before-callback');
                result = body(context_for(database, false));
                if (is_thenable(result)) {
                    throw new TypeError('SQLite transaction callbacks must be synchronous.');
                }
                if (total_changes(database) !== changesBefore) {
                    const fault = sqlite_file_state_protocol_error({ operation: 'read-data-change' });
                    runtime.fault = fault;
                    runtime.admitting = false;
                    throw fault;
                }
                assert_connection_policy(database, 1);
                emit(runtime, 'after-callback');
            } catch (error) {
                try { database.exec('ROLLBACK'); } catch { /* Preserve the callback failure. */ }
                throw error;
            }
            try {
                database.exec('COMMIT');
                return result;
            } catch (error) {
                try { database.exec('ROLLBACK'); } catch { /* Preserve the commit failure. */ }
                throw safe_error(error, 'read-commit');
            }
        } finally {
            restore_connection_policy(runtime, database);
        }
    });
}

function update_session_marker(
    runtime: RuntimeState,
    database: DatabaseSync,
    expected: SessionMarker,
    now: number,
): void {
    const previous = runtime.marker;
    const result = prepared(database, `UPDATE writer_sessions
        SET last_activity_at_ms = ?, last_committed_sequence = ?,
            last_operation_id = ?, last_operation_kind = ?
        WHERE writer_session_id = ?
          AND negotiated_protocol = ?
          AND opened_generation = ?
          AND last_committed_sequence = ?
          AND ((last_operation_id IS NULL AND ? IS NULL) OR last_operation_id = ?)
          AND ((last_operation_kind IS NULL AND ? IS NULL) OR last_operation_kind = ?)`).run(
        now,
        expected.sequence,
        expected.operationId ?? null,
        expected.operationKind ?? null,
        runtime.writerSessionId,
        runtime.options.supportedProtocol,
        runtime.generation,
        previous.sequence,
        previous.operationId ?? null,
        previous.operationId ?? null,
        previous.operationKind ?? null,
        previous.operationKind ?? null,
    );
    if (sqlite_safe_integer(result.changes, 'writer marker changes') !== 1) {
        throw sqlite_file_state_commit_error({ operation: 'writer-session-marker' });
    }
}

async function retire_uncertain_connection(
    runtime: RuntimeState,
): Promise<SqliteOpenedDatabase | undefined> {
    const opened = runtime.opened;
    runtime.opened = undefined;
    if (!opened) return undefined;
    try {
        // Keep the exact reader token until a fresh gated connection has opened.
        // Closing SQLite is necessary to release its locks; releasing the gate here
        // would create a recovery window before reconciliation can reacquire one.
        await opened.closeDatabase();
    } catch {
        // The fresh connection still decides whether the transaction committed.
    }
    return opened;
}

async function reconcile_ambiguous_commit<T>(
    runtime: RuntimeState,
    previous: SessionMarker,
    expected: SessionMarker,
    result: T,
    originalError: unknown,
): Promise<T> {
    const retired = await retire_uncertain_connection(runtime);
    let fresh: SqliteOpenedDatabase | undefined;
    try {
        emit(runtime, 'before-reconcile-open');
        if (!retired) throw sqlite_file_state_commit_error({ operation: 'commit-reconcile-connection' });
        fresh = await retired.replaceConnection({
            timeoutMs: runtime.options.timeoutMs,
            validate(database) {
                validate_sqlite_file_state_database(database, {
                    identity: runtime.options.identity,
                    supportedProtocol: runtime.options.supportedProtocol,
                    requiresPendingEditRecovery: runtime.options.requiresPendingEditRecovery,
                });
            },
        });
        emit(runtime, 'after-reconcile-open');
        validate_opened(runtime, fresh);
        const row = prepared(fresh.database, `SELECT last_committed_sequence,
            last_operation_id, last_operation_kind
            FROM writer_sessions WHERE writer_session_id = ?`).get(runtime.writerSessionId);
        if (!row) throw sqlite_file_state_commit_error({ operation: 'commit-reconcile-session' });
        const actual = marker_from_row(row);
        if (markers_equal(actual, expected)) {
            runtime.marker = expected;
            runtime.opened = fresh;
            fresh = undefined;
            emit(runtime, 'reconcile-committed');
            return result;
        }
        if (markers_equal(actual, previous)) {
            runtime.opened = fresh;
            fresh = undefined;
            emit(runtime, 'reconcile-rolled-back');
            throw safe_error(originalError, 'write-commit');
        }
        throw sqlite_file_state_commit_error({ operation: 'commit-reconcile-marker' });
    } catch (error) {
        if (runtime.opened) throw error;
        try { await fresh?.close(); } catch { /* Preserve reconciliation failure. */ }
        try { await retired?.close(); } catch { /* Preserve reconciliation failure. */ }
        const fault = error instanceof SqliteFileStateError
            ? error
            : sqlite_file_state_commit_error({ operation: 'commit-reconcile' });
        runtime.fault = fault.category === 'commit'
            ? fault
            : sqlite_file_state_commit_error({ operation: 'commit-reconcile' });
        runtime.admitting = false;
        emit(runtime, 'reconcile-indeterminate');
        throw runtime.fault;
    }
}

function write_transaction<T>(
    runtime: RuntimeState,
    kind: string,
    body: (tx: SqliteWriteTransactionContext) => T,
): Promise<T> {
    assert_nonempty(kind, 'transaction kind');
    return enqueue(runtime, async () => {
        const database = runtime.opened?.database;
        if (!database) throw runtime.fault ?? new Error('SQLite runtime connection is unavailable.');
        try {
            emit(runtime, 'before-write-begin');
        let changesBefore: number;
        try {
            database.exec('BEGIN IMMEDIATE');
            emit(runtime, 'after-write-begin');
            assert_runtime_fences(runtime, database);
            assert_connection_policy(database, 0);
            changesBefore = total_changes(database);
        } catch (error) {
            try { database.exec('ROLLBACK'); } catch { /* Preserve the begin/fence failure. */ }
            throw safe_error(error, 'write-begin');
        }
        let result: T;
        const context = context_for(database, true);
        try {
            emit(runtime, 'before-callback');
            result = body(context);
            if (is_thenable(result)) {
                throw new TypeError('SQLite transaction callbacks must be synchronous.');
            }
            assert_connection_policy(database, 0);
            emit(runtime, 'after-callback');
            if (total_changes(database) !== changesBefore) context.mark_changed();
        } catch (error) {
            try { database.exec('ROLLBACK'); } catch { /* Preserve the callback failure. */ }
            throw error;
        }
        if (!context.changed) {
            try {
                database.exec('COMMIT');
                return result;
            } catch (error) {
                try { database.exec('ROLLBACK'); } catch { /* Preserve the commit failure. */ }
                throw safe_error(error, 'write-commit');
            }
        }

        const previous = runtime.marker;
        const expected: SessionMarker = {
            sequence: previous.sequence + 1,
            operationId: runtime.options.randomId(),
            operationKind: kind,
        };
        sqlite_safe_integer(expected.sequence, 'writer committed sequence', 1, Number.MAX_SAFE_INTEGER - 1);
        assert_nonempty(expected.operationId as string, 'operationId');
        try {
            emit(runtime, 'before-marker-update');
            update_session_marker(runtime, database, expected, runtime.options.now());
            emit(runtime, 'after-marker-update');
            emit(runtime, 'before-commit');
        } catch (error) {
            try { database.exec('ROLLBACK'); } catch { /* Preserve the first failure. */ }
            throw safe_error(error, 'write-transaction');
        }

        let commitInvoked = false;
        try {
            const commit = (): void => {
                if (commitInvoked) throw new Error('SQLite transaction outcome was invoked more than once.');
                commitInvoked = true;
                database.exec('COMMIT');
            };
            const rollback = (): void => {
                if (commitInvoked) throw new Error('SQLite transaction outcome was invoked more than once.');
                commitInvoked = true;
                database.exec('ROLLBACK');
            };
            if (runtime.options.hooks?.commit) runtime.options.hooks.commit(commit, rollback);
            else commit();
            if (!commitInvoked) throw new Error('SQLite COMMIT hook did not invoke COMMIT.');
            emit(runtime, 'after-commit');
            runtime.marker = expected;
            return result;
        } catch (error) {
            if (!commitInvoked) {
                try { database.exec('ROLLBACK'); } catch { /* Preserve the first failure. */ }
                throw safe_error(error, 'write-commit');
            }
            return reconcile_ambiguous_commit(runtime, previous, expected, result, error);
        }
        } finally {
            if (runtime.opened?.database === database) {
                restore_connection_policy(runtime, database);
            }
        }
    });
}

function async_write_transaction<T>(
    runtime: RuntimeState,
    kind: string,
    body: (tx: SqliteWriteTransactionContext) => Promise<T>,
): Promise<T> {
    assert_nonempty(kind, 'transaction kind');
    return enqueue(runtime, async () => {
        const database = runtime.opened?.database;
        if (!database) throw runtime.fault ?? new Error('SQLite runtime connection is unavailable.');
        try {
            emit(runtime, 'before-write-begin');
            let changesBefore: number;
            try {
                database.exec('BEGIN IMMEDIATE');
                emit(runtime, 'after-write-begin');
                assert_runtime_fences(runtime, database);
                assert_connection_policy(database, 0);
                changesBefore = total_changes(database);
            } catch (error) {
                try { database.exec('ROLLBACK'); } catch { /* Preserve begin failure. */ }
                throw safe_error(error, 'write-begin');
            }
            const context = context_for(database, true);
            let result: T;
            try {
                emit(runtime, 'before-callback');
                result = await body(context);
                assert_runtime_fences(runtime, database);
                assert_connection_policy(database, 0);
                emit(runtime, 'after-callback');
                if (total_changes(database) !== changesBefore) context.mark_changed();
            } catch (error) {
                try { database.exec('ROLLBACK'); } catch { /* Preserve callback failure. */ }
                throw error;
            }
            if (!context.changed) {
                try {
                    database.exec('COMMIT');
                    return result;
                } catch (error) {
                    try { database.exec('ROLLBACK'); } catch { /* Preserve commit failure. */ }
                    throw safe_error(error, 'write-commit');
                }
            }
            const previous = runtime.marker;
            const expected: SessionMarker = {
                sequence: previous.sequence + 1,
                operationId: runtime.options.randomId(),
                operationKind: kind,
            };
            sqlite_safe_integer(expected.sequence, 'writer committed sequence', 1, Number.MAX_SAFE_INTEGER - 1);
            assert_nonempty(expected.operationId as string, 'operationId');
            update_session_marker(runtime, database, expected, runtime.options.now());
            let commitInvoked = false;
            try {
                const commit = (): void => {
                    if (commitInvoked) throw new Error('SQLite transaction outcome was invoked more than once.');
                    commitInvoked = true;
                    database.exec('COMMIT');
                };
                const rollback = (): void => {
                    if (commitInvoked) throw new Error('SQLite transaction outcome was invoked more than once.');
                    commitInvoked = true;
                    database.exec('ROLLBACK');
                };
                if (runtime.options.hooks?.commit) runtime.options.hooks.commit(commit, rollback);
                else commit();
                if (!commitInvoked) throw new Error('SQLite COMMIT hook did not invoke COMMIT.');
                runtime.marker = expected;
                return result;
            } catch (error) {
                if (!commitInvoked) {
                    try { database.exec('ROLLBACK'); } catch { /* Preserve commit failure. */ }
                    throw safe_error(error, 'write-commit');
                }
                return reconcile_ambiguous_commit(runtime, previous, expected, result, error);
            }
        } finally {
            if (runtime.opened?.database === database) restore_connection_policy(runtime, database);
        }
    });
}

async function cleanup_final_reference(runtime: RuntimeState): Promise<void> {
    const database = runtime.opened?.database;
    if (!database || runtime.fault) return;
    try {
        emit(runtime, 'before-final-cleanup');
        database.exec('BEGIN IMMEDIATE');
        try {
            assert_runtime_fences(runtime, database);
            const ownedEdits = prepared(database, `SELECT count(*) AS count
                FROM edit_sessions WHERE owner_writer_session_id = ?`).get(runtime.writerSessionId);
            const editCount = sqlite_safe_integer(ownedEdits?.count, 'owned edit count');
            if (editCount === 0) {
                prepared(database, 'DELETE FROM entry_leases WHERE writer_session_id = ?')
                    .run(runtime.writerSessionId);
                prepared(database, 'DELETE FROM writer_sessions WHERE writer_session_id = ?')
                    .run(runtime.writerSessionId);
            }
            database.exec('COMMIT');
        } catch (error) {
            try { database.exec('ROLLBACK'); } catch { /* Best-effort cleanup only. */ }
            throw error;
        }
        emit(runtime, 'after-final-cleanup');
    } catch {
        // Uncertain cleanup deliberately leaves protective rows rather than guessing.
    }
}

function close_handle(runtime: RuntimeState, handleState: { closed: boolean }): Promise<void> {
    if (handleState.closed) return Promise.resolve();
    handleState.closed = true;
    runtime.references -= 1;
    if (runtime.references > 0) return Promise.resolve();
    if (runtime.closePromise) return runtime.closePromise;
    runtime.admitting = false;
    runtime.closePromise = runtime.pending.then(async () => {
        let closeError: unknown;
        try {
            await cleanup_final_reference(runtime);
        } catch (error) {
            closeError = error;
        }
        const opened = runtime.opened;
        runtime.opened = undefined;
        if (opened) {
            try {
                emit(runtime, 'before-connection-close');
            } catch (error) {
                closeError ??= error;
            }
            try {
                await opened.close();
            } catch (error) {
                closeError ??= error;
            } finally {
                try {
                    emit(runtime, 'after-connection-close');
                } catch (error) {
                    closeError ??= error;
                }
            }
        }
        if (closeError) throw closeError;
    }).finally(() => {
        if (runtimeByPath.get(runtime.canonicalPath) === runtime) {
            runtimeByPath.delete(runtime.canonicalPath);
        }
    });
    runtime.pending = runtime.closePromise.then(() => undefined, () => undefined);
    return runtime.closePromise;
}

/**
 * Open or reference the one process-local runtime interned by resolved database path.
 * The supplied identity is validated before the writer session is registered.
 */
export async function open_sqlite_runtime(
    databasePath: string,
    options: SqliteRuntimeOptions,
): Promise<SqliteRuntimeHandle> {
    let runtime: RuntimeState;
    let canonicalPath: string;
    try {
        canonicalPath = resolve_sqlite_canonical_path(databasePath);
        runtime = await acquire_runtime(canonicalPath, options);
    } catch (error) {
        try { await options.adoptedConnection?.close(); } catch { /* Preserve the first failure. */ }
        throw error;
    }
    const handleState = { closed: false };
    const assertHandleOpen = (): void => {
        if (handleState.closed) throw new Error('SQLite runtime handle is closed.');
    };
    return {
        runtime_key: runtime.runtimeKey,
        canonical_path: canonicalPath,
        writer_session_id: runtime.writerSessionId,
        coordination_generation: runtime.generation,
        read_transaction(body) {
            try {
                assertHandleOpen();
                return read_transaction(runtime, body);
            } catch (error) {
                return Promise.reject(error);
            }
        },
        write_transaction(kind, body) {
            try {
                assertHandleOpen();
                return write_transaction(runtime, kind, body);
            } catch (error) {
                return Promise.reject(error);
            }
        },
        async_write_transaction(kind, body) {
            try {
                assertHandleOpen();
                return async_write_transaction(runtime, kind, body);
            } catch (error) {
                return Promise.reject(error);
            }
        },
        close: () => close_handle(runtime, handleState),
    };
}

/** Alias matching the persistence constructor vocabulary used by later packages. */
export const create_sqlite_runtime = open_sqlite_runtime;
