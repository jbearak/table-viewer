// Windows durability verification probe: an *investigation*, not a gate.
//
// Production ships the SQLite backend on Windows, and
// `assert_sqlite_directory_durability_supported` (src/sqlite-open-recovery.ts)
// skips the directory flush there rather than refusing, because Node exposes no
// primitive on NTFS to make a directory-entry change durable — the same posture
// SQLite's own Windows VFS takes. That skip is an assumption, and this probe is
// what tests it: it runs on the CI Windows runners inside the packaged Electron
// runtime and reports what that runtime can actually do on the volume it is
// standing on.
//
// It establishes facts. It never asserts a desired answer. "This primitive is not
// reachable" is a first-class result and exits 0; only a malfunction of the probe
// itself — a temp directory that cannot be made, a child that cannot be spawned,
// an unexpected throw — exits non-zero. A probe that failed the build on an
// unproven primitive would pressure whoever is reading it into finding a way to
// make it pass, which is the opposite of what it is for.
//
// ---------------------------------------------------------------------------
// THE DECISION TREE THIS PROBE FEEDS
// ---------------------------------------------------------------------------
//
// Windows ships the state backend either way. What this probe (and the kill-crash
// matrix it is the skeleton of) decides is what the durability claim in
// desktop/README.md is allowed to say:
//
//   Gate VERIFIES  — a reachable primitive is documented to make directory-entry
//                    changes durable, *and* the kill-crash matrix passes over
//                    every durable cut point on NTFS. The Windows durability
//                    claim then rests on exactly the evidence macOS's rests on: a
//                    written contract plus crash verification against the packaged
//                    runtime.
//
//   Gate CANNOT VERIFY — the claim stays where it is: no directory sync on a
//                    platform with no primitive for one, matching SQLite itself,
//                    with the uncovered cut points recorded as pending rather
//                    than assumed to pass.
//
// Neither branch permits silent weakening. In particular: a `verified` verdict
// from a *partial* run is not verification. The report names which cut points
// were covered and which are still pending precisely so a partial run can never
// be mistaken for a complete one, and the verdict is derived from those
// observations rather than written down anywhere.
//
// Scope today: the primitive survey plus one or two representative cut points.
// The remaining cut points are listed in the output as `pending`; adding them is
// mechanical (extend `REPRESENTATIVE_CUT_POINTS`).
//
// ---------------------------------------------------------------------------
//
// Bundled by desktop/build.mjs into dist/runtime-probes/, alongside
// desktop/packaged-recovery-gate.mjs and for the same reasons: it imports the
// real `src/` durability assertion and initialization code rather than
// transcribing it, and it is kept out of dist/desktop so electron-builder cannot
// ship a driver whose children call `process.abort()`.
//
// Output is counts, categories, booleans, and sanitized names. Never a path, a
// filename, a SQL statement, or any stored value: this runs in CI, where its
// stdout is a public artifact.
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import {
    SQLITE_INITIALIZATION_DURABLE_CUT_POINTS,
    SQLITE_PRESERVATION_DURABLE_CUT_POINTS,
    assert_sqlite_directory_durability_supported,
    initialize_sqlite_database_no_clobber,
} from '../src/sqlite-open-recovery';
import { SqliteFileStateError } from '../src/sqlite-file-state-errors';
import {
    DESKTOP_STATE_IDENTITY,
    desktop_state_database_path,
    desktop_state_diagnostics_directory,
} from './main/desktop-state-database';

const ROLE_VARIABLE = 'TABLE_VIEWER_DURABILITY_ROLE';
const CUT_POINT_VARIABLE = 'TABLE_VIEWER_DURABILITY_CUT_POINT';
const USER_DATA_VARIABLE = 'TABLE_VIEWER_DURABILITY_USER_DATA';
const MIGRATION = Object.freeze({
    appliedAtMs: 1_700_000_000_000,
    appVersion: 'windows-durability-probe',
});

/**
 * The cut points this run actually attempts.
 *
 * Two, deliberately, and chosen to straddle the boundary under investigation:
 * `candidate-after-schema` sits before any directory flush is required, and
 * `candidate-after-directory-flush` sits immediately after the one primitive
 * Windows has no proven form of. Extending this array to the full matrix is the
 * only change the kill-crash work needs here — everything downstream, including
 * the pending list and the verdict, is derived from it.
 */
const REPRESENTATIVE_CUT_POINTS = Object.freeze([
    'candidate-after-schema',
    'candidate-after-directory-flush',
]);

/** Every durable cut point a complete verification would have to cover. The
 *  pending list is this minus what was attempted, so a cut point added to the
 *  protocol shows up as pending here without anyone remembering to list it. */
const ALL_DURABLE_CUT_POINTS = Object.freeze([
    ...SQLITE_INITIALIZATION_DURABLE_CUT_POINTS,
    ...SQLITE_PRESERVATION_DURABLE_CUT_POINTS,
]);

/**
 * The probe itself malfunctioned — as distinct from having measured something
 * unwelcome.
 *
 * Its own class for the same reason `packaged-recovery-gate.mjs` has
 * `GateAssertionError`: the difference is a privacy boundary, not a stylistic
 * one. Every message raised this way is composed in this file out of primitive
 * names, counts, and booleans, so it is safe to print verbatim; an arbitrary
 * caught value is not, and a `NodeJS.ErrnoException`'s `.message` embeds an
 * absolute path.
 */
class ProbeMalfunctionError extends Error {
    constructor(message) {
        super(`windows durability probe malfunctioned: ${message}`);
        this.name = 'ProbeMalfunctionError';
    }
}

function write_output(stream, text) {
    // Synchronous, like the other drivers: it flushes before app.exit() and fails
    // immediately rather than silently if the pipe is already gone.
    fs.writeSync(stream.fd, text);
}

/**
 * The one function allowed to turn a thrown value into text on a public pipe.
 *
 * Same three-case reduction as `packaged-recovery-gate.mjs`'s `safe_failure_text`,
 * and for the same reason: the failure path is public too, and it is the one that
 * runs when something unexpected happened. A raw `throw` from an unwrapped `fs`
 * or `spawn` call arrives here as a `NodeJS.ErrnoException` whose `.message`
 * embeds an absolute path, so printing `error.message` unconditionally would leak
 * exactly what the header forbids.
 */
function safe_failure_text(error) {
    if (error instanceof ProbeMalfunctionError) return error.message;
    if (error instanceof SqliteFileStateError) {
        return `windows durability probe malfunctioned: category=${error.category}`
            + `${error.metadata.operation ? ` operation=${error.metadata.operation}` : ''}`;
    }
    return `windows durability probe malfunctioned: unclassified ${error_kind(error)}`
        + ` code=${error_code(error)}`;
}

/** An errno-style code, or `none`. A short constant (`EPERM`, `EISDIR`) never
 *  carries a path; the message it came from always does, so only this is kept. */
function error_code(error) {
    return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)
        ? error.code
        : 'none';
}

function error_kind(error) {
    return typeof error?.constructor?.name === 'string'
        && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name)
        ? error.constructor.name
        : typeof error;
}

/**
 * Run one measurement and record its outcome as data.
 *
 * A throw from `action` is a *finding* — "this primitive is not reachable, with
 * this errno" — not a probe failure, so it is captured rather than propagated.
 * That is the whole discipline of this file: the only things that escape are
 * malfunctions of the harness, raised deliberately as `ProbeMalfunctionError`.
 * `action` returns extra observation fields, which are merged in.
 */
function measure(name, action) {
    try {
        const detail = action() ?? {};
        return { name, reachable: true, ...detail };
    } catch (error) {
        if (error instanceof ProbeMalfunctionError) throw error;
        return { name, reachable: false, errorCode: error_code(error), errorKind: error_kind(error) };
    }
}

/** A measurement that was not attempted because a prerequisite one failed.
 *  Reported explicitly rather than omitted: a missing key reads as an oversight,
 *  and "we could not even try" is a different fact from "we tried and it failed". */
function not_attempted(name, because) {
    return { name, reachable: false, notAttempted: true, blockedBy: because };
}

function make_scratch_directory(label) {
    try {
        return fs.mkdtempSync(path.join(tmpdir(), `table-viewer-windurability-${label}-`));
    } catch (error) {
        // A temp directory that cannot be created is a broken runner, not a
        // finding about Windows durability.
        throw new ProbeMalfunctionError(
            `scratch directory could not be created (code=${error_code(error)})`,
        );
    }
}

/**
 * What the volume under the scratch directory actually is.
 *
 * Reported, never assumed. The whole reason to run on a real runner is that the
 * answer can be ReFS, a network redirector, or a dev-drive filesystem, and every
 * durability claim below is a claim about a specific filesystem. `fsutil` is
 * tried first and PowerShell's `Get-Volume` second, because `fsutil fsinfo` is
 * refused on some volume types.
 *
 * The output is matched against a strict token pattern before it is reported: the
 * command's stdout is untrusted text that can contain a volume label or a path,
 * and only a short alphanumeric filesystem name may reach the public log.
 */
function filesystem_name(directory) {
    const drive = path.parse(path.resolve(directory)).root.replace(/\\$/, '');
    const token = (value) => {
        const match = /^[A-Za-z][A-Za-z0-9]{0,15}$/.exec((value ?? '').trim());
        return match ? match[0] : undefined;
    };
    const run = (file, args) => {
        try {
            const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
            return result.status === 0 ? (result.stdout ?? '') : '';
        } catch {
            // A missing or refused helper is not a probe malfunction; it just
            // means this route did not answer.
            return '';
        }
    };
    const fsutil = /File System Name\s*:\s*(\S+)/i
        .exec(run('fsutil', ['fsinfo', 'volumeinfo', drive]));
    const from_fsutil = token(fsutil?.[1]);
    if (from_fsutil) return { filesystem: from_fsutil, source: 'fsutil' };
    const from_powershell = token(run('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Volume -FilePath '${drive}\\').FileSystemType`,
    ]));
    if (from_powershell) return { filesystem: from_powershell, source: 'get-volume' };
    return { filesystem: 'unknown', source: 'none' };
}

/**
 * The primitive survey: what this runtime can reach on this volume.
 *
 * Each entry is an observation with a name, a boolean, and — when it failed — the
 * errno that explains it. Nothing here decides anything; the verdict is computed
 * from these afterwards.
 */
function survey_primitives(scratch) {
    const observations = [];
    const at = (name) => path.join(scratch, name);

    // 1. Can a directory be opened at all? On win32 `CreateFile` needs
    //    FILE_FLAG_BACKUP_SEMANTICS to return a directory handle, and libuv's
    //    `uv_fs_open` does not set it — so this is expected to fail, and the
    //    errno it fails with is the first fact the whole question turns on. If it
    //    fails, no directory-level flush is reachable at all from plain `fs`.
    const directory_open = measure('directory-open', () => {
        const descriptor = fs.openSync(scratch, 'r');
        fs.closeSync(descriptor);
    });
    observations.push(directory_open);

    // 2. `fsync` on that directory descriptor — the POSIX primitive the storage
    //    protocol is built on. Only attempted if a descriptor is obtainable.
    observations.push(directory_open.reachable
        ? measure('directory-fsync', () => {
            const descriptor = fs.openSync(scratch, 'r');
            try {
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
        })
        : not_attempted('directory-fsync', 'directory-open'));

    // 3. `fsync` on a *file* descriptor — this is `FlushFileBuffers`, and it is
    //    the one primitive expected to work. What it guarantees is the crux; see
    //    `derive_guarantees`.
    observations.push(measure('file-fsync', () => {
        fs.writeFileSync(at('flush-probe'), 'x', { mode: 0o600 });
        const descriptor = fs.openSync(at('flush-probe'), 'r+');
        try {
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    }));

    // 4. `fdatasync`, reported separately: on Windows libuv maps it to the same
    //    `FlushFileBuffers`, so a difference here would be news.
    observations.push(measure('file-fdatasync', () => {
        fs.writeFileSync(at('fdatasync-probe'), 'x', { mode: 0o600 });
        const descriptor = fs.openSync(at('fdatasync-probe'), 'r+');
        try {
            fs.fdatasyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    }));

    // 5. A write-through open, which is the only other route to durable metadata
    //    without a native addon: libuv maps `UV_FS_O_DSYNC` to
    //    `FILE_FLAG_WRITE_THROUGH`. Both halves are reported — whether the
    //    constant is even exposed on this build, and whether an open with it
    //    succeeds — because a constant that exists but is silently ignored and a
    //    constant that is absent are different findings.
    for (const flag of ['O_DSYNC', 'O_SYNC', 'O_DIRECT']) {
        const value = fs.constants[flag];
        const name = `open-${flag.toLowerCase()}`;
        if (typeof value !== 'number') {
            observations.push({ name, reachable: false, constantExposed: false });
            continue;
        }
        // `constantExposed` is merged *outside* `measure`, not returned from inside
        // it. `measure` builds its own object on the failure path and drops whatever
        // `action` was going to return, so an exposed constant whose open failed
        // reported no `constantExposed` at all — collapsing the more interesting of
        // the three findings ("the constant exists and is rejected anyway", which is
        // the shape a silently-ignored write-through flag would take) into an absent
        // key indistinguishable from an oversight. All three shapes are now stated:
        // absent, exposed-and-reachable, exposed-and-refused.
        observations.push({
            ...measure(name, () => {
                const descriptor = fs.openSync(
                    at(`${flag.toLowerCase()}-probe`),
                    fs.constants.O_WRONLY | fs.constants.O_CREAT | value,
                    0o600,
                );
                try {
                    fs.writeSync(descriptor, 'x');
                } finally {
                    fs.closeSync(descriptor);
                }
            }),
            constantExposed: true,
        });
    }

    // 6. Rename over an existing target. The storage protocol installs a
    //    validated candidate by renaming it onto the canonical name, so whether
    //    that replaces atomically matters as much as whether it is durable.
    observations.push(measure('rename-over-existing', () => {
        fs.writeFileSync(at('rename-source'), 'source', { mode: 0o600 });
        fs.writeFileSync(at('rename-target'), 'target', { mode: 0o600 });
        fs.renameSync(at('rename-source'), at('rename-target'));
        return {
            sourceGone: !fs.existsSync(at('rename-source')),
            targetPresent: fs.existsSync(at('rename-target')),
        };
    }));

    // 7. Rename onto a target that another handle has open. On POSIX this is
    //    unremarkable; on Windows a handle without FILE_SHARE_DELETE blocks it,
    //    and the install protocol runs while readers may hold the canonical file.
    observations.push(measure('rename-over-open-target', () => {
        fs.writeFileSync(at('busy-source'), 'source', { mode: 0o600 });
        fs.writeFileSync(at('busy-target'), 'target', { mode: 0o600 });
        const descriptor = fs.openSync(at('busy-target'), 'r');
        try {
            fs.renameSync(at('busy-source'), at('busy-target'));
        } finally {
            fs.closeSync(descriptor);
        }
    }));

    // 8. Unlink, plain and with the file open. The preserve protocol removes a
    //    member's source after installing it in the recovery directory, and on
    //    Windows an open handle changes what unlink means.
    observations.push(measure('unlink', () => {
        fs.writeFileSync(at('unlink-probe'), 'x', { mode: 0o600 });
        fs.unlinkSync(at('unlink-probe'));
        return { gone: !fs.existsSync(at('unlink-probe')) };
    }));
    observations.push(measure('unlink-open-file', () => {
        fs.writeFileSync(at('unlink-open-probe'), 'x', { mode: 0o600 });
        const descriptor = fs.openSync(at('unlink-open-probe'), 'r');
        try {
            fs.unlinkSync(at('unlink-open-probe'));
        } finally {
            fs.closeSync(descriptor);
        }
        // Whether the name disappears immediately or lingers until the last
        // handle closes is itself the observation, so it is reported rather than
        // required either way.
        return { nameGoneWhileOpen: !fs.existsSync(at('unlink-open-probe')) };
    }));

    return observations;
}

/**
 * What production's own rule says today, obtained by *running* it.
 *
 * Not a re-test of `platform === 'win32'`. A second copy of the predicate keeps
 * answering confidently after the original changes, and this probe exists to
 * inform a decision about that original — so it asks it directly. Recording it
 * keeps the report honest about what the shipped build actually does with this
 * directory, so a reader cannot infer the answer from the primitive survey alone.
 */
function production_rule(scratch) {
    try {
        assert_sqlite_directory_durability_supported(scratch);
        return { declines: false };
    } catch (error) {
        if (error instanceof SqliteFileStateError) {
            return {
                declines: true,
                category: error.category,
                operation: error.metadata.operation,
            };
        }
        return { declines: true, category: 'unclassified', errorCode: error_code(error) };
    }
}

/**
 * What each reachable primitive actually promises — and, more importantly, what
 * it does not.
 *
 * Conservative on purpose. `FlushFileBuffers` on a file handle flushes that
 * file's data and its metadata, and on NTFS that includes the file's directory
 * entry, so it does cover *creation* durability. It says nothing whatsoever about
 * the ordering of a later rename or unlink against other metadata, and the
 * storage protocol depends on rename and unlink ordering, not only on creation.
 * That gap is the reason the platform is declined, and stating it here is what
 * keeps an encouraging `file-fsync: reachable` from being read as a green light.
 *
 * Derived from the observations, so a primitive that turned out unreachable does
 * not get a guarantee paragraph describing what it would have promised.
 */
function derive_guarantees(observations, filesystem) {
    const reachable = (name) => observations.find((entry) => entry.name === name)?.reachable === true;
    const guarantees = [];
    const on_ntfs = filesystem.toUpperCase() === 'NTFS';

    if (reachable('file-fsync') || reachable('file-fdatasync')) {
        guarantees.push({
            primitive: 'FlushFileBuffers (fs.fsyncSync on a file descriptor)',
            guarantees: [
                "the file's own data and metadata are written through to the volume",
                on_ntfs
                    ? "on NTFS this includes the file's directory entry, so *creation* of that file is durable"
                    : `the directory-entry consequence documented for NTFS is not established on ${filesystem}`,
            ],
            doesNotGuarantee: [
                'any ordering between a later rename and other metadata updates',
                'any ordering between a later unlink and other metadata updates',
                'that a directory whose entries changed by rename or unlink is itself durable',
                'anything at all about a volume with write caching and no barrier support',
            ],
        });
    }
    if (reachable('directory-fsync')) {
        guarantees.push({
            primitive: 'fsync on a directory descriptor',
            guarantees: [
                'the call returned without error on this volume',
            ],
            doesNotGuarantee: [
                'that the call did anything: a silently-successful no-op and a real'
                + ' flush are indistinguishable from the return value alone, so this'
                + ' observation on its own is not evidence of durability',
                'anything until the kill-crash matrix below covers every cut point',
            ],
        });
    }
    if (reachable('open-o_dsync')) {
        guarantees.push({
            primitive: 'O_DSYNC open (FILE_FLAG_WRITE_THROUGH)',
            guarantees: [
                "writes to that handle are written through rather than left in the cache",
            ],
            doesNotGuarantee: [
                'anything about metadata operations performed through other handles',
                'rename or unlink ordering, which is what the storage protocol needs',
            ],
        });
    }
    guarantees.push({
        primitive: 'the crux',
        guarantees: [],
        doesNotGuarantee: [
            'no primitive surveyed here establishes rename or unlink *ordering*.'
            + ' Creation durability is necessary and not sufficient: the install and'
            + ' preserve protocols both depend on a rename or an unlink being durable'
            + ' relative to the flushes around it, and that is the property the'
            + ' kill-crash matrix — not this survey — has to establish.',
        ],
    });
    return guarantees;
}

/**
 * Run one child of this same bundle under Electron, at one cut point, and see
 * what happened.
 *
 * The methodology is `packaged-recovery-gate.mjs`'s, with one deliberate
 * difference: there, a child that exits instead of aborting fails the gate,
 * because a cut point that was never reached means the gate proved nothing. Here
 * it is a *finding* — initialization can fail closed long before any cut point,
 * for example on a filesystem that rejects a flush it was asked to perform, and
 * reporting that honestly is the job. So every terminal outcome is classified and
 * returned; only a spawn failure is a malfunction.
 *
 * Nothing waits a fixed delay: the child's death is the observable event. The one
 * timer here is a stuck-process backstop, orders of magnitude above a healthy
 * child, and it reports rather than passing.
 */

/** Backstop for a child that neither aborts nor exits; the same limit and the same
 *  reasoning as `packaged-recovery-gate.mjs`'s. A healthy child dies in
 *  milliseconds. */
const CHILD_STUCK_LIMIT_MS = 120_000;

function run_cut_point_child(cut_point, user_data_dir) {
    // `__filename`, not `process.argv[1]`. Electron does not reserve argv[1] for
    // the script: it holds whatever the first argument happened to be, so under the
    // `--no-sandbox` a headless runner requires, argv[1] is the literal string
    // `--no-sandbox` and the child was spawned with no script at all. It then died
    // by a signal having created nothing — and the old classifier, which inferred
    // an abort from "not 0 and not 2", accepted that as a cut point reached. The
    // whole survey measured nothing while the report still read as a run that
    // happened. `packaged-recovery-gate.mjs` hit this exact defect first and records
    // it at length; this is the same fix.
    //
    // `desktop/build.mjs` bundles this to CJS, so `__filename` is the real path of
    // the bundled file that is executing — which is what the child must re-run.
    // `import.meta.url` would not work: esbuild replaces `import.meta` with an empty
    // object in that output.
    const script = __filename;
    return new Promise((resolve, reject) => {
        // `--no-sandbox` is deliberately *not* forwarded. The parent needs it as a
        // real Electron app; the child is plain Node (see `ELECTRON_RUN_AS_NODE`),
        // and Node rejects Chromium flags outright with `bad option: --no-sandbox`.
        const child = spawn(process.execPath, [script], {
            env: {
                ...process.env,
                [ROLE_VARIABLE]: 'initialize-crash',
                [CUT_POINT_VARIABLE]: cut_point,
                [USER_DATA_VARIABLE]: user_data_dir,
                // Run the child as plain Node inside the Electron binary. What is
                // under test is the *embedded runtime* — its node:sqlite, its fsync,
                // its rename — surviving a kill at a durable boundary, and none of
                // that needs Chromium, a window, or a desktop session. Booting the
                // browser stack anyway made the equivalent gate child hang on a
                // headless runner with no D-Bus for it to reach, and a hung child
                // hung the parent with it.
                ELECTRON_RUN_AS_NODE: '1',
            },
            // The child writes nothing to stdout; its stderr carries its own
            // already-reduced explanation of why it stopped short, which is the
            // most informative part of a not-reached result.
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        // A child that neither aborts nor exits would otherwise hang this promise,
        // and with it the job, until the runner's own limit killed it with no
        // diagnosis. Reported as an outcome rather than thrown: a stuck child is a
        // finding about this runner, and — unlike the old inferred abort — it cannot
        // be counted toward `complete`.
        const stuck = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({
                outcome: 'exited-unexpectedly',
                exitCode: 'none',
                signal: 'stuck',
                reportedSomething: stderr.trim().length > 0,
            });
        }, CHILD_STUCK_LIMIT_MS);
        stuck.unref?.();
        const settle = (finish) => (...args) => {
            clearTimeout(stuck);
            finish(...args);
        };
        child.on('error', settle((error) => {
            reject(new ProbeMalfunctionError(
                `cut-point child could not be spawned (code=${error_code(error)})`,
            ));
        }));
        child.on('exit', settle((code, signal) => {
            if (code === 0) {
                resolve({ outcome: 'completed-without-reaching-cut-point' });
                return;
            }
            if (code === 2) {
                resolve({ outcome: 'failed-before-cut-point', reason: stderr.trim() || 'unreported' });
                return;
            }
            // An abort is *positively* identified, never inferred from "not one of
            // the codes above". `process.abort()` raises SIGABRT, which on POSIX
            // arrives as the signal and on Windows surfaces as the CRT's abort exit
            // code (3) or as STATUS_FATAL_APP_EXIT (0xC0000409) when the runtime
            // takes the fast-fail path instead.
            //
            // Everything else is an unexplained death — an Electron launch failure,
            // an OOM kill, a crash before the cut point that never reached the
            // classified exit(2) — and it must not be filed as a covered cut point.
            // `survey_cut_points` derives `complete` from every entry having
            // aborted, and `derive_verdict` derives `verified` from `complete`, so
            // calling an unexplained death an abort is a path from a broken child to
            // a claim that Windows durability was verified. Harmless only while
            // `pending` is non-empty; the moment REPRESENTATIVE_CUT_POINTS becomes
            // the full matrix it is not, and that extension is the stated next step.
            const aborted = signal === 'SIGABRT' || code === 3 || code === 0xC0000409;
            resolve(aborted
                ? { outcome: 'aborted-at-cut-point', signal: signal ?? 'none' }
                : {
                    outcome: 'exited-unexpectedly',
                    exitCode: typeof code === 'number' ? code : 'none',
                    signal: signal ?? 'none',
                    // The code and the signal, and a *boolean* for the stderr —
                    // never the text. The `failed-before-cut-point` branch above can
                    // forward its stderr because the child wrote it through its own
                    // `safe_failure_text`. Nothing has reduced the output of a child
                    // that died before reaching that handler: an Electron launch
                    // failure or a raw errno stack carries absolute paths, and this
                    // report is a public CI artifact.
                    reportedSomething: stderr.trim().length > 0,
                });
        }));
    });
}

/**
 * The kill-crash skeleton: representative cut points only, with the rest named.
 *
 * Every entry records what the child did and what residue it left, as counts. No
 * assertion is made about the residue — this run is not a verification, and
 * dressing it up as one is exactly the silent weakening the decision tree
 * forbids. The `pending` list beside it is what stops a reader from mistaking two
 * covered cut points for a matrix.
 *
 * `complete` requires every attempted cut point to have *aborted*, positively
 * identified as such by `run_cut_point_child`. An entry appears in `covered`
 * whatever the child did, because an attempt that exited cleanly or died
 * unexplained is a finding worth printing — but only an abort counts toward the
 * matrix, so a run full of `exited-unexpectedly` children reports them and stays
 * short of `complete`.
 */
async function survey_cut_points() {
    const covered = [];
    for (const cut_point of REPRESENTATIVE_CUT_POINTS) {
        const user_data_dir = make_scratch_directory('cutpoint');
        try {
            const state_directory = desktop_state_diagnostics_directory(user_data_dir);
            fs.mkdirSync(state_directory, { recursive: true, mode: 0o700 });
            const child = await run_cut_point_child(cut_point, user_data_dir);
            // Counts, not names: a residue entry name is a filename.
            const residue = fs.readdirSync(state_directory).length;
            covered.push({ cutPoint: cut_point, ...child, residueEntryCount: residue });
        } finally {
            fs.rmSync(user_data_dir, { recursive: true, force: true });
        }
    }
    const pending = ALL_DURABLE_CUT_POINTS.filter(
        (cut_point) => !REPRESENTATIVE_CUT_POINTS.includes(cut_point),
    );
    return {
        covered,
        pending,
        complete: pending.length === 0
            && covered.every((entry) => entry.outcome === 'aborted-at-cut-point'),
    };
}

/**
 * The verdict, computed from the observations above and from nothing else.
 *
 * Three outcomes, and two of them are fine:
 *
 *  - `not-verified` — a primitive the protocol requires was observed to be out of
 *    reach. This is a *result*. The Windows durability claim stays at SQLite's own
 *    posture and the job does not fail.
 *  - `inconclusive` — nothing ruled it out, but the evidence is not complete:
 *    typically because the cut-point matrix is still partial, which it is by
 *    design in this scope. Also not a failure.
 *  - `verified` — every required primitive is reachable *and* the kill-crash
 *    matrix is complete and every cut point aborted where it should. Only then may
 *    the Windows durability claim be raised to macOS's, and only together with a
 *    written durability contract.
 *
 * Note what `verified` costs: `cutPoints.complete` is false whenever anything is
 * pending, so a partial run cannot reach it however encouraging the survey looks.
 */
function derive_verdict(observations, cut_points) {
    const reachable = (name) => observations.find((entry) => entry.name === name)?.reachable === true;
    // The protocol's requirement, stated positively: directory-entry changes must
    // be flushable. Nothing else in the survey substitutes for it — file flushes
    // cover creation only, and write-through covers one handle's data.
    const directory_flush_reachable = reachable('directory-open') && reachable('directory-fsync');
    if (!directory_flush_reachable) {
        return {
            verdict: 'not-verified',
            because: 'no directory-entry flush primitive is reachable from the packaged'
                + ' runtime without a native addon, so rename and unlink ordering cannot'
                + ' be made durable',
        };
    }
    if (!cut_points.complete) {
        return {
            verdict: 'inconclusive',
            because: 'a directory-entry flush primitive is reachable, but the kill-crash'
                + ' matrix is partial: a reachable call is not evidence that it flushed'
                + ' anything, and only the full cut-point matrix can supply that',
        };
    }
    return {
        verdict: 'verified',
        because: 'every required primitive is reachable and every durable cut point was'
            + ' covered by a kill-crash run',
    };
}

/**
 * The child half. Drives production initialization and dies at the named cut
 * point.
 *
 * `process.abort()` rather than `process.exit()`, for the reason the recovery
 * gate gives: exit runs teardown, and SQLite's close handlers running on the way
 * out would leave a cleanly closed database at a boundary meant to look like a
 * power loss. No `app.whenReady()` either — this process is not meant to exit
 * cleanly.
 *
 * Production's own code path, with no injected capability. On a platform the
 * build declines, this is expected to fail closed before the cut point, and that
 * outcome is reported rather than worked around: a child that injected a
 * `fsyncDirectory` to get past the refusal would be measuring a build nobody
 * ships.
 */
async function run_child(cut_point) {
    const user_data_dir = process.env[USER_DATA_VARIABLE];
    const database_path = desktop_state_database_path(user_data_dir);
    const result = await initialize_sqlite_database_no_clobber(
        database_path,
        DESKTOP_STATE_IDENTITY,
        MIGRATION,
        { onEvent: (event) => { if (event === cut_point) process.abort(); } },
    );
    await result.database.close();
}

async function main() {
    const role = process.env[ROLE_VARIABLE];
    if (role) {
        try {
            await run_child(process.env[CUT_POINT_VARIABLE]);
            // The cut point never fired. Exit 0 so the parent records
            // `completed-without-reaching-cut-point` — a finding, not a failure.
            //
            // `process.exit`, not `app.exit`: the child runs under
            // ELECTRON_RUN_AS_NODE, where the Electron `app` object does not exist.
            // Calling into it would throw here, on the path whose whole job is
            // reporting an outcome accurately.
            process.exit(0);
        } catch (error) {
            // Reduced before it is forwarded: the parent prints this into a public
            // CI log, and a raw errno message carries the temp path.
            write_output(process.stderr, `${safe_failure_text(error)}\n`);
            process.exit(2);
        }
    }

    let exit_code = 0;
    try {
        await app.whenReady();
        if (process.platform !== 'win32') {
            // The same shape the other probes use for a platform-specific
            // contract: report that nothing was measured, and say so in the
            // verdict rather than leaving a stale one behind. `inconclusive`, not
            // `not-verified` — this host measured nothing, which is a different
            // statement from having found a primitive missing.
            write_output(process.stdout, `${JSON.stringify({
                ran: false,
                platform: process.platform,
                verdict: 'inconclusive',
                because: 'the Windows durability probe only measures anything on win32;'
                    + ' this host is a different platform and no observation was made',
                cutPoints: { covered: [], pending: [...ALL_DURABLE_CUT_POINTS], complete: false },
            })}\n`);
            return;
        }

        const scratch = make_scratch_directory('survey');
        let survey;
        let filesystem;
        let production;
        try {
            filesystem = filesystem_name(scratch);
            survey = survey_primitives(scratch);
            production = production_rule(scratch);
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
        const cut_points = await survey_cut_points();
        const verdict = derive_verdict(survey, cut_points);
        write_output(process.stdout, `${JSON.stringify({
            ran: true,
            platform: process.platform,
            filesystem,
            primitives: survey,
            guarantees: derive_guarantees(survey, filesystem.filesystem),
            // Restated in the report so an encouraging primitive list cannot be
            // read as a change in shipped behaviour. Production still declines.
            productionRule: production,
            cutPoints: cut_points,
            ...verdict,
        })}\n`);
    } catch (error) {
        // Only a malfunction reaches here: every measured negative was captured as
        // data above. This is the one path that fails the job.
        exit_code = 1;
        try {
            write_output(process.stderr, `${safe_failure_text(error)}\n`);
        } catch {
            // A closed diagnostic pipe must not keep the Electron process alive.
        }
    } finally {
        app.exit(exit_code);
    }
}

void main();
