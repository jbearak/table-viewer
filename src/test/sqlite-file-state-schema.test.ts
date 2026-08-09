import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    initialize_sqlite_file_state_schema,
    SQLITE_DIRECT_VSCODE_FILE_STATE_FORMAT,
    SQLITE_DIRECT_VSCODE_FILE_STATE_MIGRATION_NAME,
    SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION,
    SQLITE_FILE_STATE_APPLICATION_ID,
    SQLITE_FILE_STATE_USER_VERSION,
    SQLITE_FILE_STATE_V1_INDEX_SQL,
    SQLITE_FILE_STATE_V1_TABLE_SQL,
    type SqliteDesktopFileStateIdentity,
    type SqliteDirectVscodeFileStateIdentity,
    type SqliteVscodeFileStateIdentity,
} from '../sqlite-file-state-schema';

let tempDirectory: string;
let databases: DatabaseSync[];

const desktopIdentity: SqliteDesktopFileStateIdentity = {
    productKind: 'desktop',
    databaseId: 'desktop-database',
    storageEnvironmentId: 'desktop-environment',
    coordinationGeneration: 1,
};

const directVscodeIdentity: SqliteDirectVscodeFileStateIdentity = {
    productKind: 'vscode',
    schemaKind: 'direct-vscode',
    databaseId: 'direct-vscode-database',
    clientProfileId: 'direct-profile-id',
    storageEnvironmentId: 'direct-environment',
    coordinationGeneration: 1,
};

const vscodeIdentity: SqliteVscodeFileStateIdentity = {
    productKind: 'vscode',
    databaseId: 'vscode-database',
    clientProfileId: 'profile-id',
    storageEnvironmentId: 'workspace-environment',
    coordinationGeneration: 1,
    legacy: {
        capsuleId: 'capsule-id',
        sourceFormat: 'tableViewer.fileState.v1',
        sourceDigest: 'source-digest',
        importClaimId: 'import-claim-id',
        sourceEntryCount: 2,
        sourceNextRevision: 9,
        sourceAbsenceRevision: 3,
        sourceUpdatedAtMs: 1234,
        importedAtMs: 2345,
        importerAppVersion: '0.7.0',
        sources: [
            {
                sourcePath: 'file:///exact.csv',
                sourceOrdinal: 0,
                sourceStateRevision: 7,
                sourceKind: 'exact_identity',
                sourceHadPendingEdits: true,
            },
            {
                sourcePath: '/legacy/path.csv',
                sourceOrdinal: 1,
                sourceStateRevision: 8,
                sourceKind: 'path_only_compatibility',
                sourceHadPendingEdits: false,
            },
        ],
    },
};

function openDatabase(name: string): DatabaseSync {
    const database = new DatabaseSync(path.join(tempDirectory, name), {
        enableDoubleQuotedStringLiterals: false,
    });
    databases.push(database);
    return database;
}

function pragmaNumber(database: DatabaseSync, pragma: string): number {
    const statement = database.prepare(`PRAGMA ${pragma}`);
    statement.setReadBigInts(true);
    return Number(statement.get()?.[pragma]);
}

beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-sqlite-schema-'));
    databases = [];
});

afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('canonical SQLite file-state schema', () => {
    it('creates the complete canonical v1 schema and desktop identity', () => {
        const database = openDatabase('desktop.sqlite3');

        initialize_sqlite_file_state_schema(database, desktopIdentity, {
            appliedAtMs: 100,
            appVersion: '0.7.0',
        });

        expect(pragmaNumber(database, 'application_id')).toBe(SQLITE_FILE_STATE_APPLICATION_ID);
        expect(pragmaNumber(database, 'user_version')).toBe(SQLITE_FILE_STATE_USER_VERSION);
        expect(database.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
        expect(pragmaNumber(database, 'synchronous')).toBe(2);
        expect(pragmaNumber(database, 'foreign_keys')).toBe(1);
        expect(pragmaNumber(database, 'trusted_schema')).toBe(0);
        expect(pragmaNumber(database, 'secure_delete')).toBe(1);

        const objectNames = database.prepare(`SELECT type, name FROM sqlite_schema
            WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name`).all();
        expect(objectNames.map((value) => value.name)).toEqual([
            ...Object.keys(SQLITE_FILE_STATE_V1_TABLE_SQL),
            ...Object.keys(SQLITE_FILE_STATE_V1_INDEX_SQL),
        ].sort());
        expect(database.prepare('SELECT * FROM state_meta').get()).toMatchObject({
            singleton: 1,
            database_id: 'desktop-database',
            client_profile_id: null,
            storage_environment_id: 'desktop-environment',
            product_kind: 'desktop',
            journal_policy: 'delete',
            authority_mode: 'sqlite',
            next_revision: 1,
            absence_revision: 0,
            next_recency_order: 1,
            next_ownership_generation: 1,
        });
        expect(database.prepare('SELECT * FROM schema_migrations').get()).toMatchObject({
            version: 1,
            applied_at_ms: 100,
            app_version: '0.7.0',
        });
        expect(database.prepare('SELECT count(*) AS count FROM legacy_imports').get()?.count).toBe(0);
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    it('creates a fresh migration-free direct VS Code identity without legacy metadata', () => {
        const database = openDatabase('direct-vscode.sqlite3');

        initialize_sqlite_file_state_schema(database, directVscodeIdentity, {
            appliedAtMs: 200,
            appVersion: '0.7.0',
        });

        expect(pragmaNumber(database, 'application_id')).toBe(SQLITE_FILE_STATE_APPLICATION_ID);
        expect(pragmaNumber(database, 'user_version')).toBe(SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION);
        expect(database.prepare('SELECT * FROM state_meta').get()).toMatchObject({
            format: SQLITE_DIRECT_VSCODE_FILE_STATE_FORMAT,
            database_id: 'direct-vscode-database',
            client_profile_id: 'direct-profile-id',
            storage_environment_id: 'direct-environment',
            product_kind: 'vscode',
            authority_mode: 'sqlite',
            legacy_capsule_id: null,
            legacy_source_format: null,
            legacy_source_digest: null,
            legacy_import_claim_id: null,
            next_revision: 1,
            absence_revision: 0,
        });
        expect(database.prepare('SELECT * FROM schema_migrations').get()).toMatchObject({
            version: SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION,
            name: SQLITE_DIRECT_VSCODE_FILE_STATE_MIGRATION_NAME,
        });
        expect(database.prepare('SELECT count(*) AS count FROM legacy_imports').get()?.count).toBe(0);
        expect(database.prepare('SELECT count(*) AS count FROM legacy_sources').get()?.count).toBe(0);
        expect(database.prepare('SELECT count(*) AS count FROM legacy_entry_claims').get()?.count).toBe(0);
    });

    it('does not migrate or rebrand databases across desktop and direct VS Code identities', () => {
        const desktop = openDatabase('desktop-cross-identity.sqlite3');
        initialize_sqlite_file_state_schema(desktop, desktopIdentity, {
            appliedAtMs: 100,
            appVersion: '0.7.0',
        });
        expect(() => initialize_sqlite_file_state_schema(desktop, directVscodeIdentity, {
            appliedAtMs: 200,
            appVersion: '0.7.0',
        })).toThrow('unsupported schema identity');
        expect(pragmaNumber(desktop, 'user_version')).toBe(SQLITE_FILE_STATE_USER_VERSION);
        expect(desktop.prepare('SELECT product_kind FROM state_meta').get()?.product_kind).toBe('desktop');

        const direct = openDatabase('direct-cross-identity.sqlite3');
        initialize_sqlite_file_state_schema(direct, directVscodeIdentity, {
            appliedAtMs: 200,
            appVersion: '0.7.0',
        });
        expect(() => initialize_sqlite_file_state_schema(direct, desktopIdentity, {
            appliedAtMs: 300,
            appVersion: '0.7.0',
        })).toThrow('unsupported schema identity');
        expect(pragmaNumber(direct, 'user_version')).toBe(SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION);
        expect(direct.prepare('SELECT product_kind FROM state_meta').get()?.product_kind).toBe('vscode');
    });

    it('atomically creates the immutable synthetic VS Code import identity', () => {
        const database = openDatabase('vscode.sqlite3');

        initialize_sqlite_file_state_schema(database, vscodeIdentity, {
            appliedAtMs: 3000,
            appVersion: '0.7.0',
        });

        expect(database.prepare('SELECT * FROM state_meta').get()).toMatchObject({
            database_id: 'vscode-database',
            client_profile_id: 'profile-id',
            storage_environment_id: 'workspace-environment',
            product_kind: 'vscode',
            authority_mode: 'sqlite_importing_memento',
            legacy_capsule_id: 'capsule-id',
            legacy_source_format: 'tableViewer.fileState.v1',
            legacy_source_digest: 'source-digest',
            legacy_import_claim_id: 'import-claim-id',
            next_revision: 9,
            absence_revision: 3,
            next_recency_order: 3,
            next_ownership_generation: 1,
            store_updated_at_ms: 1234,
        });
        expect(database.prepare('SELECT * FROM legacy_imports').get()).toMatchObject({
            capsule_id: 'capsule-id',
            source_entry_count: 2,
            source_next_revision: 9,
            source_absence_revision: 3,
        });
        expect(database.prepare(`SELECT source_path, source_ordinal, source_state_revision,
            source_kind, source_had_pending_edits, status
            FROM legacy_sources ORDER BY source_ordinal`).all()).toEqual([
            {
                source_path: 'file:///exact.csv',
                source_ordinal: 0,
                source_state_revision: 7,
                source_kind: 'exact_identity',
                source_had_pending_edits: 1,
                status: 'active',
            },
            {
                source_path: '/legacy/path.csv',
                source_ordinal: 1,
                source_state_revision: 8,
                source_kind: 'path_only_compatibility',
                source_had_pending_edits: 0,
                status: 'active',
            },
        ]);
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    it('sets user_version last and rolls all schema objects back on injected failure', () => {
        const database = openDatabase('failed.sqlite3');

        expect(() => initialize_sqlite_file_state_schema(database, desktopIdentity, {
            appliedAtMs: 100,
            appVersion: '0.7.0',
            beforeSetUserVersion: () => { throw new Error('injected failure'); },
        })).toThrow('injected failure');

        expect(pragmaNumber(database, 'user_version')).toBe(0);
        expect(pragmaNumber(database, 'application_id')).toBe(0);
        expect(database.prepare(`SELECT name FROM sqlite_schema
            WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`).all()).toEqual([]);
    });

    it('rejects an established WAL database without changing its journal policy', () => {
        const database = openDatabase('wal.sqlite3');
        initialize_sqlite_file_state_schema(database, desktopIdentity, {
            appliedAtMs: 100,
            appVersion: '0.7.0',
        });
        expect(database.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode).toBe('wal');

        expect(() => initialize_sqlite_file_state_schema(database, desktopIdentity, {
            appliedAtMs: 101,
            appVersion: '0.7.0',
        })).toThrow('journal policy');

        expect(database.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    });

    it('never brands or replaces a nonempty unrecognized database', () => {
        const database = openDatabase('foreign.sqlite3');
        database.exec('CREATE TABLE foreign_data (value TEXT) STRICT');

        expect(() => initialize_sqlite_file_state_schema(database, desktopIdentity, {
            appliedAtMs: 100,
            appVersion: '0.7.0',
        })).toThrow('Refusing to initialize');

        expect(pragmaNumber(database, 'application_id')).toBe(0);
        expect(pragmaNumber(database, 'user_version')).toBe(0);
        expect(database.prepare(`SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name = 'foreign_data'`).get()).toEqual({ name: 'foreign_data' });
    });

    it('rejects incomplete or inconsistent frozen source identities before DDL', () => {
        const database = openDatabase('invalid-vscode.sqlite3');
        const invalid: SqliteVscodeFileStateIdentity = {
            ...vscodeIdentity,
            legacy: { ...vscodeIdentity.legacy, sourceEntryCount: 3 },
        };

        expect(() => initialize_sqlite_file_state_schema(database, invalid, {
            appliedAtMs: 100,
            appVersion: '0.7.0',
        })).toThrow('Legacy source count');
        expect(database.prepare(`SELECT name FROM sqlite_schema
            WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`).all()).toEqual([]);
    });
});
