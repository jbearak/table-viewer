// Packaged-runtime recovery gates: the plan's initialization-crash, rollback-
// journal, sidecar, and preservation-crash requirements, proven *inside* Electron
// rather than in host Node.
//
// Like desktop/electron-sqlite-runtime-probe.mjs, this is bundled by
// desktop/build.mjs into dist/runtime-probes/ and imports the real `src/` open,
// recovery, and preservation code. That is the entire point: a gate that
// transcribed the protocol instead of calling it would pass while production
// drifted away from it. It is deliberately kept out of dist/desktop so
// electron-builder cannot ship it with the application.
//
// One bundle plays both roles. The parent drives the gates; a child re-enters the
// same bundle under `TABLE_VIEWER_GATE_ROLE` and hard-aborts at a named durable
// cut point, so the residue the parent inspects is what a real crash leaves — a
// killed process at a real fsync boundary, not a mocked filesystem. Both halves
// run under Electron, so the crash and the recovery are both proven against the
// embedded runtime.
//
// Output is counts, categories, and the backend's own sanitized stage names.
// Never a path, a filename, a SQL statement, or any stored value: this driver
// runs in CI, where its stdout is a public artifact.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import {
    SQLITE_INITIALIZATION_DURABLE_CUT_POINTS,
    SQLITE_PRESERVATION_DURABLE_CUT_POINTS,
    initialize_sqlite_database_no_clobber,
    open_existing_sqlite_database,
} from '../src/sqlite-open-recovery';
import { validate_sqlite_file_state_database } from '../src/sqlite-file-state-validation';
import { SqliteFileStateError } from '../src/sqlite-file-state-errors';
import {
    DESKTOP_STATE_IDENTITY,
    desktop_state_database_path,
    desktop_state_diagnostics_directory,
    desktop_state_platform_support,
    preserve_desktop_state_database,
} from './main/desktop-state-database';

const ROLE_VARIABLE = 'TABLE_VIEWER_GATE_ROLE';
const CUT_POINT_VARIABLE = 'TABLE_VIEWER_GATE_CUT_POINT';
const MIGRATION = Object.freeze({ appliedAtMs: 1_700_000_000_000, appVersion: 'packaged-recovery-gate' });

/** The committed value the rollback-journal gate looks for, and the uncommitted
 *  one it must never see. Both are plain counters on `state_meta`: no stored
 *  state, no row JSON, nothing derived from a user's files. */
const COMMITTED_MARK = 111;
const ROLLED_BACK_MARK = 222;

/**
 * A gate assertion that did not hold.
 *
 * Its own class, not a plain `Error`, because the difference is a privacy
 * boundary rather than a stylistic one. Every message raised through `invariant`
 * is composed here in this file out of cut-point names, categories, counts, and
 * booleans, so it is safe to print verbatim; an arbitrary caught value is not,
 * and a `NodeJS.ErrnoException`'s `.message` embeds an absolute path. Matching on
 * the type lets the reporter print the first and reduce the second, without
 * pattern-matching a message prefix that any error could be made to carry.
 */
class GateAssertionError extends Error {
    constructor(message) {
        super(`packaged recovery gate failed: ${message}`);
        this.name = 'GateAssertionError';
    }
}

function invariant(condition, message) {
    if (!condition) throw new GateAssertionError(message);
}

function write_output(stream, text) {
    // Synchronous, for the same reason as the runtime probe: it flushes before
    // app.exit() and fails immediately rather than silently if the pipe is gone.
    fs.writeSync(stream.fd, text);
}

/**
 * The one function allowed to turn a thrown value into text on a public pipe.
 *
 * The header above promises no path, filename, SQL, or stored value ever leaves
 * this driver, and `classified()` enforces that for the *result* report — but the
 * failure path is public too, and it is the one that runs when something
 * unexpected happened. A raw `throw` from any unwrapped `fs` or `spawn` call
 * reaches here as a `NodeJS.ErrnoException` whose `.message` embeds an absolute
 * path, so printing `error.message` unconditionally leaked exactly what the
 * header forbids. They are only ephemeral CI temp paths today, but the rule is
 * the rule precisely so nobody has to re-audit which paths are sensitive.
 *
 * Three cases, in order of how much may be said:
 *  - a gate assertion: composed in this file from cut-point names and counts, so
 *    printed verbatim — this is the diagnostic a failing gate exists to give;
 *  - a `SqliteFileStateError`: its category and already-sanitized stage, the same
 *    reduction `classified()` applies;
 *  - anything else: its error *code* if it has one (`ENOSPC`, `EACCES` — a short
 *    constant, never a path) and its constructor name. Enough to tell a disk-full
 *    from a permissions problem without echoing the message that names the file.
 */
function safe_failure_text(error) {
    if (error instanceof GateAssertionError) return error.message;
    if (error instanceof SqliteFileStateError) {
        return `packaged recovery gate failed: category=${error.category}`
            + `${error.metadata.operation ? ` operation=${error.metadata.operation}` : ''}`;
    }
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)
        ? error.code
        : 'none';
    const kind = typeof error?.constructor?.name === 'string'
        && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name)
        ? error.constructor.name
        : typeof error;
    return `packaged recovery gate failed: unclassified ${kind} code=${code}`;
}

/**
 * A single failure's shape, reduced to what may be printed.
 *
 * Only `SqliteFileStateError` is accepted as a fail-closed outcome. A raw
 * `NodeJS.ErrnoException` reaching here would be a leak as much as a bug — its
 * `.path` and `.message` both carry an absolute path — so an unclassified throw
 * fails the gate instead of being reported.
 */
function classified(error) {
    invariant(error instanceof SqliteFileStateError,
        `fail-closed outcome is ${error?.constructor?.name ?? typeof error}, not SqliteFileStateError`);
    return { category: error.category, operation: error.metadata.operation };
}

/** Every entry beside the database, as a name set. Names are compared, never
 *  printed: they are how "nothing was deleted" is checked, and they include the
 *  canonical basename. */
function directory_entries(directory) {
    try {
        return new Set(fs.readdirSync(directory));
    } catch (error) {
        if (error?.code === 'ENOENT') return new Set();
        throw error;
    }
}

/** Names present before an operation but gone after it. The whole failure-policy
 *  section rests on this being empty for everything except a candidate the
 *  install protocol legitimately consumes. */
function removed_entries(before, after) {
    return [...before].filter((name) => !after.has(name));
}

function state_directory(user_data_dir) {
    return desktop_state_diagnostics_directory(user_data_dir);
}

/**
 * A throwaway userData tree with the state subdirectory already present.
 *
 * `initialize_sqlite_database_no_clobber` deliberately does not create its parent
 * — that is `open_sqlite_file_state_persistence`'s job in production, and keeping
 * it out of the no-clobber primitive is what stops a stray path from silently
 * growing a directory tree. The gates call the primitive directly, so they stand
 * in for the caller that would have made the directory.
 */
function make_user_data_dir(label) {
    const user_data_dir = fs.mkdtempSync(path.join(tmpdir(), `table-viewer-gate-${label}-`));
    fs.mkdirSync(state_directory(user_data_dir), { recursive: true, mode: 0o700 });
    return user_data_dir;
}

/**
 * Open through the production non-creating read-write path and validate a
 * *complete* v1 — schema, identity, and the immutable journal policy.
 *
 * The pragmas are re-asserted on top of `validate_sqlite_file_state_database`
 * because a rollback-journal database opened in the wrong journal mode or with a
 * weakened synchronous setting is silently non-durable rather than broken, and
 * because every gate below depends on the recovery it just exercised having
 * happened under DELETE-mode rules.
 */
async function open_complete_v1(database_path) {
    const opened = await open_existing_sqlite_database(database_path, {
        validate(database) {
            validate_sqlite_file_state_database(database, { identity: DESKTOP_STATE_IDENTITY });
        },
    });
    try {
        const pragma = (name) => opened.database.prepare(`PRAGMA ${name}`).get()?.[name];
        invariant(pragma('journal_mode') === 'delete',
            `journal_mode is ${String(pragma('journal_mode'))}, not delete`);
        invariant(pragma('synchronous') === 2,
            `synchronous is ${String(pragma('synchronous'))}, not FULL (2)`);
        invariant(pragma('secure_delete') === 1,
            `secure_delete is ${String(pragma('secure_delete'))}, not on`);
        invariant(pragma('foreign_keys') === 1,
            `foreign_keys is ${String(pragma('foreign_keys'))}, not on`);
        return opened;
    } catch (error) {
        await opened.close();
        throw error;
    }
}

/**
 * The gates' central invariant, applied wherever a canonical file survives a
 * crash: whatever is at the canonical name must be a *complete* v1 or nothing.
 *
 * "No partial v1 is ever exposed" is unobservable as a negative, so it is checked
 * positively — anything at that name is opened through production's own validating
 * path, and a half-built schema fails there. A canonical file that exists but does
 * not validate is exactly the state the no-clobber install protocol exists to make
 * impossible.
 */
async function assert_no_partial_v1(database_path) {
    if (!fs.existsSync(database_path)) return 'absent';
    const opened = await open_complete_v1(database_path);
    await opened.close();
    return 'complete';
}

/**
 * Run one child of this same bundle under Electron and wait for it to die.
 *
 * `--no-sandbox` is propagated rather than added: the Linux CI runner cannot
 * configure Electron's root-owned SUID helper and passes it to the parent, and a
 * child that did not inherit that decision would fail for a reason that has
 * nothing to do with the property under test. Nothing here waits a fixed delay —
 * the child's death is the observable event, and `process.abort()` guarantees it
 * arrives.
 */
/** Backstop for a child that neither aborts nor exits; see `run_crashing_child`.
 *  Orders of magnitude above a healthy child, which dies in milliseconds. */
const CHILD_STUCK_LIMIT_MS = 120_000;

function run_crashing_child(role, cut_point, user_data_dir) {
    // This module's own file, resolved from `import.meta.url` rather than taken
    // from `process.argv[1]`.
    //
    // Electron does not reserve argv[1] for the script: it holds whatever the first
    // argument happened to be, so under the `--no-sandbox` the Linux runner
    // requires, `argv[1]` is the literal string `--no-sandbox`. The child was
    // therefore spawned with no script to run at all — it exited by a signal,
    // convincingly enough that the parent accepted it as an abort, having created
    // nothing. The gate then correctly reported that no residue existed and nothing
    // had been under test, which is why that assertion is there.
    //
    // `--no-sandbox` is also deliberately not forwarded. The parent needs it as a
    // real Electron app; the child is plain Node (see `ELECTRON_RUN_AS_NODE`), and
    // Node rejects Chromium flags outright with `bad option: --no-sandbox`.
    //
    // `__filename`, not `import.meta.url`: desktop/build.mjs bundles this to CJS,
    // where esbuild replaces `import.meta` with an empty object, so the URL form
    // resolves to undefined at runtime. `__filename` is the real path of the
    // bundled file that is actually executing, which is what the child must re-run.
    const script = __filename;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
            env: {
                ...process.env,
                [ROLE_VARIABLE]: role,
                [CUT_POINT_VARIABLE]: cut_point,
                TABLE_VIEWER_GATE_USER_DATA: user_data_dir,
                // Run the child as plain Node inside the Electron binary. The
                // property under test is that the *embedded runtime* — its
                // node:sqlite, its fsync, its rename — survives a kill at a durable
                // boundary; none of that needs Chromium, a window, or a desktop
                // session. Booting the browser stack anyway made the child hang on
                // a headless CI runner, which has no D-Bus for it to reach
                // ("Failed to connect to the bus"), and a hung child hung the
                // parent with it. `ELECTRON_RUN_AS_NODE` skips that entire layer.
                ELECTRON_RUN_AS_NODE: '1',
            },
            // The child writes nothing to stdout; its stderr is piped so that a
            // fixture that failed *before* reaching its cut point can say why.
            // That text is already reduced by the child's own `safe_failure_text`,
            // so it is safe to surface — and it is surfaced, in the rejection
            // below, rather than captured and silently dropped.
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        // A child that neither reaches its cut point nor exits would otherwise
        // hang this promise, and with it the whole job, until the CI runner's own
        // limit killed it with no diagnosis — which is exactly what a headless
        // runner produced before the child stopped booting Chromium. Every child
        // here aborts within milliseconds, so this is a stuck-process backstop and
        // never a race against slow work: it is deliberately far above any healthy
        // duration, and it reports rather than passing.
        const stuck = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new GateAssertionError(
                `child for ${role}/${cut_point} never reached its cut point or exited`
                + `${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
            ));
        }, CHILD_STUCK_LIMIT_MS);
        stuck.unref?.();
        const settle = (finish) => (...args) => {
            clearTimeout(stuck);
            finish(...args);
        };
        // Spawn itself failed (no executable, EAGAIN). Reduced like everything
        // else that reaches a public pipe: the raw error names a path.
        child.on('error', settle((error) => {
            reject(new GateAssertionError(
                `child for ${role}/${cut_point} could not be spawned (${safe_failure_text(error)})`,
            ));
        }));
        child.on('exit', settle((code, signal) => {
            // A clean exit means the cut point was never reached, so the residue
            // the parent is about to inspect would not be crash residue at all.
            // Exit 2 is the child's own classified failure, and its reduced
            // message is the only thing that explains it — dropping it here is
            // what made an early fixture failure look like an anonymous mystery.
            if (code === 0 || code === 2) {
                reject(new GateAssertionError(
                    `child for ${role}/${cut_point} ${code === 0 ? 'exited cleanly instead of aborting' : 'failed before its cut point'}`
                    + `${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
                ));
                return;
            }
            resolve({ code, signal });
        }));
    });
}

/**
 * Gate 1 — initialization crash at every durable cut point.
 *
 * For each of `SQLITE_INITIALIZATION_DURABLE_CUT_POINTS`, a child hard-aborts
 * inside `initialize_sqlite_database_no_clobber` at that boundary and the parent
 * then runs the same production initialization over the residue. The required
 * outcome is a disjunction, deliberately: either a complete valid v1 is installed,
 * or the open fails closed with a classified category. Asserting a specific
 * outcome per cut point would pin today's boundary placement; asserting the
 * disjunction plus the three invariants below pins what actually matters.
 *
 * The invariants, which hold for every cut point:
 *  - nothing is deleted, with one exact exception: a candidate the install
 *    protocol consumed *after* a complete v1 was validated at the canonical name.
 *    A candidate removed while the canonical name holds nothing would be the
 *    destruction of the only complete database on disk;
 *  - no partial v1 is ever exposed at the canonical name; and
 *  - a fail-closed outcome is a `SqliteFileStateError`, not a raw errno whose
 *    message carries a path.
 */
async function initialization_crash_gate() {
    const outcomes = [];
    for (const cut_point of SQLITE_INITIALIZATION_DURABLE_CUT_POINTS) {
        const user_data_dir = make_user_data_dir('init');
        try {
            const database_path = desktop_state_database_path(user_data_dir);
            await run_crashing_child('initialize-crash', cut_point, user_data_dir);

            const before = directory_entries(state_directory(user_data_dir));
            invariant(before.size > 0,
                `${cut_point}: the crashed child left no residue at all, so nothing was under test`);

            let result;
            let failure;
            try {
                result = await initialize_sqlite_database_no_clobber(
                    database_path,
                    DESKTOP_STATE_IDENTITY,
                    MIGRATION,
                );
            } catch (error) {
                failure = classified(error);
            }
            let installed = false;
            try {
                if (result) {
                    validate_sqlite_file_state_database(result.database.database, {
                        identity: DESKTOP_STATE_IDENTITY,
                    });
                    installed = true;
                }
            } finally {
                if (result) await result.database.close();
            }

            invariant(installed || failure !== undefined,
                `${cut_point}: initialization neither installed a valid v1 nor failed closed`);
            const canonical = await assert_no_partial_v1(database_path);
            invariant(!installed || canonical === 'complete',
                `${cut_point}: initialization reported success with no complete v1 at the canonical name`);

            // Which of the two permitted outcomes is required is derived from the
            // residue, not hardcoded per cut point — a boundary that moved would
            // otherwise silently relax this. The plan's rule is explicit: never
            // initialize when main is absent or empty while a candidate or sidecar
            // remains. Left as a bare disjunction, a build that started
            // initializing straight over abandoned first-run evidence would report
            // `installed`, satisfy every other assertion here, and pass.
            const residue_only = [...before].some((name) => name.includes('.init-candidate.'))
                && ![...before].includes(path.basename(database_path));
            invariant(!residue_only || failure !== undefined,
                `${cut_point}: initialized over crash residue instead of failing closed`);

            const after = directory_entries(state_directory(user_data_dir));
            for (const name of removed_entries(before, after)) {
                invariant(name.includes('.init-candidate.'),
                    `${cut_point}: a canonical or sidecar member was deleted during recovery`);
                invariant(canonical === 'complete',
                    `${cut_point}: an initialization candidate was deleted with no complete v1 installed`);
            }
            outcomes.push({
                cutPoint: cut_point,
                canonical,
                ...(failure ? { failedClosed: failure } : { installed: true }),
            });
        } finally {
            fs.rmSync(user_data_dir, { recursive: true, force: true });
        }
    }
    return outcomes;
}

/**
 * Gate 2 — a hot rollback journal is replayed by the production open.
 *
 * The child commits one value, opens a second `BEGIN IMMEDIATE`, writes a
 * different one, and aborts, so the parent inherits exactly what a force-quit
 * mid-write leaves: a main file whose pages are mid-update and a `-journal`
 * holding the undo. The parent then reopens through
 * `open_existing_sqlite_database` — the production non-creating read-write path,
 * not a bare `DatabaseSync` — and requires the committed value back, the
 * uncommitted one gone, the journal consumed, and the journal mode unchanged.
 *
 * The last of those is not a formality. A recovery that silently promoted the
 * database to WAL would satisfy every other assertion here while breaking the
 * coordination model that DELETE mode is the whole basis of.
 */
async function rollback_journal_gate() {
    const user_data_dir = make_user_data_dir('journal');
    try {
        const database_path = desktop_state_database_path(user_data_dir);
        const initialized = await initialize_sqlite_database_no_clobber(
            database_path,
            DESKTOP_STATE_IDENTITY,
            MIGRATION,
        );
        invariant(initialized.installed, 'rollback-journal gate could not install a fresh v1');
        await initialized.database.close();
        const settled_size = fs.statSync(database_path).size;

        await run_crashing_child('journal-crash', 'begin-immediate', user_data_dir);

        const journal_path = `${database_path}-journal`;
        invariant(fs.existsSync(journal_path),
            'the aborted writer left no hot journal, so no recovery was under test');
        invariant(!fs.existsSync(`${database_path}-wal`) && !fs.existsSync(`${database_path}-shm`),
            'a DELETE-mode database produced WAL sidecars');
        // A journal that merely exists proves nothing: SQLite leaves one behind
        // after an ordinary abort too, with no dirty pages in the main file to
        // undo, and the recovering open then has nothing to do. The witness that
        // the main file really is mid-update is that it *grew* while the aborted
        // transaction was open — the child shrinks its page cache so that the
        // uncommitted rows spill into the database file rather than sitting in
        // memory. Without this, every assertion below would pass over a database
        // that was never damaged in the first place.
        const journal_size = fs.statSync(journal_path).size;
        const crashed_size = fs.statSync(database_path).size;
        invariant(crashed_size > settled_size,
            'the crashed writer never spilled dirty pages, so nothing needed undoing');

        const opened = await open_complete_v1(database_path);
        try {
            const mark = opened.database
                .prepare('SELECT store_updated_at_ms AS mark FROM state_meta WHERE singleton = 1')
                .get()?.mark;
            invariant(Number(mark) === COMMITTED_MARK,
                `recovered value is ${String(mark)}, not the committed one`);
            invariant(Number(mark) !== ROLLED_BACK_MARK,
                'the uncommitted write survived the rollback journal');
            // The uncommitted schema change is the second, independent witness. A
            // rollback that restored the counter but left the scratch table would
            // be a partial undo, and `validate_sqlite_file_state_database` above
            // does not reject unexpected tables.
            const survivor = opened.database.prepare(
                "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'gate_scratch'",
            ).get()?.count;
            invariant(Number(survivor) === 0,
                'an uncommitted schema change survived the rollback journal');
        } finally {
            await opened.close();
        }
        invariant(!fs.existsSync(journal_path),
            'the hot journal was not consumed by the recovering open');
        return {
            replayed: true,
            journalBytes: journal_size,
            spilledBytes: crashed_size - settled_size,
            journalMode: 'delete',
        };
    } finally {
        fs.rmSync(user_data_dir, { recursive: true, force: true });
    }
}

/**
 * One sidecar case: seed the named residue, then require both production entry
 * points to refuse it and every seeded file to survive untouched.
 *
 * Both entry points, because they fail closed for different reasons and a
 * regression in either is a way in: `open_existing_sqlite_database` is what an
 * ordinary launch calls, and `initialize_sqlite_database_no_clobber` is what a
 * first run calls — and it is the one that would otherwise *initialize over* a
 * sidecar whose main file is missing, which is the failure the plan names
 * explicitly ("Never initialize when main is absent/empty but a sidecar or
 * candidate remains").
 *
 * Identity, not just presence, is compared afterwards: a file that was deleted
 * and rewritten byte-identically is still a destroyed inode, and for a journal
 * that would mean a destroyed undo log.
 */
async function sidecar_case(label, seed) {
    const user_data_dir = make_user_data_dir('sidecar');
    try {
        const database_path = desktop_state_database_path(user_data_dir);
        seed(database_path);
        const seeded = fs.readdirSync(state_directory(user_data_dir)).sort();
        const identities = seeded.map((name) => {
            const stat = fs.statSync(path.join(state_directory(user_data_dir), name), { bigint: true });
            return `${name}:${stat.dev}:${stat.ino}:${stat.size}`;
        });

        const failures = [];
        for (const attempt of [
            () => open_existing_sqlite_database(database_path),
            () => initialize_sqlite_database_no_clobber(
                database_path, DESKTOP_STATE_IDENTITY, MIGRATION,
            ),
        ]) {
            let opened;
            let failure;
            try {
                opened = await attempt();
            } catch (error) {
                failure = classified(error);
            }
            if (opened) {
                await (opened.database?.close?.() ?? opened.close());
                invariant(false, `${label}: a refused sidecar state was opened instead`);
            }
            failures.push(failure);
        }

        const after = fs.readdirSync(state_directory(user_data_dir)).sort();
        // The recovery gate directory is created by the inventory itself and is
        // not a basename member, so its appearance is expected; nothing that was
        // already there may leave or change.
        const after_identities = after
            .filter((name) => seeded.includes(name))
            .map((name) => {
                const stat = fs.statSync(path.join(state_directory(user_data_dir), name), { bigint: true });
                return `${name}:${stat.dev}:${stat.ino}:${stat.size}`;
            });
        invariant(after_identities.length === identities.length,
            `${label}: a seeded file disappeared`);
        for (const [index, identity] of identities.entries()) {
            invariant(after_identities[index] === identity,
                `${label}: a seeded file's identity or size changed`);
        }
        return { case: label, failures };
    } finally {
        fs.rmSync(user_data_dir, { recursive: true, force: true });
    }
}

/**
 * Gate 3 — sidecars, in both directions.
 *
 * The absent/zero-length-main cases are the "never initialize over recovery
 * evidence" rule. The last case is the journal-policy fence: a `-wal` beside a
 * *valid* main must be rejected before SQLite is allowed near the file, because
 * opening it is what would silently checkpoint a WAL this build never wrote and
 * cannot account for. That the rejection happened before SQLite opened is checked
 * observationally rather than taken on trust — no `-shm` was created, and the
 * `-wal`'s own inode and size are unchanged, neither of which survives a real
 * SQLite open of a WAL database.
 */
async function sidecar_gate() {
    const cases = [];
    cases.push(await sidecar_case('absent-main-with-journal', (database_path) => {
        fs.writeFileSync(`${database_path}-journal`, 'hot-journal-bytes', { mode: 0o600 });
    }));
    cases.push(await sidecar_case('zero-length-main-with-journal', (database_path) => {
        fs.writeFileSync(database_path, '', { mode: 0o600 });
        fs.writeFileSync(`${database_path}-journal`, 'hot-journal-bytes', { mode: 0o600 });
    }));
    cases.push(await sidecar_case('absent-main-with-wal-and-shm', (database_path) => {
        fs.writeFileSync(`${database_path}-wal`, 'wal-bytes', { mode: 0o600 });
        fs.writeFileSync(`${database_path}-shm`, 'shm-bytes', { mode: 0o600 });
    }));

    const user_data_dir = make_user_data_dir('policy');
    try {
        const database_path = desktop_state_database_path(user_data_dir);
        const initialized = await initialize_sqlite_database_no_clobber(
            database_path, DESKTOP_STATE_IDENTITY, MIGRATION,
        );
        await initialized.database.close();
        fs.writeFileSync(`${database_path}-wal`, 'wal-bytes', { mode: 0o600 });
        const wal_before = fs.statSync(`${database_path}-wal`, { bigint: true });

        let mismatch;
        let opened;
        try {
            opened = await open_existing_sqlite_database(database_path);
        } catch (error) {
            mismatch = classified(error);
        }
        if (opened) {
            await opened.close();
            invariant(false, 'a WAL sidecar beside a DELETE-mode database was accepted');
        }
        invariant(mismatch.operation === 'delete-journal-sidecar',
            `journal-policy rejection came from ${String(mismatch.operation)}, not the preflight`);
        invariant(!fs.existsSync(`${database_path}-shm`),
            'SQLite was reached: it created a -shm for the rejected WAL database');
        const wal_after = fs.statSync(`${database_path}-wal`, { bigint: true });
        invariant(wal_after.ino === wal_before.ino && wal_after.size === wal_before.size,
            'SQLite was reached: the rejected -wal was modified or replaced');
        cases.push({ case: 'wal-policy-mismatch', failures: [mismatch] });
    } finally {
        fs.rmSync(user_data_dir, { recursive: true, force: true });
    }
    return cases;
}

/** Every member the preservation gate must be able to account for afterwards.
 *  Names only, and only ours: the recovery-gate directory is coordination state,
 *  not a basename member, and never travels with a preserved set. */
function basename_members(user_data_dir) {
    const database_path = desktop_state_database_path(user_data_dir);
    const basename = path.basename(database_path);
    return fs.readdirSync(state_directory(user_data_dir))
        .filter((name) => name === basename || name.startsWith(`${basename}-`)
            || name.startsWith(`${basename}.init-candidate.`))
        .sort();
}

/** Every file anywhere under the state directory, so a member that moved into a
 *  recovery directory still counts as preserved rather than lost. */
function all_files_under(directory) {
    const found = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(current, entry.name));
            else found.push(entry.name);
        }
    };
    walk(directory);
    return found;
}

/**
 * The recovery directories a preserve has created, by name and by inode.
 *
 * The name carries the generation (`<basename>.recovery.<uuid>`), and the inode
 * is captured alongside it because a restart that happened to reuse a name would
 * still be a different directory. Both are compared; neither is printed.
 */
function recovery_directories(user_data_dir) {
    const marker = `${path.basename(desktop_state_database_path(user_data_dir))}.recovery.`;
    return fs.readdirSync(state_directory(user_data_dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(marker))
        .map((entry) => {
            const directory = path.join(state_directory(user_data_dir), entry.name);
            const stat = fs.statSync(directory, { bigint: true });
            return { name: entry.name, identity: `${stat.dev}:${stat.ino}`, directory };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The generation an interrupted preserve committed to, read the way the resume
 * path reads it.
 *
 * Once the blockade marker exists it *names* the recovery directory the move must
 * continue into, and that name is the authority — so it is read from the marker
 * rather than inferred from what happens to be on disk. Before the blockade is
 * written there is no such commitment yet, and the sole recovery directory the
 * crash left is the only continuation available; either way there must be exactly
 * one, because two would already be the stranded-evidence state this gate exists
 * to detect.
 */
function committed_recovery_generation(user_data_dir) {
    const database_path = desktop_state_database_path(user_data_dir);
    const gate_directory = path.join(
        path.dirname(database_path),
        `.${path.basename(database_path)}.recovery-gate`,
    );
    const observed = recovery_directories(user_data_dir);
    invariant(observed.length === 1,
        `the interrupted preserve left ${observed.length} recovery directories, not one`);
    const block_path = path.join(gate_directory, 'recovery-block.json');
    if (fs.existsSync(block_path)) {
        const block = JSON.parse(fs.readFileSync(block_path, 'utf8'));
        invariant(block.recoveryDirectoryName === observed[0].name,
            'the blockade marker names a different recovery directory than the one on disk');
    }
    // Whether there is any move left to continue. The last cut point fires *after*
    // the manifest was marked complete and the blockade removed, so by then the
    // move has genuinely finished and only the intent release was lost; the
    // desktop's own retry then correctly takes the fresh-preserve branch. Demanding
    // one generation there would be demanding a resume of something already done.
    // Read from the manifest rather than keyed to a cut-point name, so a boundary
    // that moves cannot silently re-scope the assertion.
    const manifest_path = path.join(observed[0].directory, 'manifest.json');
    const complete = fs.existsSync(manifest_path)
        && JSON.parse(fs.readFileSync(manifest_path, 'utf8')).state === 'complete';
    return { ...observed[0], complete };
}

/**
 * Gate 4 — a crash at every preservation cut point loses nothing and stays
 * resumable.
 *
 * The desktop's own `preserve_desktop_state_database` is what the child calls, so
 * the residue includes the stranded exclusive intent a force-quit really leaves,
 * and the parent's resume goes through the same attested path the recovery dialog
 * drives. Three properties are asserted, and the third is the one with teeth:
 * every member is still somewhere under the state directory after the crash, the
 * completed set holds exactly one copy of each member, and the retry *continued
 * the interrupted move* rather than starting a second one.
 *
 * That last property needs its own witness, because the first two do not imply
 * it: a clean restart — drop the blockade, inventory afresh, move everything into
 * a brand-new recovery directory — ends with exactly one copy of every member and
 * an absent canonical name, and satisfies them both. It is nonetheless the bug.
 * A restart re-derives the generation, so the directory the blockade marker
 * pointed at is abandoned mid-move: whatever had already been moved there is
 * stranded outside the manifest that describes it, and the set the plan requires
 * to be preserved as a unit is split across two generations with no record tying
 * them together. So the generation the interrupted move committed to is captured
 * *before* the retry and the finished set is required to live in that exact
 * directory, compared by inode as well as by name.
 *
 * Counting occurrences of each name rather than comparing sets is deliberate for
 * the second property: a move that left a member both at its source and in the
 * recovery directory would pass a set comparison, and that duplicate is precisely
 * the half-moved state the blockade marker exists to keep from being read as
 * settled.
 */
async function preservation_crash_gate() {
    const outcomes = [];
    for (const cut_point of SQLITE_PRESERVATION_DURABLE_CUT_POINTS) {
        const user_data_dir = make_user_data_dir('preserve');
        try {
            const database_path = desktop_state_database_path(user_data_dir);
            const initialized = await initialize_sqlite_database_no_clobber(
                database_path, DESKTOP_STATE_IDENTITY, MIGRATION,
            );
            await initialized.database.close();
            // A second member, so the per-member cut points have a member to be
            // between. With only the main file the whole loop runs once and the
            // "crashed between two members" boundaries — where a set can end up
            // half-moved — are never reached. A cold journal is the honest choice:
            // it is a real member of the basename set, the preserve moves it as
            // one unit with the main file, and preservation never opens SQLite, so
            // its contents are irrelevant to the property under test.
            fs.writeFileSync(`${database_path}-journal`, 'cold-journal-bytes', { mode: 0o600 });
            const members = basename_members(user_data_dir);
            invariant(members.length >= 2,
                `${cut_point}: fewer than two members, so no inter-member boundary is exercised`);

            await run_crashing_child('preserve-crash', cut_point, user_data_dir);

            // The crash really did strand the gate: `preserve_desktop_state_database`
            // removes the exclusive intent last of all, so its presence is proof the
            // interrupted flow is what the resume below is resuming — and proof that
            // an ordinary launch would now report the `interrupted` story rather than
            // spinning.
            const gate_directory = path.join(
                path.dirname(database_path),
                `.${path.basename(database_path)}.recovery-gate`,
            );
            invariant(fs.existsSync(path.join(gate_directory, 'exclusive-intent')),
                `${cut_point}: the crashed preserve left no exclusive intent behind`);

            const after_crash = all_files_under(state_directory(user_data_dir));
            for (const member of members) {
                invariant(after_crash.filter((name) => name === member).length >= 1,
                    `${cut_point}: a basename member was lost by the interrupted move`);
            }

            // The generation the interrupted move is committed to, read before the
            // retry can change anything. This is the whole basis of the
            // resume-not-restart assertion below.
            const committed = committed_recovery_generation(user_data_dir);

            // The attested retry. It must resume rather than restart, and it must
            // not need a second attempt to make progress.
            await preserve_desktop_state_database(user_data_dir, { allProcessesClosed: true });

            const after_resume = all_files_under(state_directory(user_data_dir));
            for (const member of members) {
                // Exactly one copy, not merely at least one. A member left both at
                // its source name and in the recovery directory is the half-moved
                // set the blockade marker exists to keep from being read as
                // settled, and a set comparison would call that success.
                const copies = after_resume.filter((name) => name === member).length;
                invariant(copies === 1,
                    `${cut_point}: a basename member exists ${copies} times after the resumed move`);
            }
            invariant(!fs.existsSync(database_path),
                `${cut_point}: the canonical name still exists after a completed preserve`);
            invariant(!fs.existsSync(`${database_path}-journal`),
                `${cut_point}: a sidecar was left detached from the preserved main file`);

            // Resume, not restart — asserted wherever there was still a move to
            // continue. A second generation directory means the retry abandoned the
            // one the blockade marker named and began a fresh move, stranding
            // whatever had already been moved into the first.
            //
            // Skipped only when the interrupted move had already reached `complete`:
            // the final cut point fires after the manifest was completed and the
            // blockade removed, so nothing remained to resume and a fresh generation
            // is the correct behavior there. The members are still accounted for by
            // the exactly-one-copy check above in that case.
            const settled = recovery_directories(user_data_dir);
            if (!committed.complete) {
                invariant(settled.length === 1,
                    `${cut_point}: the retry left ${settled.length} recovery generations,`
                    + ' so it restarted the move instead of resuming it');
                invariant(settled[0].name === committed.name
                    && settled[0].identity === committed.identity,
                    `${cut_point}: the finished set is in a different generation than the`
                    + ' one the interrupted move committed to');
                // And it is that directory the members actually landed in, so the
                // generation check above cannot be satisfied by an empty survivor.
                const preserved = fs.readdirSync(committed.directory).sort();
                for (const member of members) {
                    invariant(preserved.includes(member),
                        `${cut_point}: a member is missing from the committed generation directory`);
                }
            }
            // And the canonical name is reusable afterwards, which is the whole
            // purpose of the move: a preserve that leaves the app unable to start
            // fresh is a preserve that bricked it.
            const reinitialized = await initialize_sqlite_database_no_clobber(
                database_path, DESKTOP_STATE_IDENTITY, MIGRATION,
            );
            try {
                invariant(reinitialized.installed,
                    `${cut_point}: a fresh database could not be installed after preserving`);
            } finally {
                await reinitialized.database.close();
            }
            outcomes.push({
                cutPoint: cut_point,
                memberCount: members.length,
                // Reported rather than assumed, so the one cut point that legitimately
                // has nothing left to resume is visible in the output instead of
                // hidden behind a uniform `resumed: true`.
                resumed: !committed.complete,
                generations: settled.length,
            });
        } finally {
            fs.rmSync(user_data_dir, { recursive: true, force: true });
        }
    }
    return outcomes;
}

/**
 * Windows, and every other platform this build formally declines.
 *
 * `desktop_state_platform_support` is consulted before an open is attempted, so
 * the gate's job here is to prove the refusal is the *only* thing that happens:
 * the categorized failure is the production one, and nothing was created. A
 * packaged Windows build that quietly initialized a database it cannot flush
 * would pass every other gate in this file.
 */
async function platform_gate() {
    // Asked of a real userData tree — the same one inspected below — rather than
    // of nothing. The declaration decides platform-vs-location by comparing the
    // caller's directory against an unrelated control, so a caller that names no
    // directory gets no control and every refusal collapses into the
    // whole-platform story. Production always has a userData path here; the gate
    // supplies one so it exercises the same shape.
    const user_data_dir = make_user_data_dir('platform');
    try {
        const support = desktop_state_platform_support(user_data_dir);
        // A runner may state which answer it requires. Without this the Windows job
        // would pass by *skipping* every gate, which is indistinguishable from the
        // gates having run — and a Linux or macOS runner that silently started
        // declining the platform would pass for the same reason. The expectation
        // turns both into failures.
        const expected = process.env.TABLE_VIEWER_GATE_EXPECT_PLATFORM;
        if (expected !== undefined) {
            invariant(expected === (support.supported ? 'supported' : 'unsupported'),
                `this runner requires a ${expected} platform, but the build declares`
                + ` ${support.supported ? 'supported' : 'unsupported'}`);
        }
        if (support.supported) return { supported: true };
        const database_path = desktop_state_database_path(user_data_dir);
        // Asked before anything else touches this tree. The declaration is what
        // production consults, and the dialog it drives promises that nothing was
        // changed or moved — so on the declining path the state directory must
        // still be exactly as `make_user_data_dir` left it: empty. The probe
        // directory the declaration itself creates is removed before it returns.
        invariant(fs.readdirSync(state_directory(user_data_dir)).length === 0,
            'the platform declaration created something while answering');

        let failure;
        let result;
        try {
            result = await initialize_sqlite_database_no_clobber(
                database_path, DESKTOP_STATE_IDENTITY, MIGRATION,
            );
        } catch (error) {
            failure = classified(error);
        }
        if (result) {
            await result.database.close();
            invariant(false, 'a formally unsupported platform installed a database anyway');
        }
        invariant(failure.category === 'unsupported',
            `refusal category is ${failure.category}, not unsupported`);
        invariant(!fs.existsSync(database_path),
            'the refusal still left a database file behind');
        // The backend's own refusal, unlike the declaration above, runs after the
        // recovery gate has been created by its inventory. That is why the
        // declaration exists and why it is consulted first. Two things are then
        // required, and the second is the one that matters: nothing may sit beside
        // the database, and the gate's *interior* must be empty — no reader token,
        // no exclusive intent, no blockade. A refusal that stranded coordination
        // state would make every later launch report a recovery that never
        // happened, and on Windows this is the only substantive assertion the CI
        // job makes. Mirrors the pinned expectation in
        // src/test/sqlite-windows-fail-closed.test.ts, which allows the empty gate
        // scaffolding and nothing else.
        const gate_directory = path.join(
            path.dirname(database_path),
            `.${path.basename(database_path)}.recovery-gate`,
        );
        const beside = fs.readdirSync(path.dirname(database_path))
            .filter((name) => name !== path.basename(gate_directory));
        invariant(beside.length === 0,
            'the refusal left files beside the database that was never created');
        if (fs.existsSync(gate_directory)) {
            // Only `readers/`, and it must be empty. Descending is the whole point:
            // an earlier revision listed the parent and filtered the gate out by
            // name, so the gate's contents were never observed at all and a
            // stranded token inside it passed unnoticed.
            const gate_entries = fs.readdirSync(gate_directory).sort();
            invariant(gate_entries.length === 0
                || (gate_entries.length === 1 && gate_entries[0] === 'readers'),
                'the refusal left a marker in the coordination gate');
            const readers_directory = path.join(gate_directory, 'readers');
            if (fs.existsSync(readers_directory)) {
                const tokens = fs.readdirSync(readers_directory);
                invariant(tokens.length === 0,
                    `the refusal left ${tokens.length} reader tokens in the coordination gate`);
            }
        }
        // The declaration must name the *platform* stage, not the backend's
        // location stage. They select opposite stories, and the location story's
        // only advice — store the settings on an ordinary local disk — cannot help
        // anywhere on a platform that has no proven flush at all.
        invariant(support.failure.operation === 'platform-durability-unsupported',
            `the platform declaration reports ${String(support.failure.operation)},`
            + ' which the dialog tells as a fixable location problem');
        return { supported: false, declared: support.failure, refused: failure };
    } finally {
        fs.rmSync(user_data_dir, { recursive: true, force: true });
    }
}

/**
 * The child half. Reaches the requested cut point and dies there.
 *
 * `process.abort()` rather than `process.exit()` on purpose: exit runs teardown,
 * and SQLite's own `close` handlers running on the way out would produce a
 * *cleanly closed* database at a boundary that is supposed to look like a power
 * loss. Deliberately no `app.whenReady()` either — this process never exits
 * cleanly, so there is nothing to sequence against readiness, and skipping it
 * avoids starting GPU helpers that would outlive the abort.
 */
async function run_child(role, cut_point) {
    const user_data_dir = process.env.TABLE_VIEWER_GATE_USER_DATA;
    const database_path = desktop_state_database_path(user_data_dir);
    const abort_at = (event) => {
        if (event === cut_point) process.abort();
    };
    if (role === 'initialize-crash') {
        const result = await initialize_sqlite_database_no_clobber(
            database_path,
            DESKTOP_STATE_IDENTITY,
            MIGRATION,
            { onEvent: abort_at },
        );
        await result.database.close();
        return;
    }
    if (role === 'journal-crash') {
        const opened = await open_existing_sqlite_database(database_path);
        const mark = opened.database
            .prepare('UPDATE state_meta SET store_updated_at_ms = ? WHERE singleton = 1');
        mark.run(COMMITTED_MARK);
        // A journal is only *hot* if the main file was already modified when the
        // process died — otherwise nothing needs undoing, the next open finds a
        // consistent main file, and the gate would prove nothing while appearing
        // to pass. SQLite writes dirty pages back to the main file only when its
        // page cache overflows, so the cache is shrunk to a handful of pages and
        // the transaction is made large enough to overflow it many times over.
        // The scratch table is created *inside* the transaction, so a correct
        // rollback erases it along with everything else.
        opened.database.exec('PRAGMA cache_size = 10');
        opened.database.exec('BEGIN IMMEDIATE');
        mark.run(ROLLED_BACK_MARK);
        opened.database.exec('CREATE TABLE gate_scratch (id INTEGER PRIMARY KEY, filler TEXT)');
        const filler = 'x'.repeat(512);
        const insert = opened.database.prepare('INSERT INTO gate_scratch VALUES (?, ?)');
        for (let index = 0; index < 4000; index += 1) insert.run(index, filler);
        // Inside an open write transaction, with a hot journal and a main file
        // carrying pages that must be undone.
        process.abort();
    }
    if (role === 'preserve-crash') {
        await preserve_desktop_state_database(
            user_data_dir,
            { allProcessesClosed: true },
            { onEvent: abort_at },
        );
        return;
    }
    throw new Error(`unknown gate role ${role}`);
}

async function main() {
    const role = process.env[ROLE_VARIABLE];
    if (role) {
        try {
            await run_child(role, process.env[CUT_POINT_VARIABLE]);
            // Reaching here means the cut point never fired. Exit 0 so the parent
            // reports "exited cleanly instead of aborting" — a gate that never ran
            // must fail loudly rather than pass vacuously.
            //
            // `process.exit`, not `app.exit`: the child runs under
            // ELECTRON_RUN_AS_NODE, where there is no `app` to call.
            process.exit(0);
        } catch (error) {
            // The same reduction the parent applies, and for the same reason: this
            // text is forwarded to the parent, which prints it into a public CI
            // log. A raw error message here would carry the temp path.
            write_output(process.stderr, `${safe_failure_text(error)}\n`);
            process.exit(2);
        }
    }

    let exit_code = 0;
    try {
        await app.whenReady();
        const platform = await platform_gate();
        // On a platform this build formally declines there is no database to
        // crash, recover, or preserve; the refusal *is* the whole contract, and
        // running the other gates would only prove that a refused open refuses.
        const report = platform.supported
            ? {
                platform,
                initializationCrash: await initialization_crash_gate(),
                rollbackJournal: await rollback_journal_gate(),
                sidecar: await sidecar_gate(),
                preservationCrash: await preservation_crash_gate(),
            }
            : { platform };
        write_output(process.stdout, `${JSON.stringify(report)}\n`);
    } catch (error) {
        exit_code = 1;
        try {
            // Never `error.message`: see `safe_failure_text`. This pipe is a public
            // CI log, and the errors most likely to arrive here are the raw errnos
            // that carry a path in their message.
            write_output(process.stderr, `${safe_failure_text(error)}\n`);
        } catch {
            // A closed diagnostic pipe must not keep the Electron process alive.
        }
    } finally {
        app.exit(exit_code);
    }
}

void main();
