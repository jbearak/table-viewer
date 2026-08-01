import {
    SQLITE_FILE_STATE_EXHAUSTION_SENTINEL,
    SQLITE_FILE_STATE_MAX_COUNTER,
} from './sqlite-file-state-schema';
import {
    sqlite_file_state_counter_error,
    sqlite_file_state_malformed_error,
} from './sqlite-file-state-errors';
import { state_has_pending_edits } from './state';
import type {
    KeyedStateReadTransaction,
    KeyedStateStoreMetadata,
    KeyedStateWriteTransaction,
    PersistedAuthorityStageRecord,
    PersistedCompleteKeyedStateEntry,
    PersistedKeyedStateEntry,
    PersistedKeyedStateEntryMetadata,
    PersistedEditSessionRecord,
    PersistedPhysicalWriteReservationRecord,
    PersistedPreparedInstallCleanupRecord,
    PersistedPreparedInstallLifecycleRecord,
} from './state';
import type {
    SqliteReadTransactionContext,
    SqliteWriteTransactionContext,
} from './sqlite-runtime';
import {
    decode_stored_per_file_state,
    type PerFileState,
    type StoredPerFileState,
} from './types';

const SQLITE_MAX_INTEGER = 9_223_372_036_854_775_807n;
const MAX_VALIDATED_RECENCY = BigInt(Number.MAX_SAFE_INTEGER);

type SqliteRow = Record<string, unknown>;

export interface SqliteFileStateRepositoryOptions {
    readonly writerSessionId: string;
    readonly now?: () => number;
}

function malformed(): never {
    throw sqlite_file_state_malformed_error();
}

function text(value: unknown): string {
    if (typeof value !== 'string') return malformed();
    return value;
}

function optional_text(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    return text(value);
}

function integer(
    tx: SqliteReadTransactionContext,
    value: unknown,
    name: string,
    minimum = 0,
    maximum = SQLITE_FILE_STATE_MAX_COUNTER,
): number {
    return tx.safe_integer(value, name, minimum, maximum);
}

function optional_integer(
    tx: SqliteReadTransactionContext,
    value: unknown,
    name: string,
): number | undefined {
    if (value === null || value === undefined) return undefined;
    return integer(tx, value, name, 0, Number.MAX_SAFE_INTEGER);
}

function sqlite_bigint(value: unknown, minimum = 1n): bigint {
    const result = typeof value === 'bigint'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value)
            ? BigInt(value)
            : undefined;
    if (result === undefined || result < minimum || result > SQLITE_MAX_INTEGER) {
        throw sqlite_file_state_counter_error();
    }
    return result;
}

function safe_input_integer(
    value: number,
    minimum = 0,
    maximum = SQLITE_FILE_STATE_MAX_COUNTER,
): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw sqlite_file_state_counter_error();
    }
    return value;
}

function safe_input_timestamp(value: number | undefined): number | null {
    if (value === undefined) return null;
    return safe_input_integer(value, 0, Number.MAX_SAFE_INTEGER);
}

export const SQLITE_PREPARED_INSTALL_STATE_KEY = '__tableViewerSqlitePreparedInstall';

function nonempty_record_text(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) return malformed();
    return value;
}

export function decode_prepared_install_lifecycle(
    value: unknown,
): PersistedPreparedInstallLifecycleRecord | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
    const record = value as Record<string, unknown>;
    if (record.version !== 1
        || (record.phase !== 'reserved' && record.phase !== 'cleanupPending')
        || !Number.isSafeInteger(record.recordedAtMs)
        || (record.recordedAtMs as number) < 0
        || (record.recoveryRecordId !== undefined
            && (typeof record.recoveryRecordId !== 'string'
                || record.recoveryRecordId.length === 0))) return malformed();
    return Object.freeze({
        version: 1,
        phase: record.phase,
        reservationId: nonempty_record_text(record, 'reservationId'),
        saveOperationId: nonempty_record_text(record, 'saveOperationId'),
        stageId: nonempty_record_text(record, 'stageId'),
        preparedInstallId: nonempty_record_text(record, 'preparedInstallId'),
        hostLockId: nonempty_record_text(record, 'hostLockId'),
        previousPhysicalResourceLockKey: nonempty_record_text(
            record,
            'previousPhysicalResourceLockKey',
        ),
        physicalResourceLockKey: nonempty_record_text(record, 'physicalResourceLockKey'),
        expectedPhysicalDigest: nonempty_record_text(record, 'expectedPhysicalDigest'),
        intendedPhysicalDigest: nonempty_record_text(record, 'intendedPhysicalDigest'),
        ...(record.recoveryRecordId === undefined ? {} : {
            recoveryRecordId: record.recoveryRecordId as string,
        }),
        recordedAtMs: record.recordedAtMs as number,
    });
}

interface DecodedStateJson {
    readonly json: string;
    readonly state: StoredPerFileState;
    readonly lifecycle?: PersistedPreparedInstallLifecycleRecord;
}

function decode_state_json(value: unknown): DecodedStateJson {
    const rawJson = text(value);
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawJson);
    } catch {
        return malformed();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return malformed();
    const logical = { ...(parsed as Record<string, unknown>) };
    const lifecycle = decode_prepared_install_lifecycle(
        logical[SQLITE_PREPARED_INSTALL_STATE_KEY],
    );
    delete logical[SQLITE_PREPARED_INSTALL_STATE_KEY];
    try {
        const state = decode_stored_per_file_state(logical);
        return {
            json: JSON.stringify(logical),
            state,
            ...(lifecycle === undefined ? {} : { lifecycle }),
        };
    } catch {
        return malformed();
    }
}

function encode_state_json(
    logicalJson: string,
    lifecycle: PersistedPreparedInstallLifecycleRecord | undefined,
): string {
    let logical: unknown;
    try {
        logical = JSON.parse(logicalJson);
    } catch {
        return malformed();
    }
    if (!logical || typeof logical !== 'object' || Array.isArray(logical)
        || Object.hasOwn(logical, SQLITE_PREPARED_INSTALL_STATE_KEY)) return malformed();
    if (lifecycle === undefined) return JSON.stringify(logical);
    return JSON.stringify({
        ...(logical as Record<string, unknown>),
        [SQLITE_PREPARED_INSTALL_STATE_KEY]: lifecycle,
    });
}

function validate_metadata(value: PersistedKeyedStateEntryMetadata): void {
    if (typeof value.path !== 'string' || value.path.length === 0
        || typeof value.recoveryEntryId !== 'string' || value.recoveryEntryId.length === 0) {
        malformed();
    }
    safe_input_integer(value.stateRevision);
    const authority = value.authority;
    safe_input_integer(authority.commitSequence);
    safe_input_integer(authority.authorityRevision);
    safe_input_integer(authority.physicalRevision);
    safe_input_integer(authority.projectionRevision);
    if (authority.authorityRevision > authority.commitSequence
        || authority.physicalRevision > authority.authorityRevision
        || authority.projectionRevision > authority.authorityRevision
        || (authority.physicalDigest !== undefined && typeof authority.physicalDigest !== 'string')) {
        malformed();
    }
    sqlite_bigint(value.recencyOrder);
    safe_input_timestamp(value.updatedAtMs);
    safe_input_timestamp(value.touchedAtMs);
    if (value.recoveryRecordId !== undefined && typeof value.recoveryRecordId !== 'string') malformed();
    const copy = value.copyProvenance;
    if (copy !== undefined) {
        if (typeof copy.id !== 'string' || copy.id.length === 0
            || typeof copy.sourcePath !== 'string' || copy.sourcePath.length === 0) malformed();
        safe_input_integer(copy.sourceRevision);
    }
}

function validate_entry(value: PersistedKeyedStateEntry): void {
    validate_metadata(value);
    let parsed: unknown;
    try {
        parsed = JSON.parse(value.stateJson);
    } catch {
        return malformed();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.hasOwn(parsed, SQLITE_PREPARED_INSTALL_STATE_KEY)) return malformed();
    let state: StoredPerFileState;
    try {
        state = decode_stored_per_file_state(parsed);
    } catch {
        return malformed();
    }
    if (state_has_pending_edits(state) !== value.hasPendingEdits) malformed();
}

function validate_stage(stage: PersistedAuthorityStageRecord): void {
    if (typeof stage.id !== 'string' || stage.id.length === 0
        || (stage.kind !== 'physical' && stage.kind !== 'projection')) malformed();
    safe_input_integer(stage.ordinal, 0, Number.MAX_SAFE_INTEGER);
    safe_input_integer(stage.expectedStateRevision);
    safe_input_integer(stage.expectedCommitSequence);
    safe_input_integer(stage.createdAt, 0, Number.MAX_SAFE_INTEGER);
    if (stage.physicalDigest !== undefined && typeof stage.physicalDigest !== 'string') malformed();
    if (stage.nextState !== undefined) {
        try {
            decode_stored_per_file_state(stage.nextState);
        } catch {
            malformed();
        }
    }
}

function metadata_from_row(
    tx: SqliteReadTransactionContext,
    row: SqliteRow,
): PersistedKeyedStateEntryMetadata {
    const copyId = optional_text(row.copy_id);
    const copyPath = optional_text(row.copy_source_path);
    const copyRevision = row.copy_source_revision === null || row.copy_source_revision === undefined
        ? undefined
        : integer(tx, row.copy_source_revision, 'copy source revision');
    if ((copyId === undefined) !== (copyPath === undefined)
        || (copyId === undefined) !== (copyRevision === undefined)) malformed();
    const stageCount = row.authority_stage_count === undefined
        ? undefined
        : integer(tx, row.authority_stage_count, 'authority stage count', 0, Number.MAX_SAFE_INTEGER);
    return {
        path: text(row.path),
        stateRevision: integer(tx, row.state_revision, 'state revision'),
        hasPendingEdits: integer(tx, row.has_pending_edits, 'pending flag', 0, 1) === 1,
        authority: {
            commitSequence: integer(tx, row.authority_commit_sequence, 'authority commit sequence'),
            authorityRevision: integer(tx, row.authority_revision, 'authority revision'),
            physicalRevision: integer(tx, row.physical_revision, 'physical revision'),
            projectionRevision: integer(tx, row.projection_revision, 'projection revision'),
            ...(optional_text(row.physical_digest) === undefined
                ? {}
                : { physicalDigest: optional_text(row.physical_digest) }),
        },
        recencyOrder: sqlite_bigint(row.recency_order),
        ...(optional_integer(tx, row.updated_at_ms, 'entry updated timestamp') === undefined
            ? {}
            : { updatedAtMs: optional_integer(tx, row.updated_at_ms, 'entry updated timestamp') }),
        ...(optional_integer(tx, row.touched_at_ms, 'entry touched timestamp') === undefined
            ? {}
            : { touchedAtMs: optional_integer(tx, row.touched_at_ms, 'entry touched timestamp') }),
        recoveryEntryId: text(row.recovery_entry_id),
        ...(optional_text(row.recovery_record_id) === undefined
            ? {}
            : { recoveryRecordId: optional_text(row.recovery_record_id) }),
        ...(copyId === undefined ? {} : {
            copyProvenance: {
                id: copyId,
                sourcePath: copyPath as string,
                sourceRevision: copyRevision as number,
            },
        }),
        ...(stageCount === undefined ? {} : { authorityStageCount: stageCount }),
        ...(row.has_prepared_install_cleanup === undefined
            || integer(
                tx,
                row.has_prepared_install_cleanup,
                'prepared install cleanup flag',
                0,
                1,
            ) === 0
            ? {}
            : { hasPreparedInstallCleanup: true }),
        ...(optional_integer(tx, row.oldest_authority_stage_created_at_ms, 'oldest stage timestamp') === undefined
            ? {}
            : {
                oldestAuthorityStageCreatedAtMs: optional_integer(
                    tx,
                    row.oldest_authority_stage_created_at_ms,
                    'oldest stage timestamp',
                ),
            }),
    };
}

const ENTRY_METADATA_COLUMNS = `e.path, e.state_revision, e.has_pending_edits,
    e.authority_commit_sequence, e.authority_revision, e.physical_revision,
    e.projection_revision, e.physical_digest, e.recency_order, e.updated_at_ms,
    e.touched_at_ms, e.recovery_entry_id, e.recovery_record_id,
    e.copy_id, e.copy_source_path, e.copy_source_revision,
    CASE WHEN json_extract(
        e.state_json,
        '$.${SQLITE_PREPARED_INSTALL_STATE_KEY}.phase'
    ) = 'cleanupPending' THEN 1 ELSE 0 END AS has_prepared_install_cleanup,
    (SELECT count(*) FROM authority_stages s WHERE s.entry_path = e.path)
        AS authority_stage_count,
    (SELECT min(s.created_at_ms) FROM authority_stages s WHERE s.entry_path = e.path)
        AS oldest_authority_stage_created_at_ms`;

const COMPLETE_ENTRY_COLUMNS = `${ENTRY_METADATA_COLUMNS}, e.state_json`;

function stage_from_row(
    tx: SqliteReadTransactionContext,
    row: SqliteRow,
): PersistedAuthorityStageRecord {
    const kind = text(row.kind);
    if (kind !== 'physical' && kind !== 'projection') return malformed();
    const nextJson = optional_text(row.next_state_json);
    let nextState: PerFileState | undefined;
    if (nextJson !== undefined) nextState = decode_state_json(nextJson).state as PerFileState;
    const stage: PersistedAuthorityStageRecord = {
        id: text(row.stage_id),
        kind,
        ordinal: integer(tx, row.ordinal, 'stage ordinal', 0, Number.MAX_SAFE_INTEGER),
        expectedStateRevision: integer(tx, row.expected_state_revision, 'expected state revision'),
        expectedCommitSequence: integer(tx, row.expected_commit_sequence, 'expected commit sequence'),
        createdAt: integer(tx, row.created_at_ms, 'stage created timestamp', 0, Number.MAX_SAFE_INTEGER),
        ...(nextState === undefined ? {} : { nextState }),
        ...(optional_text(row.physical_digest) === undefined
            ? {}
            : { physicalDigest: optional_text(row.physical_digest) }),
    };
    validate_stage(stage);
    return stage;
}

function recency_input(value: bigint): bigint {
    return sqlite_bigint(value);
}

/** Prepared-statement mapping for one already-open SQLite transaction. */
export class SqliteFileStateRepository implements KeyedStateWriteTransaction {
    readonly #tx: SqliteReadTransactionContext | SqliteWriteTransactionContext;
    readonly #writerSessionId: string;
    readonly #now: () => number;

    constructor(
        tx: SqliteReadTransactionContext | SqliteWriteTransactionContext,
        options: SqliteFileStateRepositoryOptions,
    ) {
        if (typeof options.writerSessionId !== 'string' || options.writerSessionId.length === 0) {
            throw new TypeError('writerSessionId must not be empty.');
        }
        this.#tx = tx;
        this.#writerSessionId = options.writerSessionId;
        this.#now = options.now ?? Date.now;
    }

    #write_tx(): SqliteWriteTransactionContext {
        if (!('mark_changed' in this.#tx)) throw new Error('SQLite repository transaction is read-only.');
        return this.#tx;
    }

    metadata(): KeyedStateStoreMetadata {
        const row = this.#tx.prepare(`SELECT next_revision, absence_revision,
            next_recency_order, store_updated_at_ms FROM state_meta WHERE singleton = 1`).get();
        if (!row) return malformed();
        const updatedAtMs = optional_integer(this.#tx, row.store_updated_at_ms, 'store updated timestamp');
        return {
            nextRevision: integer(
                this.#tx,
                row.next_revision,
                'next revision',
                1,
                SQLITE_FILE_STATE_EXHAUSTION_SENTINEL,
            ),
            absenceRevision: integer(this.#tx, row.absence_revision, 'absence revision'),
            nextRecencyOrder: sqlite_bigint(row.next_recency_order),
            ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
        };
    }

    read_entry_metadata(path: string): PersistedKeyedStateEntryMetadata | undefined {
        const row = this.#tx.prepare(`SELECT ${ENTRY_METADATA_COLUMNS}
            FROM entries e WHERE e.path = ?`).get(path);
        return row === undefined ? undefined : metadata_from_row(this.#tx, row);
    }

    read_entry(path: string): PersistedCompleteKeyedStateEntry | undefined {
        const row = this.#tx.prepare(`SELECT ${COMPLETE_ENTRY_COLUMNS}
            FROM entries e WHERE e.path = ?`).get(path);
        if (!row) return undefined;
        const metadata = metadata_from_row(this.#tx, row);
        const decoded = decode_state_json(row.state_json);
        if (state_has_pending_edits(decoded.state) !== metadata.hasPendingEdits) malformed();
        return {
            entry: { ...metadata, stateJson: decoded.json },
            stages: this.read_authority_stages(path),
        };
    }

    read_authority_stages(path: string): readonly PersistedAuthorityStageRecord[] {
        return this.#tx.prepare(`SELECT stage_id, kind, ordinal, expected_state_revision,
            expected_commit_sequence, next_state_json, physical_digest, created_at_ms
            FROM authority_stages WHERE entry_path = ?
            ORDER BY created_at_ms, ordinal, stage_id`).all(path)
            .map((row) => stage_from_row(this.#tx, row));
    }

    scan_entry_metadata(): readonly PersistedKeyedStateEntryMetadata[] {
        return this.#tx.prepare(`SELECT ${ENTRY_METADATA_COLUMNS}
            FROM entries e ORDER BY e.recency_order, e.path`).all()
            .map((row) => metadata_from_row(this.#tx, row));
    }

    entry_is_leased(path: string): boolean {
        return this.#tx.prepare(`SELECT 1 AS present FROM entry_leases
            WHERE current_entry_path = ? LIMIT 1`).get(path) !== undefined;
    }

    #edit_session_from_row(row: Record<string, unknown>): PersistedEditSessionRecord {
        return {
            entryPath: text(row.entry_path),
            physicalResourceLockKey: text(row.physical_resource_lock_key),
            hostLockId: text(row.host_lock_id),
            editSessionId: text(row.edit_session_id),
            ownerWriterSessionId: text(row.owner_writer_session_id),
            ownershipGeneration: integer(this.#tx, row.ownership_generation, 'ownership generation', 1),
            acquiredAtMs: integer(this.#tx, row.acquired_at_ms, 'edit acquired timestamp', 0, Number.MAX_SAFE_INTEGER),
            lastConfirmedAtMs: integer(this.#tx, row.last_confirmed_at_ms, 'edit confirmed timestamp', 0, Number.MAX_SAFE_INTEGER),
        };
    }

    read_edit_session(path: string): PersistedEditSessionRecord | undefined {
        const row = this.#tx.prepare(`SELECT entry_path, physical_resource_lock_key,
            host_lock_id, edit_session_id, owner_writer_session_id,
            ownership_generation, acquired_at_ms, last_confirmed_at_ms
            FROM edit_sessions WHERE entry_path = ?`).get(path);
        return row === undefined ? undefined : this.#edit_session_from_row(row);
    }

    read_edit_session_by_identity(
        sessionId: string,
        ownershipGeneration: number,
    ): PersistedEditSessionRecord | undefined {
        const row = this.#tx.prepare(`SELECT entry_path, physical_resource_lock_key,
            host_lock_id, edit_session_id, owner_writer_session_id,
            ownership_generation, acquired_at_ms, last_confirmed_at_ms
            FROM edit_sessions
            WHERE edit_session_id = ? AND ownership_generation = ?`).get(
            sessionId,
            ownershipGeneration,
        );
        return row === undefined ? undefined : this.#edit_session_from_row(row);
    }

    read_physical_write_reservation(path: string): PersistedPhysicalWriteReservationRecord | undefined {
        const row = this.#tx.prepare(`SELECT r.reservation_id, r.save_operation_id, r.entry_path,
            r.physical_resource_lock_key, r.host_lock_id, r.edit_session_id,
            r.ownership_generation, r.reserved_generation, r.stage_id,
            r.prepared_install_id, r.expected_state_revision, r.expected_commit_sequence,
            r.expected_authority_revision, r.expected_physical_revision,
            r.expected_projection_revision, r.expected_physical_digest,
            r.intended_physical_digest, r.recovery_record_id, r.acquired_at_ms,
            e.state_json
            FROM file_write_reservations r
            JOIN entries e ON e.path = r.entry_path
            WHERE r.entry_path = ?`).get(path);
        if (!row) return undefined;
        const lifecycle = decode_state_json(row.state_json).lifecycle;
        if (!lifecycle || lifecycle.phase !== 'reserved') return malformed();
        const record: PersistedPhysicalWriteReservationRecord = {
            reservationId: text(row.reservation_id),
            saveOperationId: text(row.save_operation_id),
            entryPath: text(row.entry_path),
            physicalResourceLockKey: text(row.physical_resource_lock_key),
            previousPhysicalResourceLockKey: lifecycle.previousPhysicalResourceLockKey,
            hostLockId: text(row.host_lock_id),
            editSessionId: text(row.edit_session_id),
            ownershipGeneration: integer(this.#tx, row.ownership_generation, 'reservation ownership generation', 1),
            reservedGeneration: integer(this.#tx, row.reserved_generation, 'reserved generation', 1),
            stageId: text(row.stage_id),
            preparedInstallId: text(row.prepared_install_id),
            expectedStateRevision: integer(this.#tx, row.expected_state_revision, 'reserved state revision'),
            expectedAuthority: {
                commitSequence: integer(this.#tx, row.expected_commit_sequence, 'reserved commit sequence'),
                authorityRevision: integer(this.#tx, row.expected_authority_revision, 'reserved authority revision'),
                physicalRevision: integer(this.#tx, row.expected_physical_revision, 'reserved physical revision'),
                projectionRevision: integer(this.#tx, row.expected_projection_revision, 'reserved projection revision'),
                physicalDigest: text(row.expected_physical_digest),
            },
            expectedPhysicalDigest: text(row.expected_physical_digest),
            intendedPhysicalDigest: text(row.intended_physical_digest),
            ...(optional_text(row.recovery_record_id) === undefined ? {} : {
                recoveryRecordId: optional_text(row.recovery_record_id),
            }),
            acquiredAtMs: integer(this.#tx, row.acquired_at_ms, 'reservation acquired timestamp', 0, Number.MAX_SAFE_INTEGER),
        };
        if (lifecycle.reservationId !== record.reservationId
            || lifecycle.saveOperationId !== record.saveOperationId
            || lifecycle.stageId !== record.stageId
            || lifecycle.preparedInstallId !== record.preparedInstallId
            || lifecycle.hostLockId !== record.hostLockId
            || lifecycle.physicalResourceLockKey !== record.physicalResourceLockKey
            || lifecycle.expectedPhysicalDigest !== record.expectedPhysicalDigest
            || lifecycle.intendedPhysicalDigest !== record.intendedPhysicalDigest
            || lifecycle.recoveryRecordId !== record.recoveryRecordId) return malformed();
        return record;
    }

    allocate_revision(): number {
        const tx = this.#write_tx();
        const row = tx.prepare('SELECT next_revision FROM state_meta WHERE singleton = 1').get();
        if (!row) return malformed();
        const revision = integer(
            tx,
            row.next_revision,
            'next revision',
            1,
            SQLITE_FILE_STATE_EXHAUSTION_SENTINEL,
        );
        if (revision >= SQLITE_FILE_STATE_EXHAUSTION_SENTINEL) {
            throw sqlite_file_state_counter_error();
        }
        const result = tx.prepare(`UPDATE state_meta SET next_revision = ?
            WHERE singleton = 1 AND next_revision = ?`).run(revision + 1, revision);
        if (tx.safe_integer(result.changes, 'revision allocation changes') !== 1) malformed();
        return revision;
    }

    #renormalize_recency(): void {
        const tx = this.#write_tx();
        const rows = tx.prepare('SELECT path, recency_order FROM entries ORDER BY recency_order, path').all();
        if (BigInt(rows.length) >= SQLITE_MAX_INTEGER) throw sqlite_file_state_counter_error();
        const temporaryStart = SQLITE_MAX_INTEGER - BigInt(rows.length) + 1n;
        const update = tx.prepare('UPDATE entries SET recency_order = ? WHERE path = ?');
        for (let index = rows.length - 1; index >= 0; index -= 1) {
            const result = update.run(temporaryStart + BigInt(index), text(rows[index].path));
            if (tx.safe_integer(result.changes, 'temporary recency update changes') !== 1) malformed();
        }
        for (let index = 0; index < rows.length; index += 1) {
            const result = update.run(BigInt(index + 1), text(rows[index].path));
            if (tx.safe_integer(result.changes, 'recency update changes') !== 1) malformed();
        }
        const next = BigInt(rows.length + 1);
        const result = tx.prepare(`UPDATE state_meta SET next_recency_order = ?
            WHERE singleton = 1`).run(next);
        if (tx.safe_integer(result.changes, 'recency metadata changes') !== 1) malformed();
    }

    allocate_recency_order(): bigint {
        const tx = this.#write_tx();
        let row = tx.prepare('SELECT next_recency_order FROM state_meta WHERE singleton = 1').get();
        if (!row) return malformed();
        let recency = sqlite_bigint(row.next_recency_order);
        if (recency >= MAX_VALIDATED_RECENCY) {
            this.#renormalize_recency();
            row = tx.prepare('SELECT next_recency_order FROM state_meta WHERE singleton = 1').get();
            if (!row) return malformed();
            recency = sqlite_bigint(row.next_recency_order);
        }
        const result = tx.prepare(`UPDATE state_meta SET next_recency_order = ?
            WHERE singleton = 1 AND next_recency_order = ?`).run(recency + 1n, recency);
        if (tx.safe_integer(result.changes, 'recency allocation changes') !== 1) malformed();
        return recency;
    }

    set_absence_revision(revision: number): void {
        const tx = this.#write_tx();
        const safeRevision = safe_input_integer(revision);
        const next = this.metadata().nextRevision;
        if (safeRevision >= next) malformed();
        const result = tx.prepare(`UPDATE state_meta SET absence_revision = ?
            WHERE singleton = 1`).run(safeRevision);
        if (tx.safe_integer(result.changes, 'absence revision changes') !== 1) malformed();
    }

    set_updated_at(timestamp: number): void {
        const tx = this.#write_tx();
        const safeTimestamp = safe_input_integer(timestamp, 0, Number.MAX_SAFE_INTEGER);
        const result = tx.prepare(`UPDATE state_meta
            SET store_updated_at_ms = CASE
                WHEN store_updated_at_ms IS NULL OR store_updated_at_ms < ? THEN ?
                ELSE store_updated_at_ms END
            WHERE singleton = 1`).run(safeTimestamp, safeTimestamp);
        if (tx.safe_integer(result.changes, 'store timestamp changes') !== 1) malformed();
    }

    #write_entry_row(value: PersistedKeyedStateEntry): void {
        validate_entry(value);
        const existingRow = this.#tx.prepare(
            'SELECT state_json FROM entries WHERE path = ?',
        ).get(value.path);
        const lifecycle = existingRow === undefined
            ? undefined
            : decode_state_json(existingRow.state_json).lifecycle;
        const persistedStateJson = encode_state_json(value.stateJson, lifecycle);
        const copy = value.copyProvenance;
        const result = this.#write_tx().prepare(`INSERT INTO entries (
            path, state_revision, state_json, has_pending_edits,
            authority_commit_sequence, authority_revision, physical_revision,
            projection_revision, physical_digest, recency_order, updated_at_ms,
            touched_at_ms, recovery_entry_id, recovery_record_id, copy_id,
            copy_source_path, copy_source_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            state_revision = excluded.state_revision,
            state_json = excluded.state_json,
            has_pending_edits = excluded.has_pending_edits,
            authority_commit_sequence = excluded.authority_commit_sequence,
            authority_revision = excluded.authority_revision,
            physical_revision = excluded.physical_revision,
            projection_revision = excluded.projection_revision,
            physical_digest = excluded.physical_digest,
            recency_order = excluded.recency_order,
            updated_at_ms = excluded.updated_at_ms,
            touched_at_ms = excluded.touched_at_ms,
            recovery_entry_id = excluded.recovery_entry_id,
            recovery_record_id = excluded.recovery_record_id,
            copy_id = excluded.copy_id,
            copy_source_path = excluded.copy_source_path,
            copy_source_revision = excluded.copy_source_revision`).run(
            value.path,
            value.stateRevision,
            persistedStateJson,
            value.hasPendingEdits ? 1 : 0,
            value.authority.commitSequence,
            value.authority.authorityRevision,
            value.authority.physicalRevision,
            value.authority.projectionRevision,
            value.authority.physicalDigest ?? null,
            recency_input(value.recencyOrder),
            safe_input_timestamp(value.updatedAtMs),
            safe_input_timestamp(value.touchedAtMs),
            value.recoveryEntryId,
            value.recoveryRecordId ?? null,
            copy?.id ?? null,
            copy?.sourcePath ?? null,
            copy?.sourceRevision ?? null,
        );
        if (this.#tx.safe_integer(result.changes, 'entry write changes') !== 1) malformed();
    }

    write_entry(value: PersistedCompleteKeyedStateEntry): void {
        const ids = new Set<string>();
        for (const stage of value.stages) {
            validate_stage(stage);
            if (ids.has(stage.id)) malformed();
            ids.add(stage.id);
        }
        this.#write_entry_row(value.entry);
        this.write_authority_stages(value.entry.path, value.stages);
    }

    insert_empty_entry(value: PersistedKeyedStateEntryMetadata): void {
        validate_metadata(value);
        if (value.hasPendingEdits) malformed();
        const result = this.#write_tx().prepare(`INSERT INTO entries (
            path, state_revision, state_json, has_pending_edits,
            authority_commit_sequence, authority_revision, physical_revision,
            projection_revision, physical_digest, recency_order, updated_at_ms,
            touched_at_ms, recovery_entry_id, recovery_record_id, copy_id,
            copy_source_path, copy_source_revision
        ) VALUES (?, ?, '{}', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            value.path,
            value.stateRevision,
            value.authority.commitSequence,
            value.authority.authorityRevision,
            value.authority.physicalRevision,
            value.authority.projectionRevision,
            value.authority.physicalDigest ?? null,
            recency_input(value.recencyOrder),
            safe_input_timestamp(value.updatedAtMs),
            safe_input_timestamp(value.touchedAtMs),
            value.recoveryEntryId,
            value.recoveryRecordId ?? null,
            value.copyProvenance?.id ?? null,
            value.copyProvenance?.sourcePath ?? null,
            value.copyProvenance?.sourceRevision ?? null,
        );
        if (this.#tx.safe_integer(result.changes, 'empty entry insert changes') !== 1) malformed();
    }

    write_entry_metadata(value: PersistedKeyedStateEntryMetadata): void {
        validate_metadata(value);
        const copy = value.copyProvenance;
        const result = this.#write_tx().prepare(`UPDATE entries SET
            state_revision = ?, has_pending_edits = ?,
            authority_commit_sequence = ?, authority_revision = ?,
            physical_revision = ?, projection_revision = ?, physical_digest = ?,
            recency_order = ?, updated_at_ms = ?, touched_at_ms = ?,
            recovery_entry_id = ?, recovery_record_id = ?, copy_id = ?,
            copy_source_path = ?, copy_source_revision = ?
            WHERE path = ?`).run(
            value.stateRevision,
            value.hasPendingEdits ? 1 : 0,
            value.authority.commitSequence,
            value.authority.authorityRevision,
            value.authority.physicalRevision,
            value.authority.projectionRevision,
            value.authority.physicalDigest ?? null,
            recency_input(value.recencyOrder),
            safe_input_timestamp(value.updatedAtMs),
            safe_input_timestamp(value.touchedAtMs),
            value.recoveryEntryId,
            value.recoveryRecordId ?? null,
            copy?.id ?? null,
            copy?.sourcePath ?? null,
            copy?.sourceRevision ?? null,
            value.path,
        );
        if (this.#tx.safe_integer(result.changes, 'entry metadata changes') !== 1) malformed();
    }

    write_authority_stages(
        path: string,
        stages: readonly PersistedAuthorityStageRecord[],
    ): void {
        const tx = this.#write_tx();
        const ids = new Set<string>();
        for (const stage of stages) {
            validate_stage(stage);
            if (ids.has(stage.id)) malformed();
            ids.add(stage.id);
        }
        tx.prepare('DELETE FROM authority_stages WHERE entry_path = ?').run(path);
        const insert = tx.prepare(`INSERT INTO authority_stages (
            entry_path, stage_id, kind, ordinal, expected_state_revision,
            expected_commit_sequence, next_state_json, physical_digest, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const stage of stages) {
            const result = insert.run(
                path,
                stage.id,
                stage.kind,
                stage.ordinal,
                stage.expectedStateRevision,
                stage.expectedCommitSequence,
                stage.nextState === undefined ? null : JSON.stringify(stage.nextState),
                stage.physicalDigest ?? null,
                stage.createdAt,
            );
            if (tx.safe_integer(result.changes, 'authority stage insert changes') !== 1) malformed();
        }
    }

    delete_authority_stages_before(boundary: number): readonly string[] {
        const tx = this.#write_tx();
        const safeBoundary = safe_input_integer(
            boundary,
            Number.MIN_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER,
        );
        const paths = tx.prepare(`SELECT DISTINCT s.entry_path
            FROM authority_stages s INDEXED BY authority_stages_by_age
            WHERE s.created_at_ms < ?
              AND NOT EXISTS (SELECT 1 FROM file_write_reservations r
                  WHERE r.entry_path = s.entry_path)
            ORDER BY s.entry_path`).all(safeBoundary)
            .map((row) => text(row.entry_path));
        if (paths.length > 0) {
            tx.prepare(`DELETE FROM authority_stages INDEXED BY authority_stages_by_age
                WHERE created_at_ms < ?
                  AND NOT EXISTS (SELECT 1 FROM file_write_reservations r
                      WHERE r.entry_path = authority_stages.entry_path)`).run(safeBoundary);
        }
        return paths;
    }

    delete_entry(path: string): void {
        this.#write_tx().prepare('DELETE FROM entries WHERE path = ?').run(path);
    }

    allocate_ownership_generation(): number {
        const tx = this.#write_tx();
        const row = tx.prepare(`SELECT next_ownership_generation FROM state_meta
            WHERE singleton = 1`).get();
        if (!row) return malformed();
        const generation = integer(
            tx,
            row.next_ownership_generation,
            'next ownership generation',
            1,
            SQLITE_FILE_STATE_EXHAUSTION_SENTINEL,
        );
        if (generation >= SQLITE_FILE_STATE_EXHAUSTION_SENTINEL) {
            throw sqlite_file_state_counter_error();
        }
        const result = tx.prepare(`UPDATE state_meta SET next_ownership_generation = ?
            WHERE singleton = 1 AND next_ownership_generation = ?`).run(generation + 1, generation);
        if (tx.safe_integer(result.changes, 'ownership allocation changes') !== 1) malformed();
        return generation;
    }

    insert_edit_session(value: PersistedEditSessionRecord): void {
        const result = this.#write_tx().prepare(`INSERT INTO edit_sessions (
            entry_path, physical_resource_lock_key, host_lock_id, edit_session_id,
            owner_writer_session_id, ownership_generation, acquired_at_ms,
            last_confirmed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
            value.entryPath,
            value.physicalResourceLockKey,
            value.hostLockId,
            value.editSessionId,
            value.ownerWriterSessionId,
            value.ownershipGeneration,
            value.acquiredAtMs,
            value.lastConfirmedAtMs,
        );
        if (this.#tx.safe_integer(result.changes, 'edit session insert changes') !== 1) malformed();
    }

    update_edit_session_lock_set(
        path: string,
        sessionId: string,
        generation: number,
        hostLockId: string,
        expectedPhysicalResourceLockKey: string,
        newPhysicalResourceLockKey: string,
    ): 'updated' | 'conflict' | 'busy' {
        if (!path || !sessionId || !hostLockId
            || !expectedPhysicalResourceLockKey || !newPhysicalResourceLockKey) malformed();
        const tx = this.#write_tx();
        const conflicting = tx.prepare(`SELECT 1 AS present FROM edit_sessions
            WHERE physical_resource_lock_key = ? AND entry_path <> ? LIMIT 1`).get(
            newPhysicalResourceLockKey,
            path,
        );
        if (conflicting) return 'busy';
        const result = tx.prepare(`UPDATE edit_sessions
            SET physical_resource_lock_key = ?, last_confirmed_at_ms = ?
            WHERE entry_path = ? AND edit_session_id = ? AND ownership_generation = ?
              AND owner_writer_session_id = ? AND host_lock_id = ?
              AND physical_resource_lock_key = ?
              AND NOT EXISTS (SELECT 1 FROM file_write_reservations
                  WHERE entry_path = edit_sessions.entry_path)`).run(
            newPhysicalResourceLockKey,
            safe_input_integer(this.#now(), 0, Number.MAX_SAFE_INTEGER),
            path,
            sessionId,
            generation,
            this.#writerSessionId,
            hostLockId,
            expectedPhysicalResourceLockKey,
        );
        return this.#tx.safe_integer(result.changes, 'edit session lock-set update changes') === 1
            ? 'updated'
            : 'conflict';
    }

    delete_edit_session(path: string, sessionId: string, generation: number): boolean {
        const result = this.#write_tx().prepare(`DELETE FROM edit_sessions
            WHERE entry_path = ? AND edit_session_id = ? AND ownership_generation = ?
              AND owner_writer_session_id = ?
              AND NOT EXISTS (SELECT 1 FROM file_write_reservations
                  WHERE entry_path = edit_sessions.entry_path)`).run(
            path,
            sessionId,
            generation,
            this.#writerSessionId,
        );
        return this.#tx.safe_integer(result.changes, 'edit session delete changes') === 1;
    }

    #set_prepared_install_lifecycle(
        path: string,
        expected: PersistedPreparedInstallLifecycleRecord | undefined,
        next: PersistedPreparedInstallLifecycleRecord | undefined,
    ): boolean {
        const tx = this.#write_tx();
        const row = tx.prepare('SELECT state_json FROM entries WHERE path = ?').get(path);
        if (!row) return false;
        const decoded = decode_state_json(row.state_json);
        if (JSON.stringify(decoded.lifecycle) !== JSON.stringify(expected)) return false;
        const result = tx.prepare('UPDATE entries SET state_json = ? WHERE path = ?').run(
            encode_state_json(decoded.json, next),
            path,
        );
        return tx.safe_integer(result.changes, 'prepared install lifecycle changes') === 1;
    }

    read_prepared_install_lifecycle(
        path: string,
    ): PersistedPreparedInstallLifecycleRecord | undefined {
        const row = this.#tx.prepare('SELECT state_json FROM entries WHERE path = ?').get(path);
        return row === undefined ? undefined : decode_state_json(row.state_json).lifecycle;
    }

    read_physical_write_cleanups(): readonly PersistedPreparedInstallCleanupRecord[] {
        const records: PersistedPreparedInstallCleanupRecord[] = [];
        for (const row of this.#tx.prepare('SELECT path, state_json FROM entries ORDER BY path').all()) {
            const lifecycle = decode_state_json(row.state_json).lifecycle;
            if (lifecycle?.phase !== 'cleanupPending') continue;
            records.push({
                targetPath: text(row.path),
                reservationId: lifecycle.reservationId,
                saveOperationId: lifecycle.saveOperationId,
                stageId: lifecycle.stageId,
                preparedInstallId: lifecycle.preparedInstallId,
                hostLockId: lifecycle.hostLockId,
                previousPhysicalResourceLockKey: lifecycle.previousPhysicalResourceLockKey,
                physicalResourceLockKey: lifecycle.physicalResourceLockKey,
                expectedPhysicalDigest: lifecycle.expectedPhysicalDigest,
                intendedPhysicalDigest: lifecycle.intendedPhysicalDigest,
                ...(lifecycle.recoveryRecordId === undefined ? {} : {
                    recoveryRecordId: lifecycle.recoveryRecordId,
                }),
                finalizedAtMs: lifecycle.recordedAtMs,
            });
        }
        return records;
    }

    transition_reservation_to_cleanup(
        path: string,
        reservationId: string,
        finalizedAtMs: number,
    ): boolean {
        const current = this.read_prepared_install_lifecycle(path);
        if (!current || current.phase !== 'reserved'
            || current.reservationId !== reservationId) return false;
        return this.#set_prepared_install_lifecycle(path, current, {
            ...current,
            phase: 'cleanupPending',
            recordedAtMs: safe_input_integer(finalizedAtMs, 0, Number.MAX_SAFE_INTEGER),
        });
    }

    clear_reserved_install_lifecycle(path: string, reservationId: string): boolean {
        const current = this.read_prepared_install_lifecycle(path);
        return !!current && current.phase === 'reserved'
            && current.reservationId === reservationId
            && this.#set_prepared_install_lifecycle(path, current, undefined);
    }

    clear_prepared_install_cleanup(record: PersistedPreparedInstallCleanupRecord): boolean {
        const current = this.read_prepared_install_lifecycle(record.targetPath);
        return !!current && current.phase === 'cleanupPending'
            && current.reservationId === record.reservationId
            && current.saveOperationId === record.saveOperationId
            && current.stageId === record.stageId
            && current.preparedInstallId === record.preparedInstallId
            && current.hostLockId === record.hostLockId
            && current.previousPhysicalResourceLockKey
                === record.previousPhysicalResourceLockKey
            && current.physicalResourceLockKey === record.physicalResourceLockKey
            && current.expectedPhysicalDigest === record.expectedPhysicalDigest
            && current.intendedPhysicalDigest === record.intendedPhysicalDigest
            && current.recoveryRecordId === record.recoveryRecordId
            && current.recordedAtMs === record.finalizedAtMs
            && this.#set_prepared_install_lifecycle(record.targetPath, current, undefined);
    }

    insert_reservation(value: PersistedPhysicalWriteReservationRecord): void {
        const authority = value.expectedAuthority;
        const result = this.#write_tx().prepare(`INSERT INTO file_write_reservations (
            reservation_id, save_operation_id, entry_path, physical_resource_lock_key,
            host_lock_id, edit_session_id, ownership_generation, reserved_generation,
            stage_id, prepared_install_id, expected_state_revision,
            expected_commit_sequence, expected_authority_revision,
            expected_physical_revision, expected_projection_revision,
            expected_physical_digest, intended_physical_digest, recovery_record_id,
            acquired_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            value.reservationId,
            value.saveOperationId,
            value.entryPath,
            value.physicalResourceLockKey,
            value.hostLockId,
            value.editSessionId,
            value.ownershipGeneration,
            value.reservedGeneration,
            value.stageId,
            value.preparedInstallId,
            value.expectedStateRevision,
            authority.commitSequence,
            authority.authorityRevision,
            authority.physicalRevision,
            authority.projectionRevision,
            value.expectedPhysicalDigest,
            value.intendedPhysicalDigest,
            value.recoveryRecordId ?? null,
            value.acquiredAtMs,
        );
        if (this.#tx.safe_integer(result.changes, 'reservation insert changes') !== 1) malformed();
        if (!this.#set_prepared_install_lifecycle(value.entryPath, undefined, {
            version: 1,
            phase: 'reserved',
            reservationId: value.reservationId,
            saveOperationId: value.saveOperationId,
            stageId: value.stageId,
            preparedInstallId: value.preparedInstallId,
            hostLockId: value.hostLockId,
            previousPhysicalResourceLockKey: value.previousPhysicalResourceLockKey,
            physicalResourceLockKey: value.physicalResourceLockKey,
            expectedPhysicalDigest: value.expectedPhysicalDigest,
            intendedPhysicalDigest: value.intendedPhysicalDigest,
            ...(value.recoveryRecordId === undefined ? {} : {
                recoveryRecordId: value.recoveryRecordId,
            }),
            recordedAtMs: value.acquiredAtMs,
        })) malformed();
    }

    delete_reservation(path: string, reservationId: string): boolean {
        const result = this.#write_tx().prepare(`DELETE FROM file_write_reservations
            WHERE entry_path = ? AND reservation_id = ?`).run(path, reservationId);
        return this.#tx.safe_integer(result.changes, 'reservation delete changes') === 1;
    }

    insert_lease(lease_id: string, path: string): void {
        if (typeof lease_id !== 'string' || lease_id.length === 0) malformed();
        const tx = this.#write_tx();
        const meta = tx.prepare(`SELECT coordination_generation FROM state_meta
            WHERE singleton = 1`).get();
        if (!meta) return malformed();
        const generation = integer(tx, meta.coordination_generation, 'coordination generation', 1);
        const acquiredAt = safe_input_integer(this.#now(), 0, Number.MAX_SAFE_INTEGER);
        const result = tx.prepare(`INSERT INTO entry_leases (
            lease_id, writer_session_id, current_entry_path, acquired_at_ms,
            acquired_generation
        ) VALUES (?, ?, ?, ?, ?)`).run(
            lease_id,
            this.#writerSessionId,
            path,
            acquiredAt,
            generation,
        );
        if (tx.safe_integer(result.changes, 'lease insert changes') !== 1) malformed();
    }

    move_leases(source_paths: readonly string[], destination_path: string): void {
        const tx = this.#write_tx();
        const update = tx.prepare(`UPDATE entry_leases SET current_entry_path = ?
            WHERE current_entry_path = ?`);
        for (const source of new Set(source_paths)) {
            if (source !== destination_path) update.run(destination_path, source);
        }
    }

    move_edit_session(source_paths: readonly string[], destination_path: string): void {
        const tx = this.#write_tx();
        const owners = [...new Set(source_paths)]
            .map((path) => this.read_edit_session(path))
            .filter((owner): owner is PersistedEditSessionRecord => owner !== undefined);
        const owner = owners[0];
        if (owner && owners.some((candidate) => (
            candidate.physicalResourceLockKey !== owner.physicalResourceLockKey
            || candidate.hostLockId !== owner.hostLockId
            || candidate.editSessionId !== owner.editSessionId
            || candidate.ownerWriterSessionId !== owner.ownerWriterSessionId
            || candidate.ownershipGeneration !== owner.ownershipGeneration
        ))) malformed();
        if (!owner || owner.entryPath === destination_path) return;
        const result = tx.prepare(`UPDATE edit_sessions SET entry_path = ?
            WHERE entry_path = ? AND NOT EXISTS (
                SELECT 1 FROM file_write_reservations WHERE entry_path = ?
            )`).run(destination_path, owner.entryPath, owner.entryPath);
        if (tx.safe_integer(result.changes, 'edit session move changes') !== 1) malformed();
    }

    delete_lease(lease_id: string): boolean {
        const tx = this.#write_tx();
        const result = tx.prepare(`DELETE FROM entry_leases
            WHERE writer_session_id = ? AND lease_id = ?`).run(
            this.#writerSessionId,
            lease_id,
        );
        return tx.safe_integer(result.changes, 'lease delete changes') === 1;
    }
}

export function create_sqlite_file_state_read_repository(
    tx: SqliteReadTransactionContext,
    options: SqliteFileStateRepositoryOptions,
): KeyedStateReadTransaction {
    const repository = new SqliteFileStateRepository(tx, options);
    return {
        metadata: () => repository.metadata(),
        read_entry_metadata: (path) => repository.read_entry_metadata(path),
        read_entry: (path) => repository.read_entry(path),
        read_authority_stages: (path) => repository.read_authority_stages(path),
        scan_entry_metadata: () => repository.scan_entry_metadata(),
        entry_is_leased: (path) => repository.entry_is_leased(path),
        read_edit_session: (path) => repository.read_edit_session(path),
        read_physical_write_reservation: (path) => repository.read_physical_write_reservation(path),
        read_physical_write_cleanups: () => repository.read_physical_write_cleanups(),
    };
}

export function create_sqlite_file_state_write_repository(
    tx: SqliteWriteTransactionContext,
    options: SqliteFileStateRepositoryOptions,
): KeyedStateWriteTransaction {
    const repository = new SqliteFileStateRepository(tx, options);
    return {
        metadata: () => repository.metadata(),
        read_entry_metadata: (path) => repository.read_entry_metadata(path),
        read_entry: (path) => repository.read_entry(path),
        read_authority_stages: (path) => repository.read_authority_stages(path),
        scan_entry_metadata: () => repository.scan_entry_metadata(),
        entry_is_leased: (path) => repository.entry_is_leased(path),
        read_edit_session: (path) => repository.read_edit_session(path),
        read_physical_write_reservation: (path) => repository.read_physical_write_reservation(path),
        read_physical_write_cleanups: () => repository.read_physical_write_cleanups(),
        allocate_revision: () => repository.allocate_revision(),
        allocate_recency_order: () => repository.allocate_recency_order(),
        set_absence_revision: (revision) => repository.set_absence_revision(revision),
        set_updated_at: (timestamp) => repository.set_updated_at(timestamp),
        write_entry: (value) => repository.write_entry(value),
        insert_empty_entry: (value) => repository.insert_empty_entry(value),
        write_entry_metadata: (value) => repository.write_entry_metadata(value),
        write_authority_stages: (path, stages) => repository.write_authority_stages(path, stages),
        delete_authority_stages_before: (boundary) => repository.delete_authority_stages_before(boundary),
        delete_entry: (path) => repository.delete_entry(path),
        insert_lease: (leaseId, path) => repository.insert_lease(leaseId, path),
        move_leases: (sourcePaths, destinationPath) => repository.move_leases(sourcePaths, destinationPath),
        delete_lease: (leaseId) => repository.delete_lease(leaseId),
        move_edit_session: (sourcePaths, destinationPath) => (
            repository.move_edit_session(sourcePaths, destinationPath)
        ),
    };
}
