// The desktop's own SQLite file-state database, under the app's userData dir.
//
// The desktop and the VS Code extension each own a separate database file:
// they are separate products with separate lifecycles, and a shared file would
// make one product's recovery the other product's outage. This module owns the
// desktop side only.
//
// Pure Node (no electron import) so it is unit-testable; main.ts passes the
// `app.getPath('userData')` value, exactly as it does for `settings_file_path`.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    open_sqlite_file_state_store,
    type OpenedSqliteFileStateStore,
} from '../../src/sqlite-file-state-persistence';
import {
    categorize_sqlite_file_state_error,
    sqlite_file_state_recovery_error,
    SqliteFileStateError,
    type SqliteFileStateErrorCategory,
} from '../../src/sqlite-file-state-errors';
import type { SqliteDesktopFileStateIdentity } from '../../src/sqlite-file-state-schema';
import {
    acquire_sqlite_exclusive_recovery_gate,
    assert_sqlite_directory_durability_supported,
    inspect_sqlite_recovery_gate,
    preserve_sqlite_basename_set,
    quarantine_malformed_sqlite_gate_markers,
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

/** The throwaway directory the durability question is asked of. */
/**
 * The stage a whole-platform refusal is reported under.
 *
 * Deliberately not the backend's `directory-durability`, and that substitution is
 * the only discriminator the dialog gets. Both refusals are the same missing
 * guarantee, but they have opposite fixes: a *location* that cannot be flushed is
 * fixable today by storing the settings somewhere else, while a *platform* this
 * build declines can only be fixed by a later build. Passing the backend's stage
 * straight through would collapse the two and send half the users after a fix
 * that does not exist. Within the sanitizer's `[A-Za-z][A-Za-z0-9_-]{0,63}`, so
 * it survives into `DesktopStateOpenFailure` intact.
 */
export const DESKTOP_STATE_PLATFORM_DECLARATION_OPERATION = 'platform-durability-unsupported';

/**
 * What asking the production rule at one location told us.
 *
 * Three outcomes, not two, and the third is load-bearing. "The flush works here",
 * "the flush is refused here", and "the question could not be asked here" are
 * genuinely different, and collapsing the last into either of the others is how a
 * control location silently stops being a control: an unwritable or nonexistent
 * probe root would otherwise read as "no refusal", which is indistinguishable
 * from a location that answered normally.
 */
type DurabilityAnswer =
    | { readonly kind: 'supported' }
    | { readonly kind: 'refused'; readonly error: SqliteFileStateError }
    | { readonly kind: 'unavailable' };

/**
 * Ask the production rule whether a directory here can be durably flushed.
 *
 * Returns the answer rather than throwing it, because the caller needs to run
 * this twice — the whole platform/location distinction is the *difference*
 * between two answers, not a property of either one.
 */
function durability_answer_at(parent_directory: string): DurabilityAnswer {
    let probe_directory: string | undefined;
    try {
        // A directory we create and remove, never the canonical state directory:
        // this runs before the app has decided it can store anything here, and
        // creating the real tree as a side effect of asking the question would
        // break the "nothing has been changed or moved" claim the unsupported
        // dialog goes on to make.
        probe_directory = fs.mkdtempSync(path.join(parent_directory, '.tableviewer-durability-'));
        assert_sqlite_directory_durability_supported(probe_directory);
        return { kind: 'supported' };
    } catch (error) {
        // Only a durability refusal is an answer to the question asked. Anything
        // else — an unwritable or absent parent, a sandbox that forbids the write
        // — means the question went unasked here; the open itself classifies that
        // correctly for the *intended* location (as `environment`, retryable once
        // access is restored), and for a control location it means this control
        // has no vote.
        return error instanceof SqliteFileStateError && error.category === 'unsupported'
            ? { kind: 'refused', error }
            : { kind: 'unavailable' };
    } finally {
        if (probe_directory !== undefined) {
            try {
                fs.rmSync(probe_directory, { recursive: true, force: true });
            } catch {
                // An empty probe directory left behind is inert; failing to remove
                // it must not change the answer.
            }
        }
    }
}

/** Whether `directory` is the root itself or lives beneath it. */
function is_within(directory: string, root: string): boolean {
    const resolved = path.resolve(directory);
    const resolved_root = path.resolve(root);
    return resolved === resolved_root || resolved.startsWith(resolved_root + path.sep);
}

/**
 * The device a path is on, or `undefined` when that cannot be established.
 *
 * The nearest *existing* ancestor is what gets stat'd, because a userData
 * directory does not exist on a first launch and the question is about the volume
 * it will land on. `undefined` is a real answer meaning "unknown", never a device
 * id that might accidentally compare equal to something.
 */
function device_of(directory: string): bigint | undefined {
    let candidate = path.resolve(directory);
    for (;;) {
        try {
            return fs.statSync(candidate, { bigint: true }).dev;
        } catch {
            const parent = path.dirname(candidate);
            if (parent === candidate) return undefined;
            candidate = parent;
        }
    }
}

/**
 * Control locations to ask the same question of, ordered, each on a *different
 * filesystem* from the caller's.
 *
 * The temp directory first, because on a real install userData lives under the
 * user's home and the two are usually different filesystems — which is what makes
 * agreement between them evidence about the operating system rather than about one
 * mount.
 *
 * Discriminated by **device identity, not by path containment**. Textual
 * containment was the original test and it is not sufficient in either direction:
 * `TMPDIR` and userData can be different paths on one mount (macOS `/tmp` and
 * `$HOME` share a device on a stock install — measured, not assumed; so do a
 * userData and a `TMPDIR` both on a single NFS mount). Both probes then refuse for
 * the same *location-specific* reason, the loop stops at that first refusal, and a
 * fixable one-mount problem is reported as "this platform cannot do it, wait for a
 * future build" — the exact misdirection the platform/location split exists to
 * prevent, and the one whose cost is highest, because the story it tells offers no
 * remedy at all.
 *
 * A root whose device cannot be determined is kept rather than dropped. It may
 * still be genuinely unrelated, and `durability_answer_at` classifies a location it
 * cannot probe as `unavailable`, which already gets no vote — so an unknown device
 * degrades to the existing "could not ask" path instead of silently removing the
 * only available control. Containment is still applied, because a control *inside*
 * the caller's own tree is not a control whatever its device says.
 *
 * More than one because a control that cannot be written to has no vote, and on a
 * sandboxed or hardened host either root may be unavailable. Returning a list lets
 * the caller keep asking until something actually answers, instead of treating
 * "could not ask" as agreement.
 */
function control_roots_for(user_data_dir: string): readonly string[] {
    const intended_device = device_of(user_data_dir);
    return [os.tmpdir(), os.homedir()].filter((root) => {
        if (is_within(user_data_dir, root)) return false;
        if (intended_device === undefined) return true;
        const control_device = device_of(root);
        return control_device === undefined || control_device !== intended_device;
    });
}

/**
 * Whether this build is willing to keep a SQLite state database here at all,
 * decided *before* any open is attempted.
 *
 * The desktop's durability contract is unconditional: every marker, candidate,
 * member move, and install is made durable by flushing the containing directory,
 * and `assert_sqlite_directory_durability_supported` refuses rather than treat a
 * skipped flush as a successful one. Node exposes no proven win32 primitive for
 * that — `fs.openSync` on a directory fails outright, and `FlushFileBuffers` on a
 * file handle says nothing about the ordering of the rename and unlink operations
 * the install and preserve protocols are built from. A real primitive needs a
 * native addon, and the packaging contract forbids one (see
 * desktop/check-sqlite-bundle-externals.mjs, desktop/after-pack.mjs, and
 * desktop/README.md, all of which assert no native addon and no runtime
 * node_modules in the app bundle). So on Windows this build cannot open its state
 * database, and the failure policy forbids shipping with empty or read-only
 * authority in its place.
 *
 * Consulted up front rather than diagnosed from a failed open. The alternative
 * reaches the same conclusion by a longer route and reaches it worse in three
 * ways: it creates the coordination gate before refusing, it makes the story the
 * user is told depend on which internal stage happened to notice first, and it
 * leaves the platform decision implicit in a predicate two modules away. Stating
 * it here makes the refusal one fixed, non-looping story with nothing created and
 * nothing touched — which is what the failure policy asks of a platform whose
 * durability primitive is missing.
 *
 * Derived from the production assertion, never from a second `win32` literal. A
 * duplicated platform predicate can drift from its enforcer, and the drift is
 * silent by construction: the copy keeps answering confidently after the original
 * has changed.
 *
 * The two refusals are told apart by *where* they occur rather than by a second
 * platform test. The intended location is asked first; if it refuses, unrelated
 * control locations are asked. A control that also refuses makes this a property
 * of the platform, since the two locations have nothing in common but the
 * operating system. A control that answers normally makes it a property of that
 * one filesystem — an exotic or network mount — which the user can act on today.
 *
 * A control that cannot be asked at all gets no vote, and if *no* control can be
 * asked the answer stays with the location story. That asymmetry is deliberate:
 * the location story offers a remedy to try, so being wrong in that direction
 * costs one failed attempt, while wrongly claiming the whole platform is
 * unsupported tells someone with a fixable mount to wait for a future build.
 *
 * `user_data_dir` is required, and deliberately so. An earlier revision let it be
 * omitted and fell back to the temp directory, which quietly destroyed the
 * distinction this function exists to draw: the intended location and the control
 * were then the same directory, so the control always agreed and *every* refusal
 * — including a purely local one — was reported as a whole-platform refusal. That
 * is the "wait for a future build" story told to someone whose problem was one
 * unusual mount, which is precisely the misdirection the split was added to
 * prevent. A caller that genuinely wants the platform question asked in the
 * abstract passes a throwaway directory of its own; there is then still a real
 * control, and the answer stays honest.
 */
export function desktop_state_platform_support(
    user_data_dir: string,
): { readonly supported: true } | { readonly supported: false; readonly failure: DesktopStateOpenFailure } {
    const intended = durability_answer_at(user_data_dir);
    if (intended.kind !== 'refused') return { supported: true };
    // The first control that can actually answer decides; an unavailable one is
    // skipped rather than counted as agreement.
    let control_refused = false;
    for (const root of control_roots_for(user_data_dir)) {
        const control = durability_answer_at(root);
        if (control.kind === 'unavailable') continue;
        control_refused = control.kind === 'refused';
        break;
    }
    return {
        supported: false,
        failure: {
            category: intended.error.category,
            // Both refused: the platform itself. Only the intended location
            // refused, or no control could be reached: this filesystem, reported
            // under the backend's own stage so the dialog tells the fixable story.
            operation: control_refused
                ? DESKTOP_STATE_PLATFORM_DECLARATION_OPERATION
                : intended.error.metadata.operation,
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
 * A marker counts whether or not it *parses*. Each is created by an
 * `open`+`write`+`fsync`, so a crash in the gap leaves a zero-length file, and a
 * zero-length `exclusive-intent` blocks the reader gate exactly as a well-formed
 * one does — the reader gate tests only for the file's presence. Refusing on
 * presence alone therefore keeps the predicate honest, and the attested preserve
 * is what clears it; inspection no longer throws on either shape, because
 * throwing here is what made the torn case unrecoverable.
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
        // An entry in the readers directory that was never one of our tokens —
        // by its name or by its contents — is reported with its own stage, so
        // the dialog tells it as `coordination-residue` ("something unexpected
        // in the coordination folder") rather than as an interrupted move that
        // never happened. It is refused rather than ignored because the recovery
        // action is the only thing that can clear it, and an app that opened
        // normally would never offer that action: `waitForReaders` would then
        // spin on the entry forever the next time a preserve was attempted.
        if (gate.malformedReaderTokenNames.length > 0) {
            return open_failure(
                sqlite_file_state_recovery_error({ operation: 'reader-token-inventory' }),
                'reader-token-inventory',
            );
        }
        // An intent is either a live peer mid-recovery or the residue of an
        // interrupted one. From inside one process those are indistinguishable
        // — and must stay indistinguishable, because telling them apart would
        // mean PID/TTL/heartbeat expiry. Both are honestly "a recovery is in
        // progress", which is a dialog, not a spin.
        //
        // A *malformed* marker of either kind is refused identically, because it
        // obstructs identically: the reader gate tests only for the intent
        // file's presence, so a zero-length one left by a crash between the
        // marker's `open` and its `write` spins every later launch exactly as a
        // well-formed one does.
        if (gate.exclusiveIntentTokenId !== undefined || gate.exclusiveIntentMalformed
            || gate.recoveryBlocked || gate.recoveryBlockMalformed) {
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
        // cannot be read at all — a plain file where `readers/` belongs, say —
        // is a different story from a recovery in progress.
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
    // Before the recovery preflight, because the recovery preflight itself
    // inspects — and therefore creates — the gate directory. On a platform this
    // build declines, the promise the dialog makes is that nothing was changed or
    // moved, and creating a coordination directory in order to discover that is
    // already a change.
    const support = desktop_state_platform_support(user_data_dir);
    if (!support.supported) return { type: 'failed', failure: support.failure };
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

/**
 * Where a gate marker the backend's inspection classified malformed is moved to,
 * under the gate directory so it can never be mistaken for a basename member and
 * never travels with a preserved set.
 *
 * Named for markers rather than readers because that is what it holds: a torn
 * `exclusive-intent` and a torn `recovery-block.json` land here too, and each of
 * those was its own permanent dead-end for exactly the same reason an
 * unparseable reader name was.
 */
const GATE_MARKER_QUARANTINE_DIRECTORY_NAME = 'quarantined-gate-markers';

/**
 * Set aside every gate marker the backend's own inspection classified malformed,
 * exactly and only under the all-processes-closed attestation.
 *
 * A thin call now, and deliberately so. The hand-written version here covered
 * unparseable reader-token *names* only, while three other torn-marker shapes —
 * a zero-length `exclusive-intent`, a zero-length `recovery-block.json`, and a
 * `<uuid>.reader` whose contents are not that uuid — were the same permanent
 * dead-end by the same mechanism: the inspection path parsed a durable marker
 * strictly and threw, and it ran before, and gated, the only attested path
 * allowed to clear it. Four patches would have been four chances for the fifth
 * shape to be missed; one primitive in the module that defines the markers
 * cannot drift from them.
 *
 * What stays here is the desktop's own choice: the subtree's name, which appears
 * in the diagnostics folder the recovery dialog reveals, and the fact that this
 * product quarantines at all.
 *
 * The guarantees the primitive keeps, restated because this call site depends on
 * them: it moves and never deletes, it leaves every *valid* marker completely
 * alone, it refuses without the attestation, and it uses no PID, TTL, age, or
 * heartbeat anywhere. It also returns `SqliteFileStateError` for every
 * filesystem failure, so no `NodeJS.ErrnoException` — whose `.path` and
 * `.message` both carry an absolute path — can escape this module.
 */
async function quarantine_malformed_gate_markers(
    database_path: string,
    confirmation: { readonly allProcessesClosed: true },
    options: SqliteOpenRecoveryHooks,
): Promise<void> {
    await quarantine_malformed_sqlite_gate_markers(database_path, confirmation, {
        ...options,
        quarantineDirectoryName: GATE_MARKER_QUARANTINE_DIRECTORY_NAME,
    });
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
 * - every gate marker the backend classifies as malformed — a torn
 *   `exclusive-intent`, a torn `recovery-block.json`, a `*.reader` entry whose
 *   name or contents were never ours — is quarantined, so the very inspection
 *   this function depends on can produce a usable answer at all;
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
        // First of all: the quarantine is what makes every later step in this
        // function *reachable*. A malformed marker left in place would either
        // make the reclamation below unable to name a token to reclaim (a torn
        // intent has no id to match), route the preserve into a resume that
        // cannot parse its own blockade, or leave `waitForReaders` spinning on
        // an entry that was never a live reader.
        await quarantine_malformed_gate_markers(database_path, confirmation, options);
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
