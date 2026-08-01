import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
    SQLITE_FILE_STATE_APPLICATION_ID,
    SQLITE_FILE_STATE_EXHAUSTION_SENTINEL,
    SQLITE_FILE_STATE_FORMAT,
    SQLITE_FILE_STATE_PROTOCOL_VERSION,
    SQLITE_FILE_STATE_USER_VERSION,
    SQLITE_FILE_STATE_V1_INDEX_SQL,
    SQLITE_FILE_STATE_V1_MIGRATION_NAME,
    SQLITE_FILE_STATE_V1_TABLE_SQL,
    type SqliteFileStateIdentity,
    type SqliteLegacySourceIdentity,
} from './sqlite-file-state-schema';
import {
    sqlite_file_state_counter_error,
    sqlite_file_state_foreign_key_error,
    sqlite_file_state_malformed_error,
    sqlite_file_state_protocol_error,
    sqlite_file_state_schema_error,
} from './sqlite-file-state-errors';
import { decode_stored_per_file_state, type StoredPerFileState } from './types';
import {
    decode_prepared_install_lifecycle,
    SQLITE_PREPARED_INSTALL_STATE_KEY,
} from './sqlite-file-state-repository';
import {
    state_has_pending_edits,
    type PersistedPreparedInstallLifecycleRecord,
} from './state';

type SqliteRow = Record<string, unknown>;

export interface SqliteFileStateValidationOptions {
    readonly identity: SqliteFileStateIdentity;
    readonly supportedProtocol?: number;
    /** True for remote canonical databases whose pending edits require companion evidence. */
    readonly requiresPendingEditRecovery?: boolean;
}

export interface ValidatedSqliteFileStateMetadata {
    readonly databaseId: string;
    readonly productKind: 'desktop' | 'vscode';
    readonly authorityMode: 'sqlite_importing_memento' | 'sqlite';
    readonly coordinationGeneration: number;
    readonly nextRevision: number;
    readonly absenceRevision: number;
    readonly nextRecencyOrder: bigint;
    readonly nextOwnershipGeneration: number;
    readonly entryCount: number;
}

const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
    state_meta: [
        'singleton', 'format', 'database_id', 'client_profile_id', 'storage_environment_id',
        'product_kind', 'journal_policy', 'authority_mode', 'legacy_capsule_id',
        'legacy_source_format', 'legacy_source_digest', 'legacy_import_claim_id',
        'min_reader_protocol', 'max_reader_protocol', 'min_writer_protocol',
        'max_writer_protocol', 'coordination_generation', 'next_revision',
        'absence_revision', 'next_recency_order', 'next_ownership_generation',
        'store_updated_at_ms',
    ],
    entries: [
        'path', 'state_revision', 'state_json', 'has_pending_edits',
        'authority_commit_sequence', 'authority_revision', 'physical_revision',
        'projection_revision', 'physical_digest', 'recency_order', 'updated_at_ms',
        'touched_at_ms', 'recovery_entry_id', 'recovery_record_id', 'copy_id',
        'copy_source_path', 'copy_source_revision',
    ],
    authority_stages: [
        'entry_path', 'stage_id', 'kind', 'ordinal', 'expected_state_revision',
        'expected_commit_sequence', 'next_state_json', 'physical_digest', 'created_at_ms',
    ],
    writer_sessions: [
        'writer_session_id', 'client_kind', 'client_version', 'negotiated_protocol',
        'process_id', 'opened_at_ms', 'last_activity_at_ms', 'opened_generation',
        'last_committed_sequence', 'last_operation_id', 'last_operation_kind',
    ],
    entry_leases: [
        'lease_id', 'writer_session_id', 'current_entry_path', 'acquired_at_ms',
        'acquired_generation',
    ],
    edit_sessions: [
        'entry_path', 'physical_resource_lock_key', 'host_lock_id', 'edit_session_id',
        'owner_writer_session_id', 'ownership_generation', 'acquired_at_ms',
        'last_confirmed_at_ms',
    ],
    file_write_reservations: [
        'reservation_id', 'save_operation_id', 'entry_path', 'physical_resource_lock_key',
        'host_lock_id', 'edit_session_id', 'ownership_generation', 'reserved_generation',
        'stage_id', 'prepared_install_id', 'expected_state_revision',
        'expected_commit_sequence', 'expected_authority_revision',
        'expected_physical_revision', 'expected_projection_revision',
        'expected_physical_digest', 'intended_physical_digest', 'recovery_record_id',
        'acquired_at_ms',
    ],
    legacy_imports: [
        'capsule_id', 'source_format', 'source_digest', 'source_entry_count',
        'source_next_revision', 'source_absence_revision', 'source_updated_at_ms',
        'imported_at_ms', 'importer_app_version',
    ],
    legacy_sources: [
        'capsule_id', 'source_path', 'source_ordinal', 'source_state_revision',
        'source_kind', 'source_had_pending_edits', 'pending_survival_kind',
        'pending_survival_reference', 'status', 'terminal_disposition',
        'terminal_destination_path', 'retired_at_ms', 'retirement_operation_id',
    ],
    legacy_entry_claims: [
        'capsule_id', 'source_path', 'source_ordinal', 'source_state_revision',
        'disposition', 'destination_path', 'claimed_at_ms',
    ],
    schema_migrations: ['version', 'name', 'applied_at_ms', 'app_version'],
};

const INTEGER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
    state_meta: [
        'singleton', 'min_reader_protocol', 'max_reader_protocol', 'min_writer_protocol',
        'max_writer_protocol', 'coordination_generation', 'next_revision',
        'absence_revision', 'next_recency_order', 'next_ownership_generation',
        'store_updated_at_ms',
    ],
    entries: [
        'state_revision', 'has_pending_edits', 'authority_commit_sequence',
        'authority_revision', 'physical_revision', 'projection_revision',
        'recency_order', 'updated_at_ms', 'touched_at_ms', 'copy_source_revision',
    ],
    authority_stages: [
        'ordinal', 'expected_state_revision', 'expected_commit_sequence', 'created_at_ms',
    ],
    writer_sessions: [
        'negotiated_protocol', 'process_id', 'opened_at_ms', 'last_activity_at_ms',
        'opened_generation', 'last_committed_sequence',
    ],
    entry_leases: ['acquired_at_ms', 'acquired_generation'],
    edit_sessions: ['ownership_generation', 'acquired_at_ms', 'last_confirmed_at_ms'],
    file_write_reservations: [
        'ownership_generation', 'reserved_generation', 'expected_state_revision',
        'expected_commit_sequence', 'expected_authority_revision',
        'expected_physical_revision', 'expected_projection_revision', 'acquired_at_ms',
    ],
    legacy_imports: [
        'source_entry_count', 'source_next_revision', 'source_absence_revision',
        'source_updated_at_ms', 'imported_at_ms',
    ],
    legacy_sources: [
        'source_ordinal', 'source_state_revision', 'source_had_pending_edits', 'retired_at_ms',
    ],
    legacy_entry_claims: ['source_ordinal', 'source_state_revision', 'claimed_at_ms'],
    schema_migrations: ['version', 'applied_at_ms'],
};

function prepared(database: DatabaseSync, sql: string): StatementSync {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
}

function rows(database: DatabaseSync, sql: string): SqliteRow[] {
    return prepared(database, sql).all() as SqliteRow[];
}

function row(database: DatabaseSync, sql: string): SqliteRow | undefined {
    return prepared(database, sql).get() as SqliteRow | undefined;
}

function text(value: unknown): string {
    if (typeof value !== 'string') throw sqlite_file_state_schema_error();
    return value;
}

function nullable_text(value: unknown): string | undefined {
    if (value === null) return undefined;
    return text(value);
}

function bigint_value(value: unknown, allowNull = false): bigint | undefined {
    if (allowNull && value === null) return undefined;
    if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw sqlite_file_state_counter_error();
    }
    return value;
}

function safe_number(value: unknown, allowNull = false): number | undefined {
    const result = bigint_value(value, allowNull);
    return result === undefined ? undefined : Number(result);
}

function count(database: DatabaseSync, sql: string): number {
    return safe_number(row(database, sql)?.count) as number;
}

function normalize_sql(sql: string): string {
    return sql
        .replace(/--[^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        .replace(/;$/, '')
        .trim();
}

function validate_schema_objects(database: DatabaseSync): void {
    const expected = new Map<string, { type: string; sql: string }>();
    for (const [name, sql] of Object.entries(SQLITE_FILE_STATE_V1_TABLE_SQL)) {
        expected.set(name, { type: 'table', sql });
    }
    for (const [name, sql] of Object.entries(SQLITE_FILE_STATE_V1_INDEX_SQL)) {
        expected.set(name, { type: 'index', sql });
    }
    const actual = rows(database, `SELECT type, name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name`);
    if (actual.length !== expected.size) {
        throw sqlite_file_state_schema_error({ rowCount: actual.length });
    }
    for (const object of actual) {
        const name = text(object.name);
        const definition = expected.get(name);
        if (!definition
            || text(object.type) !== definition.type
            || normalize_sql(text(object.sql)) !== normalize_sql(definition.sql)) {
            throw sqlite_file_state_schema_error();
        }
    }
    for (const [tableName, columns] of Object.entries(EXPECTED_COLUMNS)) {
        const actualColumns = rows(database, `PRAGMA table_xinfo(${tableName})`)
            .map((value) => text(value.name));
        if (actualColumns.length !== columns.length
            || actualColumns.some((value, index) => value !== columns[index])) {
            throw sqlite_file_state_schema_error();
        }
    }
}

function validate_pragmas(database: DatabaseSync): void {
    if (safe_number(row(database, 'PRAGMA application_id')?.application_id)
        !== SQLITE_FILE_STATE_APPLICATION_ID
        || safe_number(row(database, 'PRAGMA user_version')?.user_version)
        !== SQLITE_FILE_STATE_USER_VERSION) {
        throw sqlite_file_state_schema_error({ schemaVersion: SQLITE_FILE_STATE_USER_VERSION });
    }
    if (text(row(database, 'PRAGMA journal_mode')?.journal_mode) !== 'delete') {
        throw sqlite_file_state_schema_error();
    }
    if (safe_number(row(database, 'PRAGMA foreign_keys')?.foreign_keys) !== 1
        || safe_number(row(database, 'PRAGMA trusted_schema')?.trusted_schema) !== 0
        || safe_number(row(database, 'PRAGMA synchronous')?.synchronous) !== 2
        || safe_number(row(database, 'PRAGMA secure_delete')?.secure_delete) !== 1) {
        throw sqlite_file_state_schema_error();
    }
}

function validate_integer_storage(database: DatabaseSync): void {
    for (const [tableName, columns] of Object.entries(INTEGER_COLUMNS)) {
        for (const value of rows(database, `SELECT ${columns.join(', ')} FROM ${tableName}`)) {
            for (const column of columns) {
                if (value[column] !== null) bigint_value(value[column]);
            }
        }
    }
}

function decode_state_json(value: unknown): {
    readonly state: StoredPerFileState;
    readonly lifecycle?: PersistedPreparedInstallLifecycleRecord;
} {
    if (typeof value !== 'string') throw sqlite_file_state_malformed_error();
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw sqlite_file_state_malformed_error();
        }
        const logical = { ...(parsed as Record<string, unknown>) };
        const lifecycle = decode_prepared_install_lifecycle(
            logical[SQLITE_PREPARED_INSTALL_STATE_KEY],
        );
        delete logical[SQLITE_PREPARED_INSTALL_STATE_KEY];
        return {
            state: decode_stored_per_file_state(logical),
            ...(lifecycle === undefined ? {} : { lifecycle }),
        };
    } catch {
        throw sqlite_file_state_malformed_error();
    }
}

function state_from_json(value: unknown): StoredPerFileState {
    return decode_state_json(value).state;
}

function validate_entries(
    database: DatabaseSync,
    requiresRecovery: boolean,
    nextRevision: number,
): Map<string, boolean> {
    const pendingByPath = new Map<string, boolean>();
    const entryRows = rows(database, 'SELECT * FROM entries ORDER BY path');
    for (const entry of entryRows) {
        const path = text(entry.path);
        const state = state_from_json(entry.state_json);
        const pending = state_has_pending_edits(state);
        pendingByPath.set(path, pending);
        if ((safe_number(entry.has_pending_edits) === 1) !== pending) {
            throw sqlite_file_state_malformed_error({ rowCount: entryRows.length });
        }
        if (requiresRecovery && pending && nullable_text(entry.recovery_record_id) === undefined) {
            throw sqlite_file_state_malformed_error({ rowCount: entryRows.length });
        }
        const commit = safe_number(entry.authority_commit_sequence) as number;
        const authority = safe_number(entry.authority_revision) as number;
        const physical = safe_number(entry.physical_revision) as number;
        const projection = safe_number(entry.projection_revision) as number;
        if (commit < authority || authority < physical || authority < projection) {
            throw sqlite_file_state_malformed_error({ rowCount: entryRows.length });
        }
        const copyId = nullable_text(entry.copy_id);
        const copyPath = nullable_text(entry.copy_source_path);
        const copyRevision = safe_number(entry.copy_source_revision, true);
        if ((copyId === undefined) !== (copyPath === undefined)
            || (copyId === undefined) !== (copyRevision === undefined)
            || (copyRevision !== undefined && copyRevision >= nextRevision)) {
            throw sqlite_file_state_malformed_error({ rowCount: entryRows.length });
        }
    }
    return pendingByPath;
}

function validate_stages(database: DatabaseSync, nextRevision: number): void {
    const stageRows = rows(database, `SELECT s.*, e.authority_commit_sequence
        FROM authority_stages s JOIN entries e ON e.path = s.entry_path`);
    for (const stage of stageRows) {
        if (stage.next_state_json !== null) state_from_json(stage.next_state_json);
        if ((safe_number(stage.expected_state_revision) as number) >= nextRevision
            || (safe_number(stage.expected_commit_sequence) as number)
                > (safe_number(stage.authority_commit_sequence) as number)) {
            throw sqlite_file_state_malformed_error({ rowCount: stageRows.length });
        }
    }
}

function validate_foreign_keys(database: DatabaseSync): void {
    const failures = rows(database, 'PRAGMA foreign_key_check');
    if (failures.length > 0) {
        throw sqlite_file_state_foreign_key_error({ rowCount: failures.length });
    }
}

function validate_identity_and_counters(
    database: DatabaseSync,
    options: SqliteFileStateValidationOptions,
): { meta: SqliteRow; entryCount: number } {
    const metaRows = rows(database, 'SELECT * FROM state_meta');
    if (metaRows.length !== 1) throw sqlite_file_state_schema_error({ rowCount: metaRows.length });
    const meta = metaRows[0];
    const identity = options.identity;
    if (safe_number(meta.singleton) !== 1
        || text(meta.format) !== SQLITE_FILE_STATE_FORMAT
        || text(meta.database_id) !== identity.databaseId
        || text(meta.storage_environment_id) !== identity.storageEnvironmentId
        || text(meta.product_kind) !== identity.productKind
        || text(meta.journal_policy) !== 'delete') {
        throw sqlite_file_state_schema_error();
    }
    if (identity.coordinationGeneration !== undefined
        && safe_number(meta.coordination_generation) !== identity.coordinationGeneration) {
        throw sqlite_file_state_protocol_error({
            coordinationGeneration: safe_number(meta.coordination_generation),
        });
    }
    for (const [column, expected] of [
        ['min_reader_protocol', identity.minReaderProtocol],
        ['max_reader_protocol', identity.maxReaderProtocol],
        ['min_writer_protocol', identity.minWriterProtocol],
        ['max_writer_protocol', identity.maxWriterProtocol],
    ] as const) {
        if (expected !== undefined && safe_number(meta[column]) !== expected) {
            throw sqlite_file_state_protocol_error({ protocol: expected });
        }
    }
    const supported = options.supportedProtocol ?? SQLITE_FILE_STATE_PROTOCOL_VERSION;
    const minReader = safe_number(meta.min_reader_protocol) as number;
    const maxReader = safe_number(meta.max_reader_protocol) as number;
    const minWriter = safe_number(meta.min_writer_protocol) as number;
    const maxWriter = safe_number(meta.max_writer_protocol) as number;
    if (supported < minReader || supported > maxReader || supported < minWriter || supported > maxWriter) {
        throw sqlite_file_state_protocol_error({ protocol: supported });
    }
    const generation = safe_number(meta.coordination_generation) as number;
    if (generation < 1) throw sqlite_file_state_protocol_error({ coordinationGeneration: generation });

    const entryCount = count(database, 'SELECT count(*) AS count FROM entries');
    const maxEntryRevision = safe_number(
        row(database, 'SELECT max(state_revision) AS value FROM entries')?.value,
        true,
    ) ?? -1;
    const nextRevision = safe_number(meta.next_revision) as number;
    const absenceRevision = safe_number(meta.absence_revision) as number;
    if (nextRevision > SQLITE_FILE_STATE_EXHAUSTION_SENTINEL
        || nextRevision <= Math.max(absenceRevision, maxEntryRevision)) {
        throw sqlite_file_state_counter_error();
    }
    const maxRecency = bigint_value(
        row(database, 'SELECT max(recency_order) AS value FROM entries')?.value,
        true,
    ) ?? 0n;
    const nextRecency = bigint_value(meta.next_recency_order) as bigint;
    if (nextRecency <= maxRecency) throw sqlite_file_state_counter_error();
    const maxOwnership = safe_number(
        row(database, 'SELECT max(ownership_generation) AS value FROM edit_sessions')?.value,
        true,
    ) ?? 0;
    const nextOwnership = safe_number(meta.next_ownership_generation) as number;
    if (nextOwnership >= SQLITE_FILE_STATE_EXHAUSTION_SENTINEL || nextOwnership <= maxOwnership) {
        throw sqlite_file_state_counter_error();
    }
    return { meta, entryCount };
}

function validate_coordination(
    database: DatabaseSync,
    meta: SqliteRow,
    pending: Map<string, boolean>,
    requiresPendingEditRecovery: boolean,
): void {
    const generation = safe_number(meta.coordination_generation) as number;
    const minReader = safe_number(meta.min_reader_protocol) as number;
    const maxReader = safe_number(meta.max_reader_protocol) as number;
    const minWriter = safe_number(meta.min_writer_protocol) as number;
    const maxWriter = safe_number(meta.max_writer_protocol) as number;
    for (const session of rows(database, 'SELECT * FROM writer_sessions')) {
        const protocol = safe_number(session.negotiated_protocol) as number;
        const openedGeneration = safe_number(session.opened_generation) as number;
        if (protocol < Math.max(minReader, minWriter)
            || protocol > Math.min(maxReader, maxWriter)
            || openedGeneration > generation) {
            throw sqlite_file_state_protocol_error({ protocol, coordinationGeneration: openedGeneration });
        }
    }
    for (const lease of rows(database, 'SELECT * FROM entry_leases')) {
        if ((safe_number(lease.acquired_generation) as number) > generation) {
            throw sqlite_file_state_protocol_error({ coordinationGeneration: generation });
        }
    }
    const editRows = rows(database, 'SELECT * FROM edit_sessions');
    const ownerships = new Set<number>();
    for (const edit of editRows) {
        const ownership = safe_number(edit.ownership_generation) as number;
        if (text(edit.entry_path).length === 0
            || text(edit.physical_resource_lock_key).length === 0
            || text(edit.host_lock_id).length === 0
            || text(edit.edit_session_id).length === 0
            || text(edit.owner_writer_session_id).length === 0
            || ownerships.has(ownership) || !pending.has(text(edit.entry_path))
            || (safe_number(edit.last_confirmed_at_ms) as number)
                < (safe_number(edit.acquired_at_ms) as number)) {
            throw sqlite_file_state_malformed_error({ rowCount: editRows.length });
        }
        ownerships.add(ownership);
    }

    const reservations = rows(database, `SELECT
        r.*, e.state_json, e.state_revision, e.authority_commit_sequence, e.authority_revision,
        e.physical_revision, e.projection_revision, e.physical_digest AS current_physical_digest,
        s.kind AS stage_kind, s.expected_state_revision AS stage_state_revision,
        s.expected_commit_sequence AS stage_commit_sequence,
        s.physical_digest AS stage_physical_digest,
        s.next_state_json
        FROM file_write_reservations r
        JOIN entries e ON e.path = r.entry_path
        JOIN authority_stages s ON s.entry_path = r.entry_path AND s.stage_id = r.stage_id`);
    if (reservations.length !== count(database, 'SELECT count(*) AS count FROM file_write_reservations')) {
        throw sqlite_file_state_foreign_key_error({ rowCount: reservations.length });
    }
    for (const reservation of reservations) {
        const lifecycle = decode_state_json(reservation.state_json).lifecycle;
        const exactNumbers = [
            ['expected_state_revision', 'state_revision'],
            ['expected_commit_sequence', 'authority_commit_sequence'],
            ['expected_authority_revision', 'authority_revision'],
            ['expected_physical_revision', 'physical_revision'],
            ['expected_projection_revision', 'projection_revision'],
            ['expected_state_revision', 'stage_state_revision'],
            ['expected_commit_sequence', 'stage_commit_sequence'],
        ] as const;
        if (exactNumbers.some(([left, right]) => safe_number(reservation[left]) !== safe_number(reservation[right]))) {
            throw sqlite_file_state_malformed_error({ rowCount: reservations.length });
        }
        if (!lifecycle || lifecycle.phase !== 'reserved'
            || lifecycle.reservationId !== text(reservation.reservation_id)
            || lifecycle.saveOperationId !== text(reservation.save_operation_id)
            || lifecycle.stageId !== text(reservation.stage_id)
            || lifecycle.preparedInstallId !== text(reservation.prepared_install_id)
            || lifecycle.hostLockId !== text(reservation.host_lock_id)
            || lifecycle.physicalResourceLockKey
                !== text(reservation.physical_resource_lock_key)
            || lifecycle.expectedPhysicalDigest !== text(reservation.expected_physical_digest)
            || lifecycle.intendedPhysicalDigest !== text(reservation.intended_physical_digest)
            || lifecycle.recoveryRecordId !== nullable_text(reservation.recovery_record_id)
            || text(reservation.reservation_id).length === 0
            || text(reservation.save_operation_id).length === 0
            || text(reservation.entry_path).length === 0
            || text(reservation.physical_resource_lock_key).length === 0
            || text(reservation.host_lock_id).length === 0
            || text(reservation.edit_session_id).length === 0
            || text(reservation.stage_id).length === 0
            || text(reservation.prepared_install_id).length === 0
            || nullable_text(reservation.expected_physical_digest) === undefined
            || nullable_text(reservation.expected_physical_digest)?.length === 0
            || nullable_text(reservation.expected_physical_digest)
                !== nullable_text(reservation.current_physical_digest)
            || text(reservation.intended_physical_digest).length === 0
            || text(reservation.stage_kind) !== 'physical'
            || nullable_text(reservation.stage_physical_digest)
                !== text(reservation.intended_physical_digest)
            || (safe_number(reservation.reserved_generation) as number) !== generation) {
            throw sqlite_file_state_malformed_error({ rowCount: reservations.length });
        }
        if (requiresPendingEditRecovery
            && pending.get(text(reservation.entry_path))
            && reservation.next_state_json !== null) {
            const next = state_from_json(reservation.next_state_json);
            if (!state_has_pending_edits(next) && reservation.recovery_record_id === null) {
                throw sqlite_file_state_malformed_error({ rowCount: reservations.length });
            }
        }
    }

    const lifecycleIds = new Set<string>();
    for (const entry of rows(database, 'SELECT path, state_json FROM entries')) {
        const lifecycle = decode_state_json(entry.state_json).lifecycle;
        if (!lifecycle) continue;
        if (lifecycleIds.has(lifecycle.reservationId)) {
            throw sqlite_file_state_malformed_error();
        }
        lifecycleIds.add(lifecycle.reservationId);
        const reservation = reservations.find((candidate) => (
            text(candidate.entry_path) === text(entry.path)
        ));
        if ((lifecycle.phase === 'reserved') !== (reservation !== undefined)
            || (reservation !== undefined
                && text(reservation.reservation_id) !== lifecycle.reservationId)) {
            throw sqlite_file_state_malformed_error();
        }
    }
}

function validate_legacy_source(
    actual: SqliteRow,
    expected: SqliteLegacySourceIdentity,
): void {
    if (text(actual.source_path) !== expected.sourcePath
        || safe_number(actual.source_ordinal) !== expected.sourceOrdinal
        || safe_number(actual.source_state_revision) !== expected.sourceStateRevision
        || text(actual.source_kind) !== expected.sourceKind
        || (safe_number(actual.source_had_pending_edits) === 1) !== expected.sourceHadPendingEdits) {
        throw sqlite_file_state_malformed_error();
    }
}

function validate_legacy(
    database: DatabaseSync,
    identity: SqliteFileStateIdentity,
    meta: SqliteRow,
    pending: Map<string, boolean>,
): void {
    const importRows = rows(database, 'SELECT * FROM legacy_imports');
    const sourceRows = rows(database, 'SELECT * FROM legacy_sources ORDER BY source_ordinal');
    const claimRows = rows(database, 'SELECT * FROM legacy_entry_claims');
    if (identity.productKind === 'desktop') {
        if (meta.client_profile_id !== null || text(meta.authority_mode) !== 'sqlite'
            || importRows.length !== 0 || sourceRows.length !== 0 || claimRows.length !== 0) {
            throw sqlite_file_state_schema_error();
        }
        return;
    }
    const legacy = identity.legacy;
    if (text(meta.client_profile_id) !== identity.clientProfileId
        || text(meta.legacy_capsule_id) !== legacy.capsuleId
        || text(meta.legacy_source_format) !== legacy.sourceFormat
        || text(meta.legacy_source_digest) !== legacy.sourceDigest
        || text(meta.legacy_import_claim_id) !== legacy.importClaimId
        || importRows.length !== 1 || sourceRows.length !== legacy.sourceEntryCount) {
        throw sqlite_file_state_schema_error();
    }
    const imported = importRows[0];
    if (text(imported.capsule_id) !== legacy.capsuleId
        || text(imported.source_format) !== legacy.sourceFormat
        || text(imported.source_digest) !== legacy.sourceDigest
        || safe_number(imported.source_entry_count) !== legacy.sourceEntryCount
        || safe_number(imported.source_next_revision) !== legacy.sourceNextRevision
        || safe_number(imported.source_absence_revision) !== legacy.sourceAbsenceRevision
        || safe_number(imported.source_updated_at_ms, true) !== legacy.sourceUpdatedAtMs
        || safe_number(imported.imported_at_ms) !== legacy.importedAtMs
        || text(imported.importer_app_version) !== legacy.importerAppVersion) {
        throw sqlite_file_state_schema_error();
    }
    const expectedByOrdinal = [...legacy.sources].sort((a, b) => a.sourceOrdinal - b.sourceOrdinal);
    sourceRows.forEach((source, index) => validate_legacy_source(source, expectedByOrdinal[index]));

    const claimsBySource = new Map<string, SqliteRow[]>();
    for (const claim of claimRows) {
        const sourcePath = text(claim.source_path);
        const values = claimsBySource.get(sourcePath) ?? [];
        values.push(claim);
        claimsBySource.set(sourcePath, values);
    }
    let activeCount = 0;
    for (const source of sourceRows) {
        const status = text(source.status);
        if (status === 'active') activeCount += 1;
        const sourceClaims = claimsBySource.get(text(source.source_path)) ?? [];
        if (status === 'terminal') {
            const destination = text(source.terminal_destination_path);
            const disposition = text(source.terminal_disposition);
            if (!sourceClaims.some((claim) => (
                text(claim.destination_path) === destination
                && text(claim.disposition) === disposition
            ))) throw sqlite_file_state_malformed_error({ rowCount: sourceRows.length });
            if (safe_number(source.source_had_pending_edits) === 1) {
                text(source.pending_survival_kind);
                if (!pending.get(destination)) {
                    throw sqlite_file_state_malformed_error({ rowCount: sourceRows.length });
                }
            }
        }
        if (status === 'active' && text(source.source_kind) === 'exact_identity'
            && sourceClaims.some((claim) => text(claim.disposition) !== 'ambiguous')) {
            throw sqlite_file_state_malformed_error({ rowCount: sourceRows.length });
        }
    }
    const remoteProofFailures = count(database, `SELECT count(*) AS count
        FROM legacy_sources s
        LEFT JOIN entries e ON e.path = s.terminal_destination_path
        WHERE s.status = 'terminal'
          AND s.source_had_pending_edits = 1
          AND s.pending_survival_kind = 'canonical_remote_recovery'
          AND (e.recovery_record_id IS NULL
               OR e.recovery_record_id <> s.pending_survival_reference)`);
    if (remoteProofFailures !== 0) {
        throw sqlite_file_state_malformed_error({ rowCount: remoteProofFailures });
    }
    if (text(meta.authority_mode) === 'sqlite' && activeCount !== 0) {
        throw sqlite_file_state_malformed_error({ rowCount: activeCount });
    }
}

function validate_migration_history(database: DatabaseSync): void {
    const migrations = rows(database, 'SELECT * FROM schema_migrations ORDER BY version');
    if (migrations.length !== 1
        || safe_number(migrations[0].version) !== 1
        || text(migrations[0].name) !== SQLITE_FILE_STATE_V1_MIGRATION_NAME) {
        throw sqlite_file_state_schema_error({ rowCount: migrations.length });
    }
}

/** Validate a canonical v1 database without repairing, deleting, or defaulting any state. */
export function validate_sqlite_file_state_database(
    database: DatabaseSync,
    options: SqliteFileStateValidationOptions,
): ValidatedSqliteFileStateMetadata {
    validate_pragmas(database);
    validate_schema_objects(database);
    validate_integer_storage(database);
    validate_foreign_keys(database);
    validate_migration_history(database);
    const { meta, entryCount } = validate_identity_and_counters(database, options);
    const nextRevision = safe_number(meta.next_revision) as number;
    const requiresPendingEditRecovery = options.requiresPendingEditRecovery ?? false;
    const pending = validate_entries(database, requiresPendingEditRecovery, nextRevision);
    validate_stages(database, nextRevision);
    validate_coordination(database, meta, pending, requiresPendingEditRecovery);
    validate_legacy(database, options.identity, meta, pending);

    return {
        databaseId: text(meta.database_id),
        productKind: text(meta.product_kind) as 'desktop' | 'vscode',
        authorityMode: text(meta.authority_mode) as 'sqlite_importing_memento' | 'sqlite',
        coordinationGeneration: safe_number(meta.coordination_generation) as number,
        nextRevision: safe_number(meta.next_revision) as number,
        absenceRevision: safe_number(meta.absence_revision) as number,
        nextRecencyOrder: bigint_value(meta.next_recency_order) as bigint,
        nextOwnershipGeneration: safe_number(meta.next_ownership_generation) as number,
        entryCount,
    };
}
