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
import { randomUUID } from 'node:crypto';
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
    assert_managed_directory,
    assert_sqlite_directory_durability_supported,
    capture_managed_directory,
    inspect_sqlite_recovery_gate,
    preserve_sqlite_basename_set,
    reclaim_stale_sqlite_exclusive_intent,
    resume_sqlite_basename_preservation,
    safe_error,
    type ManagedDirectoryIdentity,
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
 * The gate's two durable markers are the *whole* predicate, and deliberately so.
 * The blockade marker is written before the first member moves and removed only
 * after the manifest says `complete`, and the exclusive intent is removed last of
 * all — so every way a move can stop partway leaves at least one of them, and a
 * settled basename has neither.
 *
 * An earlier revision also refused when `inventory_sqlite_basename` reported
 * `incompleteRecoveryDirectories > 0`. That is not a stable predicate for this
 * app and it bricked the ordinary success path: `validate_completed_preservation`
 * requires a completed recovery directory's original source names to still be
 * *absent*, while the whole purpose of this flow is to re-initialize exactly that
 * name immediately after preserving. From the second launch onward every
 * successfully preserved directory therefore counted as "incomplete", so the app
 * opened once after a successful "Set Aside and Start Fresh" and then refused
 * forever, with Try Again re-failing identically and Set Aside throwing
 * `orphan-preservation-manifest` — no in-app escape at all, and reachable without
 * any crash. A half-moved set is a strictly smaller condition than that, and the
 * markers above already cover it.
 *
 * Deliberately non-blocking and non-mutating: `inspect_sqlite_recovery_gate` is
 * synchronous and acquires no token, so it cannot be starved by the condition it
 * is looking for.
 *
 * Returns the failure to report, or undefined to proceed with the open.
 */
function preflight_recovery_condition(
    database_path: string,
): DesktopStateOpenResult | undefined {
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
        return undefined;
    } catch (error) {
        // A preflight that cannot read its own gate is itself a reportable
        // condition — never a reason to fall through into the retry loop. The
        // original category and stage survive, because a gate directory that
        // cannot be listed at all is a different story from a recovery in
        // progress: a malformed reader-token filename reaches the dialog as
        // `reader-token-inventory` and gets its own prose.
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
    const blocked = preflight_recovery_condition(
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

/** Where a reader-token filename that the gate's inventory cannot parse is moved
 *  to, under the gate directory so it can never be mistaken for a basename
 *  member and never travels with a preserved set. One fresh generation
 *  subdirectory per quarantine run, so two runs cannot collide on a name and
 *  nothing has to be overwritten. */
const READER_TOKEN_QUARANTINE_DIRECTORY_NAME = 'quarantined-readers';

function desktop_state_gate_directory(database_path: string): string {
    return path.join(
        path.dirname(database_path),
        `.${path.basename(database_path)}.recovery-gate`,
    );
}

/**
 * Set aside any `*.reader` entry whose name the gate's own inventory refuses,
 * exactly and only under the all-processes-closed attestation.
 *
 * Without this, a single malformed reader-token filename is a permanent
 * dead-end: `existing_reader_token_ids` throws `reader-token-inventory` for any
 * `*.reader` whose stem is not a UUID, so the open fails *and*
 * `preserve_desktop_state_database` throws the same error out of
 * `inspect_sqlite_recovery_gate` before it can acquire the gate — leaving the
 * recovery dialog looping with no in-app action that can clear it, and the user
 * hand-editing a hidden directory as the only escape.
 *
 * This weakens no exact-token semantics, because an entry it touches was never a
 * token: every reader token this code has ever created is named
 * `<uuid>.reader` and contains that same uuid (see
 * `acquire_sqlite_shared_reader_gate`), so a name that fails `UUID_PATTERN` — or
 * an entry that is not a regular file at all — cannot represent a live reader
 * and cannot be reclaimed, waited on, or matched by any exact-token check. A
 * *valid* token is deliberately left completely alone here; reclaiming one stays
 * the exclusive gate's exact-id path, with no PID, TTL, age, or heartbeat.
 *
 * A move, never a delete, and into the diagnostics folder's own tree: the bytes
 * are evidence about how the directory got into this state, and nothing in this
 * module is allowed to destroy evidence.
 */
/**
 * Reduce any filesystem failure from the quarantine to a category.
 *
 * Load-bearing, not defensive tidiness: a raw `NodeJS.ErrnoException` carries
 * the absolute path in `.path` *and* embeds it in `.message`, and this function
 * runs before the backend's own sanitizing layer would have caught it — so
 * without this an `ENOTDIR`/`EACCES` here would put a real filesystem path into
 * whatever the caller logs or shows. `SqliteFileStateError` already carries
 * nothing but a category and a sanitized operation name.
 *
 * `safe_error` rather than `categorize_sqlite_file_state_error` so an errno maps
 * to the category that actually describes it — `EACCES` to `inaccessible`,
 * `ENOSPC` to `full` — instead of collapsing to `unknown`. Same mapping the
 * shared backend applies to its own filesystem failures, so a quarantine failure
 * and an equivalent failure one call later tell the same story.
 */
function quarantine_failure(error: unknown) {
    return safe_error('reader-token-quarantine', error);
}

function quarantine_unparseable_reader_tokens(
    database_path: string,
    confirmation: { readonly allProcessesClosed: true },
    options: SqliteOpenRecoveryHooks,
): void {
    if (confirmation?.allProcessesClosed !== true) {
        throw new Error('Quarantining reader tokens requires all processes closed.');
    }
    // Every directory this function touches is *captured* rather than merely
    // path-joined, and every child is derived from its parent's verified
    // `physicalPath`. Three rounds of defects here all had the same shape — a
    // path built with `path.join` and handed to `fs` without anything having
    // established that it is the directory we meant — so the structure, not
    // another check, is the fix: after this block no unverified string reaches an
    // `fs` call.
    //
    // `capture_managed_directory` is the shared backend's own primitive and is
    // strictly stronger than a local `lstat`: it rejects symlinks, confirms real
    // parentage via `realpath`, and re-`lstat`s to confirm dev/ino stability,
    // which closes the window between the check and the use. Reusing it also
    // means this function cannot drift from the rules the backend enforces one
    // call later.
    const state_directory = path.dirname(database_path);
    const gate_path = desktop_state_gate_directory(database_path);
    // Absent, not malformed: no gate at all means there is nothing to clear, and
    // the caller's own gate inspection is what decides whether that is a problem.
    if (!fs.existsSync(gate_path)) return;
    let gate: ManagedDirectoryIdentity;
    let readers: ManagedDirectoryIdentity;
    try {
        // The physical parent is resolved first so a symlinked *ancestor* — the
        // userData directory itself, say — cannot make an honest gate look
        // misparented, which would refuse a recovery that should have worked.
        gate = capture_managed_directory(
            gate_path,
            fs.realpathSync.native(state_directory),
            'reader-token-quarantine-directory',
        );
        const readers_path = path.join(gate.physicalPath, 'readers');
        // No readers directory yet is likewise nothing to clear.
        if (!fs.existsSync(readers_path)) return;
        readers = capture_managed_directory(
            readers_path,
            gate.physicalPath,
            'reader-token-quarantine-directory',
        );
    } catch (error) {
        throw quarantine_failure(error);
    }
    const readers_directory = readers.physicalPath;
    // Duplicated rather than imported from the shared backend: this is the shape
    // the backend *rejects*, so the predicate that decides what to quarantine has
    // to keep matching that rejection even if a future token name gains a
    // different generator. `randomUUID` is v4, which is what the backend's own
    // pattern accepts.
    const uuid_pattern
        = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    // Every filesystem call below is inside this try for the reason
    // `quarantine_failure` documents: an unsanitized errno escaping here would
    // carry an absolute path out of the module.
    try {
        const unparseable = fs.readdirSync(readers_directory, { withFileTypes: true })
            .filter((entry) => entry.name.endsWith('.reader'))
            .filter((entry) => !entry.isFile()
                || !uuid_pattern.test(entry.name.slice(0, -'.reader'.length)))
            .map((entry) => entry.name);
        if (unparseable.length === 0) return;
        const flush = (directory: string): void => {
            assert_sqlite_directory_durability_supported(
                directory,
                options.fsyncDirectory ?? fs.fsyncSync,
            );
        };
        // The destination is captured exactly like the source, and derived from
        // the gate's verified `physicalPath` rather than joined onto a raw string.
        // A symlink here would otherwise make `mkdirSync` land every rename in the
        // link target — the same escape as the read side, which is why both now go
        // through one primitive instead of two hand-written checks.
        //
        // Created one level at a time, the way `ensure_private_gate` does it, so
        // the entry recording `quarantined-readers` inside the gate can be flushed
        // before anything moves in. A single recursive mkdir would create both
        // levels while only the lower one was ever flushed.
        const quarantine_root_path = path.join(
            gate.physicalPath,
            READER_TOKEN_QUARANTINE_DIRECTORY_NAME,
        );
        const quarantine_root_existed = fs.existsSync(quarantine_root_path);
        if (!quarantine_root_existed) {
            fs.mkdirSync(quarantine_root_path, { mode: 0o700 });
            flush(gate.physicalPath);
        }
        const quarantine_root = capture_managed_directory(
            quarantine_root_path,
            gate.physicalPath,
            'reader-token-quarantine-directory',
        );
        const quarantine_directory = path.join(quarantine_root.physicalPath, randomUUID());
        fs.mkdirSync(quarantine_directory, { mode: 0o700 });
        // Before anything moves in, so a crash cannot leave a member with no
        // directory to have landed in. Both endpoints are re-asserted immediately
        // before the renames, as the shared backend does around its own mutations:
        // capture-then-use always leaves a window, and this closes it.
        flush(quarantine_root.physicalPath);
        assert_managed_directory(readers, 'reader-token-quarantine-directory');
        assert_managed_directory(quarantine_root, 'reader-token-quarantine-directory');
        for (const name of unparseable) {
            fs.renameSync(
                path.join(readers_directory, name),
                path.join(quarantine_directory, name),
            );
        }
        flush(quarantine_directory);
        flush(readers_directory);
    } catch (error) {
        throw quarantine_failure(error);
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
 * Four things beyond "start a move" happen here, all of them only because the
 * attestation was given:
 *
 * - a `*.reader` entry whose name the gate's inventory cannot parse — which was
 *   therefore never one of our tokens — is quarantined, so the very inventory
 *   this function depends on can run at all;
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
        // First of all, and before `inspect_sqlite_recovery_gate` — which lists
        // the readers directory and throws `reader-token-inventory` on an
        // unparseable name, from *this* line, making the whole recovery action
        // unreachable for a condition only the recovery action can clear.
        quarantine_unparseable_reader_tokens(database_path, confirmation, options);
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
    // Captured rather than thrown from the `finally` below: a `throw` there
    // silently discards whatever exception was already in flight, which is
    // exactly the failure this function exists to avoid. It is rethrown after
    // the try/finally settles, and only when nothing else went wrong.
    let release_error: unknown;
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
        try {
            if (!inspect_sqlite_recovery_gate(database_path).recoveryBlocked) {
                await gate.release();
            }
        } catch (error) {
            release_error = error;
        }
    }
    // Reached only when the preservation itself succeeded, so a failed release
    // can never displace the failure the user actually needs to see.
    if (completed && release_error !== undefined) throw release_error;
}
