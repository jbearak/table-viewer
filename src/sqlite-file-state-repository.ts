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

interface DecodedStateJson {
    readonly json: string;
    readonly state: StoredPerFileState;
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
    try {
        const state = decode_stored_per_file_state(parsed);
        return { json: JSON.stringify(parsed), state };
    } catch {
        return malformed();
    }
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return malformed();
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
            value.stateJson,
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
            ORDER BY s.entry_path`).all(safeBoundary)
            .map((row) => text(row.entry_path));
        if (paths.length > 0) {
            tx.prepare(`DELETE FROM authority_stages INDEXED BY authority_stages_by_age
                WHERE created_at_ms < ?`).run(safeBoundary);
        }
        return paths;
    }

    delete_entry(path: string): void {
        this.#write_tx().prepare('DELETE FROM entries WHERE path = ?').run(path);
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
    };
}

/** One `entries` row as the maintenance inspector sees it. */
export interface SqliteFileStateInspectionRow {
    readonly path: string;
    /** Bytes of stored state, as SQLite measures the payload itself. */
    readonly sizeBytes: number;
    readonly hasPendingEdits: boolean;
    /** A lease belonging to the caller's own session, so it is certainly live. */
    readonly isLeasedHere: boolean;
    readonly hasAuthorityStages: boolean;
    readonly updatedAtMs?: number;
    readonly touchedAtMs?: number;
}

/**
 * Scan every entry for the maintenance inspector.
 *
 * This deliberately does not go through `scan_entry_metadata`, and deliberately
 * does not decode `state_json`. The repository's usual discipline is to parse
 * and re-validate every row it hands out, because those rows flow back into the
 * write path where a malformed payload would corrupt real state. Nothing here
 * does: the caller receives a size SQLite computed and a handful of flags, and
 * a row it cannot decode is exactly a row worth showing the user so they can
 * delete it. Parsing here would turn "you have one unreadable entry" into "your
 * whole inspector throws", which is the opposite of what this feature is for.
 *
 * Size is `length(CAST(... AS BLOB))` rather than `length(...)`: on a TEXT
 * column the latter counts characters, so any non-ASCII payload would be
 * reported smaller than the bytes it actually occupies.
 */
export function scan_sqlite_file_state_inspection(
    tx: SqliteReadTransactionContext,
    writerSessionId: string,
): readonly SqliteFileStateInspectionRow[] {
    // Two lease questions, not one. Any lease protects the row from being
    // cleared — that is what a safety lease is for, and it holds even when the
    // session that took it is gone. But only a lease belonging to *this* session
    // proves a window has the file open right now, because a lease outlives a
    // process that did not close cleanly and there is no sound way to test
    // another session's liveness from here (this codebase deliberately refuses
    // PID and heartbeat checks elsewhere for the same reason).
    return tx.prepare(`SELECT e.path, e.has_pending_edits, e.updated_at_ms, e.touched_at_ms,
        length(CAST(e.state_json AS BLOB)) AS size_bytes,
        EXISTS(SELECT 1 FROM entry_leases l WHERE l.current_entry_path = e.path
            AND l.writer_session_id = ?) AS is_leased_here,
        EXISTS(SELECT 1 FROM authority_stages s WHERE s.entry_path = e.path) AS has_stages
        FROM entries e ORDER BY e.path`).all(writerSessionId)
        .map((row) => {
            const updatedAtMs = optional_integer(tx, row.updated_at_ms, 'updated at');
            const touchedAtMs = optional_integer(tx, row.touched_at_ms, 'touched at');
            return {
                path: text(row.path),
                sizeBytes: integer(tx, row.size_bytes, 'entry size', 0, Number.MAX_SAFE_INTEGER),
                hasPendingEdits: integer(tx, row.has_pending_edits, 'pending flag', 0, 1) === 1,
                isLeasedHere: integer(tx, row.is_leased_here, 'own lease flag', 0, 1) === 1,
                hasAuthorityStages: integer(tx, row.has_stages, 'stage flag', 0, 1) === 1,
                ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
                ...(touchedAtMs === undefined ? {} : { touchedAtMs }),
            };
        });
}
