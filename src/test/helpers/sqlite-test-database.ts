import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    create_keyed_file_state_persistence,
    type KeyedFileStatePersistence,
    type KeyedStateStoreMetadata,
    type PersistedCompleteKeyedStateEntry,
} from '../../state';
import {
    open_sqlite_file_state_persistence,
    type SqliteFileStatePersistenceOptions,
} from '../../sqlite-file-state-persistence';
import { initialize_sqlite_database_no_clobber } from '../../sqlite-open-recovery';
import type { FileStateStoreContractInspection } from '../file-state-store-contract';

export interface SqliteTestDatabaseOptions {
    readonly now?: () => number;
}

function set_bigints(statement: ReturnType<DatabaseSync['prepare']>) {
    statement.setReadBigInts(true);
    return statement;
}

function number(value: unknown): number {
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number') return value;
    throw new TypeError('Expected SQLite integer.');
}

function optional_number(value: unknown): number | undefined {
    return value === null || value === undefined ? undefined : number(value);
}

export class SqliteTestDatabase {
    readonly databasePath: string;
    readonly options: SqliteFileStatePersistenceOptions;
    readonly runtimeKey: object = {};
    readonly #opened = new Set<KeyedFileStatePersistence>();
    #initialized?: Promise<void>;
    #failNextCommit = false;
    #seedFailure?: unknown;
    #failedSeedInspection?: FileStateStoreContractInspection;

    constructor(databasePath: string, testOptions: SqliteTestDatabaseOptions = {}) {
        this.databasePath = path.resolve(databasePath);
        const now = testOptions.now ?? Date.now;
        this.options = {
            identity: {
                productKind: 'desktop',
                databaseId: `test-database:${this.databasePath}`,
                storageEnvironmentId: `test-environment:${this.databasePath}`,
            },
            migration: {
                appliedAtMs: now(),
                appVersion: 'sqlite-test',
            },
            clientKind: 'vitest',
            clientVersion: 'sqlite-test',
            now,
        };
    }

    async initialize(): Promise<void> {
        this.#initialized ??= (async () => {
            await fs.promises.mkdir(path.dirname(this.databasePath), {
                recursive: true,
                mode: 0o700,
            });
            const result = await initialize_sqlite_database_no_clobber(
                this.databasePath,
                this.options.identity,
                this.options.migration,
            );
            await result.database.close();
        })();
        await this.#initialized;
    }

    async openPersistence(): Promise<KeyedFileStatePersistence> {
        await this.initialize();
        const persistence = await open_sqlite_file_state_persistence(this.databasePath, this.options);
        this.#opened.add(persistence);
        if (this.#seedFailure !== undefined) {
            const failure = this.#seedFailure;
            return {
                ...persistence,
                read_transaction: async () => { throw failure; },
                write_transaction: async () => { throw failure; },
            };
        }
        return {
            ...persistence,
            write_transaction: (kind, body) => persistence.write_transaction(kind, (tx) => {
                const result = body(tx);
                if (this.#failNextCommit && kind !== 'lease') {
                    this.#failNextCommit = false;
                    throw new Error('injected SQLite write failure');
                }
                return result;
            }),
        };
    }

    async seedEnvelope(envelope: unknown): Promise<void> {
        const compatibility = create_keyed_file_state_persistence({
            runtime_key: {},
            read: () => structuredClone(envelope),
            write: async () => {},
        });
        let decoded: {
            metadata: KeyedStateStoreMetadata;
            entries: PersistedCompleteKeyedStateEntry[];
        };
        try {
            decoded = await compatibility.read_transaction((tx) => ({
                metadata: tx.metadata(),
                entries: tx.scan_entry_metadata().map((metadata) => tx.read_entry(metadata.path) as PersistedCompleteKeyedStateEntry),
            })) as typeof decoded;
        } catch (error) {
            this.#seedFailure = error;
            this.#failedSeedInspection = structuredClone(envelope) as FileStateStoreContractInspection;
            await this.initialize();
            await compatibility.close();
            return;
        }
        await compatibility.close();
        await this.initialize();

        const database = new DatabaseSync(this.databasePath, {
            enableDoubleQuotedStringLiterals: false,
        });
        try {
            database.exec(`PRAGMA foreign_keys = ON;
                PRAGMA trusted_schema = OFF;
                PRAGMA synchronous = FULL;
                PRAGMA secure_delete = ON;
                BEGIN IMMEDIATE`);
            database.exec('DELETE FROM entry_leases; DELETE FROM authority_stages; DELETE FROM entries');
            const insertEntry = database.prepare(`INSERT INTO entries (
                path, state_revision, state_json, has_pending_edits,
                authority_commit_sequence, authority_revision, physical_revision,
                projection_revision, physical_digest, recency_order, updated_at_ms,
                touched_at_ms, recovery_entry_id, recovery_record_id, copy_id,
                copy_source_path, copy_source_revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            const insertStage = database.prepare(`INSERT INTO authority_stages (
                entry_path, stage_id, kind, ordinal, expected_state_revision,
                expected_commit_sequence, next_state_json, physical_digest, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const complete of decoded.entries) {
                const entry = complete.entry;
                insertEntry.run(
                    entry.path,
                    entry.stateRevision,
                    entry.stateJson,
                    entry.hasPendingEdits ? 1 : 0,
                    entry.authority.commitSequence,
                    entry.authority.authorityRevision,
                    entry.authority.physicalRevision,
                    entry.authority.projectionRevision,
                    entry.authority.physicalDigest ?? null,
                    entry.recencyOrder,
                    entry.updatedAtMs ?? null,
                    entry.touchedAtMs ?? null,
                    entry.recoveryEntryId,
                    entry.recoveryRecordId ?? null,
                    entry.copyProvenance?.id ?? null,
                    entry.copyProvenance?.sourcePath ?? null,
                    entry.copyProvenance?.sourceRevision ?? null,
                );
                for (const stage of complete.stages) {
                    insertStage.run(
                        entry.path,
                        stage.id,
                        stage.kind,
                        stage.ordinal,
                        stage.expectedStateRevision,
                        stage.expectedCommitSequence,
                        stage.nextState === undefined ? null : JSON.stringify(stage.nextState),
                        stage.physicalDigest ?? null,
                        stage.createdAt,
                    );
                }
            }
            database.prepare(`UPDATE state_meta SET next_revision = ?, absence_revision = ?,
                next_recency_order = ?, store_updated_at_ms = ? WHERE singleton = 1`).run(
                decoded.metadata.nextRevision,
                decoded.metadata.absenceRevision,
                decoded.metadata.nextRecencyOrder,
                decoded.metadata.updatedAtMs ?? null,
            );
            database.exec('COMMIT');
        } catch (error) {
            try {
                database.exec('ROLLBACK');
            } catch {
                // Preserve the seed failure.
            }
            throw error;
        } finally {
            database.close();
        }
    }

    inspect(): FileStateStoreContractInspection {
        if (this.#failedSeedInspection !== undefined) {
            return structuredClone(this.#failedSeedInspection);
        }
        const database = new DatabaseSync(this.databasePath, {
            readOnly: true,
            enableDoubleQuotedStringLiterals: false,
        });
        try {
            const meta = set_bigints(database.prepare(`SELECT next_revision, absence_revision,
                store_updated_at_ms FROM state_meta WHERE singleton = 1`)).get();
            if (!meta) throw new Error('Missing test state metadata.');
            const entries: Record<string, any> = {};
            const entryRows = set_bigints(database.prepare(`SELECT * FROM entries
                ORDER BY recency_order, path`)).all();
            const stagesByPath = new Map<string, Record<string, any>>();
            for (const row of set_bigints(database.prepare(`SELECT * FROM authority_stages
                ORDER BY entry_path, created_at_ms, ordinal, stage_id`)).all()) {
                const entryPath = String(row.entry_path);
                const stages = stagesByPath.get(entryPath) ?? {};
                stages[String(row.stage_id)] = {
                    id: String(row.stage_id),
                    kind: row.kind,
                    ordinal: number(row.ordinal),
                    expectedStateRevision: number(row.expected_state_revision),
                    expectedCommitSequence: number(row.expected_commit_sequence),
                    createdAt: number(row.created_at_ms),
                    ...(row.next_state_json === null
                        ? {}
                        : { nextState: JSON.parse(String(row.next_state_json)) }),
                    ...(row.physical_digest === null
                        ? {}
                        : { physicalDigest: String(row.physical_digest) }),
                };
                stagesByPath.set(entryPath, stages);
            }
            for (const row of entryRows) {
                const entryPath = String(row.path);
                const authority = {
                    commitSequence: number(row.authority_commit_sequence),
                    authorityRevision: number(row.authority_revision),
                    physicalRevision: number(row.physical_revision),
                    projectionRevision: number(row.projection_revision),
                    ...(row.physical_digest === null
                        ? {}
                        : { physicalDigest: String(row.physical_digest) }),
                };
                const copy = row.copy_id === null ? undefined : {
                    id: String(row.copy_id),
                    sourcePath: String(row.copy_source_path),
                    sourceRevision: number(row.copy_source_revision),
                };
                entries[entryPath] = {
                    revision: number(row.state_revision),
                    state: JSON.parse(String(row.state_json)),
                    hasPendingEdits: number(row.has_pending_edits) === 1,
                    authority,
                    ...(stagesByPath.has(entryPath) ? { stages: stagesByPath.get(entryPath) } : {}),
                    ...(optional_number(row.updated_at_ms) === undefined
                        ? {}
                        : { updatedAt: optional_number(row.updated_at_ms) }),
                    ...(optional_number(row.touched_at_ms) === undefined
                        ? {}
                        : { touchedAt: optional_number(row.touched_at_ms) }),
                    ...(copy === undefined ? {} : { copyProvenance: copy }),
                };
            }
            return {
                format: 'tableViewer.fileState.v1',
                nextRevision: number(meta.next_revision),
                absenceRevision: number(meta.absence_revision),
                ...(optional_number(meta.store_updated_at_ms) === undefined
                    ? {}
                    : { updatedAt: optional_number(meta.store_updated_at_ms) }),
                entries,
            };
        } finally {
            database.close();
        }
    }

    async failNextWrite(): Promise<() => Promise<void>> {
        this.#failNextCommit = true;
        return async () => {
            this.#failNextCommit = false;
        };
    }

    async close(): Promise<void> {
        const opened = [...this.#opened];
        this.#opened.clear();
        await Promise.allSettled(opened.map((persistence) => persistence.close()));
    }
}
