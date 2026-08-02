import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteOpenRecoveryEvent } from '../../src/sqlite-open-recovery';
import {
    SqliteFileStateError,
    sqlite_file_state_protocol_error,
} from '../../src/sqlite-file-state-errors';
import { classify_state_recovery_failure } from '../main/state-recovery-dialog';
import {
    DESKTOP_STATE_DATABASE_ID,
    DESKTOP_STATE_IDENTITY,
    DESKTOP_STATE_PLATFORM_DECLARATION_OPERATION,
    DESKTOP_STATE_STORAGE_ENVIRONMENT_ID,
    desktop_state_platform_support,
    desktop_state_database_path,
    desktop_state_diagnostics_directory,
    desktop_state_error_log_line,
    desktop_state_failure_log_line,
    open_desktop_state_database,
    preserve_desktop_state_database,
    type DesktopStateOpenResult,
} from '../main/desktop-state-database';

const APP_VERSION = 'desktop-test';

/** How long a call that must not hang is allowed to take before the test fails.
 *  Generous relative to the work (each of these settles in milliseconds) but
 *  under vitest's own per-test timeout, so a hang is reported as the specific
 *  diagnosis below rather than as an anonymous timeout. */
const NO_HANG_BUDGET_MS = 4_000;

/**
 * Fail the test if `work` has not settled within the budget.
 *
 * The defects under test turn a promise into an unbounded retry loop, and a
 * plain `await` on one of those hangs the whole suite rather than reporting a
 * failure — so the race, and the assertion that the work is what won it, is the
 * actual regression check. Never a substitute for polling observable state; the
 * timer is only here to convert a hang into a diagnosis.
 */
async function within_no_hang_budget<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hang = Symbol('hang');
    const deadline = new Promise<typeof hang>((resolve) => {
        timer = setTimeout(() => resolve(hang), NO_HANG_BUDGET_MS);
    });
    try {
        const winner = await Promise.race([work.then((value) => ({ value })), deadline]);
        if (winner === hang) throw new Error('the call under test never settled');
        return winner.value;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

let userDataDir: string;
let opened: Array<{ close(): Promise<void> }>;

/** Track every opened store so no SQLite handle or reader token outlives a test. */
async function open(): Promise<DesktopStateOpenResult> {
    const result = await open_desktop_state_database(
        userDataDir,
        APP_VERSION,
        () => 10_000,
    );
    if (result.type === 'opened') opened.push(result.opened);
    return result;
}

function seed_database_file(name: string, contents: Uint8Array | string): string {
    const target = path.join(desktop_state_diagnostics_directory(userDataDir), name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    return target;
}

/** The per-basename recovery-gate directory, which the shared backend keeps
 *  beside the database and never moves with it. Reconstructed here rather than
 *  exported, so these tests exercise the same on-disk shape a crashed process
 *  would really leave behind. */
function gate_directory(): string {
    const database_path = desktop_state_database_path(userDataDir);
    return path.join(
        path.dirname(database_path),
        `.${path.basename(database_path)}.recovery-gate`,
    );
}

/** Leave behind the exclusive intent an interrupted preserve would strand. */
function seed_exclusive_intent(): string {
    const token_id = randomUUID();
    fs.mkdirSync(gate_directory(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(gate_directory(), 'exclusive-intent'), token_id, { mode: 0o600 });
    return token_id;
}

/** Leave behind the reader token a crash-while-open would strand. */
function seed_stale_reader_token(): string {
    const token_id = randomUUID();
    const readers = path.join(gate_directory(), 'readers');
    fs.mkdirSync(readers, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(readers, `${token_id}.reader`), token_id, { mode: 0o600 });
    return token_id;
}

function gate_file_exists(name: string): boolean {
    return fs.existsSync(path.join(gate_directory(), name));
}

/**
 * Run a real preservation and abort it partway, leaving the genuine residue: a
 * blockade marker, a half-advanced manifest, at least one member already moved,
 * and the exclusive intent still in place.
 *
 * Driven by the shared backend's own durable cut-point events rather than by
 * mocking the filesystem, so the state the resume path sees is the state a real
 * crash produces. The injected error carries ENOSPC so the test can tell whether
 * the original category survived or was relabeled.
 */
async function interrupt_preservation_after_first_member_move(): Promise<unknown> {
    const stop_at: SqliteOpenRecoveryEvent = 'preserve-after-member-source-removal';
    try {
        await preserve_desktop_state_database(userDataDir, { allProcessesClosed: true }, {
            onEvent: (event) => {
                if (event !== stop_at) return;
                const failure: NodeJS.ErrnoException = new Error('injected disk-full');
                failure.code = 'ENOSPC';
                throw failure;
            },
        });
    } catch (error) {
        return error;
    }
    throw new Error('the injected failure did not stop the preservation');
}

/**
 * Snapshot of the whole state *tree*, for the "fails closed and touches no
 * bytes" checks.
 *
 * Recursive, and records directories as entries in their own right, because the
 * mutations these assertions exist to detect all happen below the top level: a
 * failed open that leaked a reader token would put one in
 * `.file-state.sqlite3.recovery-gate/readers/`, a spurious exclusive intent or
 * recovery-block marker lands in that gate directory, and a stray init candidate
 * could land in a subdirectory too. A one-level, files-only snapshot is blind to
 * every one of those, so it would compare equal across exactly the regressions
 * being guarded against.
 *
 * Keys are POSIX-style relative paths so the map is stable and readable in a
 * diff; directories map to a marker rather than to contents, so an added or
 * removed directory is a difference even when it is empty.
 */
function snapshot_state_directory(): Map<string, string> {
    const root = desktop_state_diagnostics_directory(userDataDir);
    const snapshot = new Map<string, string>();
    const walk = (directory: string, prefix: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                snapshot.set(`${relative}/`, '<directory>');
                walk(absolute, relative);
            } else if (entry.isFile()) {
                snapshot.set(relative, fs.readFileSync(absolute).toString('base64'));
            } else {
                // A symlink or socket in here is itself a difference worth seeing.
                snapshot.set(relative, '<non-file>');
            }
        }
    };
    if (fs.existsSync(root)) walk(root, '');
    return snapshot;
}

/** The gate scaffolding a shared-reader acquisition creates, as snapshot keys. */
const GATE_SCAFFOLDING: ReadonlyArray<readonly [string, string]> = [
    ['.file-state.sqlite3.recovery-gate/', '<directory>'],
    ['.file-state.sqlite3.recovery-gate/readers/', '<directory>'],
];

/**
 * `before` plus the empty gate directories, and nothing else.
 *
 * The expected shape when a failed open is the *first* thing to touch the state
 * directory: acquiring the shared reader gate creates
 * `.file-state.sqlite3.recovery-gate/readers/` before the open can fail, so the
 * two directories legitimately appear. Stated explicitly rather than by relaxing
 * the snapshot, because the interesting regressions all live inside exactly those
 * directories — a leaked `<uuid>.reader` token, a spurious `exclusive-intent`, a
 * `recovery-block.json` written by a path that has no business blockading — and
 * every one of them would be a key this expectation does not contain.
 */
function with_empty_gate(before: Map<string, string>): Map<string, string> {
    return new Map([...before, ...GATE_SCAFFOLDING]);
}

beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-viewer-desktop-state-'));
    opened = [];
});

afterEach(async () => {
    for (const store of opened.splice(0)) {
        try {
            await store.close();
        } catch {
            // A test that already failed the open must not fail again in teardown.
        }
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('desktop state platform support', () => {
    it('declares this platform supported and leaves nothing behind', () => {
        // Local CI and every developer machine run a platform production supports,
        // so the observable contract here is the *absence* of side effects: the
        // question is asked before the app has decided it can store anything, and
        // the unsupported dialog goes on to promise that nothing was changed or
        // moved. A probe directory left behind would falsify that promise on the
        // one platform where it matters most.
        const before = fs.readdirSync(userDataDir).sort();

        expect(desktop_state_platform_support(userDataDir)).toEqual({ supported: true });

        expect(fs.readdirSync(userDataDir).sort()).toEqual(before);
        expect(fs.existsSync(desktop_state_diagnostics_directory(userDataDir))).toBe(false);
    });

    it('answers for a userData directory that does not exist yet', () => {
        // The open consults this before anything creates the state tree, so a
        // missing directory must produce a platform answer rather than an
        // accidental refusal — that refusal would be the app declining to run on a
        // system it fully supports, on its very first launch.
        expect(desktop_state_platform_support(path.join(userDataDir, 'not-created-yet')))
            .toEqual({ supported: true });
    });

    it('requires a location, so the platform/location control is never degenerate', () => {
        // The distinction is drawn by comparing the caller's location against an
        // unrelated control. An omitted location left nothing to compare — the
        // control became the same directory, agreed with itself, and every refusal
        // was promoted to the whole-platform story ("wait for a future build") even
        // when one unusual mount was the entire problem. Requiring the argument is
        // what makes the comparison real, so the signature is asserted rather than
        // left to review.
        // The parameter is required, so omitting it is a compile error — which is
        // the real enforcement, and `@ts-expect-error` fails the typecheck if the
        // optional marker ever comes back.
        expect(desktop_state_platform_support).toHaveLength(1);
        // @ts-expect-error the omitted-location overload is deliberately gone.
        const degenerate = () => desktop_state_platform_support();
        // And the runtime behaviour is the honest one either way: with nothing to
        // compare against it must never claim the *platform* is unsupported, which
        // is the misdirection the old fallback produced.
        expect(degenerate().supported).toBe(true);
    });

    it('reports a whole-platform refusal under its own stage, not the backend’s', async () => {
        // The Windows case, which cannot be run here. What *is* checked on any
        // host is the pairing the dialog depends on: the constant this module
        // exports is the exact stage the classifier refines into the platform
        // story. If the two drift, a Windows user gets the location story, whose
        // only advice — keep the settings on an ordinary local disk — cannot help
        // anywhere on that machine.
        expect(DESKTOP_STATE_PLATFORM_DECLARATION_OPERATION)
            .toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
        expect(classify_state_recovery_failure({
            category: 'unsupported',
            operation: DESKTOP_STATE_PLATFORM_DECLARATION_OPERATION,
        })).toMatchObject({ kind: 'unsupported-platform', canPreserve: false });
    });

    it('is consulted before the open creates or inspects anything', async () => {
        // The ordering that makes the refusal honest. With the declaration first,
        // a declined platform reports without the coordination gate having been
        // created; the recovery preflight, which runs next, creates it as a side
        // effect of inspecting it. Proven by the supported path: after a *failed*
        // open on a supported platform the gate exists, which is only true because
        // the preflight ran — i.e. because the declaration let it.
        seed_database_file('file-state.sqlite3', 'not a database');
        const result = await open();

        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('expected a failed open');
        expect(result.failure.category).not.toBe('unsupported');
    });
});

describe('desktop state database', () => {
    it('resolves the canonical path and diagnostics directory under userData', () => {
        expect(desktop_state_database_path(userDataDir))
            .toBe(path.join(userDataDir, 'state', 'file-state.sqlite3'));
        expect(desktop_state_diagnostics_directory(userDataDir))
            .toBe(path.join(userDataDir, 'state'));
    });

    it('creates the database on first open and round-trips state through the store', async () => {
        const result = await open();
        expect(result.type).toBe('opened');
        if (result.type !== 'opened') throw new Error('expected an opened database');
        expect(fs.existsSync(desktop_state_database_path(userDataDir))).toBe(true);

        const store = result.opened.store;
        const committed = await store.compare_and_set('/sheet.csv', 0, { activeSheetIndex: 2 });
        expect(committed.type).toBe('committed');
        await expect(store.read('/sheet.csv')).resolves.toEqual(committed.snapshot);
        expect(committed.snapshot.state).toMatchObject({ activeSheetIndex: 2 });
    });

    it('reopens the same userData directory after a clean close', async () => {
        // The regression the deterministic identity exists to prevent: a random
        // per-open databaseId would fail the second open's identity validation.
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.store.compare_and_set('/sheet.csv', 0, { activeSheetIndex: 1 });
        await first.opened.close();
        opened.length = 0;

        const second = await open();
        expect(second.type).toBe('opened');
        if (second.type !== 'opened') throw new Error('expected a reopened database');
        await expect(second.opened.store.read('/sheet.csv')).resolves.toMatchObject({
            state: { activeSheetIndex: 1 },
        });
    });

    it('fails closed on a stray WAL beside a valid database and touches no bytes', async () => {
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        seed_database_file('file-state.sqlite3-wal', 'stray write-ahead log');
        const before = snapshot_state_directory();

        const result = await open();
        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('expected a failed open');
        // The backend refuses the basename set before it ever opens SQLite: a
        // WAL beside a `journal_policy = 'delete'` database is an unsupported
        // shape, which it reports as a schema failure.
        expect(result.failure.category).toBe('schema');
        expect(snapshot_state_directory()).toEqual(before);
    });

    it('fails closed on a zero-length database without overwriting it', async () => {
        seed_database_file('file-state.sqlite3', new Uint8Array(0));
        const before = snapshot_state_directory();

        const result = await open();
        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('expected a failed open');
        expect(result.failure.category).toBe('recovery');
        // The seeded bytes untouched, and inside the gate the open had to create:
        // no reader token retained, no exclusive intent, no blockade marker.
        expect(snapshot_state_directory()).toEqual(with_empty_gate(before));
    });

    it('fails closed on a non-SQLite file and preserves its bytes', async () => {
        seed_database_file('file-state.sqlite3', 'this is definitely not a database\n');
        const before = snapshot_state_directory();

        const result = await open();
        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('expected a failed open');
        // Not `corrupt`: the file is rejected as an unrecognized candidate
        // during no-clobber initialization, before SQLite reports SQLITE_NOTADB.
        expect(result.failure.category).toBe('schema');
        // Same as above: the rejected candidate's bytes, and an empty gate. In
        // particular no leftover `*.candidate` in a subdirectory, which a
        // files-only snapshot of the top level would not have seen.
        expect(snapshot_state_directory()).toEqual(with_empty_gate(before));
    });

    it('carries the sanitized discriminators the recovery flow needs, and nothing more', async () => {
        // The orphaned first-run case: a force-quit during initialization leaves a
        // candidate with no main file beside it. The recovery flow has to tell that
        // apart from a genuinely interrupted preserve, and the already-sanitized
        // `operation` stage name is the discriminator — so it must actually reach
        // the failure value rather than stopping at the log.
        // The real shape a killed first run leaves: the shared backend builds its
        // database under `<basename>.init-candidate.<uuid>` and renames it into
        // place last, so a force-quit before that rename leaves exactly this.
        seed_database_file(
            `file-state.sqlite3.init-candidate.${randomUUID()}`,
            new Uint8Array(0),
        );
        const result = await open();
        if (result.type !== 'failed') throw new Error('expected a failed open');

        expect(result.failure.category).toBe('recovery');
        expect(result.failure.operation).toBe('absent-main-evidence');
        // And it is still only the sanitized fields: the numeric fence values are
        // absent here because nothing threw a version fence, and no path,
        // filename, SQL, or digest is present at all.
        expect(Object.keys(result.failure).sort()).toEqual(['category', 'operation']);
        expect(classify_state_recovery_failure(result.failure))
            .toMatchObject({ kind: 'leftover-setup', canPreserve: true });
    });

    it('carries a protocol fence value so the version story can be told', () => {
        // Not driven through a real open: reaching the reader/writer-bound fence
        // needs a database written by a *different* build's protocol bounds, which
        // the shared backend has no supported way to produce here. What this pins
        // is the desktop boundary's own behaviour — that a sanitized `protocol` or
        // `coordinationGeneration` survives the reduction to
        // `DesktopStateOpenFailure` and reaches the classifier, which is what makes
        // the version fence distinguishable from real lock contention.
        const fence = sqlite_file_state_protocol_error({ protocol: 3 });
        const contention = sqlite_file_state_protocol_error({ operation: 'desktop-state-open' });

        expect(classify_state_recovery_failure({
            category: fence.category,
            ...(fence.metadata.protocol === undefined
                ? {}
                : { protocol: fence.metadata.protocol }),
        }).kind).toBe('compatibility');
        expect(classify_state_recovery_failure({
            category: contention.category,
            ...(contention.metadata.operation === undefined
                ? {}
                : { operation: contention.metadata.operation }),
        }).kind).toBe('transient');
        // The distinguishing fact itself: only the fence throw carries the number.
        expect(fence.metadata.protocol).toBe(3);
        expect(contention.metadata.protocol).toBeUndefined();
    });

    it('leaks no path, filename, or SQL text through a failure result', async () => {
        seed_database_file('file-state.sqlite3', 'not a database');
        const result = await open();
        expect(result.type).toBe('failed');

        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(userDataDir);
        expect(serialized).not.toContain(os.tmpdir());
        expect(serialized).not.toContain('file-state.sqlite3');
        for (const keyword of [
            'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'PRAGMA', 'TABLE', 'sqlite3',
        ]) {
            expect(serialized).not.toContain(keyword);
        }
    });

    it('preserves all four basename members as a unit and lets the next open start clean', async () => {
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.store.compare_and_set('/sheet.csv', 0, { activeSheetIndex: 3 });
        await first.opened.close();
        opened.length = 0;
        // All three sidecars, not just the journal: preserve-as-a-unit is a
        // four-member claim, and moving only some of them would leave behind a WAL
        // that a later open could replay into a *different* main file.
        const sidecars = ['-journal', '-wal', '-shm'].map(
            (suffix) => seed_database_file(`file-state.sqlite3${suffix}`, `stray${suffix}`),
        );
        const databasePath = desktop_state_database_path(userDataDir);
        expect(fs.existsSync(databasePath)).toBe(true);

        await preserve_desktop_state_database(userDataDir, { allProcessesClosed: true });

        // Gone from where they were...
        expect(fs.existsSync(databasePath)).toBe(false);
        for (const sidecar of sidecars) expect(fs.existsSync(sidecar)).toBe(false);
        // ...and *present in the recovery directory*, which is the actual claim.
        // Asserting only their absence above would pass just as happily against an
        // implementation that deleted them.
        const state_directory = desktop_state_diagnostics_directory(userDataDir);
        const recovery_directories = fs.readdirSync(state_directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.includes('.recovery.'));
        expect(recovery_directories).toHaveLength(1);
        const preserved = fs.readdirSync(
            path.join(state_directory, recovery_directories[0].name),
        ).sort();
        expect(preserved).toEqual([
            'file-state.sqlite3',
            'file-state.sqlite3-journal',
            'file-state.sqlite3-shm',
            'file-state.sqlite3-wal',
            // The record of which members moved, without which a half-finished
            // move could not be resumed.
            'manifest.json',
        ]);
        // The bytes moved, not just the names.
        for (const suffix of ['-journal', '-wal', '-shm']) {
            expect(fs.readFileSync(
                path.join(
                    state_directory,
                    recovery_directories[0].name,
                    `file-state.sqlite3${suffix}`,
                ),
                'utf8',
            )).toBe(`stray${suffix}`);
        }

        const reopened = await open();
        expect(reopened.type).toBe('opened');
        if (reopened.type !== 'opened') throw new Error('expected a fresh database');
        // Fresh, not the preserved one: the old entry is gone.
        await expect(reopened.opened.store.read('/sheet.csv')).resolves.toMatchObject({
            state: {},
        });
        const committed = await reopened.opened.store.compare_and_set(
            '/fresh.csv',
            0,
            { activeSheetIndex: 1 },
        );
        expect(committed.type).toBe('committed');

        // The launch *after* the one that follows a successful preserve — the
        // regression that made a successful "Set Aside and Start Fresh" strictly
        // worse than the hang the preflight was added to fix. It had two
        // independent causes, and both are now fixed at their source. The
        // preflight once also refused on `incompleteRecoveryDirectories > 0`,
        // which is not a stable predicate for this app; and
        // `validate_completed_preservation` required a completed recovery
        // directory's original source names to still be absent, which this very
        // flow re-creates on purpose. That second one is the deeper of the two:
        // it made `inventory_sqlite_basename` misreport a finished directory as
        // incomplete for good, so `preserve_sqlite_basename_set` took its orphan
        // branch and threw `orphan-preservation-manifest` — a *second* set-aside
        // in one userData directory was impossible even with the preflight
        // narrowed. Source-absence is now enforced only where it is meaningful,
        // inside `advance_preservation`'s final loop, while the move is in
        // flight and the gate is still exclusive.
        await reopened.opened.close();
        opened.length = 0;
        const relaunched = await within_no_hang_budget(open());
        expect(relaunched.type).toBe('opened');
        if (relaunched.type !== 'opened') throw new Error('expected a second clean launch');
        // The state the first fresh launch wrote is still there: this is a
        // reopen, not another fresh start hiding the same failure.
        await expect(relaunched.opened.store.read('/fresh.csv')).resolves.toMatchObject({
            state: { activeSheetIndex: 1 },
        });
        // And nothing was deleted to make that open work. The preserved set and
        // the manifest that records which members moved are the user's only copy
        // of whatever unsaved work the old database held; an implementation that
        // "fixed" the open by clearing the recovery directory would pass every
        // assertion above.
        const still_there = fs.readdirSync(state_directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.includes('.recovery.'));
        expect(still_there.map((entry) => entry.name))
            .toEqual([recovery_directories[0].name]);
        expect(fs.readdirSync(
            path.join(state_directory, recovery_directories[0].name),
        ).sort()).toEqual(preserved);
        const manifest = JSON.parse(fs.readFileSync(
            path.join(state_directory, recovery_directories[0].name, 'manifest.json'),
            'utf8',
        )) as { state?: string };
        expect(manifest.state).toBe('complete');
    });

    it('quarantines an unparseable reader-token name instead of dead-ending the flow', async () => {
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        // Every token this code creates is `<uuid>.reader` containing that uuid,
        // so this name was never one — but `existing_reader_token_ids` throws
        // `reader-token-inventory` for it, which failed the open *and* the
        // preserve (from `inspect_sqlite_recovery_gate`, before the gate could be
        // acquired). The dialog then looped with no action able to clear it.
        const readers = path.join(gate_directory(), 'readers');
        fs.mkdirSync(readers, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(readers, 'not-a-uuid.reader'), 'whatever', { mode: 0o600 });

        const blocked = await within_no_hang_budget(open());
        expect(blocked.type).toBe('failed');
        if (blocked.type !== 'failed') throw new Error('expected a blocked open');
        // Reported with its own stage, so the dialog can tell the honest story
        // rather than claiming an interrupted move that never happened.
        expect(blocked.failure.category).toBe('recovery');
        expect(blocked.failure.operation).toBe('reader-token-inventory');
        expect(classify_state_recovery_failure(blocked.failure))
            .toMatchObject({ kind: 'coordination-residue', canPreserve: true });

        // The action the dialog offers now completes instead of throwing the same
        // inventory error back at itself.
        await within_no_hang_budget(
            preserve_desktop_state_database(userDataDir, { allProcessesClosed: true }),
        );

        expect(fs.existsSync(path.join(readers, 'not-a-uuid.reader'))).toBe(false);
        // Set aside, never deleted: the bytes are evidence about how the directory
        // reached this state, and nothing in this module destroys evidence.
        const quarantine_root = path.join(gate_directory(), 'quarantined-gate-markers');
        const generations = fs.readdirSync(quarantine_root);
        expect(generations).toHaveLength(1);
        expect(fs.readFileSync(
            path.join(quarantine_root, generations[0], 'not-a-uuid.reader'),
            'utf8',
        )).toBe('whatever');
        // And the escape actually works end to end.
        await expect(within_no_hang_budget(open())).resolves.toMatchObject({ type: 'opened' });
    });

    it.each([
        // A crash between the marker's `open` and its `write` — the gate creates
        // every marker with `write_private_file_exclusive`, so the torn shape is
        // a zero-length file, not hand-edited residue.
        ['a torn exclusive intent', 'exclusive-intent', ''],
        ['a torn recovery blockade', 'recovery-block.json', ''],
    ] as const)('recovers from %s instead of dead-ending', async (_label, name, contents) => {
        // Each of these was permanent. The torn intent made
        // `inspect_sqlite_recovery_gate` throw `exclusive-intent-inspect` from
        // the line that runs *before* — and gates — the reclamation that is the
        // only attested way to clear it, while the reader gate spun on the file's
        // mere presence. The torn blockade was reported by a bare `existsSync` as
        // a real blockade, so the preserve routed to
        // `resume_sqlite_basename_preservation`, whose `read_recovery_block` then
        // threw on `JSON.parse`. Both are one condition: strict parsing on the
        // inspection path that gates the attested repair.
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.store.compare_and_set('/sheet.csv', 0, { activeSheetIndex: 4 });
        await first.opened.close();
        opened.length = 0;
        fs.mkdirSync(gate_directory(), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(gate_directory(), name), contents, { mode: 0o600 });

        // Still refused, and still without hanging: a torn marker obstructs the
        // reader gate exactly as a well-formed one does, so reporting it is
        // honest. What changed is that reporting no longer means throwing.
        const before = snapshot_state_directory();
        const blocked = await within_no_hang_budget(open());
        expect(blocked.type).toBe('failed');
        if (blocked.type !== 'failed') throw new Error('expected a blocked open');
        expect(blocked.failure.category).toBe('recovery');
        expect(classify_state_recovery_failure(blocked.failure).canPreserve).toBe(true);
        // Refused by the *preflight*, which is the load-bearing part: it is
        // non-blocking and acquires nothing, so it cannot be starved by the
        // condition it is looking for. Letting a torn marker through to the open
        // proper would still fail — `assert_preflight_inventory` also tests the
        // blockade path for presence — but only after acquiring a reader gate,
        // which is the spin this preflight exists to prevent.
        expect(blocked.failure.operation).toBe('desktop-state-preflight');
        // Reported, never cleared by the open itself, and nothing else touched.
        expect(gate_file_exists(name)).toBe(true);
        expect(snapshot_state_directory()).toEqual(before);

        await within_no_hang_budget(
            preserve_desktop_state_database(userDataDir, { allProcessesClosed: true }),
        );

        expect(gate_file_exists(name)).toBe(false);
        // Moved, not deleted: an empty marker is evidence that a write was cut
        // between its `open` and its `write`, which is a different diagnosis from
        // a marker that was never created.
        const quarantine_root = path.join(gate_directory(), 'quarantined-gate-markers');
        const generations = fs.readdirSync(quarantine_root);
        expect(generations).toHaveLength(1);
        expect(fs.readdirSync(path.join(quarantine_root, generations[0]))).toEqual([name]);
        // The database itself was preserved as a unit, not repaired in place.
        expect(fs.existsSync(desktop_state_database_path(userDataDir))).toBe(false);
        const preserved = fs.readdirSync(
            desktop_state_diagnostics_directory(userDataDir),
            { withFileTypes: true },
        ).filter((entry) => entry.isDirectory() && entry.name.includes('.recovery.'));
        expect(preserved).toHaveLength(1);
        await expect(within_no_hang_budget(open())).resolves.toMatchObject({ type: 'opened' });
    });

    it('recovers from a reader token whose name is valid but whose contents are not', async () => {
        // `existing_reader_token_ids` validates only the filename, so this was
        // inventoried as a live reader: `reclaimStaleReaderToken` then failed its
        // exact-token check and threw `reader-token-reclaim`, and `waitForReaders`
        // spun forever on a reader that never existed. The earlier desktop-side
        // quarantine covered unparseable *names* only, deliberately, so nothing
        // in the app could clear this shape.
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        const readers = path.join(gate_directory(), 'readers');
        fs.mkdirSync(readers, { recursive: true, mode: 0o700 });
        const impostor_id = randomUUID();
        const impostor = path.join(readers, `${impostor_id}.reader`);
        fs.writeFileSync(impostor, 'not-its-own-id', { mode: 0o600 });

        const blocked = await within_no_hang_budget(open());
        expect(blocked.type).toBe('failed');
        if (blocked.type !== 'failed') throw new Error('expected a blocked open');
        expect(blocked.failure.category).toBe('recovery');
        expect(blocked.failure.operation).toBe('reader-token-inventory');
        expect(classify_state_recovery_failure(blocked.failure))
            .toMatchObject({ kind: 'coordination-residue', canPreserve: true });

        await within_no_hang_budget(
            preserve_desktop_state_database(userDataDir, { allProcessesClosed: true }),
        );

        expect(fs.existsSync(impostor)).toBe(false);
        const quarantine_root = path.join(gate_directory(), 'quarantined-gate-markers');
        const generations = fs.readdirSync(quarantine_root);
        expect(generations).toHaveLength(1);
        expect(fs.readFileSync(
            path.join(quarantine_root, generations[0], `${impostor_id}.reader`),
            'utf8',
        )).toBe('not-its-own-id');
        await expect(within_no_hang_budget(open())).resolves.toMatchObject({ type: 'opened' });
    });

    it('sets aside a second time in one userData directory, keeping the first set intact', async () => {
        // Recovery used to work exactly once per directory: after a successful
        // set-aside the app re-creates `file-state.sqlite3`, which made the
        // *completed* recovery directory validate as incomplete forever, so the
        // second preserve entered the orphan branch and threw
        // `orphan-preservation-manifest` — with Try Again failing identically.
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.store.compare_and_set('/first.csv', 0, { activeSheetIndex: 1 });
        await first.opened.close();
        opened.length = 0;
        await within_no_hang_budget(
            preserve_desktop_state_database(userDataDir, { allProcessesClosed: true }),
        );

        const second = await within_no_hang_budget(open());
        if (second.type !== 'opened') throw new Error('expected a fresh database');
        await second.opened.store.compare_and_set('/second.csv', 0, { activeSheetIndex: 2 });
        await second.opened.close();
        opened.length = 0;

        await within_no_hang_budget(
            preserve_desktop_state_database(userDataDir, { allProcessesClosed: true }),
        );

        const state_directory = desktop_state_diagnostics_directory(userDataDir);
        const recovery_directories = fs.readdirSync(state_directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.includes('.recovery.'))
            .map((entry) => entry.name);
        // Two distinct sets, side by side. Nothing was overwritten to make room:
        // each preserve gets its own generation directory.
        expect(recovery_directories).toHaveLength(2);
        for (const name of recovery_directories) {
            const members = fs.readdirSync(path.join(state_directory, name)).sort();
            expect(members).toEqual(['file-state.sqlite3', 'manifest.json']);
            const manifest = JSON.parse(fs.readFileSync(
                path.join(state_directory, name, 'manifest.json'),
                'utf8',
            )) as { state?: string };
            expect(manifest.state).toBe('complete');
        }
        // And the *first* preserved database still holds the entry it was
        // preserved with — the second set-aside did not touch it. It may be the
        // user's only copy of unsaved work.
        const contents = recovery_directories.map((name) => {
            const database = new DatabaseSync(
                path.join(state_directory, name, 'file-state.sqlite3'),
                { readOnly: true },
            );
            try {
                return database.prepare('SELECT COUNT(*) AS count FROM entries WHERE path = ?')
                    .get('/first.csv')?.count;
            } finally {
                database.close();
            }
        });
        expect(contents).toContain(1);

        const third = await within_no_hang_budget(open());
        expect(third.type).toBe('opened');
    });

    it('leaves a valid reader token untouched when it quarantines an invalid name', async () => {
        // The exact-token semantics this must not weaken: a well-formed token is
        // indistinguishable from a live peer's, so it stays put and is reclaimed
        // only by the exclusive gate's exact-id path under the attestation. The
        // quarantine may only touch names that could never have been tokens.
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        const readers = path.join(gate_directory(), 'readers');
        const valid = seed_stale_reader_token();
        fs.writeFileSync(path.join(readers, 'not-a-uuid.reader'), 'x', { mode: 0o600 });

        await within_no_hang_budget(
            preserve_desktop_state_database(userDataDir, { allProcessesClosed: true }),
        );

        // Both are gone from `readers/` afterwards, but by different routes: the
        // valid one through `reclaimStaleReaderToken`'s exact-id check, the
        // invalid one into quarantine — so only the invalid one still exists.
        expect(fs.existsSync(path.join(readers, `${valid}.reader`))).toBe(false);
        const quarantine_root = path.join(gate_directory(), 'quarantined-gate-markers');
        const generations = fs.readdirSync(quarantine_root);
        expect(generations).toHaveLength(1);
        expect(fs.readdirSync(path.join(quarantine_root, generations[0])))
            .toEqual(['not-a-uuid.reader']);
    });

    it('leaks no path when the readers directory is not a directory', async () => {
        // The quarantine runs ahead of the backend's own sanitizing layer, so an
        // errno escaping it raw would put an absolute path into `.path` and into
        // `.message` — which is exactly what every other failure in this module is
        // careful never to do. Reachable without hand-editing: a sync client or a
        // restore can leave a plain file on a directory's name.
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        const readers = path.join(gate_directory(), 'readers');
        fs.rmSync(readers, { recursive: true, force: true });
        fs.writeFileSync(readers, 'not a directory', { mode: 0o600 });

        const failure = await preserve_desktop_state_database(
            userDataDir,
            { allProcessesClosed: true },
        ).then(() => undefined, (error: unknown) => error);

        expect(failure).toBeInstanceOf(SqliteFileStateError);
        const categorized = failure as SqliteFileStateError;
        expect(categorized.category).toBe('recovery');
        expect((categorized as unknown as { path?: string }).path).toBeUndefined();
        // The absolute path and the database's own name are the secrets. The
        // sanitized stage name is not one, even when it happens to contain the
        // word `readers`: `readers-directory-verify` is a compile-time constant
        // of the shared backend, already matched by
        // `[A-Za-z][A-Za-z0-9_-]{0,63}` and already emitted by every other
        // failure at this stage. Asserting against the bare word would have
        // forbidden the module from ever naming its own stage, which is the one
        // diagnostic the failure policy explicitly permits.
        for (const secret of [userDataDir, os.tmpdir(), 'file-state.sqlite3']) {
            expect(categorized.message).not.toContain(secret);
            expect(JSON.stringify(categorized.metadata)).not.toContain(secret);
        }
        expect(categorized.metadata.operation).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
    });

    it('moves nothing when the readers directory is a symlink out of the gate', async () => {
        // `existsSync` follows symlinks, so resolving the readers directory that
        // way would send every rename to wherever the link points — mutating files
        // outside the gate tree, and doing it before the backend's own
        // managed-directory check could object. Nothing here is ours to move.
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        const elsewhere = path.join(userDataDir, 'elsewhere');
        fs.mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
        const decoy = path.join(elsewhere, 'not-a-uuid.reader');
        fs.writeFileSync(decoy, 'outside the gate', { mode: 0o600 });
        const readers = path.join(gate_directory(), 'readers');
        fs.rmSync(readers, { recursive: true, force: true });
        fs.symlinkSync(elsewhere, readers);

        await expect(preserve_desktop_state_database(
            userDataDir,
            { allProcessesClosed: true },
        )).rejects.toBeInstanceOf(SqliteFileStateError);

        // The decoy never moved, and no quarantine tree was created for it.
        expect(fs.readFileSync(decoy, 'utf8')).toBe('outside the gate');
        expect(fs.existsSync(path.join(gate_directory(), 'quarantined-gate-markers'))).toBe(false);
    });

    it('writes nothing outside the gate when the quarantine name is a symlink', async () => {
        // The read side was guarded first, which left this: the destination name is
        // joined onto the gate path and never otherwise checked, so `mkdirSync`
        // followed the link and every rename landed in the target. Verified before
        // the fix that the token really did land outside the gate and `preserve` did
        // not even throw — a silent write outside the tree.
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        const readers = path.join(gate_directory(), 'readers');
        fs.mkdirSync(readers, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(readers, 'not-a-uuid.reader'), 'token', { mode: 0o600 });
        const outside = path.join(userDataDir, 'outside');
        fs.mkdirSync(outside, { recursive: true, mode: 0o700 });
        fs.symlinkSync(outside, path.join(gate_directory(), 'quarantined-gate-markers'));

        await expect(preserve_desktop_state_database(
            userDataDir,
            { allProcessesClosed: true },
        )).rejects.toBeInstanceOf(SqliteFileStateError);

        // Nothing was created or moved into the link target, and the token is still
        // where it was — evidence preserved, not relocated out of the tree.
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fs.existsSync(path.join(readers, 'not-a-uuid.reader'))).toBe(true);
    });

    it('moves nothing when the gate directory itself is a symlink', async () => {
        // The gate directory is derived with `path.join`, so guarding only
        // `readers` leaves this hole: through a symlinked gate, `readers` is a
        // genuine directory and passes a leaf-only check, while every path built
        // from it resolves into the link target. Same escape as the case above, one
        // level up, and it needs its own test because the leaf guard cannot see it.
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        const outside = path.join(userDataDir, 'outside');
        fs.mkdirSync(path.join(outside, 'readers'), { recursive: true, mode: 0o700 });
        const decoy = path.join(outside, 'readers', 'not-a-uuid.reader');
        fs.writeFileSync(decoy, 'outside the gate', { mode: 0o600 });
        fs.rmSync(gate_directory(), { recursive: true, force: true });
        fs.symlinkSync(outside, gate_directory());

        await expect(preserve_desktop_state_database(
            userDataDir,
            { allProcessesClosed: true },
        )).rejects.toBeInstanceOf(SqliteFileStateError);

        expect(fs.readFileSync(decoy, 'utf8')).toBe('outside the gate');
        expect(fs.existsSync(path.join(outside, 'quarantined-gate-markers'))).toBe(false);
    });

    it('reports a non-file on a basename member as its own condition, not a resumed move', async () => {
        // A folder — created by hand, or restored by a sync client — on the name
        // the settings set owns. `member_for` rejects it with
        // `inventory-member-type` from every path that inventories the basename,
        // including the preserve action's own, so the honest story is neither
        // "a previous set-aside did not finish" nor damage to a database that may
        // not exist.
        fs.mkdirSync(desktop_state_database_path(userDataDir), { recursive: true });
        const before = snapshot_state_directory();

        const result = await within_no_hang_budget(open());

        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('expected a failed open');
        expect(result.failure.category).toBe('recovery');
        expect(result.failure.operation).toBe('inventory-member-type');
        const detail = classify_state_recovery_failure(result.failure);
        // No preserve offered, because it cannot run: it inventories the same
        // obstructed name and fails identically, which is a dialog loop whose
        // only exit is Quit.
        expect(detail).toMatchObject({ kind: 'obstructed', canPreserve: false });
        expect(snapshot_state_directory()).toEqual(with_empty_gate(before));
    });

    it('calls a headerless main file damaged rather than another product’s', async () => {
        // `read_sqlite_raw_header` throws `schema` for bad magic, and `schema`
        // defaults to the `compatibility` story — whose every clause is false
        // here: it says the settings belong to another product or a newer version,
        // that they are "not damaged", and that setting them aside would leave the
        // other product without them, which discourages the only action that
        // recovers. The story even flipped on file length, since a longer
        // truncation of a real database keeps its header and reaches SQLite, which
        // reports `corrupt` correctly.
        seed_database_file('file-state.sqlite3', Buffer.alloc(50, 0x41));

        const result = await within_no_hang_budget(open());

        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('expected a failed open');
        expect(result.failure.category).toBe('schema');
        expect(result.failure.operation).toBe('raw-header');
        expect(classify_state_recovery_failure(result.failure))
            .toMatchObject({ kind: 'corrupt', canPreserve: true });
    });

    it('rejects preservation without the all-processes-closed confirmation', async () => {
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;

        await expect(preserve_desktop_state_database(
            userDataDir,
            { allProcessesClosed: false } as unknown as { allProcessesClosed: true },
        )).rejects.toThrow();
        await expect(preserve_desktop_state_database(
            userDataDir,
            {} as unknown as { allProcessesClosed: true },
        )).rejects.toThrow();
        expect(fs.existsSync(desktop_state_database_path(userDataDir))).toBe(true);
    });

    it('reports a leftover exclusive intent as a recovery condition without hanging', async () => {
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        // Exactly what an interrupted "Set Aside and Start Fresh" strands. The
        // shared reader gate waits for this to disappear in an unbounded loop, so
        // without the preflight every future launch spins forever with no window
        // and no dialog — the user's only escape being a hidden dotfile.
        seed_exclusive_intent();
        const before = snapshot_state_directory();

        const result = await within_no_hang_budget(open());

        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('expected a failed open');
        expect(result.failure.category).toBe('recovery');
        // Reported, never cleared: only the attested preserve may reclaim it.
        expect(gate_file_exists('exclusive-intent')).toBe(true);
        expect(snapshot_state_directory()).toEqual(before);
    });

    it('reports a recovery blockade marker as a recovery condition and touches no bytes', async () => {
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        fs.mkdirSync(gate_directory(), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(gate_directory(), 'recovery-block.json'), '{}', { mode: 0o600 });
        const before = snapshot_state_directory();

        const result = await within_no_hang_budget(open());

        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('expected a failed open');
        expect(result.failure.category).toBe('recovery');
        expect(gate_file_exists('recovery-block.json')).toBe(true);
        expect(snapshot_state_directory()).toEqual(before);
    });

    it('reclaims an exact stale reader token under the attestation instead of waiting forever', async () => {
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.close();
        opened.length = 0;
        // What a crash while the database was open leaves behind. The exclusive
        // gate's reader wait has no deadline — deliberately, because a deadline
        // would be the time-based expiry the plan forbids — so the recovery
        // action itself hangs unless the exact token is reclaimed.
        const stale_token = seed_stale_reader_token();
        expect(fs.existsSync(path.join(gate_directory(), 'readers', `${stale_token}.reader`)))
            .toBe(true);

        await within_no_hang_budget(
            preserve_desktop_state_database(userDataDir, { allProcessesClosed: true }),
        );

        expect(fs.existsSync(path.join(gate_directory(), 'readers', `${stale_token}.reader`)))
            .toBe(false);
        expect(fs.existsSync(desktop_state_database_path(userDataDir))).toBe(false);
        // Settled: intent removed last, after the blockade and directories.
        expect(gate_file_exists('exclusive-intent')).toBe(false);
        expect(gate_file_exists('recovery-block.json')).toBe(false);
        await expect(within_no_hang_budget(open())).resolves.toMatchObject({ type: 'opened' });
    });

    it('surfaces the original failure category when a move fails partway, and keeps the evidence', async () => {
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.store.compare_and_set('/sheet.csv', 0, { activeSheetIndex: 7 });
        await first.opened.close();
        opened.length = 0;
        const journal = seed_database_file('file-state.sqlite3-journal', 'rollback journal');

        const error = await interrupt_preservation_after_first_member_move();

        // The honest capacity failure, not the generic `exclusive-gate-blocked-release`
        // that the old unconditional `finally { await gate.release() }` substituted
        // for it — the failure policy forbids relabeling a device/space failure.
        expect(error).toMatchObject({ category: 'full' });
        // Evidence retained: the blockade and the intent are what let the next
        // attempt know a move is unfinished and which one to continue.
        expect(gate_file_exists('recovery-block.json')).toBe(true);
        expect(gate_file_exists('exclusive-intent')).toBe(true);
        // A preserve is a move, never a delete: the first member is already in a
        // recovery directory, and the untouched one is still where it was.
        expect(fs.existsSync(journal)).toBe(true);
        const recovery_directories = fs.readdirSync(
            desktop_state_diagnostics_directory(userDataDir),
            { withFileTypes: true },
        ).filter((entry) => entry.isDirectory() && entry.name.includes('.recovery.'));
        expect(recovery_directories).toHaveLength(1);
    });

    it('resumes an interrupted preservation under the attestation and reopens clean', async () => {
        const first = await open();
        if (first.type !== 'opened') throw new Error('expected an opened database');
        await first.opened.store.compare_and_set('/sheet.csv', 0, { activeSheetIndex: 7 });
        await first.opened.close();
        opened.length = 0;
        const journal = seed_database_file('file-state.sqlite3-journal', 'rollback journal');
        await interrupt_preservation_after_first_member_move();

        // F1's other half: the blockade the interrupted move left is reported as
        // a recovery condition rather than spun on.
        const blocked = await within_no_hang_budget(open());
        expect(blocked.type).toBe('failed');
        if (blocked.type !== 'failed') throw new Error('expected a blocked open');
        expect(blocked.failure.category).toBe('recovery');

        // The same action the user already attested to, resuming rather than
        // starting a second move.
        await within_no_hang_budget(
            preserve_desktop_state_database(userDataDir, { allProcessesClosed: true }),
        );

        expect(gate_file_exists('recovery-block.json')).toBe(false);
        expect(gate_file_exists('exclusive-intent')).toBe(false);
        expect(fs.existsSync(desktop_state_database_path(userDataDir))).toBe(false);
        expect(fs.existsSync(journal)).toBe(false);
        // Exactly one recovery directory: the interrupted move was continued,
        // not duplicated beside a second half-moved set.
        const recovery_directories = fs.readdirSync(
            desktop_state_diagnostics_directory(userDataDir),
            { withFileTypes: true },
        ).filter((entry) => entry.isDirectory() && entry.name.includes('.recovery.'));
        expect(recovery_directories).toHaveLength(1);

        const reopened = await within_no_hang_budget(open());
        expect(reopened.type).toBe('opened');
        if (reopened.type !== 'opened') throw new Error('expected a fresh database');
        await expect(reopened.opened.store.read('/sheet.csv')).resolves.toMatchObject({
            state: {},
        });
    });

    // Pinned to their literal values, not merely to each other. These two strings
    // are the identity recorded in `state_meta` and validated on every open, and
    // the desktop has nowhere to remember an alternative: a typo'd rename would
    // turn every existing user's perfectly healthy database into an unopenable
    // compatibility failure, while every other test in this file — which creates
    // its database fresh under the new id — kept passing.
    it('pins the identity strings that existing databases were created under', () => {
        expect(DESKTOP_STATE_DATABASE_ID).toBe('tableViewer.desktop.fileState.v1');
        expect(DESKTOP_STATE_STORAGE_ENVIRONMENT_ID).toBe('desktop');
        expect(DESKTOP_STATE_IDENTITY).toEqual({
            productKind: 'desktop',
            databaseId: 'tableViewer.desktop.fileState.v1',
            storageEnvironmentId: 'desktop',
        });
    });

    describe('failure log lines', () => {
        // The only thing about a failure that may be written to a log. Both fields
        // are provably safe — a closed category union, and an upstream-sanitized
        // short stage name — which is exactly why no desktop path logs the error
        // object: a raw ErrnoException carries the user's file path in `.path` and
        // again inside `.message`.
        it('emits the category, and the operation when there is one', () => {
            expect(desktop_state_failure_log_line({ category: 'io' })).toBe('category=io');
            expect(desktop_state_failure_log_line({
                category: 'recovery',
                operation: 'desktop-state-preflight',
            })).toBe('category=recovery operation=desktop-state-preflight');
        });

        it('reduces an arbitrary error to a category and leaks nothing else', () => {
            const secret = '/Users/someone/Documents/salaries.csv';
            const failure: NodeJS.ErrnoException = new Error(`EACCES: denied, open '${secret}'`);
            failure.code = 'EACCES';
            failure.path = secret;

            const line = desktop_state_error_log_line(failure);

            expect(line).toBe('category=unknown');
            expect(line).not.toContain(secret);
            expect(line).not.toContain('salaries');
            expect(line).not.toContain('EACCES');
        });

        it('says nothing beyond a category about a failed state open', async () => {
            seed_database_file('file-state.sqlite3', 'not a database');
            const result = await open();
            if (result.type !== 'failed') throw new Error('expected a failed open');

            const line = desktop_state_failure_log_line(result.failure);

            expect(line).not.toContain(userDataDir);
            expect(line).not.toContain(os.tmpdir());
            expect(line).not.toContain('file-state');
            expect(line).not.toContain('sqlite');
            // The sanitized stage name is the only free-form part, and it is
            // constrained to a short identifier upstream.
            expect(line).toMatch(/^category=[a-z-]+( operation=[A-Za-z][A-Za-z0-9_-]{0,63})?$/);
        });
    });
});
