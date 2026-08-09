import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    categorize_sqlite_file_state_error,
    SqliteFileStateError,
    type SqliteFileStateErrorCategory,
} from '../sqlite-file-state-errors';
import {
    initialize_sqlite_file_state_schema,
    type SqliteDesktopFileStateIdentity,
    type SqliteDirectVscodeFileStateIdentity,
    type SqliteFileStateIdentity,
    type SqliteVscodeFileStateIdentity,
} from '../sqlite-file-state-schema';
import { validate_sqlite_file_state_database } from '../sqlite-file-state-validation';
import { SQLITE_PREPARED_INSTALL_STATE_KEY } from '../sqlite-file-state-repository';

let tempDirectory: string;
let databases: DatabaseSync[];
let counter = 0;

const desktopIdentity: SqliteDesktopFileStateIdentity = {
    productKind: 'desktop',
    databaseId: 'desktop-database',
    storageEnvironmentId: 'desktop-environment',
};

const directVscodeIdentity: SqliteDirectVscodeFileStateIdentity = {
    productKind: 'vscode',
    schemaKind: 'direct-vscode',
    databaseId: 'direct-vscode-database',
    clientProfileId: 'direct-profile-id',
    storageEnvironmentId: 'direct-environment',
};

const vscodeIdentity: SqliteVscodeFileStateIdentity = {
    productKind: 'vscode',
    databaseId: 'vscode-database',
    clientProfileId: 'profile-id',
    storageEnvironmentId: 'workspace-environment',
    legacy: {
        capsuleId: 'capsule-id',
        sourceFormat: 'tableViewer.fileState.v1',
        sourceDigest: 'source-digest',
        importClaimId: 'import-claim-id',
        sourceEntryCount: 1,
        sourceNextRevision: 4,
        sourceAbsenceRevision: 0,
        importedAtMs: 100,
        importerAppVersion: '0.7.0',
        sources: [{
            sourcePath: 'file:///legacy.csv',
            sourceOrdinal: 0,
            sourceStateRevision: 3,
            sourceKind: 'exact_identity',
            sourceHadPendingEdits: true,
        }],
    },
};

function createDatabase(
    identity: SqliteFileStateIdentity = desktopIdentity,
): DatabaseSync {
    const database = new DatabaseSync(path.join(tempDirectory, `state-${counter++}.sqlite3`), {
        enableDoubleQuotedStringLiterals: false,
    });
    databases.push(database);
    initialize_sqlite_file_state_schema(database, identity, {
        appliedAtMs: 1,
        appVersion: '0.7.0',
    });
    return database;
}

function expectValidationCategory(
    database: DatabaseSync,
    category: SqliteFileStateErrorCategory,
    identity: SqliteFileStateIdentity = desktopIdentity,
): void {
    try {
        validate_sqlite_file_state_database(database, { identity });
        throw new Error('validation unexpectedly succeeded');
    } catch (error) {
        expect(error).toBeInstanceOf(SqliteFileStateError);
        expect((error as SqliteFileStateError).category).toBe(category);
    }
}

function insertEntry(
    database: DatabaseSync,
    state: unknown,
    options: {
        path?: string;
        revision?: number;
        recency?: number;
        hasPending?: boolean;
        recoveryEntryId?: string;
        recoveryRecordId?: string;
    } = {},
): void {
    const entryPath = options.path ?? 'file:///entry.csv';
    const revision = options.revision ?? 1;
    const recency = options.recency ?? 1;
    database.prepare(`INSERT INTO entries (
        path, state_revision, state_json, has_pending_edits,
        authority_commit_sequence, authority_revision, physical_revision,
        projection_revision, physical_digest, recency_order, updated_at_ms,
        touched_at_ms, recovery_entry_id, recovery_record_id,
        copy_id, copy_source_path, copy_source_revision
    ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, NULL, NULL, ?, ?, NULL, NULL, NULL)`)
        .run(
            entryPath,
            revision,
            JSON.stringify(state),
            options.hasPending ? 1 : 0,
            recency,
            options.recoveryEntryId ?? `recovery-entry-${recency}`,
            options.recoveryRecordId ?? null,
        );
    database.prepare(`UPDATE state_meta SET
        next_revision = max(next_revision, ?),
        next_recency_order = max(next_recency_order, ?)`)
        .run(revision + 1, recency + 1);
}

beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-sqlite-validation-'));
    databases = [];
});

afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('SQLite file-state structural validation', () => {
    it('accepts a canonical desktop database and preserves unknown state leaves', () => {
        const database = createDatabase();
        insertEntry(database, {
            activeSheetIndex: 2,
            futureCompatibleLeaf: { nested: ['unchanged'] },
        });

        expect(validate_sqlite_file_state_database(database, { identity: desktopIdentity })).toEqual({
            databaseId: 'desktop-database',
            productKind: 'desktop',
            authorityMode: 'sqlite',
            coordinationGeneration: 1,
            nextRevision: 2,
            absenceRevision: 0,
            nextRecencyOrder: 2n,
            nextOwnershipGeneration: 1,
            entryCount: 1,
        });
    });

    it('accepts the complete synthetic VS Code import identity', () => {
        const database = createDatabase(vscodeIdentity);

        expect(validate_sqlite_file_state_database(database, { identity: vscodeIdentity })).toMatchObject({
            databaseId: 'vscode-database',
            productKind: 'vscode',
            authorityMode: 'sqlite_importing_memento',
            nextRevision: 4,
            nextRecencyOrder: 2n,
        });
    });

    it('accepts the exact direct VS Code identity without import lineage', () => {
        const database = createDatabase(directVscodeIdentity);

        expect(validate_sqlite_file_state_database(database, {
            identity: directVscodeIdentity,
        })).toMatchObject({
            databaseId: 'direct-vscode-database',
            productKind: 'vscode',
            authorityMode: 'sqlite',
            nextRevision: 1,
            absenceRevision: 0,
        });
        expect(() => validate_sqlite_file_state_database(database, {
            identity: vscodeIdentity,
        })).toThrow(SqliteFileStateError);
    });

    it('accepts direct cosmetic entries and live runtime writer sessions', () => {
        const database = createDatabase(directVscodeIdentity);
        const entryPath = 'file:///cosmetic.csv';
        insertEntry(database, { activeSheetIndex: 2 }, { path: entryPath, recoveryEntryId: entryPath });
        database.prepare(`INSERT INTO writer_sessions (
            writer_session_id, client_kind, client_version, negotiated_protocol,
            process_id, opened_at_ms, last_activity_at_ms, opened_generation,
            last_committed_sequence, last_operation_id, last_operation_kind
        ) VALUES ('writer', 'vscode-cosmetic', '0.7.0', 1, 123, 10, 11, 1,
            1, 'operation', 'compareAndSet')`).run();

        expect(() => validate_sqlite_file_state_database(database, {
            identity: directVscodeIdentity,
        })).not.toThrow();
    });

    it('rejects direct VS Code top-level pending edits and recovery references', () => {
        const pending = createDatabase(directVscodeIdentity);
        const pendingPath = 'file:///pending.csv';
        insertEntry(pending, {
            pendingEdits: { '0:0': { value: 'changed', base: 'original' } },
        }, {
            path: pendingPath,
            hasPending: true,
            recoveryEntryId: pendingPath,
        });
        expectValidationCategory(pending, 'malformed-state', directVscodeIdentity);

        const recovery = createDatabase(directVscodeIdentity);
        const recoveryPath = 'file:///recovery.csv';
        insertEntry(recovery, { activeSheetIndex: 1 }, {
            path: recoveryPath,
            recoveryEntryId: recoveryPath,
            recoveryRecordId: 'recovery-record',
        });
        expectValidationCategory(recovery, 'malformed-state', directVscodeIdentity);
    });

    it('rejects empty direct VS Code entry and recovery identities', () => {
        const database = createDatabase(directVscodeIdentity);
        insertEntry(database, { activeSheetIndex: 1 }, {
            path: '',
            recoveryEntryId: '',
        });

        expectValidationCategory(database, 'malformed-state', directVscodeIdentity);
    });

    it('rejects direct VS Code physical/projection authority and stages', () => {
        // One forged column per database. Forging all five at once would keep the
        // test green even if a rule for any single column stopped being validated,
        // because the remaining four still trigger the same category.
        const forgeries = [
            'authority_commit_sequence = 1',
            'authority_revision = 1',
            'physical_revision = 1',
            'projection_revision = 1',
            "physical_digest = 'forged-digest'",
        ];
        for (const forgery of forgeries) {
            const authority = createDatabase(directVscodeIdentity);
            const authorityPath = 'file:///authority.csv';
            insertEntry(authority, { activeSheetIndex: 1 }, {
                path: authorityPath,
                recoveryEntryId: authorityPath,
            });
            authority.exec(`UPDATE entries SET ${forgery}`);
            expectValidationCategory(authority, 'malformed-state', directVscodeIdentity);
        }

        const stage = createDatabase(directVscodeIdentity);
        const stagePath = 'file:///stage.csv';
        insertEntry(stage, { activeSheetIndex: 1 }, {
            path: stagePath,
            recoveryEntryId: stagePath,
        });
        stage.prepare(`INSERT INTO authority_stages (
            entry_path, stage_id, kind, ordinal, expected_state_revision,
            expected_commit_sequence, next_state_json, physical_digest, created_at_ms
        ) VALUES (?, 'forged-stage', 'projection', 0, 1, 0, '{}', NULL, 10)`)
            .run(stagePath);
        expectValidationCategory(stage, 'malformed-state', directVscodeIdentity);
    });

    it('rejects direct VS Code entry leases, edit sessions, and ownership history', () => {
        const lease = createDatabase(directVscodeIdentity);
        lease.prepare(`INSERT INTO entry_leases (
            lease_id, writer_session_id, current_entry_path, acquired_at_ms,
            acquired_generation
        ) VALUES ('lease', 'writer', 'file:///lease.csv', 10, 1)`).run();
        expectValidationCategory(lease, 'malformed-state', directVscodeIdentity);

        const edit = createDatabase(directVscodeIdentity);
        const editPath = 'file:///edit.csv';
        insertEntry(edit, { activeSheetIndex: 1 }, {
            path: editPath,
            recoveryEntryId: editPath,
        });
        edit.prepare(`INSERT INTO edit_sessions (
            entry_path, physical_resource_lock_key, host_lock_id, edit_session_id,
            owner_writer_session_id, ownership_generation, acquired_at_ms,
            last_confirmed_at_ms
        ) VALUES (?, 'resource', 'host', 'edit', 'writer', 1, 10, 10)`)
            .run(editPath);
        edit.exec('UPDATE state_meta SET next_ownership_generation = 2');
        expectValidationCategory(edit, 'malformed-state', directVscodeIdentity);

        const ownership = createDatabase(directVscodeIdentity);
        ownership.exec('UPDATE state_meta SET next_ownership_generation = 2');
        expectValidationCategory(ownership, 'malformed-state', directVscodeIdentity);
    });

    it('rejects direct VS Code prepared-install lifecycle and reservation state', () => {
        const cleanup = createDatabase(directVscodeIdentity);
        const cleanupPath = 'file:///cleanup.csv';
        insertEntry(cleanup, {
            activeSheetIndex: 3,
            [SQLITE_PREPARED_INSTALL_STATE_KEY]: {
                version: 1,
                phase: 'cleanupPending',
                reservationId: 'cleanup-reservation',
                saveOperationId: 'cleanup-operation',
                stageId: 'cleanup-stage',
                preparedInstallId: 'cleanup-install',
                hostLockId: 'cleanup-host',
                previousPhysicalResourceLockKey: 'cleanup-previous-resource',
                physicalResourceLockKey: 'cleanup-resource',
                expectedPhysicalDigest: 'cleanup-expected',
                intendedPhysicalDigest: 'cleanup-intended',
                recordedAtMs: 20,
            },
        }, { path: cleanupPath, recoveryEntryId: cleanupPath });
        expectValidationCategory(cleanup, 'malformed-state', directVscodeIdentity);

        const reserved = createDatabase(directVscodeIdentity);
        const reservedPath = 'file:///reserved.csv';
        insertEntry(reserved, {
            activeSheetIndex: 1,
            [SQLITE_PREPARED_INSTALL_STATE_KEY]: {
                version: 1,
                phase: 'reserved',
                reservationId: 'reservation',
                saveOperationId: 'save-operation',
                stageId: 'save-stage',
                preparedInstallId: 'prepared-install',
                hostLockId: 'host-lock',
                previousPhysicalResourceLockKey: 'previous-resource-lock',
                physicalResourceLockKey: 'resource-lock',
                expectedPhysicalDigest: 'expected-digest',
                intendedPhysicalDigest: 'intended-digest',
                recordedAtMs: 10,
            },
        }, { path: reservedPath, recoveryEntryId: reservedPath });
        reserved.exec("UPDATE entries SET physical_digest = 'expected-digest'");
        reserved.prepare(`INSERT INTO edit_sessions (
            entry_path, physical_resource_lock_key, host_lock_id, edit_session_id,
            owner_writer_session_id, ownership_generation, acquired_at_ms,
            last_confirmed_at_ms
        ) VALUES (?, 'resource-lock', 'host-lock', 'edit-session',
            'writer-session', 1, 10, 10)`).run(reservedPath);
        reserved.exec('UPDATE state_meta SET next_ownership_generation = 2');
        reserved.prepare(`INSERT INTO authority_stages (
            entry_path, stage_id, kind, ordinal, expected_state_revision,
            expected_commit_sequence, next_state_json, physical_digest, created_at_ms
        ) VALUES (?, 'save-stage', 'physical', 0, 1, 0,
            '{}', 'intended-digest', 10)`).run(reservedPath);
        reserved.prepare(`INSERT INTO file_write_reservations (
            reservation_id, save_operation_id, entry_path, physical_resource_lock_key,
            host_lock_id, edit_session_id, ownership_generation, reserved_generation,
            stage_id, prepared_install_id, expected_state_revision,
            expected_commit_sequence, expected_authority_revision,
            expected_physical_revision, expected_projection_revision,
            expected_physical_digest, intended_physical_digest, recovery_record_id,
            acquired_at_ms
        ) VALUES ('reservation', 'save-operation', ?, 'resource-lock',
            'host-lock', 'edit-session', 1, 1, 'save-stage', 'prepared-install',
            1, 0, 0, 0, 0, 'expected-digest', 'intended-digest', NULL, 10)`)
            .run(reservedPath);
        expectValidationCategory(reserved, 'malformed-state', directVscodeIdentity);
    });

    it('rejects exact schema/index SQL drift', () => {
        const database = createDatabase();
        database.exec('DROP INDEX entries_by_state_revision');
        database.exec('CREATE UNIQUE INDEX entries_by_state_revision ON entries(state_revision)');

        expectValidationCategory(database, 'schema');
    });

    it('rejects malformed known leaves without substituting defaults', () => {
        const database = createDatabase();
        insertEntry(database, { activeSheetIndex: 'not-an-integer' });

        expectValidationCategory(database, 'malformed-state');
    });

    it('requires the pending bit to match the decoded nonempty pending map', () => {
        const database = createDatabase();
        insertEntry(database, { pendingEdits: {} }, { hasPending: true });

        expectValidationCategory(database, 'malformed-state');
    });

    it('requires remote pending rows to carry recovery evidence', () => {
        const database = createDatabase();
        insertEntry(database, {
            pendingEdits: { '0:0': { value: 'changed', base: 'original' } },
        }, { hasPending: true });

        try {
            validate_sqlite_file_state_database(database, {
                identity: desktopIdentity,
                requiresPendingEditRecovery: true,
            });
            throw new Error('validation unexpectedly succeeded');
        } catch (error) {
            expect(error).toBeInstanceOf(SqliteFileStateError);
            expect((error as SqliteFileStateError).category).toBe('malformed-state');
        }
    });

    it('rejects revision and recency counters behind durable rows', () => {
        const database = createDatabase();
        insertEntry(database, { activeSheetIndex: 1 }, { revision: 5, recency: 7 });
        database.exec('UPDATE state_meta SET next_revision = 5, next_recency_order = 7');

        expectValidationCategory(database, 'counter');
    });

    it('rejects foreign-key damage without deleting the offending row', () => {
        const database = createDatabase();
        database.exec('PRAGMA foreign_keys = OFF');
        database.prepare(`INSERT INTO authority_stages (
            entry_path, stage_id, kind, ordinal, expected_state_revision,
            expected_commit_sequence, next_state_json, physical_digest, created_at_ms
        ) VALUES ('missing', 'stage', 'projection', 0, 0, 0, NULL, NULL, 0)`).run();
        database.exec('PRAGMA foreign_keys = ON');

        expectValidationCategory(database, 'foreign-key');
        expect(database.prepare('SELECT count(*) AS count FROM authority_stages').get()?.count).toBe(1);
    });

    it('validates complete edit, stage, reservation, authority, and recovery bindings', () => {
        const database = createDatabase();
        insertEntry(database, {
            pendingEdits: { '0:0': { value: 'changed', base: 'original' } },
            [SQLITE_PREPARED_INSTALL_STATE_KEY]: {
                version: 1,
                phase: 'reserved',
                reservationId: 'reservation',
                saveOperationId: 'save-operation',
                stageId: 'save-stage',
                preparedInstallId: 'prepared-install',
                hostLockId: 'host-lock',
                previousPhysicalResourceLockKey: 'previous-resource-lock',
                physicalResourceLockKey: 'resource-lock',
                expectedPhysicalDigest: 'expected-digest',
                intendedPhysicalDigest: 'intended-digest',
                recoveryRecordId: 'clear-record',
                recordedAtMs: 10,
            },
        }, { hasPending: true, recoveryRecordId: 'snapshot-record' });
        database.exec("UPDATE entries SET physical_digest = 'expected-digest'");
        database.prepare(`INSERT INTO edit_sessions (
            entry_path, physical_resource_lock_key, host_lock_id, edit_session_id,
            owner_writer_session_id, ownership_generation, acquired_at_ms, last_confirmed_at_ms
        ) VALUES ('file:///entry.csv', 'resource-lock', 'host-lock', 'edit-session',
            'writer-session', 1, 10, 10)`).run();
        database.exec('UPDATE state_meta SET next_ownership_generation = 2');
        database.prepare(`INSERT INTO authority_stages (
            entry_path, stage_id, kind, ordinal, expected_state_revision,
            expected_commit_sequence, next_state_json, physical_digest, created_at_ms
        ) VALUES ('file:///entry.csv', 'save-stage', 'physical', 0, 1, 0,
            '{}', 'intended-digest', 10)`).run();
        database.prepare(`INSERT INTO file_write_reservations (
            reservation_id, save_operation_id, entry_path, physical_resource_lock_key,
            host_lock_id, edit_session_id, ownership_generation, reserved_generation,
            stage_id, prepared_install_id, expected_state_revision,
            expected_commit_sequence, expected_authority_revision,
            expected_physical_revision, expected_projection_revision,
            expected_physical_digest, intended_physical_digest, recovery_record_id,
            acquired_at_ms
        ) VALUES ('reservation', 'save-operation', 'file:///entry.csv', 'resource-lock',
            'host-lock', 'edit-session', 1, 1, 'save-stage', 'prepared-install',
            1, 0, 0, 0, 0, 'expected-digest', 'intended-digest', 'clear-record', 10)`).run();

        expect(() => validate_sqlite_file_state_database(database, {
            identity: desktopIdentity,
        })).not.toThrow();

        database.exec('UPDATE file_write_reservations SET expected_authority_revision = 1');
        expectValidationCategory(database, 'malformed-state');
    });

    it('accepts a durable cleanup lifecycle after its reservation row is gone', () => {
        const database = createDatabase();
        insertEntry(database, {
            activeSheetIndex: 3,
            [SQLITE_PREPARED_INSTALL_STATE_KEY]: {
                version: 1,
                phase: 'cleanupPending',
                reservationId: 'cleanup-reservation',
                saveOperationId: 'cleanup-operation',
                stageId: 'cleanup-stage',
                preparedInstallId: 'cleanup-install',
                hostLockId: 'cleanup-host',
                previousPhysicalResourceLockKey: 'cleanup-previous-resource',
                physicalResourceLockKey: 'cleanup-resource',
                expectedPhysicalDigest: 'cleanup-expected',
                intendedPhysicalDigest: 'cleanup-intended',
                recordedAtMs: 20,
            },
        });

        expect(() => validate_sqlite_file_state_database(database, {
            identity: desktopIdentity,
        })).not.toThrow();
    });

    it('rejects cleanup lifecycle records without their previous lock identity', () => {
        const database = createDatabase();
        insertEntry(database, {
            [SQLITE_PREPARED_INSTALL_STATE_KEY]: {
                version: 1,
                phase: 'cleanupPending',
                reservationId: 'cleanup-reservation',
                saveOperationId: 'cleanup-operation',
                stageId: 'cleanup-stage',
                preparedInstallId: 'cleanup-install',
                hostLockId: 'cleanup-host',
                physicalResourceLockKey: 'cleanup-resource',
                expectedPhysicalDigest: 'cleanup-expected',
                intendedPhysicalDigest: 'cleanup-intended',
                recordedAtMs: 20,
            },
        });

        expectValidationCategory(database, 'malformed-state');
    });

    it('rejects an exact legacy source consumed by a claim while still active', () => {
        const database = createDatabase(vscodeIdentity);
        database.prepare(`INSERT INTO legacy_entry_claims (
            capsule_id, source_path, source_ordinal, source_state_revision,
            disposition, destination_path, claimed_at_ms
        ) VALUES ('capsule-id', 'file:///legacy.csv', 0, 3,
            'imported', 'file:///destination.csv', 10)`).run();

        expectValidationCategory(database, 'malformed-state', vscodeIdentity);
    });
});

describe('SQLite file-state error categorization', () => {
    it('categorizes a real SQLITE_LOCKED error from an active statement', () => {
        const database = new DatabaseSync(':memory:');
        database.exec('CREATE TABLE locked_table (value INTEGER); INSERT INTO locked_table VALUES (1), (2)');
        const rows = database.prepare('SELECT value FROM locked_table').iterate();
        expect(rows.next().done).toBe(false);
        try {
            database.exec('DROP TABLE locked_table');
            throw new Error('DROP TABLE unexpectedly bypassed the active statement lock');
        } catch (error) {
            const categorized = categorize_sqlite_file_state_error(error, {
                operation: 'real-locked-probe',
            });
            expect(categorized.category).toBe('contention');
            expect(categorized.metadata).toMatchObject({
                sqlitePrimaryCode: 6,
                operation: 'real-locked-probe',
            });
        } finally {
            rows.return?.();
            database.close();
        }
    });

    it.each([
        [5, 'contention'],
        [6, 'contention'],
        [15, 'contention'],
        [8, 'readonly'],
        [3, 'inaccessible'],
        [14, 'inaccessible'],
        [23, 'inaccessible'],
        [13, 'full'],
        [10, 'io'],
        [11, 'corrupt'],
        [26, 'corrupt'],
        [17, 'schema'],
        [787, 'foreign-key'],
        [19, 'unknown'],
    ] as const)('maps SQLite errcode %i to %s', (errcode, category) => {
        const error = Object.assign(new Error('sensitive path and SQL'), {
            code: 'ERR_SQLITE_ERROR',
            errcode,
            errstr: 'sensitive detail',
        });

        const categorized = categorize_sqlite_file_state_error(error, {
            operation: 'validate',
            rowCount: 2,
        });

        expect(categorized.category).toBe(category);
        expect(categorized.metadata).toMatchObject({
            sqliteErrorCode: errcode,
            sqlitePrimaryCode: errcode & 0xff,
            operation: 'validate',
            rowCount: 2,
        });
        expect(categorized.message).not.toContain('sensitive');
        expect(JSON.stringify(categorized.metadata)).not.toContain('sensitive');
        expect(categorized.cause).toBeUndefined();
    });

    it('drops untrusted metadata rather than logging paths, SQL, or arbitrary codes', () => {
        const categorized = categorize_sqlite_file_state_error(
            Object.assign(new Error('/private/file.csv SELECT *'), {
                code: 'not safe /private/file.csv',
                errcode: '10',
            }),
            {
                operation: '/private/file.csv',
                rowCount: -1,
            },
        );

        expect(categorized.category).toBe('unknown');
        expect(categorized.metadata).toEqual({});
        expect(categorized.message).toBe('The SQLite file-state operation failed.');
    });
});
