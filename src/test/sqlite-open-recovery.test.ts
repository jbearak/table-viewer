import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteFileStateError } from '../sqlite-file-state-errors';
import { open_sqlite_file_state_store } from '../sqlite-file-state-persistence';
import {
    SQLITE_FILE_STATE_APPLICATION_ID,
    type SqliteDesktopFileStateIdentity,
} from '../sqlite-file-state-schema';
import {
    acquire_sqlite_exclusive_recovery_gate,
    acquire_sqlite_shared_reader_gate,
    assert_sqlite_directory_durability_supported,
    initialize_custom_sqlite_database_no_clobber,
    initialize_sqlite_database_no_clobber,
    inspect_sqlite_recovery_gate,
    install_recognized_sqlite_candidate_no_clobber,
    inventory_sqlite_basename,
    open_existing_sqlite_database,
    preserve_sqlite_basename_set,
    quarantine_malformed_sqlite_gate_markers,
    read_sqlite_raw_header,
    reclaim_stale_sqlite_exclusive_intent,
    recognize_sqlite_initialization_candidate,
    resume_sqlite_basename_preservation,
    type SqliteOpenRecoveryEvent,
} from '../sqlite-open-recovery';

let tempDirectory: string;
let childProcesses: ChildProcess[];

const identity: SqliteDesktopFileStateIdentity = {
    productKind: 'desktop',
    databaseId: 'desktop-database',
    storageEnvironmentId: 'desktop-environment',
};

const CUSTOM_APPLICATION_ID = 0x54564354;
const customSpec = {
    applicationId: CUSTOM_APPLICATION_ID,
    initialize(database: DatabaseSync) {
        database.exec(`
            PRAGMA journal_mode=DELETE;
            PRAGMA application_id=${CUSTOM_APPLICATION_ID};
            PRAGMA user_version=1;
            CREATE TABLE custom_state (id INTEGER PRIMARY KEY);
        `);
    },
    validate(database: DatabaseSync) {
        const row = database.prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name='custom_state'",
        ).get() as { name?: unknown } | undefined;
        if (row?.name !== 'custom_state') throw new Error('custom schema missing');
    },
};

function databasePath(name = 'file-state.sqlite3'): string {
    return path.join(tempDirectory, name);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function pollFor(predicate: () => boolean, description: string): Promise<void> {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`observable condition was not reached: ${description}`);
}

async function expectCategory(promise: Promise<unknown>, category: string): Promise<SqliteFileStateError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(SqliteFileStateError);
        expect((error as SqliteFileStateError).category).toBe(category);
        return error as SqliteFileStateError;
    }
    throw new Error(`expected ${category} failure`);
}

async function initialize(name = 'file-state.sqlite3'): Promise<void> {
    const result = await initialize_sqlite_database_no_clobber(
        databasePath(name),
        identity,
        { appliedAtMs: 100, appVersion: '0.7.0' },
    );
    await result.database.close();
}

function publicOpen() {
    return open_sqlite_file_state_store(databasePath(), {
        identity,
        migration: { appliedAtMs: 100, appVersion: '0.7.0' },
        clientKind: 'sqlite-open-recovery-test',
        clientVersion: '0.7.0',
        timeoutMs: 0,
    });
}

async function childReady(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        child.once('message', (message) => {
            if (message === 'ready') resolve();
            else reject(new Error('child sent an unexpected readiness message'));
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            reject(new Error(`child exited before readiness (${code ?? signal})`));
        });
    });
}

async function childExit(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-sqlite-open-recovery-'));
    childProcesses = [];
});

afterEach(async () => {
    vi.restoreAllMocks();
    for (const child of childProcesses) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await childExit(child);
        }
    }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('basename-scoped recovery gate', () => {
    it('closes the reader-token/exclusive-intent race and never admits the reader early', async () => {
        const tokenFlushed = deferred();
        const continueReader = deferred();
        let retryObserved = false;
        const readerPromise = acquire_sqlite_shared_reader_gate(databasePath(), {
            async onEvent(event) {
                if (event === 'reader-after-token-flush') {
                    tokenFlushed.resolve();
                    await continueReader.promise;
                }
                if (event === 'reader-retrying') retryObserved = true;
            },
        });

        await tokenFlushed.promise;
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        continueReader.resolve();
        await pollFor(() => retryObserved, 'reader removed its raced token');
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            exclusiveIntentTokenId: exclusive.tokenId,
            readerTokenIds: [],
        });

        await exclusive.release();
        const reader = await readerPromise;
        await reader.release();
    });

    it('holds exclusive intent while live readers drain', async () => {
        const reader = await acquire_sqlite_shared_reader_gate(databasePath());
        const waiting = deferred();
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath(), {
            onEvent(event) {
                if (event === 'exclusive-waiting-for-readers') waiting.resolve();
            },
        });
        const wait = exclusive.waitForReaders();
        await waiting.promise;
        expect(exclusive.listReaderTokenIds()).toEqual([reader.tokenId]);

        await reader.release();
        await wait;
        expect(exclusive.listReaderTokenIds()).toEqual([]);
        await exclusive.release();
    });

    it('reclaims only an exact stale reader token after explicit all-processes-closed confirmation', async () => {
        const reader = await acquire_sqlite_shared_reader_gate(databasePath());
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        expect(exclusive.listReaderTokenIds()).toEqual([reader.tokenId]);
        expect(inspect_sqlite_recovery_gate(databasePath())).toEqual({
            exclusiveIntentTokenId: exclusive.tokenId,
            exclusiveIntentMalformed: false,
            readerTokenIds: [reader.tokenId],
            malformedReaderTokenNames: [],
            recoveryBlocked: false,
            recoveryBlockMalformed: false,
        });

        await expectCategory(
            exclusive.reclaimStaleReaderToken('not-the-token', { allProcessesClosed: true }),
            'recovery',
        );
        await exclusive.reclaimStaleReaderToken(reader.tokenId, { allProcessesClosed: true });
        expect(exclusive.listReaderTokenIds()).toEqual([]);
        await exclusive.waitForReaders();
        await exclusive.release();
    });

    it('validates stale token IDs before path construction and requires inventory membership', async () => {
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        const gateDirectory = path.join(tempDirectory, '.file-state.sqlite3.recovery-gate');
        const outsidePath = path.join(gateDirectory, 'outside.reader');
        fs.writeFileSync(outsidePath, 'outside');

        await expectCategory(
            exclusive.reclaimStaleReaderToken('../outside', { allProcessesClosed: true }),
            'recovery',
        );
        expect(fs.readFileSync(outsidePath, 'utf8')).toBe('outside');
        fs.unlinkSync(outsidePath);
        await expectCategory(
            exclusive.reclaimStaleReaderToken(
                '00000000-0000-4000-8000-000000000001',
                { allProcessesClosed: true },
            ),
            'recovery',
        );
        await exclusive.release();
    });

    it('fails closed when reader-token inventory contains a malformed .reader entry', async () => {
        const reader = await acquire_sqlite_shared_reader_gate(databasePath());
        const readersDirectory = path.join(
            tempDirectory,
            '.file-state.sqlite3.recovery-gate',
            'readers',
        );
        const malformedPath = path.join(readersDirectory, 'not-a-uuid.reader');
        fs.writeFileSync(malformedPath, 'not-a-uuid');
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());

        expect(() => exclusive.listReaderTokenIds()).toThrow(SqliteFileStateError);
        // Inspection *classifies* this rather than throwing, which is the whole
        // point of separating it from the two enforcement callers: the entry is
        // reported as malformed alongside the valid token, so the attested
        // quarantine — the only thing allowed to clear it — is reachable. It
        // used to throw from here, which is precisely what made the condition
        // permanent: the open failed and the recovery action failed at the same
        // line. Enforcement stays strict, as `listReaderTokenIds` above proves.
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            readerTokenIds: [reader.tokenId],
            malformedReaderTokenNames: ['not-a-uuid.reader'],
        });
        await expectCategory(
            exclusive.reclaimStaleReaderToken(reader.tokenId, { allProcessesClosed: true }),
            'recovery',
        );
        expect(fs.existsSync(malformedPath)).toBe(true);
        expect(fs.existsSync(path.join(readersDirectory, `${reader.tokenId}.reader`))).toBe(true);

        fs.unlinkSync(malformedPath);
        await reader.release();
        await exclusive.waitForReaders();
        await exclusive.release();
    });

    it('fails closed on a symlinked managed gate directory', async () => {
        const target = path.join(tempDirectory, 'gate-target');
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(tempDirectory, '.file-state.sqlite3.recovery-gate'), 'dir');

        const error = await expectCategory(acquire_sqlite_shared_reader_gate(databasePath()), 'recovery');
        expect(error.message).not.toContain(tempDirectory);
        expect(fs.readdirSync(target)).toEqual([]);
    });

    it('fails closed on a symlinked managed readers directory', async () => {
        const gateDirectory = path.join(tempDirectory, '.file-state.sqlite3.recovery-gate');
        const target = path.join(tempDirectory, 'readers-target');
        fs.mkdirSync(gateDirectory);
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(gateDirectory, 'readers'), 'dir');

        const error = await expectCategory(acquire_sqlite_shared_reader_gate(databasePath()), 'recovery');
        expect(error.message).not.toContain(tempDirectory);
        expect(fs.readdirSync(target)).toEqual([]);
    });

    it('refuses to mutate a replaced readers directory when releasing an exact token', async () => {
        const reader = await acquire_sqlite_shared_reader_gate(databasePath());
        const gateDirectory = path.join(tempDirectory, '.file-state.sqlite3.recovery-gate');
        const readersDirectory = path.join(gateDirectory, 'readers');
        const displaced = path.join(gateDirectory, 'readers-displaced');
        fs.renameSync(readersDirectory, displaced);
        fs.mkdirSync(readersDirectory);
        const replacementToken = path.join(readersDirectory, `${reader.tokenId}.reader`);
        fs.writeFileSync(replacementToken, reader.tokenId);

        const error = await expectCategory(reader.release(), 'recovery');
        expect(error.message).not.toContain(tempDirectory);
        expect(fs.readFileSync(replacementToken, 'utf8')).toBe(reader.tokenId);
    });

    it('does not use age, PID, or TTL to steal reader tokens', async () => {
        const reader = await acquire_sqlite_shared_reader_gate(databasePath());
        const gateDirectory = path.join(tempDirectory, '.file-state.sqlite3.recovery-gate', 'readers');
        const tokenPath = path.join(gateDirectory, `${reader.tokenId}.reader`);
        fs.utimesSync(tokenPath, new Date(0), new Date(0));

        const waiting = deferred();
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath(), {
            onEvent(event) {
                if (event === 'exclusive-waiting-for-readers') waiting.resolve();
            },
        });
        const wait = exclusive.waitForReaders();
        await waiting.promise;
        expect(exclusive.listReaderTokenIds()).toEqual([reader.tokenId]);
        await reader.release();
        await wait;
        await exclusive.release();
    });
});

describe('attested quarantine of malformed gate markers', () => {
    const attested = { allProcessesClosed: true } as const;

    function gateDirectory(): string {
        return path.join(tempDirectory, '.file-state.sqlite3.recovery-gate');
    }

    function readersDirectory(): string {
        return path.join(gateDirectory(), 'readers');
    }

    /**
     * The quarantine subtree the module creates, by name.
     *
     * Used by the become-valid-mid-run tests as their cut point: its appearance
     * means classification is finished and the renames have not started, which is
     * exactly the window those tests need and is observable rather than counted.
     */
    function quarantineRoot(): string {
        return path.join(gateDirectory(), 'quarantined-markers');
    }

    /** The single quarantine generation one run creates, as an absolute path. */
    function soleQuarantineGeneration(): string {
        const root = path.join(gateDirectory(), 'quarantined-markers');
        const generations = fs.readdirSync(root);
        expect(generations).toHaveLength(1);
        return path.join(root, generations[0]);
    }

    /** Exactly what a crash between the marker's `open` and its `write` leaves:
     *  the entry exists and is empty. Not hand-edited residue — the gate's own
     *  `write_private_file_exclusive` creates every marker this way. */
    function tearMarker(name: string): string {
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const markerPath = path.join(gateDirectory(), name);
        fs.writeFileSync(markerPath, '', { mode: 0o600 });
        return markerPath;
    }

    it('classifies a torn exclusive intent instead of throwing, and quarantines it', async () => {
        const intentPath = tearMarker('exclusive-intent');

        // Before: inspection threw `exclusive-intent-inspect` from here, and it
        // runs *before* — and gates — `reclaim_stale_sqlite_exclusive_intent`,
        // the only attested path that could have cleared the file. So the torn
        // marker made both the open and the recovery action fail identically,
        // forever, while the reader gate spun on the marker's mere presence.
        const inspected = inspect_sqlite_recovery_gate(databasePath());
        expect(inspected.exclusiveIntentMalformed).toBe(true);
        // Absent as a property, not merely undefined: `preflight_recovery_condition`
        // and the reclamation both discriminate on presence.
        expect('exclusiveIntentTokenId' in inspected).toBe(false);

        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);

        expect(result.movedCount).toBe(1);
        expect(fs.existsSync(intentPath)).toBe(false);
        // Moved, never deleted: the empty file is evidence that a write was cut
        // between its `open` and its `write`, which is a different diagnosis
        // from a marker that was never created at all.
        expect(fs.readdirSync(soleQuarantineGeneration())).toEqual(['exclusive-intent']);
        expect(inspect_sqlite_recovery_gate(databasePath()).exclusiveIntentMalformed).toBe(false);
        // The birth-time capability probe leaves nothing behind. It writes a
        // throwaway file into this very directory to decide whether `createdAt` is a
        // usable discriminator here, and a leaked probe file would sit in the gate
        // directory of every user who ever hit the quarantine — listed by the
        // diagnostics window as unexplained residue next to real evidence.
        expect(fs.readdirSync(gateDirectory()).filter((name) => name.includes('birthtime')))
            .toEqual([]);
        // And the gate is acquirable again, which is the escape that did not exist.
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await exclusive.release();
    });

    it.each([
        ['exclusive-intent'],
        ['recovery-block.json'],
    ] as const)('classifies an oversized %s as malformed without reading it whole', async (name) => {
        // These markers are read on the *startup* path, in the main process, before
        // any window or dialog exists. Nothing this module writes could produce a
        // large one — an intent is a uuid, a blockade is a three-field object — but
        // they are plain files in a user-visible directory, and a backup restore, a
        // sync client, or an unrelated tool can leave anything at all on the name. An
        // unbounded read there hangs or OOMs the launch with no UI to explain it,
        // which contradicts this module's whole posture: a damaged gate produces a
        // dialog, never a dead process.
        //
        // A *sparse* 8 GiB file: `ftruncate` gives it that apparent size while using
        // almost no blocks, so the test stays fast and does not need 8 GiB of disk.
        // It is also the decisive size rather than a merely large one — an unbounded
        // `readFileSync` on it fails `ERR_STRING_TOO_LONG`, which is not ENOENT and so
        // propagates out of inspection as `recovery-gate-inspect`: the preflight
        // refuses the open, the quarantine throws from the same shape, and the dialog
        // loops with no exit. That is the permanent dead-end this module is built to
        // never have, and it is what the bound prevents. A merely large file would
        // parse successfully and prove nothing.
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const markerPath = path.join(gateDirectory(), name);
        const descriptor = fs.openSync(markerPath, 'w', 0o600);
        fs.ftruncateSync(descriptor, 8 * 1024 * 1024 * 1024);
        fs.closeSync(descriptor);

        // Malformed, not valid and not absent: an oversized file obstructs everything
        // a well-formed marker would, so it must be visible to inspection.
        const inspected = inspect_sqlite_recovery_gate(databasePath());
        if (name === 'exclusive-intent') {
            expect(inspected.exclusiveIntentMalformed).toBe(true);
            // Emphatically not reported as a token id: `reclaim_stale_sqlite_exclusive_intent`
            // *unlinks* what it is given, and its guard is a bare contents comparison.
            expect('exclusiveIntentTokenId' in inspected).toBe(false);
        } else {
            expect(inspected.recoveryBlockMalformed).toBe(true);
            expect(inspected.recoveryBlocked).toBe(false);
        }

        // And the escape works: the attested quarantine moves it, so the gate is
        // usable again rather than permanently blocked by an unparseable file.
        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);
        expect(result.movedCount).toBe(1);
        expect(fs.existsSync(markerPath)).toBe(false);
        // Moved, not truncated or deleted: it is still evidence, at its full size.
        expect(fs.statSync(path.join(soleQuarantineGeneration(), name)).size)
            .toBe(8 * 1024 * 1024 * 1024);
    });

    it('treats an oversized reader token as malformed, never as a live reader', async () => {
        // The same bound on the readers directory, where it matters most: this read
        // runs once per entry, so an unbounded one is the startup hang multiplied by
        // however many entries are present. Classifying it as a live token would be
        // worse than slow — `waitForReaders` would then block forever on a reader
        // that never existed.
        const tokenId = '00000000-0000-4000-8000-000000000001';
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const tokenPath = path.join(readersDirectory(), `${tokenId}.reader`);
        // Sparse and past the string limit, for the reason given in the sibling above:
        // unbounded, this read throws ERR_STRING_TOO_LONG and turns inspection itself
        // into the dead-end totality exists to prevent.
        const descriptor = fs.openSync(tokenPath, 'w', 0o600);
        fs.ftruncateSync(descriptor, 8 * 1024 * 1024 * 1024);
        fs.closeSync(descriptor);

        const inspected = inspect_sqlite_recovery_gate(databasePath());
        expect(inspected.readerTokenIds).toEqual([]);
        expect(inspected.malformedReaderTokenNames).toEqual([`${tokenId}.reader`]);

        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);
        expect(result.movedCount).toBe(1);
        expect(fs.existsSync(tokenPath)).toBe(false);
        // The enforcer agrees, which is the property that keeps the gate acquirable.
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        expect(exclusive.listReaderTokenIds()).toEqual([]);
        await exclusive.waitForReaders();
        await exclusive.release();
    });

    it.each([
        ['zero-length', ''],
        ['non-UUID text', 'garbage-not-a-token'],
        ['UUID-shaped but not a v4 UUID', '00000000-0000-0000-0000-000000000000'],
    ] as const)('quarantines rather than reclaims a %s exclusive intent', async (_label, contents) => {
        // Classification is what decides *which* clearing path an intent takes,
        // and the two paths differ in a way the constraints care about:
        // quarantine **moves**, while `reclaim_stale_sqlite_exclusive_intent`
        // **unlinks**. Its guard is `exact_token_matches`, a bare contents
        // comparison with no shape check at all — so anything the classifier
        // reports as a valid token id can be handed straight back to it and
        // deleted. Only `classify_exclusive_intent`'s UUID check keeps a
        // non-token out of that path, which makes it the line standing between
        // "evidence preserved" and "evidence destroyed", not a cosmetic filter.
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const intentPath = path.join(gateDirectory(), 'exclusive-intent');
        fs.writeFileSync(intentPath, contents, { mode: 0o600 });

        const inspected = inspect_sqlite_recovery_gate(databasePath());
        expect(inspected.exclusiveIntentMalformed).toBe(true);
        // Never offered as a reclaimable token id: the desktop feeds exactly
        // this field to `reclaim_stale_sqlite_exclusive_intent`.
        expect('exclusiveIntentTokenId' in inspected).toBe(false);

        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);

        expect(result.movedCount).toBe(1);
        // Moved with its bytes intact, not unlinked. Asserting only that the
        // live gate no longer holds it would pass against a delete.
        expect(fs.existsSync(intentPath)).toBe(false);
        expect(fs.readFileSync(
            path.join(soleQuarantineGeneration(), 'exclusive-intent'),
            'utf8',
        )).toBe(contents);
    });

    it('classifies a torn recovery block instead of routing it to an unparseable resume', async () => {
        const blockPath = tearMarker('recovery-block.json');

        // `existsSync` reported this as a genuine blockade, so the desktop routed
        // to `resume_sqlite_basename_preservation`, whose `read_recovery_block`
        // then threw on `JSON.parse` — a blockade nothing could lift.
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            recoveryBlocked: false,
            recoveryBlockMalformed: true,
        });

        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);

        expect(result.movedCount).toBe(1);
        expect(fs.existsSync(blockPath)).toBe(false);
        expect(fs.readdirSync(soleQuarantineGeneration())).toEqual(['recovery-block.json']);
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            recoveryBlocked: false,
            recoveryBlockMalformed: false,
        });
    });

    it('classifies a reader token whose name is valid but whose contents are not', async () => {
        // The strict inventory validates only the filename, so this was counted
        // as a live reader: `reclaimStaleReaderToken` then failed its exact-token
        // check and `waitForReaders` spun on a reader that never existed. The
        // desktop-side quarantine covered unparseable *names* only, by design, so
        // nothing could clear it.
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const impostorId = '00000000-0000-4000-8000-000000000001';
        const impostorPath = path.join(readersDirectory(), `${impostorId}.reader`);
        fs.writeFileSync(impostorPath, 'not-its-own-id', { mode: 0o600 });

        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            readerTokenIds: [],
            malformedReaderTokenNames: [`${impostorId}.reader`],
        });

        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);

        expect(result.movedCount).toBe(1);
        expect(fs.existsSync(impostorPath)).toBe(false);
        expect(fs.readFileSync(
            path.join(soleQuarantineGeneration(), `${impostorId}.reader`),
            'utf8',
        )).toBe('not-its-own-id');
        // The exclusive wait now completes instead of spinning forever.
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await exclusive.waitForReaders();
        await exclusive.release();
    });

    it('leaves a valid intent and a valid reader token completely untouched', async () => {
        // The exact-token semantics the quarantine may not weaken: a well-formed
        // marker is indistinguishable from a live peer's, so clearing one stays
        // the exclusive gate's exact-id path. There is no age, PID, TTL, or
        // heartbeat here — the impostor is set aside for what it *is*, not for
        // how old it is, which is why its timestamps are made ancient and the
        // valid token's are not.
        const reader = await acquire_sqlite_shared_reader_gate(databasePath());
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        const validTokenPath = path.join(readersDirectory(), `${reader.tokenId}.reader`);
        const impostorPath = path.join(readersDirectory(), 'not-a-uuid.reader');
        fs.writeFileSync(impostorPath, 'impostor', { mode: 0o600 });
        fs.utimesSync(validTokenPath, new Date(0), new Date(0));

        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);

        expect(result.movedCount).toBe(1);
        expect(fs.readFileSync(validTokenPath, 'utf8')).toBe(reader.tokenId);
        expect(fs.readFileSync(path.join(tempDirectory, '.file-state.sqlite3.recovery-gate', 'exclusive-intent'), 'utf8'))
            .toBe(exclusive.tokenId);
        expect(fs.readdirSync(soleQuarantineGeneration())).toEqual(['not-a-uuid.reader']);
        // Still the live gate's own markers afterwards, by the gate's own checks.
        expect(exclusive.listReaderTokenIds()).toEqual([reader.tokenId]);
        await reader.release();
        await exclusive.release();
    });

    it('moves all three malformed shapes in one attested run and creates one generation', async () => {
        tearMarker('exclusive-intent');
        tearMarker('recovery-block.json');
        fs.writeFileSync(path.join(readersDirectory(), 'not-a-uuid.reader'), 'x', { mode: 0o600 });

        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);

        expect(result.movedCount).toBe(3);
        expect(fs.readdirSync(soleQuarantineGeneration()).sort()).toEqual([
            'exclusive-intent',
            'not-a-uuid.reader',
            'recovery-block.json',
        ]);
        expect(fs.readdirSync(readersDirectory())).toEqual([]);
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            exclusiveIntentMalformed: false,
            malformedReaderTokenNames: [],
            recoveryBlockMalformed: false,
        });
    });

    it.each([
        ['wrong format', (block: any) => { block.format = 'tableViewer.sqliteRecoveryBlock.v2'; }],
        ['missing format', (block: any) => { delete block.format; }],
        ['non-string generation', (block: any) => { block.generation = 7; }],
        // The generation *and* the directory name are moved together, so the
        // directory-name check is satisfied and only the UUID check can reject
        // this. Mutating the generation alone would be caught by the other
        // clause, leaving the UUID check itself unpinned.
        ['self-consistent non-UUID generation', (block: any) => {
            block.generation = 'not-a-uuid';
            block.recoveryDirectoryName = 'file-state.sqlite3.recovery.not-a-uuid';
        }],
        ['foreign recovery directory', (block: any) => {
            block.recoveryDirectoryName = `other.sqlite3.recovery.${block.generation}`;
        }],
        ['generation/directory disagreement', (block: any) => {
            block.recoveryDirectoryName
                = 'file-state.sqlite3.recovery.00000000-0000-4000-8000-0000000000ff';
        }],
    ] as const)('classifies a blockade with %s as malformed, exactly as the enforcer rejects it', async (
        _label,
        mutate,
    ) => {
        // The acceptance boundary of `parse_recovery_block`, pinned from *both*
        // sides at once. `classify_recovery_block` and `read_recovery_block`
        // share that one predicate rather than each carrying a copy, and this is
        // what makes weakening it visible: a laxer predicate would report the
        // marker as a legitimate blockade here, the desktop would route to
        // `resume_sqlite_basename_preservation` on that word, and the enforcer
        // would then refuse to parse the very file the classifier vouched for —
        // dead-end (b), reintroduced by editing one of two duplicated checks.
        //
        // Asserting the two *agree* would only pin the shapes enumerated below.
        // Sharing the predicate is what makes disagreement unrepresentable; these
        // cases pin the boundary itself so a shared weakening is caught too.
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const block: Record<string, unknown> = {
            format: 'tableViewer.sqliteRecoveryBlock.v1',
            generation: '00000000-0000-4000-8000-000000000001',
            recoveryDirectoryName:
                'file-state.sqlite3.recovery.00000000-0000-4000-8000-000000000001',
        };
        mutate(block);
        const blockPath = path.join(gateDirectory(), 'recovery-block.json');
        fs.writeFileSync(blockPath, JSON.stringify(block), { mode: 0o600 });

        // Classifier side: malformed, never a valid blockade.
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            recoveryBlocked: false,
            recoveryBlockMalformed: true,
        });

        // Enforcer side, through the resume path that reads the same marker: it
        // refuses rather than acting on it. Reached with a real exclusive gate so
        // this is the production path, not a direct call to an internal.
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await expectCategory(
            resume_sqlite_basename_preservation(databasePath(), { gate: exclusive }),
            'recovery',
        );

        // And the attested quarantine can clear it, which is the escape that a
        // marker classified valid-but-unreadable would never have reached.
        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);
        expect(result.movedCount).toBe(1);
        expect(fs.readdirSync(soleQuarantineGeneration())).toEqual(['recovery-block.json']);
        expect(fs.existsSync(blockPath)).toBe(false);
    });

    it.each([
        ['bare parent', '..'],
        ['parent-relative sibling', '../SIBLING'],
        ['nested traversal', '../../ESCAPE'],
        // The worst shape: an empty, recovery-directory-shaped entry in the
        // basename namespace is exactly what `find_empty_pre_manifest_preservation`
        // selects and what `inventory_sqlite_basename` counts as incomplete. Two
        // of them make `orphan-preservation-count` throw and
        // `preserve_sqlite_basename_set` refuse outright — the primitive whose
        // only job is restoring recoverability manufacturing an unrecoverable
        // state instead.
        ['recovery-directory shape', '../file-state.sqlite3.recovery.00000000-0000-4000-8000-0000000000aa'],
        ['nested path', 'nested/child'],
        ['current directory', '.'],
        ['empty', ''],
    ] as const)('refuses a %s quarantine name and creates nothing outside the gate', async (
        _label,
        quarantineDirectoryName,
    ) => {
        // The name reaches `path.join(gate.physicalPath, name)`, so a traversal
        // escapes the gate entirely. `capture_managed_directory` does reject it
        // — but only *after* `mkdirSync` already created the directory somewhere
        // else, and the failing path then leaves it behind. So the parent
        // listing, not merely the thrown category, is the assertion that matters:
        // a check placed after the mkdir passes a category-only test.
        const intentPath = tearMarker('exclusive-intent');
        const parentBefore = fs.readdirSync(tempDirectory).sort();
        const gateBefore = fs.readdirSync(gateDirectory()).sort();

        const error = await expectCategory(
            quarantine_malformed_sqlite_gate_markers(databasePath(), attested, {
                quarantineDirectoryName,
            }),
            'recovery',
        );

        expect(error.message).not.toContain(tempDirectory);
        // Nothing created anywhere: not beside the gate, not in the basename
        // namespace, not inside the gate itself.
        expect(fs.readdirSync(tempDirectory).sort()).toEqual(parentBefore);
        expect(fs.readdirSync(gateDirectory()).sort()).toEqual(gateBefore);
        // And the marker it was asked to quarantine is untouched, so the refusal
        // is total rather than partial.
        expect(fs.existsSync(intentPath)).toBe(true);
    });

    it.each([
        ['reader token', 'token'],
        ['exclusive intent', 'intent'],
        ['recovery blockade', 'block'],
    ] as const)('does not move a %s that becomes valid between classification and rename', async (
        _label,
        kind,
    ) => {
        // Not an injected-hook artifact: this is precisely the transient
        // `write_private_file_exclusive` produces — `openSync('wx')` → *(a
        // zero-length file exists right here)* → `writeFileSync` → `fsync`. A
        // live peer mid-`acquire_sqlite_shared_reader_gate` sits in that state
        // for real, and two `mkdirSync`, two `flush_directory`, and a
        // `capture_managed_directory` separate classification from the first
        // rename. Moving the file anyway evicted a live reader on content shape
        // alone, with none of the exact-id attestation this primitive promises:
        // the peer's write then landed in the moved file and it returned a gate
        // it believed was live, while a fresh exclusive gate saw no readers.
        const tokenId = '00000000-0000-4000-8000-000000000001';
        const generationId = '00000000-0000-4000-8000-0000000000cc';
        const completions = {
            token: {
                markerPath: path.join(readersDirectory(), `${tokenId}.reader`),
                becomesValid: tokenId,
            },
            intent: {
                markerPath: path.join(gateDirectory(), 'exclusive-intent'),
                becomesValid: '00000000-0000-4000-8000-0000000000bb',
            },
            block: {
                markerPath: path.join(gateDirectory(), 'recovery-block.json'),
                becomesValid: JSON.stringify({
                    format: 'tableViewer.sqliteRecoveryBlock.v1',
                    generation: generationId,
                    recoveryDirectoryName: `file-state.sqlite3.recovery.${generationId}`,
                }),
            },
        }[kind];
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        // The zero-length instant, exactly as a crash or an in-flight peer leaves it.
        fs.writeFileSync(completions.markerPath, '', { mode: 0o600 });

        let peerCompleted = false;
        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested, {
            // Keyed on the quarantine root appearing, not on a flush ordinal — see
            // `quarantineRoot`. Its existence means classification is finished and
            // no rename has started, which is the window this test needs, and it is
            // observable rather than counted.
            fsyncDirectory(descriptor) {
                if (!peerCompleted && fs.existsSync(quarantineRoot())) {
                    peerCompleted = true;
                    fs.writeFileSync(completions.markerPath, completions.becomesValid);
                }
                fs.fsyncSync(descriptor);
            },
        });

        expect(peerCompleted).toBe(true);
        // Left alone: the marker is valid now, whatever it looked like when it
        // was classified, so clearing it belongs to the exclusive gate's
        // exact-id path and not to this one.
        expect(result.movedCount).toBe(0);
        expect(fs.readFileSync(completions.markerPath, 'utf8')).toBe(completions.becomesValid);
        // Nothing was quarantined. A generation directory is only created when a
        // move is attempted and only kept when one succeeded, so after a wholly
        // refused run there is either no root at all or no generation under it.
        const generations = fs.existsSync(quarantineRoot())
            ? fs.readdirSync(quarantineRoot())
            : [];
        expect(generations).toEqual([]);
    });

    it('still moves a marker whose bytes churn but never become a token', async () => {
        // The other side of the re-check: it must refuse markers that turned
        // *valid*, not refuse everything. Written same-length and in place, so
        // device, inode, and size all still match and only the validity question
        // decides — without this case, a `move` that returned early
        // unconditionally would satisfy every "does not move" test above while
        // silently making the whole primitive a no-op.
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const intentPath = path.join(gateDirectory(), 'exclusive-intent');
        fs.writeFileSync(intentPath, 'aaaaaaaa', { mode: 0o600 });
        const before = fs.lstatSync(intentPath);

        // Keyed on the quarantine root appearing rather than on a flush ordinal, and
        // one-shot so the rewrite happens exactly once. `rewritten` is asserted
        // below: without it a guard that never fired would leave every assertion
        // here passing over a marker that was never churned at all.
        let rewritten = false;
        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested, {
            fsyncDirectory(descriptor) {
                if (!rewritten && fs.existsSync(quarantineRoot())) {
                    rewritten = true;
                    fs.writeFileSync(intentPath, 'bbbbbbbb');
                }
                fs.fsyncSync(descriptor);
            },
        });

        expect(rewritten).toBe(true);
        // Same incarnation, same size, still not a uuid — so it is still nobody's
        // live marker and the quarantine may set it aside.
        expect(fs.lstatSync(path.join(soleQuarantineGeneration(), 'exclusive-intent')).ino)
            .toBe(before.ino);
        expect(result.movedCount).toBe(1);
        expect(fs.existsSync(intentPath)).toBe(false);
        expect(fs.readFileSync(
            path.join(soleQuarantineGeneration(), 'exclusive-intent'),
            'utf8',
        )).toBe('bbbbbbbb');
    });

    it.each([
        ['exclusive intent', 'intent'],
        ['reader token', 'token'],
    ] as const)('does not move a %s that becomes valid in place, same inode and same size', async (
        _label,
        kind,
    ) => {
        // The re-classification, isolated from the identity comparison. Both
        // markers here start as a 36-character non-token and become a
        // 36-character uuid written in place, so device, inode, and size are all
        // unchanged and *only* re-reading the contents can tell the difference.
        // Without this pair, deleting the `stillMalformed` check leaves every
        // other TOCTOU test passing, because those transitions happen to change
        // the file's length.
        const tokenId = '00000000-0000-4000-8000-000000000001';
        const target = {
            intent: {
                markerPath: path.join(gateDirectory(), 'exclusive-intent'),
                malformed: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
                becomesValid: '00000000-0000-4000-8000-0000000000bb',
            },
            token: {
                markerPath: path.join(readersDirectory(), `${tokenId}.reader`),
                malformed: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
                becomesValid: tokenId,
            },
        }[kind];
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target.markerPath, target.malformed, { mode: 0o600 });
        const before = fs.lstatSync(target.markerPath);
        expect(target.malformed).toHaveLength(target.becomesValid.length);

        // Swapped on the first flush that happens *after* classification, found by
        // observing the quarantine directory the run creates rather than by
        // counting calls. An ordinal ("the third flush") encodes how many
        // directories the implementation happens to flush, which differs with the
        // filesystem — it passed locally and failed on CI's tmpfs, where the count
        // is not the same. `swapped` keeps it to exactly one write.
        let swapped = false;
        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested, {
            fsyncDirectory(descriptor) {
                if (!swapped && fs.existsSync(quarantineRoot())) {
                    swapped = true;
                    fs.writeFileSync(target.markerPath, target.becomesValid);
                }
                fs.fsyncSync(descriptor);
            },
        });
        expect(swapped).toBe(true);

        const after = fs.lstatSync(target.markerPath);
        // Proves the identity check cannot be what saved it.
        expect(after.ino).toBe(before.ino);
        expect(after.size).toBe(before.size);
        expect(result.movedCount).toBe(0);
        expect(fs.readFileSync(target.markerPath, 'utf8')).toBe(target.becomesValid);
    });

    // Note on coverage: the *guard* is exercised everywhere, but the specific
    // hazard it defends against — a recreate that recycles the freed inode, so
    // device, inode, and size all still match — only occurs where the filesystem
    // recycles. ext4 and tmpfs do; APFS does not. So this passes on macOS whether
    // or not the guard is correct, and only the Linux runner can tell the
    // difference. It caught the missing creation-time field from CI while no local
    // run ever reproduced it.
    //
    // A deterministic collision was attempted and abandoned: a hardlink shares
    // inode *and* birthtime, so it cannot stand in for a recreate. Do not
    // "simplify" this to a local-only assertion, and do not assert that the inode
    // changed — reuse is the case under test, not a failure of it.
    it('refuses a marker replaced by a different file of the same size', async () => {
        // Identity, not just size: an unlink-and-recreate leaves the byte count
        // unchanged while the inode changes, and whatever wrote it is a party
        // this run never classified.
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const intentPath = path.join(gateDirectory(), 'exclusive-intent');
        fs.writeFileSync(intentPath, 'aaaaaaaa', { mode: 0o600 });
        const original = fs.lstatSync(intentPath, { bigint: true });

        // Keyed on the quarantine directory appearing, not on a flush ordinal —
        // see the sibling test above for why counting calls is not portable.
        let swapped = false;
        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested, {
            fsyncDirectory(descriptor) {
                if (!swapped && fs.existsSync(quarantineRoot())) {
                    swapped = true;
                    fs.unlinkSync(intentPath);
                    fs.writeFileSync(intentPath, 'cccccccc', { mode: 0o600 });
                }
                fs.fsyncSync(descriptor);
            },
        });

        expect(swapped).toBe(true);
        const replacement = fs.lstatSync(intentPath, { bigint: true });
        // Deliberately *not* asserting the inode changed. Whether the recreate
        // lands on a fresh inode or recycles the freed one is the filesystem's
        // choice — ext4 and tmpfs reuse it, APFS does not — and the reuse case is
        // precisely the hazard this guard exists for. Asserting a change would
        // demand the collision never happen, which is the opposite of the point,
        // and it failed on CI for exactly that reason (`expected 8947075 not to be
        // 8947075`) *after* the guard had already done its job.
        //
        // What must hold on every filesystem: the replacement is a different
        // incarnation, so the marker is refused and left where it is with the
        // replacement's bytes intact. Those two assertions are the test.
        //
        // The birth times differing is *not* universal, and asserting it
        // unconditionally would fail before those two ever ran. A filesystem with no
        // birth time reports a stable `0` on both sides, which is exactly the case
        // the production guard measures for and degrades around — and there the
        // refusal comes from the inode, or from the `stillMalformed` re-read, not
        // from this field. So it is asserted only where a birth time is recorded at
        // all, which is what makes it an assertion about the discriminator rather
        // than about the host.
        if (original.birthtimeNs !== 0n && replacement.birthtimeNs !== 0n) {
            expect(replacement.birthtimeNs).not.toBe(original.birthtimeNs);
        }
        expect(result.movedCount).toBe(0);
        expect(fs.readFileSync(intentPath, 'utf8')).toBe('cccccccc');
    });

    it.each([
        ['directory', (target: string) => fs.mkdirSync(target)],
        ['symlink', (target: string) => fs.symlinkSync('/nonexistent-target', target)],
        ['fifo', (target: string) => execFileSync('mkfifo', [target])],
    ] as const)('reports and clears a %s occupying a reader-token name', async (_label, create) => {
        // A non-regular file on a token's name is refused by
        // `existing_reader_token_ids`, so it *must* be visible to inspection and
        // clearable by the quarantine. When it was neither, the result was worse
        // than the original dead-end: the preflight saw nothing, so the app
        // opened normally and said nothing, and then every preserve failed with
        // `reader-token-inventory` while the dialog kept offering "Set Aside" —
        // no in-app escape, and no warning either.
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const name = '00000000-0000-4000-8000-000000000001.reader';
        const target = path.join(readersDirectory(), name);
        create(target);

        // Visible to inspection, which is what the preflight refuses on.
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            readerTokenIds: [],
            malformedReaderTokenNames: [name],
        });
        // And genuinely fatal to the enforcer until cleared, which is why
        // inspection reporting it is load-bearing rather than cosmetic.
        const blocked = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        expect(() => blocked.listReaderTokenIds()).toThrow(SqliteFileStateError);
        await blocked.release();

        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);

        expect(result.movedCount).toBe(1);
        expect(fs.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
        // Moved as the thing it is, not deleted and not dereferenced: a symlink
        // arrives as a symlink, a directory as a directory.
        const quarantined = path.join(soleQuarantineGeneration(), name);
        expect(fs.lstatSync(quarantined, { throwIfNoEntry: false })).toBeDefined();
        expect(fs.readdirSync(soleQuarantineGeneration())).toEqual([name]);
        // The escape works end to end: the enforcer runs again.
        const recovered = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        expect(recovered.listReaderTokenIds()).toEqual([]);
        await recovered.waitForReaders();
        await recovered.release();
    });

    it('does not move a non-file marker replaced by a real one before the rename', async () => {
        // The non-file branch has no identity to compare and no contents to
        // re-classify, so its only protection is re-confirming the entry is
        // still not a regular file. Without that it would rename whatever now
        // occupies the name — including a genuine marker a live peer wrote in
        // the meantime, which is the same eviction-by-stale-classification the
        // identity check exists to prevent, reached by the other branch.
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const intentPath = path.join(gateDirectory(), 'exclusive-intent');
        fs.mkdirSync(intentPath);
        const liveToken = '00000000-0000-4000-8000-0000000000bb';

        // Keyed on the quarantine root appearing — after classification, before any
        // rename — rather than on a flush ordinal, and one-shot. A peer clears the
        // obstruction and takes the gate inside that window. `replaced` is asserted
        // below so a guard that never fired cannot pass this test vacuously: an
        // untouched directory is refused for the wrong reason and every assertion
        // here would still hold.
        let replaced = false;
        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested, {
            fsyncDirectory(descriptor) {
                if (!replaced && fs.existsSync(quarantineRoot())) {
                    replaced = true;
                    fs.rmSync(intentPath, { recursive: true, force: true });
                    fs.writeFileSync(intentPath, liveToken, { mode: 0o600 });
                }
                fs.fsyncSync(descriptor);
            },
        });

        expect(replaced).toBe(true);
        expect(result.movedCount).toBe(0);
        // The peer's intent is intact and still a live exclusive claim.
        expect(fs.readFileSync(intentPath, 'utf8')).toBe(liveToken);
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            exclusiveIntentTokenId: liveToken,
            exclusiveIntentMalformed: false,
        });
    });

    it.each([
        ['exclusive-intent'],
        ['recovery-block.json'],
    ] as const)('classifies a directory occupying %s instead of throwing', async (name) => {
        // Inspection is meant to be total. It was not total over *file types*: a
        // directory on either marker's name made `readFileSync` fail EISDIR,
        // which is not ENOENT and so propagated as `recovery-gate-inspect` — the
        // preflight refused the open, the quarantine threw from the same shape,
        // and the dialog looped with no exit. Rarer than a torn write, same
        // permanence.
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const target = path.join(gateDirectory(), name);
        fs.mkdirSync(target);
        // Something inside, so a "cleared" implementation that quietly removed an
        // empty directory instead of moving it would be caught.
        fs.writeFileSync(path.join(target, 'evidence'), 'why it got this way');

        const inspected = inspect_sqlite_recovery_gate(databasePath());
        expect(name === 'exclusive-intent'
            ? inspected.exclusiveIntentMalformed
            : inspected.recoveryBlockMalformed).toBe(true);
        // Never offered as a usable marker: the desktop feeds these to the
        // reclamation and the resume path respectively.
        expect('exclusiveIntentTokenId' in inspected).toBe(false);
        expect(inspected.recoveryBlocked).toBe(false);

        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);

        expect(result.movedCount).toBe(1);
        expect(fs.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
        // Moved whole, contents and all.
        expect(fs.readFileSync(
            path.join(soleQuarantineGeneration(), name, 'evidence'),
            'utf8',
        )).toBe('why it got this way');
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            exclusiveIntentMalformed: false,
            recoveryBlockMalformed: false,
        });
    });

    it('refuses without the all-processes-closed attestation and moves nothing', async () => {
        const intentPath = tearMarker('exclusive-intent');

        for (const confirmation of [
            { allProcessesClosed: false },
            {},
        ] as unknown as Array<{ allProcessesClosed: true }>) {
            await expectCategory(
                quarantine_malformed_sqlite_gate_markers(databasePath(), confirmation),
                'recovery',
            );
        }

        expect(fs.readFileSync(intentPath, 'utf8')).toBe('');
        expect(fs.existsSync(path.join(gateDirectory(), 'quarantined-markers'))).toBe(false);
    });

    it('creates nothing when every marker is well formed', async () => {
        const reader = await acquire_sqlite_shared_reader_gate(databasePath());

        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);

        expect(result).toEqual({ movedCount: 0 });
        expect(fs.existsSync(path.join(gateDirectory(), 'quarantined-markers'))).toBe(false);
        await reader.release();
    });

    it('moves nothing through a symlinked gate directory', async () => {
        // The case a leaf-only check cannot see: through a symlinked *gate*,
        // `readers/` is a genuine directory that passes its own lstat while every
        // path built from it resolves into the link target. Both this and the
        // symlinked-leaf case are covered by the same captured-parent discipline.
        const outside = path.join(tempDirectory, 'outside');
        fs.mkdirSync(path.join(outside, 'readers'), { recursive: true, mode: 0o700 });
        const decoy = path.join(outside, 'readers', 'not-a-uuid.reader');
        fs.writeFileSync(decoy, 'outside the gate', { mode: 0o600 });
        fs.symlinkSync(outside, gateDirectory(), 'dir');

        const error = await expectCategory(
            quarantine_malformed_sqlite_gate_markers(databasePath(), attested),
            'recovery',
        );

        expect(error.message).not.toContain(tempDirectory);
        expect(fs.readFileSync(decoy, 'utf8')).toBe('outside the gate');
        expect(fs.existsSync(path.join(outside, 'quarantined-markers'))).toBe(false);
    });

    it('writes nothing outside the gate when the quarantine name is a symlink', async () => {
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const impostorPath = path.join(readersDirectory(), 'not-a-uuid.reader');
        fs.writeFileSync(impostorPath, 'impostor', { mode: 0o600 });
        const outside = path.join(tempDirectory, 'outside');
        fs.mkdirSync(outside, { recursive: true, mode: 0o700 });
        fs.symlinkSync(outside, path.join(gateDirectory(), 'quarantined-markers'), 'dir');

        const error = await expectCategory(
            quarantine_malformed_sqlite_gate_markers(databasePath(), attested),
            'recovery',
        );

        expect(error.message).not.toContain(tempDirectory);
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fs.readFileSync(impostorPath, 'utf8')).toBe('impostor');
    });

    it('never names the crash-controlled entry, on the failing path or the succeeding one', async () => {
        // The malformed reader-token *name* is crash- or attacker-controlled
        // data, so it may be used to move the entry and for nothing else. This
        // code also runs ahead of any sanitizing layer a caller might have, so a
        // raw `NodeJS.ErrnoException` escaping it would carry the whole absolute
        // path in `.path` and embed it in `.message`.
        fs.mkdirSync(readersDirectory(), { recursive: true, mode: 0o700 });
        const secretName = 'private-user-secret.reader';
        const secretPath = path.join(readersDirectory(), secretName);
        fs.writeFileSync(secretPath, 'x', { mode: 0o600 });
        // A plain file where the quarantine subtree belongs — reachable without
        // hand-editing, since a sync client or a restore can leave one.
        const obstruction = path.join(gateDirectory(), 'quarantined-markers');
        fs.writeFileSync(obstruction, 'not a directory', { mode: 0o600 });

        const error = await expectCategory(
            quarantine_malformed_sqlite_gate_markers(databasePath(), attested),
            'recovery',
        );

        expect(error.message).not.toContain(secretName);
        expect(error.message).not.toContain(tempDirectory);
        expect(JSON.stringify(error.metadata)).not.toContain(secretName);
        expect((error as unknown as { path?: string }).path).toBeUndefined();
        // Nothing moved, and the obstruction is left as the evidence it is.
        expect(fs.readFileSync(secretPath, 'utf8')).toBe('x');
        expect(fs.readFileSync(obstruction, 'utf8')).toBe('not a directory');

        // The success path says nothing about it either: the result carries a
        // count and a fresh generation id, never an on-disk name.
        fs.unlinkSync(obstruction);
        const result = await quarantine_malformed_sqlite_gate_markers(databasePath(), attested);
        expect(JSON.stringify(result)).not.toContain(secretName);
    });
});

describe('raw preflight and writable rollback-journal recovery', () => {
    it('rejects non-SQLite, app-ID-zero, and unexpected-app-ID files without mutation', async () => {
        const cases: Array<{ name: string; create: (file: string) => void }> = [
            {
                name: 'foreign-bytes.sqlite3',
                create(file) { fs.writeFileSync(file, Buffer.alloc(512, 0x5a)); },
            },
            {
                name: 'unbranded.sqlite3',
                create(file) {
                    const database = new DatabaseSync(file);
                    database.exec('CREATE TABLE foreign_table (value TEXT)');
                    database.close();
                },
            },
            {
                name: 'other-app.sqlite3',
                create(file) {
                    const database = new DatabaseSync(file);
                    database.exec('PRAGMA application_id = 12345; CREATE TABLE foreign_table (value TEXT)');
                    database.close();
                },
            },
        ];

        for (const item of cases) {
            const file = databasePath(item.name);
            item.create(file);
            const before = fs.readFileSync(file);
            const error = await expectCategory(open_existing_sqlite_database(file), 'schema');
            expect(fs.readFileSync(file)).toEqual(before);
            expect(error.message).not.toContain(file);
            expect(JSON.stringify(error.metadata)).not.toContain(path.basename(file));
        }
    });

    it.each(['-journal', '-wal', '-shm', '.init-candidate.evidence'])(
        'fails closed when the main file is absent with %s evidence',
        async (suffix) => {
            const file = databasePath();
            fs.writeFileSync(`${file}${suffix}`, 'evidence');
            const before = fs.readFileSync(`${file}${suffix}`);
            await expectCategory(
                initialize_sqlite_database_no_clobber(
                    file,
                    identity,
                    { appliedAtMs: 100, appVersion: '0.7.0' },
                ),
                'recovery',
            );
            expect(fs.existsSync(file)).toBe(false);
            expect(fs.readFileSync(`${file}${suffix}`)).toEqual(before);
        },
    );

    it.each(['-journal', '-wal', '-shm', '.init-candidate.evidence', '.init-candidate.zzz'])(
        'lets the attested preserve clear %s evidence that blocked the open',
        async (suffix) => {
            // The companion half of the refusal above, and the half whose absence
            // hid a live dead-end. A `.init-candidate.` tail that is not a uuid
            // was counted as absence evidence by `inventory_sqlite_basename`
            // (prefix-only) and then refused by name in the preserve path
            // (`expected_member_kind`, prefix + uuid) — so the open refused, the
            // dialog offered "Set Aside and Start Fresh", and that action threw
            // `preserve-member-name` every time. No in-app action cleared it, and
            // the gate quarantine could not help: it owns the three gate markers,
            // not the basename namespace. Reachable from an interrupted install,
            // a sync client, or a restore.
            //
            // Pinning only "the open refuses" would have passed throughout. A
            // refusal assertion needs a companion proving the escape still fires.
            const file = databasePath();
            const evidencePath = `${file}${suffix}`;
            fs.writeFileSync(evidencePath, 'evidence');

            const exclusive = await acquire_sqlite_exclusive_recovery_gate(file);
            const preserved = await preserve_sqlite_basename_set(file, { gate: exclusive });
            await exclusive.release();

            // Moved as a member of the set, never deleted: it sits in our
            // namespace, so it travels with the rest rather than being left
            // behind for a fresh database to be initialized beside.
            expect(fs.existsSync(evidencePath)).toBe(false);
            expect(fs.readFileSync(
                path.join(preserved.recoveryDirectory, path.basename(evidencePath)),
                'utf8',
            )).toBe('evidence');

            // And the escape genuinely completes: a fresh database initializes.
            const result = await initialize_sqlite_database_no_clobber(
                file,
                identity,
                { appliedAtMs: 100, appVersion: '0.7.0' },
            );
            expect(result.installed).toBe(true);
            await result.database.close();
        },
    );

    it.each([
        ['candidate', 'file-state.sqlite3.init-candidate.zzz'],
        ['canonical main', 'file-state.sqlite3'],
        ['wal sidecar', 'file-state.sqlite3-wal'],
    ] as const)('refuses a directory occupying the %s name identically from open and preserve', async (
        _label,
        name,
    ) => {
        // Deliberate, and *uniform across the whole basename set* — which is the
        // evidence that it is a policy rather than an oversight in the candidate
        // namespace specifically. `member_for`'s `!stat.isFile()` is enforcement:
        // a directory is not a basename member and must never be moved as one.
        //
        // It is not the unclearable class the gate markers were in, because the
        // refusal is never paired with an action that then fails. The desktop
        // classifies `inventory-member-type` as `obstructed` with
        // `canPreserve: false` (see `can_preserve` in state-recovery-dialog.ts),
        // so no set-aside is offered at all; the dialog instead names the
        // obstruction and points at the diagnostics folder. The one action that
        // would clear it — removing something Table Viewer did not create — is
        // the one it must not take.
        //
        // Pinned here so the three paths cannot drift into disagreeing about
        // which names this applies to: a future change that made the candidate
        // namespace movable-as-a-directory while `main` stayed enforced would be
        // the asymmetry that started this whole series.
        const file = databasePath();
        fs.mkdirSync(path.join(tempDirectory, name));
        fs.writeFileSync(path.join(tempDirectory, name, 'inside'), 'not ours to move');

        await expectCategory(inventory_sqlite_basename(file), 'recovery');
        const openFailure = await expectCategory(open_existing_sqlite_database(file), 'recovery');
        expect(openFailure.metadata.operation).toBe('inventory-member-type');

        const exclusive = await acquire_sqlite_exclusive_recovery_gate(file);
        const preserveFailure = await expectCategory(
            preserve_sqlite_basename_set(file, { gate: exclusive }),
            'recovery',
        );
        // Identical stage from both paths, which is what lets the desktop
        // recognize the condition and decline to offer an action that cannot work.
        expect(preserveFailure.metadata.operation).toBe('inventory-member-type');
        await exclusive.release();

        // Untouched, contents and all: refusing is the point, not a failure to
        // clean up. Nothing of the user's was moved or deleted.
        expect(fs.readFileSync(path.join(tempDirectory, name, 'inside'), 'utf8'))
            .toBe('not ours to move');
    });

    it('treats a non-uuid candidate tail as one namespace for inventory and preservation', async () => {
        // The two predicates stated the candidate namespace differently. This
        // pins them on one answer from both directions at once: the inventory
        // must see the entry, and the preserve path must accept the same entry as
        // a nameable member. Either half alone is satisfied by the drifted code.
        const file = databasePath();
        fs.writeFileSync(file, 'main-state');
        for (const tail of ['zzz', 'not-a-uuid', '00000000-0000-4000-8000-000000000001']) {
            fs.writeFileSync(`${file}.init-candidate.${tail}`, `candidate-${tail}`);
        }

        const inventory = await inventory_sqlite_basename(file);
        expect(inventory.candidates.map((candidate) => candidate.name).sort()).toEqual([
            'file-state.sqlite3.init-candidate.00000000-0000-4000-8000-000000000001',
            'file-state.sqlite3.init-candidate.not-a-uuid',
            'file-state.sqlite3.init-candidate.zzz',
        ]);

        const exclusive = await acquire_sqlite_exclusive_recovery_gate(file);
        const preserved = await preserve_sqlite_basename_set(file, { gate: exclusive });
        await exclusive.release();

        // Every one of them named, moved, and intact — the whole set as a unit.
        expect(preserved.memberCount).toBe(4);
        for (const tail of ['zzz', 'not-a-uuid', '00000000-0000-4000-8000-000000000001']) {
            const name = `file-state.sqlite3.init-candidate.${tail}`;
            expect(fs.existsSync(path.join(tempDirectory, name))).toBe(false);
            expect(fs.readFileSync(path.join(preserved.recoveryDirectory, name), 'utf8'))
                .toBe(`candidate-${tail}`);
        }
    });

    it('excludes a bare candidate marker with no tail from the namespace', async () => {
        // `<basename>.init-candidate.` with nothing after it names no candidate
        // this module could ever have built — the marker is a separator, and
        // `build_candidate` always appends a uuid. Left out of the namespace
        // deliberately, and asserted separately because the case has to be
        // *present on disk* to be meaningful: an assertion made while the file
        // does not exist passes against any predicate at all.
        const file = databasePath();
        fs.writeFileSync(file, 'main-state');
        const bare = `${file}.init-candidate.`;
        fs.writeFileSync(bare, 'not-a-candidate');

        const inventory = await inventory_sqlite_basename(file);

        expect(inventory.candidates).toEqual([]);
        // Not ours, so the preserve leaves it exactly where it is rather than
        // sweeping an unrelated file into the recovery set.
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(file);
        const preserved = await preserve_sqlite_basename_set(file, { gate: exclusive });
        await exclusive.release();
        expect(preserved.memberCount).toBe(1);
        expect(fs.readFileSync(bare, 'utf8')).toBe('not-a-candidate');
        expect(fs.existsSync(path.join(preserved.recoveryDirectory, path.basename(bare))))
            .toBe(false);
    });

    it('inventories every candidate-prefixed entry and preserves non-regular evidence', async () => {
        const target = path.join(tempDirectory, 'candidate-symlink-target');
        fs.writeFileSync(target, 'target-bytes');
        const cases: Array<{
            readonly label: string;
            readonly candidatePath: string;
            readonly create: () => void;
            readonly verifyPreserved: () => void;
        }> = [
            {
                label: 'symlink',
                candidatePath: `${databasePath()}.init-candidate.symlink`,
                create() { fs.symlinkSync(target, this.candidatePath); },
                verifyPreserved() {
                    expect(fs.lstatSync(this.candidatePath).isSymbolicLink()).toBe(true);
                    expect(fs.readlinkSync(this.candidatePath)).toBe(target);
                    expect(fs.readFileSync(target, 'utf8')).toBe('target-bytes');
                },
            },
            {
                label: 'directory',
                candidatePath: `${databasePath()}.init-candidate.directory`,
                create() {
                    fs.mkdirSync(this.candidatePath);
                    fs.writeFileSync(path.join(this.candidatePath, 'evidence'), 'directory-evidence');
                },
                verifyPreserved() {
                    expect(fs.lstatSync(this.candidatePath).isDirectory()).toBe(true);
                    expect(fs.readFileSync(path.join(this.candidatePath, 'evidence'), 'utf8'))
                        .toBe('directory-evidence');
                },
            },
        ];
        if (process.platform !== 'win32') {
            const fifoPath = `${databasePath()}.init-candidate.fifo`;
            cases.push({
                label: 'FIFO',
                candidatePath: fifoPath,
                create() {
                    const created = spawnSync('mkfifo', [fifoPath]);
                    if (created.status !== 0) throw new Error('mkfifo failed');
                },
                verifyPreserved() { expect(fs.lstatSync(fifoPath).isFIFO()).toBe(true); },
            });
        }

        for (const candidateCase of cases) {
            candidateCase.create();
            await expectCategory(inventory_sqlite_basename(databasePath()), 'recovery');
            await expectCategory(initialize_sqlite_database_no_clobber(
                databasePath(),
                identity,
                { appliedAtMs: 100, appVersion: '0.7.0' },
            ), 'recovery');
            expect(fs.existsSync(databasePath())).toBe(false);
            candidateCase.verifyPreserved();
            fs.rmSync(candidateCase.candidatePath, { recursive: true, force: true });
        }
    });

    it('treats a zero-length main as recovery evidence even without a sidecar', async () => {
        fs.writeFileSync(databasePath(), '');
        await expectCategory(open_existing_sqlite_database(databasePath()), 'recovery');
        expect(fs.statSync(databasePath()).size).toBe(0);
    });

    it('rejects WAL/SHM before SQLite can recreate or change either sidecar', async () => {
        await initialize();
        const wal = `${databasePath()}-wal`;
        const shm = `${databasePath()}-shm`;
        fs.writeFileSync(wal, 'wal-evidence');
        fs.writeFileSync(shm, 'shm-evidence');

        await expectCategory(open_existing_sqlite_database(databasePath()), 'schema');
        expect(fs.readFileSync(wal, 'utf8')).toBe('wal-evidence');
        expect(fs.readFileSync(shm, 'utf8')).toBe('shm-evidence');
    });

    it('reads the SQLite header and application ID without opening SQLite', async () => {
        await initialize();
        const header = read_sqlite_raw_header(databasePath(), SQLITE_FILE_STATE_APPLICATION_ID);
        expect(header.applicationId).toBe(SQLITE_FILE_STATE_APPLICATION_ID);
        expect(header.pageSize).toBeGreaterThanOrEqual(512);
        expect(header.writeVersion).toBe(1);
        expect(header.readVersion).toBe(1);
    });

    it('rejects non-rollback journal header versions before SQLite open', async () => {
        await initialize();
        for (const offset of [18, 19]) {
            const bytes = fs.readFileSync(databasePath());
            bytes[offset] = 2;
            fs.writeFileSync(databasePath(), bytes);
            await expectCategory(open_existing_sqlite_database(databasePath()), 'schema');
            expect(fs.readFileSync(databasePath())[offset]).toBe(2);
            bytes[offset] = 1;
            fs.writeFileSync(databasePath(), bytes);
        }
    });

    it('rejects a symlinked canonical main without creating a gate beside the alias', async () => {
        await initialize('real.sqlite3');
        fs.symlinkSync(databasePath('real.sqlite3'), databasePath());
        const error = await expectCategory(open_existing_sqlite_database(databasePath()), 'inaccessible');
        expect(error.message).not.toContain(tempDirectory);
        expect(fs.existsSync(path.join(tempDirectory, '.file-state.sqlite3.recovery-gate'))).toBe(false);
    });

    it.each(['EISDIR', 'EPERM'])(
        'skips when the default Windows directory-open primitive reports %s',
        (code) => {
            const opened: string[] = [];
            const closed: number[] = [];
            const unavailable = Object.assign(new Error('directories cannot be opened'), { code });

            expect(() => assert_sqlite_directory_durability_supported(
                tempDirectory,
                fs.fsyncSync,
                'win32',
                {
                    openDirectory(directoryPath) {
                        opened.push(directoryPath);
                        throw unavailable;
                    },
                    closeDirectory(descriptor) {
                        closed.push(descriptor);
                    },
                },
            )).not.toThrow();
            expect(opened).toEqual([tempDirectory]);
            expect(closed).toEqual([]);
        },
    );

    it('flushes and closes a reachable Windows directory handle', () => {
        const events: string[] = [];
        assert_sqlite_directory_durability_supported(
            tempDirectory,
            (descriptor) => { events.push(`fsync:${descriptor}`); },
            'win32',
            {
                openDirectory(directoryPath) {
                    events.push(`open:${directoryPath}`);
                    return 37;
                },
                closeDirectory(descriptor) {
                    events.push(`close:${descriptor}`);
                },
            },
        );
        expect(events).toEqual([
            `open:${tempDirectory}`,
            'fsync:37',
            'close:37',
        ]);
    });

    it('skips when the default Windows fsync cannot use an opened directory handle', () => {
        const events: string[] = [];
        const unavailable = Object.assign(new Error('directory handles cannot be flushed'), {
            code: 'EPERM',
        });

        expect(() => assert_sqlite_directory_durability_supported(
            tempDirectory,
            fs.fsyncSync,
            'win32',
            {
                openDirectory(directoryPath) {
                    events.push(`open:${directoryPath}`);
                    return 39;
                },
                syncDirectory(descriptor) {
                    events.push(`fsync:${descriptor}`);
                    throw unavailable;
                },
                closeDirectory(descriptor) {
                    events.push(`close:${descriptor}`);
                },
            },
        )).not.toThrow();
        expect(events).toEqual([
            `open:${tempDirectory}`,
            'fsync:39',
            'close:39',
        ]);
    });

    it('fails closed when a reachable Windows filesystem rejects fsync', () => {
        const rejected = Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
        const closed: number[] = [];
        try {
            assert_sqlite_directory_durability_supported(
                tempDirectory,
                () => { throw rejected; },
                'win32',
                {
                    openDirectory() {
                        return 41;
                    },
                    closeDirectory(descriptor) {
                        closed.push(descriptor);
                    },
                },
            );
            throw new Error('directory durability unexpectedly succeeded');
        } catch (error) {
            expect(error).toBeInstanceOf(SqliteFileStateError);
            expect((error as SqliteFileStateError).category).toBe('unsupported');
            expect((error as SqliteFileStateError).metadata.operation).toBe('directory-durability');
        }
        expect(closed).toEqual([41]);
    });

    it('always executes an injected Windows fsync primitive', () => {
        const flushed: number[] = [];
        assert_sqlite_directory_durability_supported(
            tempDirectory,
            (descriptor) => { flushed.push(descriptor); },
            'win32',
        );
        expect(flushed).toHaveLength(1);
    });

    it('sanitizes spoofed SqliteFileStateError names instead of trusting attacker fields', async () => {
        const nativeMessage = `spoofed failure at ${databasePath()}`;
        const fake = Object.assign(new Error(nativeMessage), {
            name: 'SqliteFileStateError',
            category: 'readonly',
            metadata: { operation: nativeMessage },
        });
        const error = await expectCategory(initialize_sqlite_database_no_clobber(
            databasePath(),
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
            {
                onEvent(event) {
                    if (event === 'candidate-after-schema') throw fake;
                },
            },
        ), 'recovery');
        expect(error).not.toBe(fake);
        expect(error.message).not.toContain(nativeMessage);
        expect(JSON.stringify(error.metadata)).not.toContain(nativeMessage);
        expect(error.cause).toBeUndefined();
    });

    it('rejects unsupported directory durability without leaking native details', async () => {
        const nativePath = databasePath();
        const unsupported = await expectCategory(acquire_sqlite_shared_reader_gate(nativePath, {
            fsyncDirectory() {
                const error = new Error(`EINVAL at ${nativePath}`) as NodeJS.ErrnoException;
                error.code = 'EINVAL';
                throw error;
            },
        }), 'unsupported');
        expect(unsupported.message).not.toContain(nativePath);
        expect((unsupported as Error & { cause?: unknown }).cause).toBeUndefined();
    });

    it('uses a non-creating read-write open to recover a branded hot rollback journal', async () => {
        await initialize();
        const script = `
            const { DatabaseSync } = require('node:sqlite');
            const database = new DatabaseSync(process.argv[1]);
            database.exec('BEGIN IMMEDIATE; UPDATE state_meta SET next_revision = 2 WHERE singleton = 1');
            if (process.send) process.send('ready');
            setInterval(() => {}, 1000);
        `;
        const child = spawn(process.execPath, ['-e', script, databasePath()], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        childProcesses.push(child);
        await childReady(child);
        await pollFor(() => fs.existsSync(`${databasePath()}-journal`), 'hot journal exists');
        child.kill('SIGKILL');
        await childExit(child);

        expect(fs.existsSync(`${databasePath()}-journal`)).toBe(true);
        const opened = await open_existing_sqlite_database(databasePath());
        expect(opened.database.prepare(
            'SELECT next_revision FROM state_meta WHERE singleton = 1',
        ).get()?.next_revision).toBe(1);
        await opened.close();
        const journalPath = `${databasePath()}-journal`;
        if (fs.existsSync(journalPath)) {
            expect(fs.readFileSync(journalPath).subarray(0, 8)).toEqual(Buffer.alloc(8));
        }
    });

    it('does not create a missing canonical file during failed open', async () => {
        await expectCategory(open_existing_sqlite_database(databasePath()), 'recovery');
        expect(fs.existsSync(databasePath())).toBe(false);
    });
});

describe('public SQLite open failure distinctions and preservation', () => {
    it.each([
        ['future schema', (database: DatabaseSync) => database.exec('PRAGMA user_version = 2'), 'schema'],
        ['future protocol', (database: DatabaseSync) => database.exec(`UPDATE state_meta SET
            min_reader_protocol = 2, max_reader_protocol = 2,
            min_writer_protocol = 2, max_writer_protocol = 2 WHERE singleton = 1`), 'protocol'],
    ] as const)('rejects %s without mutating the branded database', async (_label, mutate, category) => {
        await initialize();
        const direct = new DatabaseSync(databasePath());
        mutate(direct);
        direct.close();
        const before = fs.readFileSync(databasePath());

        const error = await expectCategory(publicOpen(), category);
        expect(error.message).not.toContain(databasePath());
        expect(error.cause).toBeUndefined();
        expect(fs.readFileSync(databasePath())).toEqual(before);
    });

    it('preserves a malformed branded database instead of replacing it', async () => {
        await initialize();
        const direct = new DatabaseSync(databasePath());
        direct.exec('PRAGMA ignore_check_constraints = ON');
        direct.prepare(`INSERT INTO entries (
            path, state_revision, state_json, has_pending_edits,
            authority_commit_sequence, authority_revision, physical_revision,
            projection_revision, physical_digest, recency_order, updated_at_ms,
            touched_at_ms, recovery_entry_id, recovery_record_id,
            copy_id, copy_source_path, copy_source_revision
        ) VALUES ('file:///malformed.csv', 1, '{"activeSheetIndex":"bad"}', 0,
            0, 0, 0, 0, NULL, 1, NULL, NULL, 'entry', NULL, NULL, NULL, NULL)`).run();
        direct.exec('UPDATE state_meta SET next_revision = 2, next_recency_order = 2');
        direct.close();
        const before = fs.readFileSync(databasePath());

        await expectCategory(publicOpen(), 'malformed-state');
        expect(fs.readFileSync(databasePath())).toEqual(before);
    });

    it('distinguishes a real held SQLite lock from corruption through public open', async () => {
        await initialize();
        const locker = new DatabaseSync(databasePath(), { timeout: 0 });
        locker.exec('BEGIN EXCLUSIVE');
        await expectCategory(publicOpen(), 'contention');
        locker.exec('ROLLBACK');
        locker.close();

        const bytes = fs.readFileSync(databasePath());
        fs.truncateSync(databasePath(), 512);
        const corrupt = fs.readFileSync(databasePath());
        expect(corrupt.subarray(0, 100)).toEqual(bytes.subarray(0, 100));
        await expectCategory(publicOpen(), 'corrupt');
        expect(fs.readFileSync(databasePath())).toEqual(corrupt);
    });

    it.skipIf(process.platform === 'win32')(
        'reports a real read-only database without changing it',
        async () => {
            await initialize();
            const before = fs.readFileSync(databasePath());
            fs.chmodSync(databasePath(), 0o400);
            try {
                await expectCategory(publicOpen(), 'readonly');
                expect(fs.readFileSync(databasePath())).toEqual(before);
            } finally {
                fs.chmodSync(databasePath(), 0o600);
            }
        },
    );

    it('reports an inaccessible parent and creates no replacement main', async () => {
        const missingParentFile = path.join(tempDirectory, 'missing-parent', 'state.sqlite3');
        const error = await expectCategory(open_sqlite_file_state_store(missingParentFile, {
            identity,
            migration: { appliedAtMs: 100, appVersion: '0.7.0' },
            clientKind: 'sqlite-open-recovery-test',
            clientVersion: '0.7.0',
            initialization: {
                fsyncDirectory() {
                    const native = new Error('injected inaccessible directory') as NodeJS.ErrnoException;
                    native.code = 'EACCES';
                    throw native;
                },
            },
        }), 'inaccessible');
        expect(error.cause).toBeUndefined();
        expect(fs.existsSync(missingParentFile)).toBe(false);
    });

    // node:sqlite and the host filesystem expose no reliable, portable way to
    // force SQLITE_FULL or a generic SQLITE_IOERR. Inject the corresponding OS
    // failures at the lowest directory-durability operation boundary, then prove
    // the public open category and byte-for-byte preservation.
    it.each([
        ['ENOSPC', 'full'],
        ['EIO', 'io'],
    ] as const)('maps injected lowest-level %s through public open and preserves durable evidence',
        async (code, category) => {
            await initialize();
            const before = fs.readFileSync(databasePath());
            const error = await expectCategory(open_sqlite_file_state_store(databasePath(), {
                identity,
                migration: { appliedAtMs: 100, appVersion: '0.7.0' },
                clientKind: 'sqlite-open-recovery-test',
                clientVersion: '0.7.0',
                initialization: {
                    fsyncDirectory() {
                        const native = new Error(`injected ${code}`) as NodeJS.ErrnoException;
                        native.code = code;
                        throw native;
                    },
                },
            }), category);
            expect(error.cause).toBeUndefined();
            expect(fs.readFileSync(databasePath())).toEqual(before);
        });
});

describe('complete candidates and no-clobber installation', () => {
    it('selects exactly one complete winner between concurrent initializers', async () => {
        const bothReady = deferred();
        let readyCount = 0;
        const events = async (event: SqliteOpenRecoveryEvent): Promise<void> => {
            if (event !== 'candidate-before-install') return;
            readyCount += 1;
            if (readyCount === 2) bothReady.resolve();
            await bothReady.promise;
        };

        const first = initialize_sqlite_database_no_clobber(
            databasePath(), identity, { appliedAtMs: 100, appVersion: '0.7.0' }, { onEvent: events },
        );
        const second = initialize_sqlite_database_no_clobber(
            databasePath(), identity, { appliedAtMs: 100, appVersion: '0.7.0' }, { onEvent: events },
        );
        const results = await Promise.all([first, second]);
        expect(results.filter((result) => result.wonInstallation)).toHaveLength(1);
        expect(results.every((result) => result.database.database.prepare(
            'SELECT database_id FROM state_meta',
        ).get()?.database_id === identity.databaseId)).toBe(true);
        await Promise.all(results.map((result) => result.database.close()));

        const inventory = await inventory_sqlite_basename(databasePath());
        expect(inventory.main).toBeDefined();
        expect(inventory.candidates).toEqual([]);
    });

    it('never mutates a winner carrying another exact database identity', async () => {
        await initialize();
        const before = fs.readFileSync(databasePath());
        const otherIdentity: SqliteDesktopFileStateIdentity = {
            ...identity,
            databaseId: 'another-database',
        };
        await expectCategory(
            initialize_sqlite_database_no_clobber(
                databasePath(), otherIdentity, { appliedAtMs: 200, appVersion: '0.7.0' },
            ),
            'schema',
        );
        expect(fs.readFileSync(databasePath())).toEqual(before);
    });

    it('recognizes a fully built candidate by schema and exact embedded identity', async () => {
        let candidateName: string | undefined;
        const failure = initialize_sqlite_database_no_clobber(
            databasePath(),
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
            {
                onEvent(event) {
                    if (event === 'candidate-before-install') throw new Error('injected stop');
                },
            },
        );
        await expectCategory(failure, 'recovery');
        const inventory = await inventory_sqlite_basename(databasePath());
        candidateName = inventory.candidates[0]?.name;
        expect(candidateName).toBeDefined();
        const candidate = path.join(tempDirectory, candidateName!);
        expect(recognize_sqlite_initialization_candidate(candidate, identity)).toMatchObject({
            recognized: true,
            identityMatches: true,
            userVersion: 1,
        });
        expect(recognize_sqlite_initialization_candidate(candidate, {
            ...identity,
            databaseId: 'wrong',
        })).toMatchObject({ recognized: false, identityMatches: false });
        expect(recognize_sqlite_initialization_candidate(
            candidate,
            identity,
            SQLITE_FILE_STATE_APPLICATION_ID,
            2,
        )).toMatchObject({ recognized: false, identityMatches: false });
    });

    it('revalidates a candidate after the before-install cut point and never links malformed bytes', async () => {
        await expectCategory(initialize_sqlite_database_no_clobber(
            databasePath(),
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
            {
                onEvent(event) {
                    if (event !== 'candidate-before-install') return;
                    const candidateName = fs.readdirSync(tempDirectory)
                        .find((name) => name.includes('.init-candidate.'));
                    if (!candidateName) throw new Error('candidate missing');
                    const database = new DatabaseSync(path.join(tempDirectory, candidateName));
                    database.exec('DROP INDEX entries_by_state_revision');
                    database.close();
                },
            },
        ), 'schema');
        const inventory = await inventory_sqlite_basename(databasePath());
        expect(inventory.main).toBeUndefined();
        expect(inventory.candidates).toHaveLength(1);
    });

    it.each([
        {
            defect: 'altered table structure',
            corrupt(database: DatabaseSync) {
                database.exec('ALTER TABLE entries RENAME TO entries_altered');
            },
        },
        {
            defect: 'altered migration history',
            corrupt(database: DatabaseSync) {
                database.exec("UPDATE schema_migrations SET name = 'not-v1'");
            },
        },
        {
            defect: 'invalid counters',
            corrupt(database: DatabaseSync) {
                database.exec('PRAGMA ignore_check_constraints = ON');
                database.exec('UPDATE state_meta SET next_revision = 0');
            },
        },
        {
            defect: 'malformed stored state',
            corrupt(database: DatabaseSync) {
                database.prepare(`INSERT INTO entries (
                    path, state_revision, state_json, has_pending_edits,
                    authority_commit_sequence, authority_revision, physical_revision,
                    projection_revision, physical_digest, recency_order, updated_at_ms,
                    touched_at_ms, recovery_entry_id, recovery_record_id,
                    copy_id, copy_source_path, copy_source_revision
                ) VALUES ('file:///malformed.csv', 0, '{"activeSheetIndex":"bad"}', 0,
                    0, 0, 0, 0, NULL, 1, NULL, NULL, 'recovery-entry', NULL,
                    NULL, NULL, NULL)`).run();
                database.exec('UPDATE state_meta SET next_recency_order = 2');
            },
        },
        {
            defect: 'foreign-key damage',
            corrupt(database: DatabaseSync) {
                database.exec('PRAGMA foreign_keys = OFF');
                database.prepare(`INSERT INTO authority_stages (
                    entry_path, stage_id, kind, ordinal, expected_state_revision,
                    expected_commit_sequence, next_state_json, physical_digest, created_at_ms
                ) VALUES ('missing', 'stage', 'projection', 0, 0, 0, NULL, NULL, 0)`).run();
            },
        },
    ])('rejects a candidate with $defect before it can become canonical', async ({ corrupt }) => {
        await expectCategory(initialize_sqlite_database_no_clobber(
            databasePath(),
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
            {
                onEvent(event) {
                    if (event === 'candidate-before-install') throw new Error('stop before install');
                },
            },
        ), 'recovery');
        const candidate = (await inventory_sqlite_basename(databasePath())).candidates[0];
        expect(candidate).toBeDefined();
        const candidatePath = path.join(tempDirectory, candidate!.name);
        const database = new DatabaseSync(candidatePath);
        corrupt(database);
        database.close();

        expect(recognize_sqlite_initialization_candidate(candidatePath, identity)).toMatchObject({
            recognized: false,
            identityMatches: false,
        });
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await expectCategory(install_recognized_sqlite_candidate_no_clobber(
            databasePath(),
            candidatePath,
            identity,
            { gate: exclusive },
        ), 'schema');
        const inventory = await inventory_sqlite_basename(databasePath());
        expect(inventory.main).toBeUndefined();
        expect(inventory.candidates.map((member) => member.name)).toContain(candidate!.name);
        await exclusive.release();
    });

    it('rejects a fully branded existing winner with structural damage before return', async () => {
        await initialize();
        const database = new DatabaseSync(databasePath());
        database.exec('DROP INDEX entries_by_state_revision');
        database.close();
        const before = fs.readFileSync(databasePath());

        await expectCategory(initialize_sqlite_database_no_clobber(
            databasePath(), identity, { appliedAtMs: 100, appVersion: '0.7.0' },
        ), 'schema');
        expect(fs.readFileSync(databasePath())).toEqual(before);
    });

    it('resumes a recognized crash-left candidate under the exclusive gate', async () => {
        await expectCategory(
            initialize_sqlite_database_no_clobber(
                databasePath(),
                identity,
                { appliedAtMs: 100, appVersion: '0.7.0' },
                {
                    onEvent(event) {
                        if (event === 'candidate-before-install') throw new Error('stop before install');
                    },
                },
            ),
            'recovery',
        );
        const candidate = (await inventory_sqlite_basename(databasePath())).candidates[0];
        expect(candidate).toBeDefined();
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        const resumed = await install_recognized_sqlite_candidate_no_clobber(
            databasePath(),
            path.join(tempDirectory, candidate!.name),
            identity,
            { gate: exclusive },
        );
        expect(resumed.installed).toBe(true);
        expect(resumed.database.database.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
        await resumed.database.close();
        await exclusive.release();
        expect((await inventory_sqlite_basename(databasePath())).candidates).toEqual([]);
    });

    it.runIf(process.platform !== 'win32')('rejects a resumed candidate replaced at the source-link boundary', async () => {
        await expectCategory(
            initialize_sqlite_database_no_clobber(
                databasePath(),
                identity,
                { appliedAtMs: 100, appVersion: '0.7.0' },
                {
                    onEvent(event) {
                        if (event === 'candidate-before-install') throw new Error('stop before install');
                    },
                },
            ),
            'recovery',
        );
        const candidate = (await inventory_sqlite_basename(databasePath())).candidates[0];
        expect(candidate).toBeDefined();
        const candidatePath = path.join(tempDirectory, candidate!.name);
        const alternatePath = path.join(tempDirectory, 'alternate-resume.sqlite3');
        const alternate = await initialize_sqlite_database_no_clobber(
            alternatePath,
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
        );
        await alternate.database.close();
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());

        await expectCategory(install_recognized_sqlite_candidate_no_clobber(
            databasePath(),
            candidatePath,
            identity,
            {
                gate: exclusive,
                beforeCandidateSourceLink() {
                    fs.unlinkSync(candidatePath);
                    fs.symlinkSync(alternatePath, candidatePath);
                },
            },
        ), 'recovery');
        expect(fs.existsSync(databasePath())).toBe(false);
        expect(fs.lstatSync(candidatePath).isSymbolicLink()).toBe(true);
        await exclusive.release();
    });

    it('serves only the complete canonical winner after a crash immediately after install', async () => {
        const failure = initialize_sqlite_database_no_clobber(
            databasePath(),
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
            {
                onEvent(event) {
                    if (event === 'candidate-after-install') throw new Error('injected crash');
                },
            },
        );
        await expectCategory(failure, 'recovery');
        expect(fs.existsSync(databasePath())).toBe(true);

        const restarted = await initialize_sqlite_database_no_clobber(
            databasePath(), identity, { appliedAtMs: 100, appVersion: '0.7.0' },
        );
        expect(restarted.installed).toBe(false);
        expect(restarted.database.database.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
        await restarted.database.close();
    });

    it('closes the winner before releasing its internally owned reader token when the winner hook fails', async () => {
        await initialize();
        let tokenId: string | undefined;
        await expectCategory(initialize_sqlite_database_no_clobber(
            databasePath(),
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
            {
                onEvent(event) {
                    if (event !== 'winner-validated') return;
                    tokenId = inspect_sqlite_recovery_gate(databasePath()).readerTokenIds[0];
                    throw new Error('winner hook failure');
                },
            },
        ), 'recovery');
        expect(tokenId).toBeDefined();
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toEqual([]);
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await exclusive.waitForReaders();
        await exclusive.release();
    });

    it('retains a caller-owned exclusive gate after a post-open winner-hook failure', async () => {
        await initialize();
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await exclusive.waitForReaders();
        await expectCategory(initialize_sqlite_database_no_clobber(
            databasePath(),
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
            {
                gate: exclusive,
                onEvent(event) {
                    if (event === 'winner-validated') throw new Error('winner hook failure');
                },
            },
        ), 'recovery');
        expect(inspect_sqlite_recovery_gate(databasePath()).exclusiveIntentTokenId).toBe(exclusive.tokenId);
        await exclusive.release();
    });

    it.runIf(process.platform !== 'win32')('rejects a symlink replacement for the built candidate before installation', async () => {
        const alternatePath = path.join(tempDirectory, 'alternate.sqlite3');
        const alternate = await initialize_sqlite_database_no_clobber(
            alternatePath,
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
        );
        await alternate.database.close();
        let replacedCandidatePath: string | undefined;

        const initialization = initialize_sqlite_database_no_clobber(
            databasePath(),
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
            {
                beforeCandidateSourceLink() {
                    const candidate = fs.readdirSync(tempDirectory)
                        .find((name) => name.startsWith('file-state.sqlite3.init-candidate.'));
                    if (!candidate) throw new Error('candidate missing');
                    replacedCandidatePath = path.join(tempDirectory, candidate);
                    fs.unlinkSync(replacedCandidatePath);
                    fs.symlinkSync(alternatePath, replacedCandidatePath);
                },
            },
        );

        await expectCategory(initialization, 'recovery');
        expect(fs.existsSync(databasePath())).toBe(false);
        expect(replacedCandidatePath).toBeDefined();
        expect(fs.lstatSync(replacedCandidatePath!).isSymbolicLink()).toBe(true);
    });

    it('keeps the installed winner open and preserves a replacement at the cleanup rename boundary', async () => {
        let replaced = false;
        const result = await initialize_sqlite_database_no_clobber(
            databasePath(),
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
            {
                beforeCandidateCleanupRename() {
                    if (replaced) return;
                    const candidate = fs.readdirSync(tempDirectory)
                        .find((name) => name.includes('.init-candidate.')
                            && !name.includes('.install-snapshot.'));
                    if (!candidate) throw new Error('candidate missing');
                    const candidatePath = path.join(tempDirectory, candidate);
                    fs.renameSync(candidatePath, `${candidatePath}.owned-original`);
                    fs.writeFileSync(candidatePath, 'replacement');
                    replaced = true;
                },
            },
        );

        expect(result).toMatchObject({ installed: true, wonInstallation: true });
        expect(replaced).toBe(true);
        const preservedReplacement = fs.readdirSync(tempDirectory)
            .find((name) => name.includes('.cleanup-preserved.'));
        expect(preservedReplacement).toBeDefined();
        expect(fs.readFileSync(path.join(tempDirectory, preservedReplacement!), 'utf8')).toBe('replacement');
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toHaveLength(1);
        const opened = await open_existing_sqlite_database(databasePath());
        await opened.close();
        await result.database.close();
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toEqual([]);
    });

    it('flushes candidates and canonical installation with private modes', async () => {
        const result = await initialize_sqlite_database_no_clobber(
            databasePath(), identity, { appliedAtMs: 100, appVersion: '0.7.0' },
        );
        await result.database.close();
        expect(fs.statSync(databasePath()).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.join(tempDirectory, '.file-state.sqlite3.recovery-gate')).mode & 0o777)
            .toBe(0o700);
    });
});

describe('restartable preserve-as-a-unit recovery', () => {
    it('preserves the complete basename set without overwriting and removes blockade only when complete', async () => {
        const file = databasePath();
        const original = new Map<string, Buffer>([
            [path.basename(file), Buffer.from('main')],
            [`${path.basename(file)}-journal`, Buffer.from('journal')],
            [`${path.basename(file)}-wal`, Buffer.from('wal')],
            [`${path.basename(file)}-shm`, Buffer.from('shm')],
            [`${path.basename(file)}.init-candidate.00000000-0000-4000-8000-000000000001`, Buffer.from('candidate')],
        ]);
        for (const [name, contents] of original) fs.writeFileSync(path.join(tempDirectory, name), contents);

        const exclusive = await acquire_sqlite_exclusive_recovery_gate(file);
        const result = await preserve_sqlite_basename_set(file, { gate: exclusive });
        for (const [name, contents] of original) {
            expect(fs.existsSync(path.join(tempDirectory, name))).toBe(false);
            expect(fs.readFileSync(path.join(result.recoveryDirectory, name))).toEqual(contents);
        }
        const inventory = await inventory_sqlite_basename(file);
        expect(inventory.recoveryBlocked).toBe(false);
        expect(inventory.recoveryDirectories).toBe(1);
        expect(inventory.incompleteRecoveryDirectories).toBe(0);
        await exclusive.release();
    });

    it('reconstructs an initial manifest after a crash following durable recovery-directory creation', async () => {
        fs.writeFileSync(databasePath(), 'main-state');
        const firstExclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await expectCategory(preserve_sqlite_basename_set(databasePath(), {
            gate: firstExclusive,
            onEvent(event) {
                if (event === 'preserve-after-recovery-directory-flush') {
                    throw new Error('crash before manifest creation');
                }
            },
        }), 'recovery');
        const recoveryName = fs.readdirSync(tempDirectory)
            .find((name) => name.startsWith('file-state.sqlite3.recovery.'));
        expect(recoveryName).toMatch(/^file-state\.sqlite3\.recovery\.[0-9a-f-]{36}$/i);
        const recoveryDirectory = path.join(tempDirectory, recoveryName!);
        expect(fs.readdirSync(recoveryDirectory)).toEqual([]);
        expect(fs.readFileSync(databasePath(), 'utf8')).toBe('main-state');
        expect(inspect_sqlite_recovery_gate(databasePath()).recoveryBlocked).toBe(false);

        await reclaim_stale_sqlite_exclusive_intent(
            databasePath(), firstExclusive.tokenId, { allProcessesClosed: true },
        );
        const secondExclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        const resumed = await preserve_sqlite_basename_set(databasePath(), { gate: secondExclusive });
        expect(resumed.recoveryDirectory).toBe(fs.realpathSync.native(recoveryDirectory));
        expect(fs.existsSync(databasePath())).toBe(false);
        expect(fs.readFileSync(path.join(recoveryDirectory, 'file-state.sqlite3'), 'utf8'))
            .toBe('main-state');
        expect(JSON.parse(fs.readFileSync(path.join(recoveryDirectory, 'manifest.json'), 'utf8')))
            .toMatchObject({ state: 'complete' });
        await secondExclusive.release();
    });

    it.each([
        ['nonempty exact UUID directory', 'file-state.sqlite3.recovery.00000000-0000-4000-8000-000000000001', true],
        ['empty malformed directory', 'file-state.sqlite3.recovery.not-a-uuid', false],
    ] as const)('fails closed on a %s left before manifest creation', async (_label, name, nonempty) => {
        fs.writeFileSync(databasePath(), 'main-state');
        const recoveryDirectory = path.join(tempDirectory, name);
        fs.mkdirSync(recoveryDirectory);
        if (nonempty) fs.writeFileSync(path.join(recoveryDirectory, 'unexpected'), 'orphan-evidence');
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());

        await expectCategory(preserve_sqlite_basename_set(databasePath(), { gate: exclusive }), 'recovery');
        expect(fs.readFileSync(databasePath(), 'utf8')).toBe('main-state');
        expect(fs.existsSync(path.join(recoveryDirectory, 'manifest.json'))).toBe(false);
        expect(fs.readdirSync(recoveryDirectory)).toEqual(nonempty ? ['unexpected'] : []);
        await exclusive.release();
    });

    it('treats a symlinked managed recovery directory as incomplete evidence', async () => {
        const target = path.join(tempDirectory, 'recovery-target');
        fs.mkdirSync(target);
        const recoveryName = 'file-state.sqlite3.recovery.00000000-0000-4000-8000-000000000001';
        fs.symlinkSync(target, path.join(tempDirectory, recoveryName), 'dir');

        const inventory = await inventory_sqlite_basename(databasePath());
        expect(inventory.recoveryDirectories).toBe(1);
        expect(inventory.incompleteRecoveryDirectories).toBe(1);
        await expectCategory(initialize_sqlite_database_no_clobber(
            databasePath(), identity, { appliedAtMs: 100, appVersion: '0.7.0' },
        ), 'recovery');
    });

    it('counts a complete manifest as complete only while every durable member invariant holds', async () => {
        fs.writeFileSync(databasePath(), 'main-state');
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        const result = await preserve_sqlite_basename_set(databasePath(), { gate: exclusive });
        const manifestPath = path.join(result.recoveryDirectory, 'manifest.json');
        const targetPath = path.join(result.recoveryDirectory, 'file-state.sqlite3');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        manifest.members[0].installed = false;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        expect((await inventory_sqlite_basename(databasePath())).incompleteRecoveryDirectories).toBe(1);

        manifest.members[0].installed = true;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        expect((await inventory_sqlite_basename(databasePath())).incompleteRecoveryDirectories).toBe(0);

        // A file back on the canonical name does *not* make a finished recovery
        // unfinished. Completion is a property of the manifest and of the moved
        // bytes, both of which are still exactly as `advance_preservation` left
        // them; the source name is free again precisely because the move
        // finished, and re-initializing it is what the app does next. Requiring
        // absence here made every completed directory count as incomplete from
        // the following launch onward, which sent `preserve_sqlite_basename_set`
        // into its orphan branch and threw `orphan-preservation-manifest` — so a
        // userData directory could be recovered exactly once, ever.
        fs.linkSync(targetPath, databasePath());
        expect((await inventory_sqlite_basename(databasePath())).incompleteRecoveryDirectories).toBe(0);
        fs.unlinkSync(databasePath());
        expect((await inventory_sqlite_basename(databasePath())).incompleteRecoveryDirectories).toBe(0);

        // The preserved bytes themselves are still the invariant: replace the
        // target and the directory is incomplete again, whatever the manifest says.
        fs.unlinkSync(targetPath);
        fs.writeFileSync(targetPath, 'replacement-main-state');
        expect((await inventory_sqlite_basename(databasePath())).incompleteRecoveryDirectories).toBe(1);
        await exclusive.release();
    });

    it('resumes after a crash between no-clobber target installation and manifest progress', async () => {
        fs.writeFileSync(databasePath(), 'main-state');
        fs.writeFileSync(`${databasePath()}-journal`, 'journal-state');
        const firstExclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        let injected = false;
        await expectCategory(
            preserve_sqlite_basename_set(databasePath(), {
                gate: firstExclusive,
                onEvent(event) {
                    if (!injected && event === 'preserve-after-member-install') {
                        injected = true;
                        throw new Error('crash after hard-link');
                    }
                },
            }),
            'recovery',
        );
        let inventory = await inventory_sqlite_basename(databasePath());
        expect(inventory.recoveryBlocked).toBe(true);
        expect(inventory.incompleteRecoveryDirectories).toBe(1);

        await reclaim_stale_sqlite_exclusive_intent(
            databasePath(),
            firstExclusive.tokenId,
            { allProcessesClosed: true },
        );
        const secondExclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        const resumed = await resume_sqlite_basename_preservation(databasePath(), { gate: secondExclusive });
        expect(fs.readFileSync(path.join(resumed.recoveryDirectory, 'file-state.sqlite3'), 'utf8'))
            .toBe('main-state');
        expect(fs.readFileSync(path.join(resumed.recoveryDirectory, 'file-state.sqlite3-journal'), 'utf8'))
            .toBe('journal-state');
        inventory = await inventory_sqlite_basename(databasePath());
        expect(inventory.recoveryBlocked).toBe(false);
        expect(inventory.incompleteRecoveryDirectories).toBe(0);
        await secondExclusive.release();
    });

    it('refuses to mark a move complete while a source name is reoccupied mid-move', async () => {
        // The single point of enforcement for source-absence, and the reason
        // `validate_completed_preservation` may drop its own copy of the check.
        // Absence is meaningful *here* and nowhere else: this loop runs while the
        // move is in flight and the gate is still exclusive, so nothing may
        // legitimately be on the canonical name yet. After completion the gate is
        // released and the app re-creates that very name on purpose, which is why
        // asserting absence at validation time made recovery work once per
        // directory (dead-end (d)).
        //
        // Pinned deliberately: with the check now in one place instead of two, a
        // future simplification of this loop would let a preserve report
        // `complete` while a member still sits on its source name — a set that is
        // half-moved but labelled finished, which is silent divergence rather
        // than the loud refusal every other failure here produces.
        fs.writeFileSync(databasePath(), 'main-state');
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        let reoccupied = false;

        const error = await expectCategory(preserve_sqlite_basename_set(databasePath(), {
            gate: exclusive,
            onEvent(event) {
                // After the real source was unlinked and before the final loop
                // runs: exactly the window an uncoordinated writer, a sync
                // client, or a racing peer could reoccupy the name in.
                if (event !== 'preserve-after-member-source-removal' || reoccupied) return;
                reoccupied = true;
                fs.writeFileSync(databasePath(), 'reoccupied-source');
            },
        }), 'recovery');

        expect(reoccupied).toBe(true);
        // The specific stage, not merely "some recovery error": the target still
        // matches its manifest entry, so `stat_matches` is satisfied and only the
        // absence clause can have produced this.
        expect(error.metadata.operation).toBe('preserve-validation');
        const recoveryName = fs.readdirSync(tempDirectory)
            .find((name) => name.startsWith('file-state.sqlite3.recovery.'));
        expect(recoveryName).toBeDefined();
        const manifest = JSON.parse(fs.readFileSync(
            path.join(tempDirectory, recoveryName!, 'manifest.json'),
            'utf8',
        ));
        // Never labelled complete, and the moved bytes are still the preserved
        // ones — the refusal happened before any of that could be claimed.
        expect(manifest.state).toBe('moving');
        expect(fs.readFileSync(path.join(tempDirectory, recoveryName!, 'file-state.sqlite3'), 'utf8'))
            .toBe('main-state');
        // The blockade stays up, so the next attested attempt resumes rather than
        // opening a main file detached from the set it belongs to.
        expect(inspect_sqlite_recovery_gate(databasePath()).recoveryBlocked).toBe(true);
        // And the reoccupying file is left exactly as found: it is not ours.
        expect(fs.readFileSync(databasePath(), 'utf8')).toBe('reoccupied-source');
    });

    it('fails closed when the canonical source becomes a dangling symlink after target installation', async () => {
        fs.writeFileSync(databasePath(), 'main-state');
        const danglingTarget = path.join(tempDirectory, 'missing-symlink-target');
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());

        await expectCategory(preserve_sqlite_basename_set(databasePath(), {
            gate: exclusive,
            onEvent(event) {
                if (event !== 'preserve-after-member-install') return;
                fs.unlinkSync(databasePath());
                fs.symlinkSync(danglingTarget, databasePath());
            },
        }), 'recovery');

        expect(fs.lstatSync(databasePath()).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(databasePath())).toBe(danglingTarget);
        expect(fs.existsSync(path.join(
            tempDirectory,
            '.file-state.sqlite3.recovery-gate',
            'recovery-block.json',
        ))).toBe(true);
    });

    it('durably removes a blockade left beside a complete manifest only after revalidation', async () => {
        fs.writeFileSync(databasePath(), 'main-state');
        const firstExclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await expectCategory(preserve_sqlite_basename_set(databasePath(), {
            gate: firstExclusive,
            onEvent(event) {
                if (event === 'preserve-after-complete-flush') throw new Error('crash before unblock');
            },
        }), 'recovery');
        expect((await inventory_sqlite_basename(databasePath())).recoveryBlocked).toBe(true);
        await reclaim_stale_sqlite_exclusive_intent(
            databasePath(), firstExclusive.tokenId, { allProcessesClosed: true },
        );
        const secondExclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        const resumed = await resume_sqlite_basename_preservation(databasePath(), { gate: secondExclusive });
        expect(fs.readFileSync(path.join(resumed.recoveryDirectory, 'file-state.sqlite3'), 'utf8'))
            .toBe('main-state');
        expect((await inventory_sqlite_basename(databasePath())).recoveryBlocked).toBe(false);
        await secondExclusive.release();
    });

    it('clears a complete-manifest blockade without disturbing a recreated canonical source', async () => {
        // Previously this asserted that a file back on the canonical name kept
        // the blockade forever. That was the wrong place to enforce
        // source-absence: by the time the manifest says `complete` every member
        // is already in the recovery directory and the source name is free by
        // construction, so re-creating it is the ordinary next step rather than
        // evidence of a half-moved set. Enforcing it here instead made the
        // *successful* path unrecoverable — see the dropped clause in
        // `validate_completed_preservation`. Source-absence still holds where it
        // means something: `advance_preservation`'s final loop, which runs while
        // the move is in flight and the gate is still exclusive.
        fs.writeFileSync(databasePath(), 'main-state');
        const originalInode = fs.statSync(databasePath()).ino;
        const firstExclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await expectCategory(preserve_sqlite_basename_set(databasePath(), {
            gate: firstExclusive,
            onEvent(event) {
                if (event === 'preserve-after-complete-flush') throw new Error('crash before unblock');
            },
        }), 'recovery');
        expect(fs.existsSync(databasePath())).toBe(false);
        fs.writeFileSync(databasePath(), 'recreated-main');
        expect(fs.statSync(databasePath()).ino).not.toBe(originalInode);

        await reclaim_stale_sqlite_exclusive_intent(
            databasePath(), firstExclusive.tokenId, { allProcessesClosed: true },
        );
        const secondExclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        const resumed = await resume_sqlite_basename_preservation(
            databasePath(), { gate: secondExclusive },
        );

        // The blockade is gone because the move it guarded is genuinely finished.
        expect(inspect_sqlite_recovery_gate(databasePath()).recoveryBlocked).toBe(false);
        // Neither the recreated file nor the preserved bytes were touched: the
        // resume observed completion, it did not move anything a second time.
        expect(fs.readFileSync(databasePath(), 'utf8')).toBe('recreated-main');
        expect(fs.readFileSync(path.join(resumed.recoveryDirectory, 'file-state.sqlite3'), 'utf8'))
            .toBe('main-state');
        await secondExclusive.release();
    });

    it('preserves a second complete set in a directory that already holds one', async () => {
        // Recovery once worked exactly once per directory. `validate_completed_preservation`
        // required the first set's source names to still be absent, so as soon as
        // the app re-created `file-state.sqlite3` — the entire purpose of "Set
        // Aside and Start Fresh" — the finished directory was re-classified as
        // incomplete, `preserve_sqlite_basename_set` took its orphan branch,
        // found no resumable manifest, and threw `orphan-preservation-manifest`.
        fs.writeFileSync(databasePath(), 'first-main');
        const first = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        const firstResult = await preserve_sqlite_basename_set(databasePath(), { gate: first });
        await first.release();

        fs.writeFileSync(databasePath(), 'second-main');
        expect((await inventory_sqlite_basename(databasePath())).incompleteRecoveryDirectories)
            .toBe(0);
        const second = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        const secondResult = await preserve_sqlite_basename_set(databasePath(), { gate: second });
        await second.release();

        expect(secondResult.recoveryDirectory).not.toBe(firstResult.recoveryDirectory);
        expect(fs.existsSync(databasePath())).toBe(false);
        // Both sets intact, and neither one moved into the other: the second
        // preserve is a new set-aside, never a resume of a finished one.
        expect(fs.readFileSync(path.join(firstResult.recoveryDirectory, 'file-state.sqlite3'), 'utf8'))
            .toBe('first-main');
        expect(fs.readFileSync(path.join(secondResult.recoveryDirectory, 'file-state.sqlite3'), 'utf8'))
            .toBe('second-main');
        const inventory = await inventory_sqlite_basename(databasePath());
        expect(inventory.recoveryDirectories).toBe(2);
        expect(inventory.incompleteRecoveryDirectories).toBe(0);
    });

    it('keeps a complete-manifest blockade when the completed target no longer matches', async () => {
        const file = databasePath('invalid-complete.sqlite3');
        fs.writeFileSync(file, 'main-state');
        const firstExclusive = await acquire_sqlite_exclusive_recovery_gate(file);
        await expectCategory(preserve_sqlite_basename_set(file, {
            gate: firstExclusive,
            onEvent(event) {
                if (event === 'preserve-after-complete-flush') throw new Error('crash before unblock');
            },
        }), 'recovery');
        const blockPath = path.join(tempDirectory, '.invalid-complete.sqlite3.recovery-gate', 'recovery-block.json');
        const block = JSON.parse(fs.readFileSync(blockPath, 'utf8'));
        fs.writeFileSync(path.join(tempDirectory, block.recoveryDirectoryName, 'invalid-complete.sqlite3'), 'changed');
        await reclaim_stale_sqlite_exclusive_intent(
            file, firstExclusive.tokenId, { allProcessesClosed: true },
        );
        const secondExclusive = await acquire_sqlite_exclusive_recovery_gate(file);
        await expectCategory(resume_sqlite_basename_preservation(file, { gate: secondExclusive }), 'recovery');
        expect(inspect_sqlite_recovery_gate(file).recoveryBlocked).toBe(true);
    });

    it.each([
        ['traversal source', (manifest: any) => { manifest.members[0].sourceName = '../escape'; }],
        ['absolute target', (manifest: any) => { manifest.members[0].targetName = path.join(tempDirectory, 'escape'); }],
        ['source target mismatch', (manifest: any) => { manifest.members[0].targetName += '-other'; }],
        ['duplicate member', (manifest: any) => { manifest.members.push({ ...manifest.members[0] }); }],
        ['kind mismatch', (manifest: any) => { manifest.members[0].kind = 'wal'; }],
        ['unsafe size', (manifest: any) => { manifest.members[0].size = Number.MAX_SAFE_INTEGER + 1; }],
        ['unsafe device', (manifest: any) => { manifest.members[0].device = '-1'; }],
        ['unsafe inode', (manifest: any) => { manifest.members[0].inode = 'not-an-inode'; }],
        ['generation mismatch', (manifest: any) => { manifest.generation = '00000000-0000-4000-8000-000000000099'; }],
    ])('rejects invalid preservation manifest context before mutation: %s', async (_label, mutate) => {
        const file = databasePath(`invalid-${_label.replaceAll(' ', '-')}.sqlite3`);
        fs.writeFileSync(file, 'canonical-state');
        const firstExclusive = await acquire_sqlite_exclusive_recovery_gate(file);
        await expectCategory(preserve_sqlite_basename_set(file, {
            gate: firstExclusive,
            onEvent(event) {
                if (event === 'preserve-after-blockade-flush') throw new Error('stop before mutation');
            },
        }), 'recovery');
        const gateDirectory = path.join(tempDirectory, `.${path.basename(file)}.recovery-gate`);
        const blockPath = path.join(gateDirectory, 'recovery-block.json');
        const block = JSON.parse(fs.readFileSync(blockPath, 'utf8'));
        const manifestPath = path.join(tempDirectory, block.recoveryDirectoryName, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        mutate(manifest);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        await reclaim_stale_sqlite_exclusive_intent(
            file, firstExclusive.tokenId, { allProcessesClosed: true },
        );
        const secondExclusive = await acquire_sqlite_exclusive_recovery_gate(file);
        await expectCategory(resume_sqlite_basename_preservation(file, { gate: secondExclusive }), 'recovery');
        expect(fs.readFileSync(file, 'utf8')).toBe('canonical-state');
        expect(fs.existsSync(path.join(tempDirectory, 'escape'))).toBe(false);
    });

    it('rejects a blockade whose recovery directory is not the exact generation directory', async () => {
        const file = databasePath('invalid-block.sqlite3');
        fs.writeFileSync(file, 'canonical-state');
        const firstExclusive = await acquire_sqlite_exclusive_recovery_gate(file);
        await expectCategory(preserve_sqlite_basename_set(file, {
            gate: firstExclusive,
            onEvent(event) {
                if (event === 'preserve-after-blockade-flush') throw new Error('stop before mutation');
            },
        }), 'recovery');
        const blockPath = path.join(tempDirectory, '.invalid-block.sqlite3.recovery-gate', 'recovery-block.json');
        const block = JSON.parse(fs.readFileSync(blockPath, 'utf8'));
        block.recoveryDirectoryName = `other.sqlite3.recovery.${block.generation}`;
        fs.writeFileSync(blockPath, JSON.stringify(block));
        await reclaim_stale_sqlite_exclusive_intent(
            file, firstExclusive.tokenId, { allProcessesClosed: true },
        );
        const secondExclusive = await acquire_sqlite_exclusive_recovery_gate(file);
        await expectCategory(resume_sqlite_basename_preservation(file, { gate: secondExclusive }), 'recovery');
        expect(fs.readFileSync(file, 'utf8')).toBe('canonical-state');
    });

    it('keeps the blockade and source intact when a recovery target already exists', async () => {
        fs.writeFileSync(databasePath(), 'canonical-state');
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        let conflictingTarget: string | undefined;
        const failure = preserve_sqlite_basename_set(databasePath(), {
            gate: exclusive,
            onEvent(event) {
                if (event !== 'preserve-after-blockade-flush') return;
                const recoveryName = fs.readdirSync(tempDirectory)
                    .find((name) => name.startsWith('file-state.sqlite3.recovery.'));
                if (!recoveryName) throw new Error('recovery directory missing');
                conflictingTarget = path.join(tempDirectory, recoveryName, 'file-state.sqlite3');
                fs.writeFileSync(conflictingTarget, 'do-not-overwrite');
            },
        });
        await expectCategory(failure, 'contention');
        expect(fs.readFileSync(databasePath(), 'utf8')).toBe('canonical-state');
        expect(fs.readFileSync(conflictingTarget!, 'utf8')).toBe('do-not-overwrite');
        expect((await inventory_sqlite_basename(databasePath())).recoveryBlocked).toBe(true);
    });

    it('removes a manifest temporary file when replacement rename fails', async () => {
        fs.writeFileSync(databasePath(), 'canonical-state');
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        let recoveryDirectory: string | undefined;

        await expectCategory(preserve_sqlite_basename_set(databasePath(), {
            gate: exclusive,
            onEvent(event) {
                if (event !== 'preserve-after-member-install') return;
                const recoveryName = fs.readdirSync(tempDirectory)
                    .find((name) => name.startsWith('file-state.sqlite3.recovery.'));
                if (!recoveryName) throw new Error('recovery directory missing');
                recoveryDirectory = path.join(tempDirectory, recoveryName);
                const manifestPath = path.join(recoveryDirectory, 'manifest.json');
                fs.unlinkSync(manifestPath);
                fs.mkdirSync(manifestPath);
            },
        }), 'recovery');

        expect(recoveryDirectory).toBeDefined();
        expect(fs.readdirSync(recoveryDirectory!)
            .filter((name) => name.includes('.tmp.'))).toEqual([]);
        expect(fs.readFileSync(databasePath(), 'utf8')).toBe('canonical-state');
    });

    it('blocks startup while an interrupted recovery manifest is active', async () => {
        fs.writeFileSync(databasePath(), 'main-state');
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await expectCategory(
            preserve_sqlite_basename_set(databasePath(), {
                gate: exclusive,
                onEvent(event) {
                    if (event === 'preserve-after-blockade-flush') throw new Error('stop');
                },
            }),
            'recovery',
        );
        const blocked = deferred();
        const startup = open_existing_sqlite_database(databasePath(), {
            onEvent(event) {
                if (event === 'reader-retrying') blocked.resolve();
            },
        });
        await blocked.promise;
        expect(inspect_sqlite_recovery_gate(databasePath())).toMatchObject({
            exclusiveIntentTokenId: exclusive.tokenId,
            recoveryBlocked: true,
        });
        await reclaim_stale_sqlite_exclusive_intent(
            databasePath(), exclusive.tokenId, { allProcessesClosed: true },
        );
        await expectCategory(startup, 'recovery');
        expect(fs.readFileSync(databasePath(), 'utf8')).toBe('main-state');
    });

    it('removes its exact custom initialization candidate after a caught build failure', async () => {
        let initialized = false;
        await expectCategory(initialize_custom_sqlite_database_no_clobber(
            databasePath('custom.sqlite3'),
            {
                ...customSpec,
                initialize(database) {
                    customSpec.initialize(database);
                    initialized = true;
                    throw new Error('injected custom initialization failure');
                },
            },
        ), 'recovery');

        expect(initialized).toBe(true);
        expect(fs.readdirSync(tempDirectory).filter((name) => name.includes('.init-candidate.'))).toEqual([]);
        expect(fs.existsSync(databasePath('custom.sqlite3'))).toBe(false);
    });

    it('preserves a replacement at a custom candidate pathname when cleanup identity no longer matches', async () => {
        let replacementPath: string | undefined;
        await expect(initialize_custom_sqlite_database_no_clobber(
            databasePath('custom.sqlite3'),
            customSpec,
            {
                onEvent(event) {
                    if (event !== 'candidate-after-schema') return;
                    const candidateName = fs.readdirSync(tempDirectory)
                        .find((name) => name.includes('.init-candidate.'));
                    if (!candidateName) throw new Error('candidate missing');
                    replacementPath = path.join(tempDirectory, candidateName);
                    fs.renameSync(replacementPath, `${replacementPath}.owned-original`);
                    fs.writeFileSync(replacementPath, 'foreign replacement');
                    throw new Error('injected replacement failure');
                },
            },
        )).rejects.toThrow();

        expect(replacementPath).toBeDefined();
        expect(fs.readFileSync(replacementPath!, 'utf8')).toBe('foreign replacement');
        expect(fs.existsSync(databasePath('custom.sqlite3'))).toBe(false);
    });

    it.runIf(process.platform !== 'win32')('rejects a custom candidate replaced at the source-link boundary', async () => {
        const alternatePath = databasePath('alternate-custom.sqlite3');
        const alternate = await initialize_custom_sqlite_database_no_clobber(alternatePath, customSpec);
        await alternate.database.close();
        let candidatePath: string | undefined;

        await expect(initialize_custom_sqlite_database_no_clobber(
            databasePath('custom.sqlite3'),
            customSpec,
            {
                beforeCandidateSourceLink() {
                    const candidateName = fs.readdirSync(tempDirectory)
                        .find((name) => name.startsWith('custom.sqlite3.init-candidate.'));
                    if (!candidateName) throw new Error('candidate missing');
                    candidatePath = path.join(tempDirectory, candidateName);
                    fs.unlinkSync(candidatePath);
                    fs.symlinkSync(alternatePath, candidatePath);
                },
            },
        )).rejects.toThrow();

        expect(fs.existsSync(databasePath('custom.sqlite3'))).toBe(false);
        expect(candidatePath).toBeDefined();
        expect(fs.lstatSync(candidatePath!).isSymbolicLink()).toBe(true);
    });

    it('still installs and opens a valid custom candidate', async () => {
        const result = await initialize_custom_sqlite_database_no_clobber(
            databasePath('custom.sqlite3'),
            customSpec,
        );
        expect(result.installed).toBe(true);
        expect(result.wonInstallation).toBe(true);
        expect(fs.readdirSync(tempDirectory).filter((name) => name.includes('.init-candidate.'))).toEqual([]);
        customSpec.validate(result.database.database);
        await result.database.close();
    });

    it('requires exact-token all-processes-closed reclamation for a crashed exclusive intent', async () => {
        const exclusive = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await expectCategory(
            reclaim_stale_sqlite_exclusive_intent(
                databasePath(), 'wrong-token', { allProcessesClosed: true },
            ),
            'recovery',
        );
        await reclaim_stale_sqlite_exclusive_intent(
            databasePath(), exclusive.tokenId, { allProcessesClosed: true },
        );
        const replacement = await acquire_sqlite_exclusive_recovery_gate(databasePath());
        await replacement.release();
    });
});
