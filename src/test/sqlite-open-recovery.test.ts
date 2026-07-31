import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
    initialize_sqlite_database_no_clobber,
    inspect_sqlite_recovery_gate,
    install_recognized_sqlite_candidate_no_clobber,
    inventory_sqlite_basename,
    open_existing_sqlite_database,
    preserve_sqlite_basename_set,
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
            readerTokenIds: [reader.tokenId],
            recoveryBlocked: false,
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
        expect(() => inspect_sqlite_recovery_gate(databasePath())).toThrow(SqliteFileStateError);
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

    it('fails closed explicitly on Windows without a proven directory primitive', () => {
        try {
            assert_sqlite_directory_durability_supported(tempDirectory, fs.fsyncSync, 'win32');
            throw new Error('Windows directory durability unexpectedly succeeded');
        } catch (error) {
            expect(error).toBeInstanceOf(SqliteFileStateError);
            expect((error as SqliteFileStateError).category).toBe('unsupported');
            expect((error as SqliteFileStateError).metadata.operation).toBe('directory-durability');
        }
        expect(() => assert_sqlite_directory_durability_supported(
            tempDirectory,
            () => {},
            'win32',
        )).not.toThrow();
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
    it.runIf(process.platform === 'win32')(
        'fails public open on Windows at unsupported directory durability without creating database evidence',
        async () => {
            const error = await expectCategory(publicOpen(), 'unsupported');
            expect(error.metadata.operation).toBe('directory-durability');
            expect(fs.existsSync(databasePath())).toBe(false);
            expect(fs.readdirSync(tempDirectory).filter((name) =>
                name !== '.file-state.sqlite3.recovery-gate')).toEqual([]);

            const gateDirectory = path.join(tempDirectory, '.file-state.sqlite3.recovery-gate');
            if (fs.existsSync(gateDirectory)) {
                expect(fs.readdirSync(gateDirectory)).toEqual(['readers']);
                expect(fs.readdirSync(path.join(gateDirectory, 'readers'))).toEqual([]);
            }
        },
    );

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

    it('closes the installed winner before token release when exact candidate cleanup fails', async () => {
        await expectCategory(initialize_sqlite_database_no_clobber(
            databasePath(),
            identity,
            { appliedAtMs: 100, appVersion: '0.7.0' },
            {
                onEvent(event) {
                    if (event !== 'winner-validated') return;
                    const candidate = fs.readdirSync(tempDirectory)
                        .find((name) => name.includes('.init-candidate.'));
                    if (!candidate) throw new Error('candidate missing');
                    const candidatePath = path.join(tempDirectory, candidate);
                    fs.unlinkSync(candidatePath);
                    fs.writeFileSync(candidatePath, 'replacement');
                },
            },
        ), 'recovery');
        expect(inspect_sqlite_recovery_gate(databasePath()).readerTokenIds).toEqual([]);
        const opened = await open_existing_sqlite_database(databasePath());
        await opened.close();
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

        fs.linkSync(targetPath, databasePath());
        expect((await inventory_sqlite_basename(databasePath())).incompleteRecoveryDirectories).toBe(1);
        fs.unlinkSync(databasePath());
        expect((await inventory_sqlite_basename(databasePath())).incompleteRecoveryDirectories).toBe(0);

        fs.unlinkSync(targetPath);
        fs.writeFileSync(targetPath, 'main-state');
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

    it('keeps a complete-manifest blockade when the canonical source path is recreated', async () => {
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
        await expectCategory(
            resume_sqlite_basename_preservation(databasePath(), { gate: secondExclusive }),
            'recovery',
        );
        expect(fs.readFileSync(databasePath(), 'utf8')).toBe('recreated-main');
        expect(inspect_sqlite_recovery_gate(databasePath()).recoveryBlocked).toBe(true);
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
