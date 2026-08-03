import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const COMPANION_APPLICATION_ID = 1_414_942_019;
export const COMPANION_USER_VERSION = 1;
export const COMPANION_PROTOCOL_VERSION = 1;
export const COMPANION_FORMAT = 'tableViewer.namespaceRecovery.sqlite.v1';
export const COMPANION_MIGRATION_NAME = 'namespace-recovery-v1';
export const COMPANION_MAX_METADATA_UTF8_BYTES = 1_024;

function bounded_metadata(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0
        || Buffer.byteLength(value, 'utf8') > COMPANION_MAX_METADATA_UTF8_BYTES) {
        throw new Error(`Invalid companion ${name}.`);
    }
    return value;
}

const TABLES = {
    companion_meta: `CREATE TABLE companion_meta (
    singleton                  INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    format                     TEXT NOT NULL
                               CHECK (format = 'tableViewer.namespaceRecovery.sqlite.v1'),
    profile_database_id        TEXT NOT NULL COLLATE BINARY,
    coordination_generation    INTEGER NOT NULL CHECK (coordination_generation >= 1)
) STRICT, WITHOUT ROWID`,
    capsules: `CREATE TABLE capsules (
    capsule_id                 TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    source_key                 TEXT NOT NULL COLLATE BINARY,
    source_format              TEXT NOT NULL,
    source_digest              TEXT NOT NULL COLLATE BINARY,
    created_operation_id       TEXT NOT NULL COLLATE BINARY UNIQUE,
    request_digest             TEXT NOT NULL COLLATE BINARY,
    ordered_source_json        TEXT CHECK (ordered_source_json IS NULL OR json_valid(ordered_source_json)),
    source_entry_count         INTEGER NOT NULL CHECK (source_entry_count >= 0),
    source_next_revision       INTEGER NOT NULL CHECK (source_next_revision BETWEEN 1 AND 9007199254740991),
    source_absence_revision    INTEGER NOT NULL CHECK (source_absence_revision BETWEEN 0 AND 9007199254740990),
    source_updated_at_ms       INTEGER CHECK (source_updated_at_ms IS NULL OR source_updated_at_ms >= 0),
    status                     TEXT NOT NULL CHECK (status IN ('candidate','armed','cutover','drifted','retired')),
    created_at_ms              INTEGER NOT NULL CHECK (created_at_ms >= 0),
    retired_at_ms              INTEGER CHECK (retired_at_ms IS NULL OR retired_at_ms >= 0),
    retirement_operation_id    TEXT COLLATE BINARY UNIQUE,
    UNIQUE (capsule_id, source_digest),
    CHECK (source_absence_revision < source_next_revision),
    CHECK ((status = 'retired' AND ordered_source_json IS NULL AND retired_at_ms IS NOT NULL AND retirement_operation_id IS NOT NULL)
        OR (status <> 'retired' AND ordered_source_json IS NOT NULL AND retired_at_ms IS NULL AND retirement_operation_id IS NULL))
) STRICT, WITHOUT ROWID`,
    environment_namespaces: `CREATE TABLE environment_namespaces (
    placement_key_digest       TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    storage_environment_id     TEXT NOT NULL COLLATE BINARY UNIQUE,
    created_operation_id       TEXT NOT NULL COLLATE BINARY UNIQUE,
    request_digest             TEXT NOT NULL COLLATE BINARY,
    created_at_ms              INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT, WITHOUT ROWID`,
    environment_import_claims: `CREATE TABLE environment_import_claims (
    capsule_id                 TEXT NOT NULL COLLATE BINARY,
    storage_environment_id     TEXT NOT NULL COLLATE BINARY,
    database_id                TEXT NOT NULL COLLATE BINARY,
    import_claim_id            TEXT NOT NULL COLLATE BINARY UNIQUE,
    source_digest              TEXT NOT NULL COLLATE BINARY,
    status                     TEXT NOT NULL CHECK (status IN ('preparing','confirmed','abandoned')),
    operation_id               TEXT NOT NULL COLLATE BINARY UNIQUE,
    request_digest             TEXT NOT NULL COLLATE BINARY,
    prepared_at_ms             INTEGER NOT NULL CHECK (prepared_at_ms >= 0),
    confirmed_at_ms            INTEGER CHECK (confirmed_at_ms IS NULL OR confirmed_at_ms >= 0),
    abandoned_at_ms            INTEGER CHECK (abandoned_at_ms IS NULL OR abandoned_at_ms >= 0),
    abandonment_operation_id   TEXT COLLATE BINARY UNIQUE,
    abandonment_evidence_digest TEXT COLLATE BINARY,
    PRIMARY KEY (capsule_id, storage_environment_id, database_id),
    UNIQUE (capsule_id, storage_environment_id, database_id, import_claim_id),
    FOREIGN KEY (capsule_id, source_digest) REFERENCES capsules(capsule_id, source_digest) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK ((status = 'preparing' AND confirmed_at_ms IS NULL AND abandoned_at_ms IS NULL AND abandonment_operation_id IS NULL AND abandonment_evidence_digest IS NULL)
        OR (status = 'confirmed' AND confirmed_at_ms IS NOT NULL AND abandoned_at_ms IS NULL AND abandonment_operation_id IS NULL AND abandonment_evidence_digest IS NULL)
        OR (status = 'abandoned' AND confirmed_at_ms IS NULL AND abandoned_at_ms IS NOT NULL AND abandonment_operation_id IS NOT NULL AND abandonment_evidence_digest IS NOT NULL))
) STRICT, WITHOUT ROWID`,
    environment_confirmations: `CREATE TABLE environment_confirmations (
    capsule_id                 TEXT NOT NULL COLLATE BINARY,
    storage_environment_id     TEXT NOT NULL COLLATE BINARY,
    database_id                TEXT NOT NULL COLLATE BINARY,
    import_claim_id            TEXT NOT NULL COLLATE BINARY,
    operation_id               TEXT NOT NULL COLLATE BINARY UNIQUE,
    request_digest             TEXT NOT NULL COLLATE BINARY,
    confirmed_at_ms            INTEGER NOT NULL CHECK (confirmed_at_ms >= 0),
    PRIMARY KEY (capsule_id, storage_environment_id, database_id),
    FOREIGN KEY (capsule_id, storage_environment_id, database_id, import_claim_id)
        REFERENCES environment_import_claims(capsule_id, storage_environment_id, database_id, import_claim_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`,
    environment_source_retirements: `CREATE TABLE environment_source_retirements (
    capsule_id                 TEXT NOT NULL COLLATE BINARY,
    storage_environment_id     TEXT NOT NULL COLLATE BINARY,
    database_id                TEXT NOT NULL COLLATE BINARY,
    source_digest              TEXT NOT NULL COLLATE BINARY,
    retirement_kind            TEXT NOT NULL CHECK (retirement_kind IN ('naturally_complete','user_retired')),
    source_state_digest        TEXT NOT NULL COLLATE BINARY,
    operation_id               TEXT NOT NULL COLLATE BINARY UNIQUE,
    request_digest             TEXT NOT NULL COLLATE BINARY,
    retired_at_ms              INTEGER NOT NULL CHECK (retired_at_ms >= 0),
    PRIMARY KEY (capsule_id, storage_environment_id, database_id),
    FOREIGN KEY (capsule_id, storage_environment_id, database_id)
        REFERENCES environment_confirmations(capsule_id, storage_environment_id, database_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (capsule_id, source_digest) REFERENCES capsules(capsule_id, source_digest) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`,
    companion_rpc_operations: `CREATE TABLE companion_rpc_operations (
    operation_id               TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    operation_kind             TEXT NOT NULL CHECK (operation_kind IN (
        'namespace','submit_capsule_candidate','archive_drift','begin_environment_import',
        'abandon_environment_import','confirm_environment','confirm_environment_source_retirement',
        'retire_capsule','prepare_pending_edit_recovery','confirm_pending_edit_recovery')),
    request_digest             TEXT NOT NULL COLLATE BINARY,
    result_json                TEXT NOT NULL CHECK (json_valid(result_json)) CHECK (json_type(result_json) = 'object'),
    completed_at_ms            INTEGER NOT NULL CHECK (completed_at_ms >= 0)
) STRICT, WITHOUT ROWID`,
    pending_edit_recovery_records: `CREATE TABLE pending_edit_recovery_records (
    recovery_record_id         TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
    storage_environment_id     TEXT NOT NULL COLLATE BINARY,
    database_id                TEXT NOT NULL COLLATE BINARY,
    recovery_entry_id          TEXT NOT NULL COLLATE BINARY,
    operation_id               TEXT NOT NULL COLLATE BINARY UNIQUE,
    request_digest             TEXT NOT NULL COLLATE BINARY,
    kind                       TEXT NOT NULL CHECK (kind IN ('snapshot','clear')),
    resource_identity_json     TEXT NOT NULL CHECK (json_valid(resource_identity_json)) CHECK (json_type(resource_identity_json) = 'object'),
    authority_revision         INTEGER NOT NULL CHECK (authority_revision BETWEEN 0 AND 9007199254740990),
    physical_revision          INTEGER NOT NULL CHECK (physical_revision BETWEEN 0 AND 9007199254740990),
    projection_revision        INTEGER NOT NULL CHECK (projection_revision BETWEEN 0 AND 9007199254740990),
    physical_digest            TEXT,
    pending_edits_json         TEXT CHECK (pending_edits_json IS NULL OR (json_valid(pending_edits_json) AND json_type(pending_edits_json) = 'object')),
    status                     TEXT NOT NULL CHECK (status IN ('prepared','committed')),
    prepared_at_ms             INTEGER NOT NULL CHECK (prepared_at_ms >= 0),
    confirmation_operation_id  TEXT COLLATE BINARY UNIQUE,
    confirmation_request_digest TEXT COLLATE BINARY,
    committed_state_revision   INTEGER CHECK (committed_state_revision IS NULL OR committed_state_revision BETWEEN 0 AND 9007199254740990),
    committed_at_ms            INTEGER CHECK (committed_at_ms IS NULL OR committed_at_ms >= 0),
    CHECK ((kind = 'snapshot' AND pending_edits_json IS NOT NULL) OR (kind = 'clear' AND pending_edits_json IS NULL)),
    CHECK ((status = 'prepared' AND confirmation_operation_id IS NULL AND confirmation_request_digest IS NULL AND committed_state_revision IS NULL AND committed_at_ms IS NULL)
        OR (status = 'committed' AND confirmation_operation_id IS NOT NULL AND confirmation_request_digest IS NOT NULL AND committed_state_revision IS NOT NULL AND committed_at_ms IS NOT NULL))
) STRICT, WITHOUT ROWID`,
    schema_migrations: `CREATE TABLE schema_migrations (
    version                    INTEGER NOT NULL PRIMARY KEY CHECK (version >= 1),
    name                       TEXT NOT NULL UNIQUE,
    applied_at_ms              INTEGER NOT NULL CHECK (applied_at_ms >= 0),
    app_version                TEXT NOT NULL
) STRICT, WITHOUT ROWID`,
} as const;

const INDEXES = [
    `CREATE UNIQUE INDEX capsules_by_digest ON capsules(source_key, source_digest)`,
    `CREATE UNIQUE INDEX one_active_capsule_per_source ON capsules(source_key) WHERE status IN ('armed','cutover')`,
    `CREATE INDEX import_claims_by_status ON environment_import_claims(capsule_id, status, storage_environment_id, database_id)`,
    `CREATE INDEX recovery_records_by_resource ON pending_edit_recovery_records(storage_environment_id, database_id, recovery_entry_id, prepared_at_ms)`,
    `CREATE INDEX recovery_records_by_status ON pending_edit_recovery_records(status, prepared_at_ms)`,
] as const;

function pragma_number(database: DatabaseSync, sql: string, key: string): number {
    const value = database.prepare(sql).get()?.[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid ${key}.`);
    return value;
}

function apply_policy(database: DatabaseSync): void {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON');
}

function normalized_schema_sql(sql: string): string {
    return sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
}

function validate_schema_inventory(database: DatabaseSync): void {
    const expected = new Map<string, string>([
        ...Object.entries(TABLES),
        ...INDEXES.map((sql) => {
            const name = /^CREATE (?:UNIQUE )?INDEX ([^ ]+)/.exec(sql)?.[1];
            if (!name) throw new Error('Invalid companion index declaration.');
            return [name, sql] as const;
        }),
    ].map(([name, sql]) => [name, normalized_schema_sql(sql)]));
    const actualRows = database.prepare(
        `SELECT type,name,sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type,name`,
    ).all() as Array<{ type: string; name: string; sql: string | null }>;
    if (actualRows.length !== expected.size) throw new Error('Companion schema object set mismatch.');
    for (const row of actualRows) {
        if ((row.type !== 'table' && row.type !== 'index') || typeof row.sql !== 'string'
            || expected.get(row.name) !== normalized_schema_sql(row.sql)) {
            throw new Error(`Companion schema object mismatch: ${row.name}.`);
        }
        expected.delete(row.name);
    }
    if (expected.size !== 0) throw new Error('Companion schema object set mismatch.');
}

export function initialize_companion_schema(
    database: DatabaseSync,
    options: {
        appliedAtMs: number;
        appVersion: string;
        profileDatabaseId?: string;
        beforeSetUserVersion?: () => void;
    },
): void {
    const appVersion = bounded_metadata(options.appVersion, 'app version');
    const profileDatabaseId = bounded_metadata(options.profileDatabaseId ?? randomUUID(), 'profile database id');
    apply_policy(database);
    const journal = database.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode;
    if (journal !== 'delete') throw new Error('Companion journal policy is not DELETE.');
    database.exec('BEGIN IMMEDIATE');
    try {
        database.exec(`PRAGMA application_id = ${COMPANION_APPLICATION_ID}`);
        for (const sql of Object.values(TABLES)) database.exec(sql);
        for (const sql of INDEXES) database.exec(sql);
        database.prepare(`INSERT INTO schema_migrations(version,name,applied_at_ms,app_version) VALUES(1,?,?,?)`)
            .run(COMPANION_MIGRATION_NAME, options.appliedAtMs, appVersion);
        database.prepare(`INSERT INTO companion_meta(singleton,format,profile_database_id,coordination_generation) VALUES(1,?,?,1)`)
            .run(COMPANION_FORMAT, profileDatabaseId);
        options.beforeSetUserVersion?.();
        database.exec(`PRAGMA user_version = ${COMPANION_USER_VERSION}`);
        database.exec('COMMIT');
    } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* Preserve first failure. */ }
        throw error;
    }
    validate_companion_schema(database);
}

export function validate_companion_schema(database: DatabaseSync): void {
    apply_policy(database);
    if (pragma_number(database, 'PRAGMA application_id', 'application_id') !== COMPANION_APPLICATION_ID) {
        throw new Error('Companion application id mismatch.');
    }
    if (pragma_number(database, 'PRAGMA user_version', 'user_version') !== COMPANION_USER_VERSION) {
        throw new Error('Unsupported companion schema version.');
    }
    if (database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete'
        || pragma_number(database, 'PRAGMA foreign_keys', 'foreign_keys') !== 1
        || pragma_number(database, 'PRAGMA trusted_schema', 'trusted_schema') !== 0
        || pragma_number(database, 'PRAGMA synchronous', 'synchronous') !== 2
        || pragma_number(database, 'PRAGMA secure_delete', 'secure_delete') !== 1) {
        throw new Error('Companion connection policy mismatch.');
    }
    validate_schema_inventory(database);
    const metaRows = database.prepare(`SELECT singleton,format,profile_database_id,coordination_generation FROM companion_meta`).all();
    const meta = metaRows[0];
    if (metaRows.length !== 1 || !meta || meta.singleton !== 1 || meta.format !== COMPANION_FORMAT
        || typeof meta.profile_database_id !== 'string' || meta.profile_database_id.length === 0
        || Buffer.byteLength(meta.profile_database_id, 'utf8') > COMPANION_MAX_METADATA_UTF8_BYTES
        || typeof meta.coordination_generation !== 'number'
        || !Number.isSafeInteger(meta.coordination_generation) || meta.coordination_generation < 1) {
        throw new Error('Companion metadata is invalid.');
    }
    const migrationRows = database.prepare(`SELECT version,name,applied_at_ms,app_version FROM schema_migrations`).all();
    const migration = migrationRows[0];
    if (migrationRows.length !== 1 || migration?.version !== 1 || migration.name !== COMPANION_MIGRATION_NAME
        || typeof migration.applied_at_ms !== 'number' || !Number.isSafeInteger(migration.applied_at_ms)
        || migration.applied_at_ms < 0 || typeof migration.app_version !== 'string' || migration.app_version.length === 0
        || Buffer.byteLength(migration.app_version, 'utf8') > COMPANION_MAX_METADATA_UTF8_BYTES) {
        throw new Error('Companion migration history is invalid.');
    }
    if (database.prepare('PRAGMA foreign_key_check').get() !== undefined) {
        throw new Error('Companion foreign-key validation failed.');
    }
}
