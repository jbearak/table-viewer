// The desktop's own SQLite file-state database, under the app's userData dir.
//
// The desktop and the VS Code extension each own a separate database file:
// they are separate products with separate lifecycles, and a shared file would
// make one product's recovery the other product's outage. This module owns the
// desktop side only.
//
// Pure Node (no electron import) so it is unit-testable; main.ts passes the
// `app.getPath('userData')` value, exactly as it does for `settings_file_path`
// and `json_state_file_path`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    open_sqlite_file_state_store,
    type OpenedSqliteFileStateStore,
} from '../../src/sqlite-file-state-persistence';
import {
    categorize_sqlite_file_state_error,
    sqlite_file_state_recovery_error,
    type SqliteFileStateErrorCategory,
} from '../../src/sqlite-file-state-errors';
import type { SqliteDesktopFileStateIdentity } from '../../src/sqlite-file-state-schema';
import {
    acquire_sqlite_exclusive_recovery_gate,
    inspect_sqlite_recovery_gate,
    inventory_sqlite_basename,
    preserve_sqlite_basename_set,
    reclaim_stale_sqlite_exclusive_intent,
    resume_sqlite_basename_preservation,
    type SqliteExclusiveRecoveryGate,
    type SqliteOpenRecoveryHooks,
} from '../../src/sqlite-open-recovery';

/** Subdirectory of userData holding the database and its recovery artifacts. */
export const DESKTOP_STATE_DIRECTORY_NAME = 'state';
export const DESKTOP_STATE_DATABASE_NAME = 'file-state.sqlite3';

/**
 * The desktop identity is deterministic, not a random per-install id.
 *
 * The identity in `state_meta` is validated on every open
 * (`src/sqlite-file-state-validation.ts`), and a mismatch is an unopenable
 * compatibility error rather than something the app can repair. A random
 * `databaseId` therefore only works if it is durably remembered somewhere else,
 * and the desktop has nowhere to remember it: there is exactly one canonical
 * database per userData directory and no companion registry to preallocate an
 * id against. The sidecar we would have to invent would become a second point
 * of failure whose loss turns a perfectly healthy database into a permanently
 * unopenable one.
 *
 * Only VS Code needs a preallocated random `databaseId`, because there it is
 * the import-claim key that ties a database to the memento it was imported
 * from; the desktop imports from nothing and claims nothing.
 */
export const DESKTOP_STATE_DATABASE_ID = 'tableViewer.desktop.fileState.v1';
export const DESKTOP_STATE_STORAGE_ENVIRONMENT_ID = 'desktop';

export const DESKTOP_STATE_IDENTITY: SqliteDesktopFileStateIdentity = Object.freeze({
    productKind: 'desktop',
    databaseId: DESKTOP_STATE_DATABASE_ID,
    storageEnvironmentId: DESKTOP_STATE_STORAGE_ENVIRONMENT_ID,
});

/** Client identification recorded on the writer session for diagnostics. */
export const DESKTOP_STATE_CLIENT_KIND = 'desktop';

export function desktop_state_database_path(user_data_dir: string): string {
    return path.join(
        user_data_dir,
        DESKTOP_STATE_DIRECTORY_NAME,
        DESKTOP_STATE_DATABASE_NAME,
    );
}

/**
 * The directory the recovery dialog's "Open Diagnostics Folder" action reveals.
 * It is the database's own directory, so a preserved basename set (which is
 * moved into a sibling recovery directory) is visible next to the live file.
 */
export function desktop_state_diagnostics_directory(user_data_dir: string): string {
    return path.join(user_data_dir, DESKTOP_STATE_DIRECTORY_NAME);
}

/**
 * All the failure detail that may cross this boundary. Deliberately narrow: the
 * category drives the recovery dialog's wording, and `operation` is the already
 * sanitized stage name from `SqliteFileStateErrorMetadata`. Paths, filenames,
 * SQL text, persisted state, and raw SQLite messages never leave this module —
 * a state database is full of user file paths, and a dialog or a crash report
 * is not a place to spill them.
 */
export type DesktopStateOpenFailure = {
    readonly category: SqliteFileStateErrorCategory;
    readonly operation?: string;
    /**
     * The negotiated protocol version, present only when the failure came from a
     * version/ownership fence rather than from lock contention.
     *
     * Carried because `protocol` is one category with two meanings: real
     * SQLITE_PROTOCOL contention ("another process is using this") and this
     * build's own reader/writer-protocol bound check ("this database belongs to a
     * different version"). Only the latter attaches metadata, so its presence is
     * the discriminator the recovery flow needs in order to tell the ownership
     * story instead of blaming a window that does not exist — see
     * `refine_state_recovery_kind`.
     *
     * Safe to carry: sanitized upstream to a non-negative safe integer, and it
     * describes this build's own wire version, not any user content.
     */
    readonly protocol?: number;
    /** The coordination generation, present for the same reason and under the
     *  same sanitization: a non-negative safe integer, never user content. */
    readonly coordinationGeneration?: number;
};

export type DesktopStateOpenResult =
    | { readonly type: 'opened'; readonly opened: OpenedSqliteFileStateStore }
    | { readonly type: 'failed'; readonly failure: DesktopStateOpenFailure };

/**
 * The one thing that may be written to a log about a state-backend failure.
 *
 * Both fields are provably safe to emit: `category` is a member of a closed
 * union, and `operation` has already been narrowed upstream to
 * `[A-Za-z][A-Za-z0-9_-]{0,63}` (see `SqliteFileStateError`'s metadata
 * sanitizer). Everything else a raw error carries is not: a
 * `NodeJS.ErrnoException` has `.path`, and its `.message` embeds that path — and
 * for this app a path is a CSV the user opened or the location of their state
 * database. That is why nothing anywhere in the desktop path logs an error
 * *object*; it logs the output of this function instead.
 */
export function desktop_state_failure_log_line(failure: DesktopStateOpenFailure): string {
    return failure.operation === undefined
        ? `category=${failure.category}`
        : `category=${failure.category} operation=${failure.operation}`;
}

/**
 * Reduce an arbitrary thrown value to a loggable category, for the paths that
 * catch something they did not classify (the startup catch in main.ts).
 *
 * Unrecognized values become `unknown`, which is the honest answer and, more
 * importantly, the safe one: the alternative of logging the error is exactly the
 * path leak described above. Any classification detail beyond the category —
 * message, code, stack, `.path` — is deliberately discarded here rather than at
 * the call site, so no call site has to be trusted to remember.
 */
export function desktop_state_error_log_line(error: unknown): string {
    return desktop_state_failure_log_line({
        category: categorize_sqlite_file_state_error(error).category,
    });
}

/** The narrow failure shape used by both the preflight and the open itself.
 *
 *  Each field is copied only when the sanitizer kept it, so `undefined` never
 *  appears as an own property — the recovery flow's discriminators are
 *  *presence* tests, and an explicit `protocol: undefined` would read as
 *  "present" to anything doing `'protocol' in failure`. */
function open_failure(error: unknown, operation: string): DesktopStateOpenResult {
    const categorized = categorize_sqlite_file_state_error(error, { operation });
    const { metadata } = categorized;
    return {
        type: 'failed',
        failure: {
            category: categorized.category,
            ...(metadata.operation === undefined ? {} : { operation: metadata.operation }),
            ...(metadata.protocol === undefined ? {} : { protocol: metadata.protocol }),
            ...(metadata.coordinationGeneration === undefined ? {} : {
                coordinationGeneration: metadata.coordinationGeneration,
            }),
        },
    };
}

/**
 * Refuse the open, without acquiring anything, when the basename is under an
 * unfinished recovery.
 *
 * This exists because `acquire_sqlite_shared_reader_gate` waits for an exclusive
 * intent to disappear in an *unbounded* retry loop — correct while another live
 * process is mid-preserve, catastrophic when the intent was left behind by a
 * preserve that was interrupted (a force-quit during "Set Aside and Start
 * Fresh"). Without this check every subsequent launch spins forever with no
 * window and no dialog, and the only escape is deleting a hidden dotfile by
 * hand. With it, the same residue becomes the `recovery` category, which the
 * dialog tells as the `interrupted` story and whose preserve action can now
 * resume and clear it (see `preserve_desktop_state_database`).
 *
 * Deliberately non-blocking and non-mutating: `inspect_sqlite_recovery_gate` is
 * synchronous and acquires no token, and `inventory_sqlite_basename` only reads.
 * Neither can be starved by the condition it is looking for.
 *
 * Returns the failure to report, or undefined to proceed with the open.
 */
async function preflight_recovery_condition(
    database_path: string,
): Promise<DesktopStateOpenResult | undefined> {
    // First run: the directory the store itself creates does not exist yet, so
    // there is nothing to be blocked by — and inspecting would both fail with
    // ENOENT and create the gate before the store has made its own directory.
    if (!fs.existsSync(path.dirname(database_path))) return undefined;
    try {
        const gate = inspect_sqlite_recovery_gate(database_path);
        // An intent is either a live peer mid-recovery or the residue of an
        // interrupted one. From inside one process those are indistinguishable
        // — and must stay indistinguishable, because telling them apart would
        // mean PID/TTL/heartbeat expiry. Both are honestly "a recovery is in
        // progress", which is a dialog, not a spin.
        if (gate.exclusiveIntentTokenId !== undefined || gate.recoveryBlocked) {
            return open_failure(
                sqlite_file_state_recovery_error({ operation: 'desktop-state-preflight' }),
                'desktop-state-preflight',
            );
        }
        const inventory = await inventory_sqlite_basename(database_path);
        // A recovery directory that does not validate as complete means a move
        // is half-done. Opening the main file would serve state detached from
        // whichever members already left, so fail closed into the resume path.
        if (inventory.recoveryBlocked || inventory.incompleteRecoveryDirectories > 0) {
            return open_failure(
                sqlite_file_state_recovery_error({ operation: 'desktop-state-preflight' }),
                'desktop-state-preflight',
            );
        }
        return undefined;
    } catch (error) {
        // A preflight that cannot read its own gate is itself a reportable
        // condition — never a reason to fall through into the retry loop.
        return open_failure(error, 'desktop-state-preflight');
    }
}

/**
 * Open (creating on first run) the desktop's file-state database.
 *
 * Never throws and never logs: an unopenable state database is a condition the
 * app reports to the user through the recovery dialog, not a crash, and the
 * only safe thing to say about it is its category.
 */
export async function open_desktop_state_database(
    user_data_dir: string,
    app_version: string,
    get_max_stored_files: () => number,
    options: { readonly now?: () => number } = {},
): Promise<DesktopStateOpenResult> {
    const now = options.now ?? Date.now;
    const blocked = await preflight_recovery_condition(
        desktop_state_database_path(user_data_dir),
    );
    if (blocked) return blocked;
    try {
        const opened = await open_sqlite_file_state_store(
            desktop_state_database_path(user_data_dir),
            {
                identity: DESKTOP_STATE_IDENTITY,
                migration: { appliedAtMs: now(), appVersion: app_version },
                clientKind: DESKTOP_STATE_CLIENT_KIND,
                clientVersion: app_version,
                ...(options.now ? { now: options.now } : {}),
            },
            get_max_stored_files,
        );
        return { type: 'opened', opened };
    } catch (error) {
        return open_failure(error, 'desktop-state-open');
    }
}

/**
 * Clear the residue of an *interrupted* recovery, exactly and only under the
 * user's all-processes-closed attestation.
 *
 * Both reclamations are exact-token: the exclusive intent is removed only if the
 * file still contains the very token id just read from it, and a reader token
 * only if that exact id is still present with its own id as its content. There
 * is deliberately no PID, TTL, age, or heartbeat anywhere here — plan line 1386
 * permits exactly this, and only this: "after explicit all-processes-closed
 * confirmation, exact stale reader tokens may be reclaimed under the exclusive
 * intent; never use PID/TTL/heartbeat expiry". Reclaiming by age would let a
 * momentarily slow live peer have its database moved out from under it.
 *
 * The reader reclamation is what stops the recovery action itself from hanging:
 * a crash while the database was open leaves a reader token behind, and
 * `waitForReaders()` waits for it without a deadline (correctly — a deadline
 * would be a time-based expiry). Force-quitting that wait is what leaks the
 * exclusive intent in the first place.
 */
async function reclaim_interrupted_recovery_residue(
    gate: SqliteExclusiveRecoveryGate,
    confirmation: { readonly allProcessesClosed: true },
): Promise<void> {
    // Every token here is someone else's by construction: this process reaches
    // preservation only from the recovery flow, i.e. only after its own open
    // failed, so it holds no reader token of its own to reclaim by mistake.
    for (const token_id of gate.listReaderTokenIds()) {
        await gate.reclaimStaleReaderToken(token_id, confirmation);
    }
}

/**
 * Move the unopenable database aside so the next launch starts clean, keeping
 * the old bytes for diagnostics.
 *
 * The confirmation argument is the caller attesting that no other Table Viewer
 * process is using this database; there is no way to verify that from inside
 * one process, so it is fail-closed and explicit. The shared preservation
 * routine does the actual work — it moves the whole `{main, -journal, -wal,
 * -shm}` set as one unit — because preserving only some members would leave
 * behind a WAL that a later open would replay into a *different* main file.
 *
 * Three things beyond "start a move" happen here, all of them only because the
 * attestation was given:
 *
 * - a stale exclusive intent left by an interrupted attempt is reclaimed by
 *   exact token, so this attempt can acquire the gate at all;
 * - stale reader tokens are reclaimed by exact id, so the exclusive wait can
 *   finish instead of spinning on a token whose process is gone; and
 * - an already-blockaded basename is *resumed* rather than restarted, because a
 *   half-moved set has exactly one correct continuation.
 */
export async function preserve_desktop_state_database(
    user_data_dir: string,
    confirmation: { readonly allProcessesClosed: true },
    options: SqliteOpenRecoveryHooks = {},
): Promise<void> {
    if (confirmation?.allProcessesClosed !== true) {
        throw new Error('Preserving the desktop state database requires all processes closed.');
    }
    const database_path = desktop_state_database_path(user_data_dir);
    // Before acquiring: an intent left behind by an interrupted attempt would
    // make our own `write_private_file_exclusive` fail with EEXIST, i.e. the
    // user could never retry the very operation that was interrupted.
    if (fs.existsSync(path.dirname(database_path))) {
        const residue = inspect_sqlite_recovery_gate(database_path);
        if (residue.exclusiveIntentTokenId !== undefined) {
            await reclaim_stale_sqlite_exclusive_intent(
                database_path,
                residue.exclusiveIntentTokenId,
                confirmation,
            );
        }
    }
    const gate = await acquire_sqlite_exclusive_recovery_gate(database_path, options);
    let completed = false;
    try {
        await reclaim_interrupted_recovery_residue(gate, confirmation);
        // Resume explicitly when a blockade is already present, rather than
        // leaving it to `preserve_sqlite_basename_set`'s own internal delegation:
        // "continue the interrupted move" is a desktop-visible guarantee — the
        // recovery dialog promises it in prose and the flow loops on it — so it
        // is stated here instead of depending on an implementation detail of the
        // shared routine. The manifest, not a fresh inventory, is the only record
        // of which members have already left.
        const blocked = inspect_sqlite_recovery_gate(database_path).recoveryBlocked;
        if (blocked) await resume_sqlite_basename_preservation(database_path, { ...options, gate });
        else await preserve_sqlite_basename_set(database_path, { ...options, gate });
        completed = true;
    } finally {
        // The exclusive intent is removed *last*, and only once the blockade
        // state and directories are durably settled — so a mid-move failure
        // deliberately leaves it in place. That is not a leak: the preflight in
        // `open_desktop_state_database` now reports it as a recovery condition,
        // and the attested retry above reclaims it and resumes the move.
        //
        // Releasing here regardless would also be futile as well as wrong:
        // `release()` refuses while the blockade marker exists, so the old
        // unconditional `finally { await gate.release() }` replaced the honest
        // ENOSPC/EIO with a generic recovery error *and* left the intent behind
        // anyway — relabeling an IOERR, which the failure policy forbids.
        let release_error: unknown;
        try {
            if (!inspect_sqlite_recovery_gate(database_path).recoveryBlocked) {
                await gate.release();
            }
        } catch (error) {
            release_error = error;
        }
        // Only when nothing else went wrong: a failed release must never
        // displace the failure the user actually needs to see.
        if (completed && release_error !== undefined) throw release_error;
    }
}
