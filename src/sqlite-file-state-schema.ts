import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_FILE_STATE_APPLICATION_ID = 1_414_940_243;
export const SQLITE_FILE_STATE_USER_VERSION = 1;
export const SQLITE_FILE_STATE_FORMAT = 'tableViewer.fileState.sqlite.v1';
export const SQLITE_FILE_STATE_PROTOCOL_VERSION = 1;
export const SQLITE_FILE_STATE_EXHAUSTION_SENTINEL = 9_007_199_254_740_991;
export const SQLITE_FILE_STATE_MAX_COUNTER = SQLITE_FILE_STATE_EXHAUSTION_SENTINEL - 1;
export const SQLITE_FILE_STATE_V1_MIGRATION_NAME = 'canonical-file-state-v1';

export type SqliteFileStateProductKind = 'desktop' | 'vscode';
export type SqliteFileStateAuthorityMode = 'sqlite_importing_memento' | 'sqlite';
export type SqliteLegacySourceKind = 'exact_identity' | 'path_only_compatibility';

interface SqliteFileStateIdentityBase {
    readonly databaseId: string;
    readonly storageEnvironmentId: string;
    readonly minReaderProtocol?: number;
    readonly maxReaderProtocol?: number;
    readonly minWriterProtocol?: number;
    readonly maxWriterProtocol?: number;
    readonly coordinationGeneration?: number;
}

export interface SqliteDesktopFileStateIdentity extends SqliteFileStateIdentityBase {
    readonly productKind: 'desktop';
}

export interface SqliteLegacySourceIdentity {
    readonly sourcePath: string;
    readonly sourceOrdinal: number;
    readonly sourceStateRevision: number;
    readonly sourceKind: SqliteLegacySourceKind;
    readonly sourceHadPendingEdits: boolean;
}

export interface SqliteLegacyImportIdentity {
    readonly capsuleId: string;
    readonly sourceFormat: string;
    readonly sourceDigest: string;
    readonly importClaimId: string;
    readonly sourceEntryCount: number;
    readonly sourceNextRevision: number;
    readonly sourceAbsenceRevision: number;
    readonly sourceUpdatedAtMs?: number;
    readonly importedAtMs: number;
    readonly importerAppVersion: string;
    readonly sources: readonly SqliteLegacySourceIdentity[];
}

export interface SqliteVscodeFileStateIdentity extends SqliteFileStateIdentityBase {
    readonly productKind: 'vscode';
    readonly clientProfileId: string;
    readonly legacy: SqliteLegacyImportIdentity;
}

export type SqliteFileStateIdentity =
    | SqliteDesktopFileStateIdentity
    | SqliteVscodeFileStateIdentity;

export interface SqliteFileStateMigrationOptions {
    readonly appliedAtMs: number;
    readonly appVersion: string;
    /** Test/fault-injection hook run inside the migration immediately before user_version. */
    readonly beforeSetUserVersion?: () => void;
}

export const SQLITE_FILE_STATE_V1_TABLE_SQL = {
    state_meta: `CREATE TABLE state_meta (
    singleton                  INTEGER NOT NULL PRIMARY KEY
                               CHECK (singleton = 1),
    format                     TEXT NOT NULL
                               CHECK (format = 'tableViewer.fileState.sqlite.v1'),
    database_id                TEXT NOT NULL COLLATE BINARY,
    client_profile_id          TEXT COLLATE BINARY,
    storage_environment_id     TEXT NOT NULL COLLATE BINARY,
    product_kind               TEXT NOT NULL
                               CHECK (product_kind IN ('desktop', 'vscode')),
    journal_policy             TEXT NOT NULL CHECK (journal_policy = 'delete'),
    authority_mode             TEXT NOT NULL
                               CHECK (authority_mode IN (
                                   'sqlite_importing_memento',
                                   'sqlite'
                               )),
    legacy_capsule_id          TEXT COLLATE BINARY,
    legacy_source_format       TEXT,
    legacy_source_digest       TEXT COLLATE BINARY,
    legacy_import_claim_id     TEXT COLLATE BINARY,

    min_reader_protocol        INTEGER NOT NULL CHECK (min_reader_protocol >= 1),
    max_reader_protocol        INTEGER NOT NULL CHECK (max_reader_protocol >= 1),
    min_writer_protocol        INTEGER NOT NULL CHECK (min_writer_protocol >= 1),
    max_writer_protocol        INTEGER NOT NULL CHECK (max_writer_protocol >= 1),
    coordination_generation    INTEGER NOT NULL CHECK (coordination_generation >= 1),

    next_revision              INTEGER NOT NULL
                               CHECK (next_revision BETWEEN 1 AND 9007199254740991),
    absence_revision           INTEGER NOT NULL
                               CHECK (absence_revision BETWEEN 0 AND 9007199254740990),
    next_recency_order         INTEGER NOT NULL CHECK (next_recency_order >= 1),
    next_ownership_generation  INTEGER NOT NULL
                               CHECK (next_ownership_generation BETWEEN 1 AND 9007199254740991),
    store_updated_at_ms        INTEGER
                               CHECK (store_updated_at_ms IS NULL OR store_updated_at_ms >= 0),

    CHECK (min_reader_protocol <= max_reader_protocol),
    CHECK (min_writer_protocol <= max_writer_protocol),
    CHECK (absence_revision < next_revision),
    CHECK (
        (product_kind = 'desktop'
            AND client_profile_id IS NULL
            AND authority_mode = 'sqlite'
            AND legacy_capsule_id IS NULL
            AND legacy_source_format IS NULL
            AND legacy_source_digest IS NULL
            AND legacy_import_claim_id IS NULL)
        OR
        (product_kind = 'vscode'
            AND client_profile_id IS NOT NULL
            AND legacy_capsule_id IS NOT NULL
            AND legacy_source_format IS NOT NULL
            AND legacy_source_digest IS NOT NULL
            AND legacy_import_claim_id IS NOT NULL)
    ),
    FOREIGN KEY (
        legacy_capsule_id,
        legacy_source_format,
        legacy_source_digest
    ) REFERENCES legacy_imports(
        capsule_id,
        source_format,
        source_digest
    ) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`,
    entries: `CREATE TABLE entries (
    path                       TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    state_revision             INTEGER NOT NULL
                               CHECK (state_revision BETWEEN 0 AND 9007199254740990),
    state_json                 TEXT NOT NULL
                               CHECK (json_valid(state_json))
                               CHECK (json_type(state_json) = 'object'),
    has_pending_edits          INTEGER NOT NULL
                               CHECK (has_pending_edits IN (0, 1)),

    authority_commit_sequence  INTEGER NOT NULL
                               CHECK (authority_commit_sequence BETWEEN 0 AND 9007199254740990),
    authority_revision         INTEGER NOT NULL
                               CHECK (authority_revision BETWEEN 0 AND 9007199254740990),
    physical_revision          INTEGER NOT NULL
                               CHECK (physical_revision BETWEEN 0 AND 9007199254740990),
    projection_revision        INTEGER NOT NULL
                               CHECK (projection_revision BETWEEN 0 AND 9007199254740990),
    physical_digest            TEXT,

    recency_order              INTEGER NOT NULL CHECK (recency_order >= 1),
    updated_at_ms              INTEGER
                               CHECK (updated_at_ms IS NULL OR updated_at_ms >= 0),
    touched_at_ms              INTEGER
                               CHECK (touched_at_ms IS NULL OR touched_at_ms >= 0),

    recovery_entry_id          TEXT NOT NULL COLLATE BINARY UNIQUE,
    recovery_record_id         TEXT COLLATE BINARY,

    copy_id                    TEXT,
    copy_source_path           TEXT COLLATE BINARY,
    copy_source_revision       INTEGER
                               CHECK (
                                   copy_source_revision IS NULL
                                   OR copy_source_revision BETWEEN 0 AND 9007199254740990
                               ),

    CHECK (
        (has_pending_edits = 0
            AND json_type(state_json, '$.pendingEdits') IS NULL)
        OR
        (has_pending_edits = 1
            AND json_type(state_json, '$.pendingEdits') = 'object')
    ),
    CHECK (
        (copy_id IS NULL
            AND copy_source_path IS NULL
            AND copy_source_revision IS NULL)
        OR
        (copy_id IS NOT NULL
            AND copy_source_path IS NOT NULL
            AND copy_source_revision IS NOT NULL)
    )
) STRICT, WITHOUT ROWID`,
    authority_stages: `CREATE TABLE authority_stages (
    entry_path                 TEXT NOT NULL COLLATE BINARY,
    stage_id                   TEXT NOT NULL COLLATE BINARY,
    kind                       TEXT NOT NULL
                               CHECK (kind IN ('physical', 'projection')),
    ordinal                    INTEGER NOT NULL
                               CHECK (ordinal BETWEEN 0 AND 9007199254740991),
    expected_state_revision    INTEGER NOT NULL
                               CHECK (expected_state_revision BETWEEN 0 AND 9007199254740990),
    expected_commit_sequence   INTEGER NOT NULL
                               CHECK (expected_commit_sequence BETWEEN 0 AND 9007199254740990),
    next_state_json            TEXT
                               CHECK (
                                   next_state_json IS NULL
                                   OR (
                                       json_valid(next_state_json)
                                       AND json_type(next_state_json) = 'object'
                                   )
                               ),
    physical_digest            TEXT,
    created_at_ms              INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (entry_path, stage_id),
    FOREIGN KEY (entry_path)
        REFERENCES entries(path)
        ON UPDATE CASCADE
        ON DELETE CASCADE
) STRICT, WITHOUT ROWID`,
    writer_sessions: `CREATE TABLE writer_sessions (
    writer_session_id          TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    client_kind                TEXT NOT NULL,
    client_version             TEXT NOT NULL,
    negotiated_protocol        INTEGER NOT NULL CHECK (negotiated_protocol >= 1),
    process_id                 INTEGER NOT NULL CHECK (process_id > 0),
    opened_at_ms               INTEGER NOT NULL CHECK (opened_at_ms >= 0),
    last_activity_at_ms        INTEGER NOT NULL CHECK (last_activity_at_ms >= 0),
    opened_generation          INTEGER NOT NULL CHECK (opened_generation >= 1),
    last_committed_sequence    INTEGER NOT NULL DEFAULT 0
                               CHECK (last_committed_sequence BETWEEN 0 AND 9007199254740990),
    last_operation_id          TEXT COLLATE BINARY,
    last_operation_kind        TEXT,
    CHECK (
        (last_committed_sequence = 0
            AND last_operation_id IS NULL
            AND last_operation_kind IS NULL)
        OR
        (last_committed_sequence > 0
            AND last_operation_id IS NOT NULL
            AND last_operation_kind IS NOT NULL)
    )
) STRICT, WITHOUT ROWID`,
    entry_leases: `CREATE TABLE entry_leases (
    lease_id                   TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    writer_session_id          TEXT NOT NULL COLLATE BINARY,
    current_entry_path         TEXT NOT NULL COLLATE BINARY,
    acquired_at_ms             INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
    acquired_generation        INTEGER NOT NULL CHECK (acquired_generation >= 1)
    -- No FK to entries: absent paths may be leased.
    -- No FK to writer_sessions: session removal must not release safety leases.
) STRICT, WITHOUT ROWID`,
    edit_sessions: `CREATE TABLE edit_sessions (
    entry_path                 TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    physical_resource_lock_key TEXT NOT NULL COLLATE BINARY UNIQUE,
    host_lock_id               TEXT NOT NULL COLLATE BINARY UNIQUE,
    edit_session_id            TEXT NOT NULL COLLATE BINARY UNIQUE,
    owner_writer_session_id    TEXT NOT NULL COLLATE BINARY,
    ownership_generation       INTEGER NOT NULL CHECK (ownership_generation >= 1),
    acquired_at_ms             INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
    last_confirmed_at_ms       INTEGER NOT NULL CHECK (last_confirmed_at_ms >= 0),
    UNIQUE (
        entry_path,
        edit_session_id,
        physical_resource_lock_key,
        host_lock_id,
        ownership_generation
    )
    -- Deliberately no cascading FK to writer_sessions.
) STRICT, WITHOUT ROWID`,
    file_write_reservations: `CREATE TABLE file_write_reservations (
    reservation_id             TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    save_operation_id          TEXT NOT NULL COLLATE BINARY UNIQUE,
    entry_path                 TEXT NOT NULL COLLATE BINARY UNIQUE,
    physical_resource_lock_key TEXT NOT NULL COLLATE BINARY UNIQUE,
    host_lock_id               TEXT NOT NULL COLLATE BINARY UNIQUE,
    edit_session_id            TEXT NOT NULL COLLATE BINARY,
    ownership_generation       INTEGER NOT NULL CHECK (ownership_generation >= 1),
    reserved_generation        INTEGER NOT NULL CHECK (reserved_generation >= 1),
    stage_id                   TEXT NOT NULL COLLATE BINARY,
    prepared_install_id        TEXT NOT NULL COLLATE BINARY UNIQUE,
    expected_state_revision    INTEGER NOT NULL
                               CHECK (expected_state_revision BETWEEN 0 AND 9007199254740990),
    expected_commit_sequence   INTEGER NOT NULL
                               CHECK (expected_commit_sequence BETWEEN 0 AND 9007199254740990),
    expected_authority_revision INTEGER NOT NULL
                                CHECK (expected_authority_revision BETWEEN 0 AND 9007199254740990),
    expected_physical_revision INTEGER NOT NULL
                               CHECK (expected_physical_revision BETWEEN 0 AND 9007199254740990),
    expected_projection_revision INTEGER NOT NULL
                                 CHECK (expected_projection_revision BETWEEN 0 AND 9007199254740990),
    expected_physical_digest   TEXT,
    intended_physical_digest   TEXT NOT NULL,
    recovery_record_id         TEXT COLLATE BINARY,
    acquired_at_ms             INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
    FOREIGN KEY (
        entry_path,
        edit_session_id,
        physical_resource_lock_key,
        host_lock_id,
        ownership_generation
    ) REFERENCES edit_sessions(
        entry_path,
        edit_session_id,
        physical_resource_lock_key,
        host_lock_id,
        ownership_generation
    )
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    FOREIGN KEY (entry_path, stage_id)
        REFERENCES authority_stages(entry_path, stage_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`,
    legacy_imports: `CREATE TABLE legacy_imports (
    capsule_id                 TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    source_format              TEXT NOT NULL,
    source_digest              TEXT NOT NULL COLLATE BINARY,
    source_entry_count         INTEGER NOT NULL CHECK (source_entry_count >= 0),
    source_next_revision       INTEGER NOT NULL
                               CHECK (source_next_revision BETWEEN 1 AND 9007199254740991),
    source_absence_revision    INTEGER NOT NULL
                               CHECK (source_absence_revision BETWEEN 0 AND 9007199254740990),
    source_updated_at_ms       INTEGER
                               CHECK (source_updated_at_ms IS NULL OR source_updated_at_ms >= 0),
    imported_at_ms             INTEGER NOT NULL CHECK (imported_at_ms >= 0),
    importer_app_version       TEXT NOT NULL,
    UNIQUE (capsule_id, source_format, source_digest),
    CHECK (source_absence_revision < source_next_revision)
) STRICT, WITHOUT ROWID`,
    legacy_sources: `CREATE TABLE legacy_sources (
    capsule_id                 TEXT NOT NULL COLLATE BINARY,
    source_path                TEXT NOT NULL COLLATE BINARY,
    source_ordinal             INTEGER NOT NULL CHECK (source_ordinal >= 0),
    source_state_revision      INTEGER NOT NULL
                               CHECK (source_state_revision BETWEEN 0 AND 9007199254740990),
    source_kind                TEXT NOT NULL
                               CHECK (source_kind IN (
                                   'exact_identity',
                                   'path_only_compatibility'
                               )),
    source_had_pending_edits   INTEGER NOT NULL
                               CHECK (source_had_pending_edits IN (0, 1)),
    pending_survival_kind      TEXT
                               CHECK (
                                   pending_survival_kind IS NULL
                                   OR pending_survival_kind IN (
                                       'canonical_local',
                                       'canonical_remote_recovery',
                                       'explicit_export',
                                       'basis_valid_recovery'
                                   )
                               ),
    pending_survival_reference TEXT COLLATE BINARY,
    status                     TEXT NOT NULL
                               CHECK (status IN ('active', 'terminal', 'retired')),
    terminal_disposition       TEXT
                               CHECK (
                                   terminal_disposition IS NULL
                                   OR terminal_disposition IN (
                                       'imported',
                                       'alias-superseded',
                                       'shadowed'
                                   )
                               ),
    terminal_destination_path  TEXT COLLATE BINARY,
    retired_at_ms              INTEGER
                               CHECK (retired_at_ms IS NULL OR retired_at_ms >= 0),
    retirement_operation_id    TEXT COLLATE BINARY,
    PRIMARY KEY (capsule_id, source_path),
    UNIQUE (capsule_id, source_ordinal),
    UNIQUE (
        capsule_id,
        source_path,
        source_ordinal,
        source_state_revision
    ),
    FOREIGN KEY (capsule_id)
        REFERENCES legacy_imports(capsule_id)
        ON DELETE RESTRICT,
    CHECK (
        (status = 'active'
            AND terminal_disposition IS NULL
            AND terminal_destination_path IS NULL
            AND retired_at_ms IS NULL
            AND retirement_operation_id IS NULL)
        OR
        (status = 'terminal'
            AND source_kind = 'exact_identity'
            AND terminal_disposition IS NOT NULL
            AND terminal_destination_path IS NOT NULL
            AND terminal_destination_path <> ''
            AND retired_at_ms IS NULL
            AND retirement_operation_id IS NULL)
        OR
        (status = 'retired'
            AND terminal_disposition IS NULL
            AND terminal_destination_path IS NULL
            AND retired_at_ms IS NOT NULL
            AND retirement_operation_id IS NOT NULL)
    ),
    CHECK (
        (status = 'active'
            AND pending_survival_kind IS NULL
            AND pending_survival_reference IS NULL)
        OR
        (status IN ('terminal', 'retired')
            AND source_had_pending_edits = 0
            AND pending_survival_kind IS NULL
            AND pending_survival_reference IS NULL)
        OR
        (status = 'terminal'
            AND source_had_pending_edits = 1
            AND pending_survival_kind IN (
                'canonical_local',
                'canonical_remote_recovery',
                'basis_valid_recovery'
            )
            AND (
                (pending_survival_kind = 'canonical_local'
                    AND pending_survival_reference IS NULL)
                OR
                (pending_survival_kind <> 'canonical_local'
                    AND pending_survival_reference IS NOT NULL)
            ))
        OR
        (status = 'retired'
            AND source_had_pending_edits = 1
            AND pending_survival_kind IN (
                'explicit_export',
                'basis_valid_recovery'
            )
            AND pending_survival_reference IS NOT NULL)
    )
) STRICT, WITHOUT ROWID`,
    legacy_entry_claims: `CREATE TABLE legacy_entry_claims (
    capsule_id                 TEXT NOT NULL COLLATE BINARY,
    source_path                TEXT NOT NULL COLLATE BINARY,
    source_ordinal             INTEGER NOT NULL CHECK (source_ordinal >= 0),
    source_state_revision      INTEGER NOT NULL
                               CHECK (source_state_revision BETWEEN 0 AND 9007199254740990),
    disposition                TEXT NOT NULL
                               CHECK (disposition IN (
                                   'imported',
                                   'alias-superseded',
                                   'shadowed',
                                   'ambiguous'
                               )),
    destination_path           TEXT NOT NULL COLLATE BINARY,
    claimed_at_ms              INTEGER NOT NULL CHECK (claimed_at_ms >= 0),
    PRIMARY KEY (capsule_id, source_path, destination_path),
    FOREIGN KEY (
        capsule_id,
        source_path,
        source_ordinal,
        source_state_revision
    ) REFERENCES legacy_sources(
        capsule_id,
        source_path,
        source_ordinal,
        source_state_revision
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (
        (disposition = 'ambiguous' AND destination_path = '')
        OR
        (disposition <> 'ambiguous' AND destination_path <> '')
    )
) STRICT, WITHOUT ROWID`,
    schema_migrations: `CREATE TABLE schema_migrations (
    version                    INTEGER NOT NULL PRIMARY KEY CHECK (version >= 1),
    name                       TEXT NOT NULL UNIQUE,
    applied_at_ms              INTEGER NOT NULL CHECK (applied_at_ms >= 0),
    app_version                TEXT NOT NULL
) STRICT, WITHOUT ROWID`,
} as const;

export const SQLITE_FILE_STATE_V1_INDEX_SQL = {
    entries_by_recency: 'CREATE UNIQUE INDEX entries_by_recency ON entries(recency_order)',
    entries_by_state_revision: 'CREATE INDEX entries_by_state_revision ON entries(state_revision)',
    entries_with_pending_edits: `CREATE INDEX entries_with_pending_edits
    ON entries(recency_order, path)
    WHERE has_pending_edits = 1`,
    authority_stages_by_age: `CREATE INDEX authority_stages_by_age
    ON authority_stages(created_at_ms, entry_path, stage_id)`,
    writer_sessions_by_activity: `CREATE INDEX writer_sessions_by_activity
    ON writer_sessions(last_activity_at_ms, writer_session_id)`,
    entry_leases_by_path: `CREATE INDEX entry_leases_by_path
    ON entry_leases(current_entry_path, lease_id)`,
    entry_leases_by_session: `CREATE INDEX entry_leases_by_session
    ON entry_leases(writer_session_id, lease_id)`,
    edit_sessions_by_owner: `CREATE INDEX edit_sessions_by_owner
    ON edit_sessions(owner_writer_session_id, entry_path)`,
    legacy_sources_by_status: `CREATE INDEX legacy_sources_by_status
    ON legacy_sources(capsule_id, status, source_kind, source_ordinal)`,
    legacy_entry_claims_by_ordinal: `CREATE INDEX legacy_entry_claims_by_ordinal
    ON legacy_entry_claims(capsule_id, source_ordinal, destination_path)`,
} as const;

export const SQLITE_FILE_STATE_V1_SCHEMA_SQL = [
    ...Object.values(SQLITE_FILE_STATE_V1_TABLE_SQL),
    ...Object.values(SQLITE_FILE_STATE_V1_INDEX_SQL),
] as const;

function assert_nonempty(value: string, name: string): void {
    if (value.length === 0) throw new TypeError(`${name} must not be empty.`);
}

function assert_safe_integer(value: number, name: string, minimum = 0): void {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(`${name} must be a safe integer at least ${minimum}.`);
    }
}

function protocol_value(value: number | undefined): number {
    return value ?? SQLITE_FILE_STATE_PROTOCOL_VERSION;
}

function validate_identity(identity: SqliteFileStateIdentity): void {
    assert_nonempty(identity.databaseId, 'databaseId');
    assert_nonempty(identity.storageEnvironmentId, 'storageEnvironmentId');
    for (const [name, value] of [
        ['minReaderProtocol', protocol_value(identity.minReaderProtocol)],
        ['maxReaderProtocol', protocol_value(identity.maxReaderProtocol)],
        ['minWriterProtocol', protocol_value(identity.minWriterProtocol)],
        ['maxWriterProtocol', protocol_value(identity.maxWriterProtocol)],
        ['coordinationGeneration', identity.coordinationGeneration ?? 1],
    ] as const) assert_safe_integer(value, name, 1);
    if (protocol_value(identity.minReaderProtocol) > protocol_value(identity.maxReaderProtocol)
        || protocol_value(identity.minWriterProtocol) > protocol_value(identity.maxWriterProtocol)) {
        throw new TypeError('Protocol minimum must not exceed its maximum.');
    }
    if (identity.productKind === 'desktop') return;
    assert_nonempty(identity.clientProfileId, 'clientProfileId');
    const legacy = identity.legacy;
    for (const [name, value] of [
        ['capsuleId', legacy.capsuleId],
        ['sourceFormat', legacy.sourceFormat],
        ['sourceDigest', legacy.sourceDigest],
        ['importClaimId', legacy.importClaimId],
        ['importerAppVersion', legacy.importerAppVersion],
    ] as const) assert_nonempty(value, name);
    assert_safe_integer(legacy.sourceEntryCount, 'sourceEntryCount');
    assert_safe_integer(legacy.sourceNextRevision, 'sourceNextRevision', 1);
    assert_safe_integer(legacy.sourceAbsenceRevision, 'sourceAbsenceRevision');
    assert_safe_integer(legacy.importedAtMs, 'importedAtMs');
    if (legacy.sourceUpdatedAtMs !== undefined) {
        assert_safe_integer(legacy.sourceUpdatedAtMs, 'sourceUpdatedAtMs');
    }
    if (legacy.sourceAbsenceRevision >= legacy.sourceNextRevision) {
        throw new TypeError('Legacy absence revision must be below next revision.');
    }
    if (legacy.sources.length !== legacy.sourceEntryCount) {
        throw new TypeError('Legacy source count does not match sourceEntryCount.');
    }
    const ordinals = new Set<number>();
    const paths = new Set<string>();
    for (const source of legacy.sources) {
        assert_nonempty(source.sourcePath, 'sourcePath');
        assert_safe_integer(source.sourceOrdinal, 'sourceOrdinal');
        assert_safe_integer(source.sourceStateRevision, 'sourceStateRevision');
        if (source.sourceStateRevision >= legacy.sourceNextRevision) {
            throw new TypeError('Legacy source revision must be below sourceNextRevision.');
        }
        if (ordinals.has(source.sourceOrdinal) || paths.has(source.sourcePath)) {
            throw new TypeError('Legacy source paths and ordinals must be unique.');
        }
        ordinals.add(source.sourceOrdinal);
        paths.add(source.sourcePath);
    }
    for (let ordinal = 0; ordinal < legacy.sourceEntryCount; ordinal += 1) {
        if (!ordinals.has(ordinal)) throw new TypeError('Legacy source ordinals must be complete.');
    }
}

function scalar_number(database: DatabaseSync, sql: string, column: string): number {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    const value = statement.get()?.[column];
    if (typeof value !== 'bigint' || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new TypeError(`SQLite ${column} is not a safe integer.`);
    }
    return Number(value);
}

function insert_v1_identity(database: DatabaseSync, identity: SqliteFileStateIdentity): void {
    const minReader = protocol_value(identity.minReaderProtocol);
    const maxReader = protocol_value(identity.maxReaderProtocol);
    const minWriter = protocol_value(identity.minWriterProtocol);
    const maxWriter = protocol_value(identity.maxWriterProtocol);
    const generation = identity.coordinationGeneration ?? 1;

    if (identity.productKind === 'vscode') {
        const legacy = identity.legacy;
        database.prepare(`INSERT INTO legacy_imports (
            capsule_id, source_format, source_digest, source_entry_count,
            source_next_revision, source_absence_revision, source_updated_at_ms,
            imported_at_ms, importer_app_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                legacy.capsuleId,
                legacy.sourceFormat,
                legacy.sourceDigest,
                legacy.sourceEntryCount,
                legacy.sourceNextRevision,
                legacy.sourceAbsenceRevision,
                legacy.sourceUpdatedAtMs ?? null,
                legacy.importedAtMs,
                legacy.importerAppVersion,
            );
        const insertSource = database.prepare(`INSERT INTO legacy_sources (
            capsule_id, source_path, source_ordinal, source_state_revision,
            source_kind, source_had_pending_edits, pending_survival_kind,
            pending_survival_reference, status, terminal_disposition,
            terminal_destination_path, retired_at_ms, retirement_operation_id
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'active', NULL, NULL, NULL, NULL)`);
        for (const source of legacy.sources) {
            insertSource.run(
                legacy.capsuleId,
                source.sourcePath,
                source.sourceOrdinal,
                source.sourceStateRevision,
                source.sourceKind,
                source.sourceHadPendingEdits ? 1 : 0,
            );
        }
        database.prepare(`INSERT INTO state_meta (
            singleton, format, database_id, client_profile_id,
            storage_environment_id, product_kind, journal_policy, authority_mode,
            legacy_capsule_id, legacy_source_format, legacy_source_digest,
            legacy_import_claim_id, min_reader_protocol, max_reader_protocol,
            min_writer_protocol, max_writer_protocol, coordination_generation,
            next_revision, absence_revision, next_recency_order,
            next_ownership_generation, store_updated_at_ms
        ) VALUES (1, ?, ?, ?, ?, 'vscode', 'delete', 'sqlite_importing_memento',
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
            .run(
                SQLITE_FILE_STATE_FORMAT,
                identity.databaseId,
                identity.clientProfileId,
                identity.storageEnvironmentId,
                legacy.capsuleId,
                legacy.sourceFormat,
                legacy.sourceDigest,
                legacy.importClaimId,
                minReader,
                maxReader,
                minWriter,
                maxWriter,
                generation,
                legacy.sourceNextRevision,
                legacy.sourceAbsenceRevision,
                legacy.sourceEntryCount + 1,
                legacy.sourceUpdatedAtMs ?? null,
            );
        return;
    }

    database.prepare(`INSERT INTO state_meta (
        singleton, format, database_id, client_profile_id,
        storage_environment_id, product_kind, journal_policy, authority_mode,
        legacy_capsule_id, legacy_source_format, legacy_source_digest,
        legacy_import_claim_id, min_reader_protocol, max_reader_protocol,
        min_writer_protocol, max_writer_protocol, coordination_generation,
        next_revision, absence_revision, next_recency_order,
        next_ownership_generation, store_updated_at_ms
    ) VALUES (1, ?, ?, NULL, ?, 'desktop', 'delete', 'sqlite',
        NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, 1, 0, 1, 1, NULL)`)
        .run(
            SQLITE_FILE_STATE_FORMAT,
            identity.databaseId,
            identity.storageEnvironmentId,
            minReader,
            maxReader,
            minWriter,
            maxWriter,
            generation,
        );
}

function apply_v1_migration(
    database: DatabaseSync,
    identity: SqliteFileStateIdentity,
    options: SqliteFileStateMigrationOptions,
): void {
    for (const sql of SQLITE_FILE_STATE_V1_SCHEMA_SQL) database.exec(sql);
    database.prepare(`INSERT INTO schema_migrations (
        version, name, applied_at_ms, app_version
    ) VALUES (?, ?, ?, ?)`)
        .run(1, SQLITE_FILE_STATE_V1_MIGRATION_NAME, options.appliedAtMs, options.appVersion);
    insert_v1_identity(database, identity);
}

/**
 * Apply all ordered canonical migrations. V1 only initializes an empty candidate;
 * it never adopts or brands an existing unrecognized schema.
 */
export function migrate_sqlite_file_state_schema(
    database: DatabaseSync,
    identity: SqliteFileStateIdentity,
    options: SqliteFileStateMigrationOptions,
): void {
    validate_identity(identity);
    assert_safe_integer(options.appliedAtMs, 'appliedAtMs');
    assert_nonempty(options.appVersion, 'appVersion');

    const applicationId = scalar_number(database, 'PRAGMA application_id', 'application_id');
    const userVersion = scalar_number(database, 'PRAGMA user_version', 'user_version');
    if (userVersion > SQLITE_FILE_STATE_USER_VERSION) {
        throw new Error('SQLite file-state schema is newer than this application supports.');
    }
    if (userVersion === SQLITE_FILE_STATE_USER_VERSION) {
        if (applicationId !== SQLITE_FILE_STATE_APPLICATION_ID) {
            throw new Error('SQLite file-state application identity does not match.');
        }
        if (database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') {
            throw new Error('SQLite file-state journal policy is not DELETE.');
        }
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('PRAGMA trusted_schema = OFF');
        database.exec('PRAGMA synchronous = FULL');
        database.exec('PRAGMA secure_delete = ON');
        return;
    }
    if (userVersion !== 0 || applicationId !== 0) {
        throw new Error('SQLite file-state database has an unsupported partial identity.');
    }
    const userObjects = scalar_number(
        database,
        `SELECT count(*) AS count FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%'`,
        'count',
    );
    if (userObjects !== 0) {
        throw new Error('Refusing to initialize a nonempty unbranded SQLite database.');
    }

    const journalMode = database.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode;
    if (journalMode !== 'delete') throw new Error('SQLite file-state journal policy is not DELETE.');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA trusted_schema = OFF');
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA secure_delete = ON');
    database.exec(`PRAGMA application_id = ${SQLITE_FILE_STATE_APPLICATION_ID}`);
    database.exec('BEGIN IMMEDIATE');
    try {
        apply_v1_migration(database, identity, options);
        options.beforeSetUserVersion?.();
        database.exec(`PRAGMA user_version = ${SQLITE_FILE_STATE_USER_VERSION}`);
        database.exec('COMMIT');
    } catch (error) {
        try {
            database.exec('ROLLBACK');
        } catch {
            // Preserve the original migration failure.
        }
        throw error;
    }
}

/** Alias emphasizing that v1 initialization is the only currently ordered migration. */
export const initialize_sqlite_file_state_schema = migrate_sqlite_file_state_schema;
