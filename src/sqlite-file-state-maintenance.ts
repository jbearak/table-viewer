/**
 * Inspecting and trimming the stored file-state database.
 *
 * This sits beside the persistence layer rather than on the store in state.ts:
 * byte sizes and file compaction are facts about SQLite, not about the file-state
 * model, and the semantic store stays free of them. It takes the *same*
 * `SqliteRuntimeHandle` the live store uses, which is what makes trimming safe
 * to do while windows are open — every operation here lands in the same
 * serialized queue as ordinary reads and writes, so no new locking is involved.
 *
 * Three rules govern deletion, and all of them are enforced here rather than in
 * the UI, because a UI is the wrong place to keep a promise about data loss:
 *
 *  1. Leased and staged entries are never deleted. A lease means a window is
 *     working with the entry; a stage means a commit is in flight. No
 *     confirmation unlocks either. This matches what automatic eviction in
 *     state.ts has always done.
 *  2. Entries with unsaved edits are deletable, but only when the caller passes
 *     the exact paths back as confirmed. Since that set is what the second
 *     confirmation dialog was built from, an unconfirmed path cannot be
 *     destroyed by any code path, bulk ones included.
 *  3. Whether an entry is leased, staged, or holds unsaved edits is re-read
 *     inside the deleting transaction. A preview is a snapshot, and acting on a
 *     snapshot is how a file that became busy in the meantime gets destroyed.
 */
import * as fs from 'node:fs';
import { is_provider_state_key } from './resource-identity';
import {
    create_sqlite_file_state_write_repository,
    scan_sqlite_file_state_inspection,
} from './sqlite-file-state-repository';
import type { SqliteRuntimeHandle, SqliteVacuumOutcome } from './sqlite-runtime';
import {
    entry_activity_timestamp,
    type StoredFileStateEntry,
} from './stored-file-state-entry';

export type { StoredFileStateEntry };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StoredFileStateInventory {
    readonly entries: readonly StoredFileStateEntry[];
    readonly totalEntryCount: number;
    /** The database file itself, which only shrinks when a trim vacuums it. */
    readonly databaseSizeBytes: number;
}

export type StoredFileStateTrimSelection =
    | { readonly kind: 'paths'; readonly paths: readonly string[] }
    | { readonly kind: 'olderThanDays'; readonly days: number }
    | { readonly kind: 'missingOnDisk' }
    | { readonly kind: 'all' };

/** What a selection resolves to, before anything is deleted. */
export interface StoredFileStateTrimPreview {
    readonly targets: readonly StoredFileStateEntry[];
    /** Targets holding unsaved edits; deleting these needs explicit confirmation. */
    readonly pendingEditPaths: readonly string[];
    /** Matched the selection but is protected, so it will be left alone. */
    readonly protectedPaths: readonly string[];
}

export interface StoredFileStateTrimRequest {
    readonly paths: readonly string[];
    /** Paths the user was shown by name and explicitly agreed to lose edits for. */
    readonly confirmedPendingEditPaths: readonly string[];
}

export type StoredFileStateVacuum = SqliteVacuumOutcome | 'not-needed';

export interface StoredFileStateTrimResult {
    readonly deletedPaths: readonly string[];
    readonly skippedProtectedPaths: readonly string[];
    readonly skippedUnconfirmedPaths: readonly string[];
    readonly vacuum: StoredFileStateVacuum;
    readonly reclaimedBytes: number;
}

export interface StoredFileStateMaintenancePorts {
    readonly fileExists?: (path: string) => Promise<boolean>;
    readonly databaseSizeBytes?: () => Promise<number>;
    readonly now?: () => number;
}

export interface StoredFileStateMaintenance {
    inspect(): Promise<StoredFileStateInventory>;
    preview(selection: StoredFileStateTrimSelection): Promise<StoredFileStateTrimPreview>;
    trim(request: StoredFileStateTrimRequest): Promise<StoredFileStateTrimResult>;
}

async function default_file_exists(target: string): Promise<boolean> {
    try {
        await fs.promises.access(target);
        return true;
    } catch {
        return false;
    }
}

/**
 * Age-based trimming skips entries with no timestamps at all rather than
 * treating them as infinitely old. An age that cannot be computed is not
 * evidence of staleness, and "delete what we know nothing about" is the wrong
 * default when the payload may be someone's unsaved work.
 */
function is_older_than(entry: StoredFileStateEntry, cutoff: number): boolean {
    const stamp = entry_activity_timestamp(entry);
    return stamp !== undefined && stamp < cutoff;
}

export function create_sqlite_file_state_maintenance(
    handle: SqliteRuntimeHandle,
    ports: StoredFileStateMaintenancePorts = {},
): StoredFileStateMaintenance {
    const file_exists = ports.fileExists ?? default_file_exists;
    const now = ports.now ?? Date.now;
    const database_size = ports.databaseSizeBytes
        ?? (async () => {
            try {
                return (await fs.promises.stat(handle.canonical_path)).size;
            } catch {
                return 0;
            }
        });

    async function read_entries(): Promise<readonly StoredFileStateEntry[]> {
        const rows = await handle.read_transaction(scan_sqlite_file_state_inspection);
        // `hasAuthorityStages` is intentionally dropped here: an in-flight commit
        // is an internal detail with no meaning to someone reading a list of
        // their files. It still protects the row at deletion time, where it is
        // re-read from the database anyway.
        return rows.map((row) => ({
            path: row.path,
            sizeBytes: row.sizeBytes,
            hasPendingEdits: row.hasPendingEdits,
            isLeased: row.isLeased || row.hasAuthorityStages,
            ...(row.updatedAtMs === undefined ? {} : { updatedAtMs: row.updatedAtMs }),
            ...(row.touchedAtMs === undefined ? {} : { touchedAtMs: row.touchedAtMs }),
        }));
    }

    async function select(
        entries: readonly StoredFileStateEntry[],
        selection: StoredFileStateTrimSelection,
    ): Promise<readonly StoredFileStateEntry[]> {
        switch (selection.kind) {
            case 'all':
                return entries;
            case 'paths': {
                const wanted = new Set(selection.paths);
                return entries.filter((entry) => wanted.has(entry.path));
            }
            case 'olderThanDays': {
                const cutoff = now() - Math.max(0, selection.days) * MS_PER_DAY;
                return entries.filter((entry) => is_older_than(entry, cutoff));
            }
            case 'missingOnDisk': {
                // Not every key is a filesystem path. Virtual providers and
                // untitled buffers are stored under synthetic keys that no stat
                // could ever find, so testing them here would nominate every one
                // of them for deletion.
                const candidates = entries.filter((entry) => !is_provider_state_key(entry.path));
                const present = await Promise.all(
                    candidates.map((entry) => file_exists(entry.path)),
                );
                return candidates.filter((_, index) => !present[index]);
            }
        }
    }

    return {
        async inspect() {
            const [entries, databaseSizeBytes] = await Promise.all([
                read_entries(),
                database_size(),
            ]);
            return { entries, totalEntryCount: entries.length, databaseSizeBytes };
        },

        async preview(selection) {
            const matched = await select(await read_entries(), selection);
            const targets = matched.filter((entry) => !entry.isLeased);
            return {
                targets,
                pendingEditPaths: targets
                    .filter((entry) => entry.hasPendingEdits)
                    .map((entry) => entry.path),
                protectedPaths: matched
                    .filter((entry) => entry.isLeased)
                    .map((entry) => entry.path),
            };
        },

        async trim(request) {
            const confirmed = new Set(request.confirmedPendingEditPaths);
            const sizeBefore = await database_size();
            const outcome = await handle.write_transaction('maintenance-trim', (tx) => {
                const deletedPaths: string[] = [];
                const skippedProtectedPaths: string[] = [];
                const skippedUnconfirmedPaths: string[] = [];
                // Re-read current state inside the transaction. The request was
                // built from a preview, and between then and now an entry may
                // have been opened, staged, or gained unsaved edits.
                const live = new Map(
                    scan_sqlite_file_state_inspection(tx).map((row) => [row.path, row]),
                );
                const repository = create_sqlite_file_state_write_repository(tx, {
                    writerSessionId: handle.writer_session_id,
                    now,
                });
                for (const path of new Set(request.paths)) {
                    const row = live.get(path);
                    if (!row) continue;
                    if (row.isLeased || row.hasAuthorityStages) {
                        skippedProtectedPaths.push(path);
                        continue;
                    }
                    if (row.hasPendingEdits && !confirmed.has(path)) {
                        skippedUnconfirmedPaths.push(path);
                        continue;
                    }
                    repository.delete_entry(path);
                    deletedPaths.push(path);
                }
                if (deletedPaths.length > 0) {
                    // Readers cache by revision, so a deletion has to advance the
                    // absence revision or a window holding a stale snapshot would
                    // keep serving state for an entry that no longer exists. This
                    // is the same sequencing automatic eviction uses.
                    const absenceRevision = repository.allocate_revision();
                    repository.set_absence_revision(absenceRevision);
                    repository.set_updated_at(now());
                }
                return { deletedPaths, skippedProtectedPaths, skippedUnconfirmedPaths };
            });

            // Only rewrite the file if something actually left it. A vacuum takes
            // an exclusive lock and rewrites every page, which is not a cost worth
            // paying to reclaim nothing.
            const vacuum: StoredFileStateVacuum = outcome.deletedPaths.length === 0
                ? 'not-needed'
                : await handle.vacuum();
            const sizeAfter = await database_size();
            return {
                ...outcome,
                vacuum,
                reclaimedBytes: Math.max(0, sizeBefore - sizeAfter),
            };
        },
    };
}
