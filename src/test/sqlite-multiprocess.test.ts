import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { open_sqlite_file_state_store } from '../sqlite-file-state-persistence';
import {
    SQLITE_INITIALIZATION_DURABLE_CUT_POINTS,
    SQLITE_PRESERVATION_DURABLE_CUT_POINTS,
} from '../sqlite-open-recovery';
import { SqliteTestDatabase } from './helpers/sqlite-test-database';
import {
    build_sqlite_process_worker,
    SqliteChildProcess,
} from './helpers/sqlite-child-process';

let suiteDirectory: string;
let testDirectory: string;
let workerPath: string;
let database: SqliteTestDatabase;
let workers: SqliteChildProcess[];

function databasePath(): string {
    return path.join(testDirectory, 'file-state.sqlite3');
}

function inspectionDatabase(readOnly = true): DatabaseSync {
    const opened = new DatabaseSync(databasePath(), {
        readOnly,
        timeout: 0,
        enableDoubleQuotedStringLiterals: false,
    });
    if (!readOnly) {
        opened.exec(`PRAGMA foreign_keys = ON;
            PRAGMA trusted_schema = OFF;
            PRAGMA synchronous = FULL;
            PRAGMA secure_delete = ON`);
    }
    return opened;
}

function number(value: unknown): number {
    return typeof value === 'bigint' ? Number(value) : value as number;
}

async function spawn(options: Parameters<typeof SqliteChildProcess.spawn>[2] = {}) {
    const worker = await SqliteChildProcess.spawn(workerPath, databasePath(), options);
    workers.push(worker);
    return worker;
}

async function seed(pathname: string, state: Record<string, unknown>): Promise<void> {
    const opened = await open_sqlite_file_state_store(databasePath(), database.options);
    try {
        await opened.store.compare_and_set(pathname, 0, state);
    } finally {
        await opened.close();
    }
}

async function pollObservable(
    description: string,
    observe: () => boolean,
    timeoutMs = 10_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!observe()) {
        if (Date.now() >= deadline) throw new Error(`Timed out polling ${description}.`);
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

function exclusiveIntentToken(): string {
    return fs.readFileSync(path.join(
        testDirectory,
        '.file-state.sqlite3.recovery-gate',
        'exclusive-intent',
    ), 'utf8');
}

async function reclaimCrashedExclusive(tokenId: string): Promise<void> {
    const reclaimer = await spawn({ mode: 'recovery' });
    await reclaimer.request('recoveryReclaimExclusive', { tokenId });
}

type PreservationCutPoint = typeof SQLITE_PRESERVATION_DURABLE_CUT_POINTS[number];
type PreservationMemberProgress = readonly [installed: boolean, sourceRemoved: boolean];

interface PreservationCrashCase {
    readonly label: string;
    readonly event: PreservationCutPoint;
    readonly occurrence: number;
    readonly blockExists: boolean;
    readonly sourceExists: readonly [main: boolean, journal: boolean];
    readonly targetExists: readonly [main: boolean, journal: boolean];
    readonly manifestState: 'absent' | 'moving' | 'complete';
    readonly memberProgress: readonly [main: PreservationMemberProgress, journal: PreservationMemberProgress];
    readonly restart: 'preserve' | 'resume' | 'already-complete';
}

const PRESERVATION_CRASH_CASES: readonly PreservationCrashCase[] = [
    {
        label: 'recovery directory is durable before initial manifest creation',
        event: 'preserve-after-recovery-directory-flush', occurrence: 1, blockExists: false,
        sourceExists: [true, true], targetExists: [false, false], manifestState: 'absent',
        memberProgress: [[false, false], [false, false]], restart: 'preserve',
    },
    {
        label: 'initial manifest is durable before the blockade',
        event: 'preserve-after-manifest-flush', occurrence: 1, blockExists: false,
        sourceExists: [true, true], targetExists: [false, false], manifestState: 'moving',
        memberProgress: [[false, false], [false, false]], restart: 'preserve',
    },
    {
        label: 'blockade is durable before any member moves',
        event: 'preserve-after-blockade-flush', occurrence: 1, blockExists: true,
        sourceExists: [true, true], targetExists: [false, false], manifestState: 'moving',
        memberProgress: [[false, false], [false, false]], restart: 'resume',
    },
    {
        label: 'first target is durable before install progress',
        event: 'preserve-after-member-install', occurrence: 1, blockExists: true,
        sourceExists: [true, true], targetExists: [true, false], manifestState: 'moving',
        memberProgress: [[false, false], [false, false]], restart: 'resume',
    },
    {
        label: 'first install progress is durable before source removal',
        event: 'preserve-after-progress-flush', occurrence: 1, blockExists: true,
        sourceExists: [true, true], targetExists: [true, false], manifestState: 'moving',
        memberProgress: [[true, false], [false, false]], restart: 'resume',
    },
    {
        label: 'first source removal is durable before removal progress',
        event: 'preserve-after-member-source-removal', occurrence: 1, blockExists: true,
        sourceExists: [false, true], targetExists: [true, false], manifestState: 'moving',
        memberProgress: [[true, false], [false, false]], restart: 'resume',
    },
    {
        label: 'first removal progress is durable before the later install',
        event: 'preserve-after-progress-flush', occurrence: 2, blockExists: true,
        sourceExists: [false, true], targetExists: [true, false], manifestState: 'moving',
        memberProgress: [[true, true], [false, false]], restart: 'resume',
    },
    {
        label: 'later target is durable before its install progress',
        event: 'preserve-after-member-install', occurrence: 2, blockExists: true,
        sourceExists: [false, true], targetExists: [true, true], manifestState: 'moving',
        memberProgress: [[true, true], [false, false]], restart: 'resume',
    },
    {
        label: 'later install progress is durable before its source removal',
        event: 'preserve-after-progress-flush', occurrence: 3, blockExists: true,
        sourceExists: [false, true], targetExists: [true, true], manifestState: 'moving',
        memberProgress: [[true, true], [true, false]], restart: 'resume',
    },
    {
        label: 'later source removal is durable before its removal progress',
        event: 'preserve-after-member-source-removal', occurrence: 2, blockExists: true,
        sourceExists: [false, false], targetExists: [true, true], manifestState: 'moving',
        memberProgress: [[true, true], [true, false]], restart: 'resume',
    },
    {
        label: 'all members are durably moved before complete',
        event: 'preserve-after-progress-flush', occurrence: 4, blockExists: true,
        sourceExists: [false, false], targetExists: [true, true], manifestState: 'moving',
        memberProgress: [[true, true], [true, true]], restart: 'resume',
    },
    {
        label: 'complete manifest is durable before unblock',
        event: 'preserve-after-complete-flush', occurrence: 1, blockExists: true,
        sourceExists: [false, false], targetExists: [true, true], manifestState: 'complete',
        memberProgress: [[true, true], [true, true]], restart: 'resume',
    },
    {
        label: 'complete preservation is durable after unblock',
        event: 'preserve-after-blockade-removal', occurrence: 1, blockExists: false,
        sourceExists: [false, false], targetExists: [true, true], manifestState: 'complete',
        memberProgress: [[true, true], [true, true]], restart: 'already-complete',
    },
];

beforeAll(async () => {
    suiteDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-sqlite-multiprocess-suite-'));
    workerPath = await build_sqlite_process_worker(suiteDirectory);
});

afterAll(async () => {
    await fs.promises.rm(suiteDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
    testDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-sqlite-multiprocess-'));
    database = new SqliteTestDatabase(databasePath());
    workers = [];
    await database.initialize();
});

afterEach(async () => {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await database.close();
    await fs.promises.rm(testDirectory, { recursive: true, force: true });
});

describe('SQLite real multi-process behavior', () => {
    it('allows exactly one competing CAS commit and returns one fresh conflict', async () => {
        const first = await spawn();
        const second = await spawn();

        const firstResult = first.request<any>('cas', {
            path: '/same.csv', expectedRevision: 0, state: { activeSheetIndex: 1 },
            barrierId: 'first-cas',
        });
        const secondResult = second.request<any>('cas', {
            path: '/same.csv', expectedRevision: 0, state: { activeSheetIndex: 2 },
            barrierId: 'second-cas',
        });
        await Promise.all([
            first.waitForBarrier('first-cas', 'before-cas'),
            second.waitForBarrier('second-cas', 'before-cas'),
        ]);
        await Promise.all([
            first.releaseBarrier('first-cas'),
            second.releaseBarrier('second-cas'),
        ]);
        const results = await Promise.all([firstResult, secondResult]);

        expect(results.map((result) => result.type).sort()).toEqual(['committed', 'conflict']);
        const committed = results.find((result) => result.type === 'committed');
        const conflict = results.find((result) => result.type === 'conflict');
        expect(committed.snapshot.revision).toBe(1);
        expect(conflict.snapshot).toEqual(committed.snapshot);
    });

    it('allocates unique revisions and strict recency across unrelated writers', async () => {
        const first = await spawn();
        const second = await spawn();
        const leftResult = first.request<any>('cas', {
            path: '/left.csv', expectedRevision: 0, state: { activeSheetIndex: 1 },
            barrierId: 'left-writer', barrierName: 'before-write',
        });
        const rightResult = second.request<any>('cas', {
            path: '/right.csv', expectedRevision: 0, state: { activeSheetIndex: 2 },
            barrierId: 'right-writer', barrierName: 'before-write',
        });
        await Promise.all([
            first.waitForBarrier('left-writer', 'before-write'),
            second.waitForBarrier('right-writer', 'before-write'),
        ]);
        await Promise.all([
            first.releaseBarrier('left-writer'),
            second.releaseBarrier('right-writer'),
        ]);
        const [left, right] = await Promise.all([leftResult, rightResult]);

        expect(left.type).toBe('committed');
        expect(right.type).toBe('committed');
        expect(new Set([left.snapshot.revision, right.snapshot.revision]).size).toBe(2);

        const direct = inspectionDatabase();
        const statement = direct.prepare('SELECT state_revision, recency_order FROM entries ORDER BY path');
        statement.setReadBigInts(true);
        const rows = statement.all();
        direct.close();
        expect(new Set(rows.map((row) => String(row.state_revision))).size).toBe(2);
        expect(new Set(rows.map((row) => String(row.recency_order))).size).toBe(2);
    });

    it('keeps a deferred reader on one coherent prior snapshot during an uncommitted write', async () => {
        await seed('/snapshot.csv', { activeSheetIndex: 1 });
        const reader = await spawn({ mode: 'raw' });
        const writer = await spawn({ mode: 'raw' });
        const sql = 'SELECT state_revision, state_json FROM entries WHERE path = ?';

        const before = await reader.request<any>('rawBeginSnapshot', {
            sql, parameters: ['/snapshot.csv'],
        });
        expect(number(before.state_revision)).toBe(1);
        expect(JSON.parse(before.state_json)).toEqual({ activeSheetIndex: 1 });

        const begun = writer.request('rawBeginWrite', {
            sql: 'UPDATE entries SET state_revision = 2, state_json = ? WHERE path = ?',
            parameters: [JSON.stringify({ activeSheetIndex: 2 }), '/snapshot.csv'],
        });
        await writer.waitForEvent('write-uncommitted');
        await begun;

        const committing = writer.request('rawCommit');
        const during = await reader.request<any>('rawFinishSnapshot', {
            sql, parameters: ['/snapshot.csv'],
        });
        await committing;
        expect(number(during.state_revision)).toBe(1);
        expect(JSON.parse(during.state_json)).toEqual({ activeSheetIndex: 1 });
    });

    it('conflicts a stale CAS when another process advances authority only', async () => {
        await seed('/authority.csv', { activeSheetIndex: 1 });
        const stale = await spawn();
        const advancing = await spawn();
        const authority = await stale.request<any>('readAuthority', { path: '/authority.csv' });

        await expect(advancing.request('stage', {
            path: '/authority.csv',
            stage: {
                id: 'projection',
                kind: 'projection',
                ordinal: 1,
                expectedStateRevision: 1,
                expectedCommitSequence: 0,
            },
        })).resolves.toEqual({ type: 'staged' });
        await expect(advancing.request('finalize', {
            path: '/authority.csv', stageId: 'projection',
        })).resolves.toMatchObject({ type: 'finalized' });

        const result = await stale.request<any>('cas', {
            path: '/authority.csv',
            expectedRevision: 1,
            state: { activeSheetIndex: 9 },
            basis: { expectedAuthorityRevision: authority.authorityRevision },
        });
        expect(result).toMatchObject({
            type: 'conflict',
            snapshot: { revision: 1, state: { activeSheetIndex: 1 } },
            authority: { authorityRevision: authority.authorityRevision + 1 },
        });
    });

    it('isolates ambiguous markers per session and admits no local overtake of reconciliation', async () => {
        const releasePath = path.join(testDirectory, 'reconcile-release');
        const reconciling = await spawn({
            ambiguousCommit: { reconciliationReleasePath: releasePath },
        });
        const other = await spawn();

        const ambiguous = reconciling.request<any>('ambiguousCasWithQueuedRead', {
            path: '/ambiguous.csv',
            expectedRevision: 0,
            state: { activeSheetIndex: 1 },
        });
        await reconciling.waitForEvent('reconciliation-ready');

        await expect(other.request('cas', {
            path: '/other.csv', expectedRevision: 0, state: { activeSheetIndex: 2 },
        })).resolves.toMatchObject({ type: 'committed' });
        fs.writeFileSync(releasePath, 'release', { mode: 0o600, flag: 'wx' });

        const result = await ambiguous;
        expect(result.commitResult).toMatchObject({ type: 'committed' });
        expect(result.readResult).toEqual(result.commitResult.snapshot);
        expect(result.runtimeEvents.indexOf('reconcile-committed')).toBeGreaterThanOrEqual(0);
        expect(result.runtimeEvents.indexOf('before-read-begin'))
            .toBeGreaterThan(result.runtimeEvents.indexOf('reconcile-committed'));

        const direct = inspectionDatabase();
        const statement = direct.prepare(`SELECT process_id, last_committed_sequence,
            last_operation_kind FROM writer_sessions ORDER BY process_id`);
        statement.setReadBigInts(true);
        const rows = statement.all();
        direct.close();
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => number(row.last_committed_sequence))).toEqual([1, 1]);
        expect(rows.every((row) => row.last_operation_kind === 'compareAndSet')).toBe(true);
    }, 15_000);

    it('allows exactly one durable edit owner across competing processes', async () => {
        await seed('/owned.csv', { activeSheetIndex: 1 });
        const first = await spawn();
        const second = await spawn();
        const [left, right] = await Promise.all([
            first.request<any>('acquireEdit', {
                path: '/owned.csv', hostLockId: 'host-left', physicalResourceLockKey: 'shared-resource',
            }),
            second.request<any>('acquireEdit', {
                path: '/owned.csv', hostLockId: 'host-right', physicalResourceLockKey: 'shared-resource',
            }),
        ]);
        expect([left.type, right.type].sort()).toEqual(['acquired', 'busy']);
        const owner = left.type === 'acquired' ? first : second;
        const session = left.type === 'acquired' ? left.session : right.session;
        const other = owner === first ? second : first;
        await owner.crash();
        await expect(other.request('acquireEdit', {
            path: '/owned.csv', hostLockId: 'host-third', physicalResourceLockKey: 'shared-resource',
        })).resolves.toEqual({ type: 'busy' });
        const direct = inspectionDatabase();
        const row = direct.prepare(`SELECT edit_session_id, ownership_generation
            FROM edit_sessions WHERE entry_path = ?`).get('/owned.csv');
        direct.close();
        expect(row).toMatchObject({
            edit_session_id: session.editSessionId,
            ownership_generation: session.ownershipGeneration,
        });
    });

    it('moves durable leases cross-process and exact release deletes the original handle', async () => {
        await seed('/Alias.csv', { activeSheetIndex: 1 });
        const owner = await spawn();
        const canonicalizer = await spawn();
        await owner.request('lease', {
            handleId: 'lease-handle', canonicalPath: '/Alias.csv', keyKind: 'lowercase',
        });

        await canonicalizer.request('canonicalize', {
            canonicalPath: '/alias.csv', keyKind: 'lowercase',
        });
        let direct = inspectionDatabase();
        expect(direct.prepare('SELECT current_entry_path FROM entry_leases').get()?.current_entry_path)
            .toBe('/alias.csv');
        direct.close();

        await owner.request('releaseLease', { handleId: 'lease-handle' });
        direct = inspectionDatabase();
        expect(direct.prepare('SELECT count(*) AS count FROM entry_leases').get()?.count).toBe(0);
        direct.close();
    });

    it('leaves a crashed lease protective under cross-process quota churn', async () => {
        await seed('/protected.csv', { activeSheetIndex: 1 });
        const owner = await spawn({ maxStoredFiles: 1 });
        await owner.request('lease', {
            handleId: 'crash-lease', canonicalPath: '/protected.csv', keyKind: 'identity',
        });
        await pollObservable('durable lease row', () => {
            const direct = inspectionDatabase();
            const count = number(direct.prepare('SELECT count(*) AS count FROM entry_leases').get()?.count);
            direct.close();
            return count === 1;
        });
        await owner.crash();

        const churn = await spawn({ maxStoredFiles: 1 });
        for (let index = 0; index < 6; index += 1) {
            await churn.request('cas', {
                path: `/churn-${index}.csv`,
                expectedRevision: index === 0 ? 0 : (await churn.request<any>('read', {
                    path: `/churn-${index}.csv`,
                })).revision,
                state: { activeSheetIndex: index },
            });
        }
        await expect(churn.request('read', { path: '/protected.csv' })).resolves.toMatchObject({
            revision: 1,
            state: { activeSheetIndex: 1 },
        });
        const direct = inspectionDatabase();
        expect(direct.prepare('SELECT count(*) AS count FROM entry_leases').get()?.count).toBe(1);
        direct.close();
    });

    it('fences an already-open runtime after explicit generation advancement', async () => {
        const oldRuntime = await spawn();
        const direct = inspectionDatabase(false);
        direct.prepare(`UPDATE state_meta SET coordination_generation = coordination_generation + 1
            WHERE singleton = 1`).run();
        direct.close();

        await expect(oldRuntime.request('cas', {
            path: '/fenced.csv', expectedRevision: 0, state: { activeSheetIndex: 1 },
        })).rejects.toMatchObject({ category: 'protocol' });
    });

    it('categorizes real lock contention distinctly from real database corruption', async () => {
        const locker = await spawn({ mode: 'raw' });
        const observer = await spawn({ mode: 'raw' });
        const holding = locker.request('rawHoldWriteLock');
        await locker.waitForEvent('write-lock-held');
        await holding;

        await expect(observer.request('rawCategorizeContention')).resolves.toMatchObject({
            category: 'contention',
        });
        await locker.request('rawRollback');

        const corruptPath = path.join(testDirectory, 'corrupt.sqlite3');
        fs.writeFileSync(corruptPath, Buffer.alloc(4096, 0x5a), { mode: 0o600 });
        await expect(observer.request('rawCategorizeCorruption', { path: corruptPath })).resolves.toMatchObject({
            category: 'corrupt',
        });
    });

    it('never evicts pending-edit rows during multi-process quota churn', async () => {
        await seed('/pending.csv', { pendingEdits: { '0:0': 'recoverable' } });
        const first = await spawn({ maxStoredFiles: 1 });
        const second = await spawn({ maxStoredFiles: 1 });
        for (let index = 0; index < 8; index += 1) {
            const worker = index % 2 === 0 ? first : second;
            await worker.request('cas', {
                path: `/quota-${index}.csv`,
                expectedRevision: 0,
                state: { activeSheetIndex: index },
            });
        }

        await expect(first.request('read', { path: '/pending.csv' })).resolves.toMatchObject({
            revision: 1,
            state: { pendingEdits: { '0:0': 'recoverable' } },
        });
        const direct = inspectionDatabase();
        expect(direct.prepare(`SELECT has_pending_edits FROM entries
            WHERE path = '/pending.csv'`).get()?.has_pending_edits).toBe(1);
        direct.close();
    });
});

describe('SQLite real child-process recovery gates', () => {
    it('does not lose an event sent immediately after readiness', async () => {
        const worker = await spawn({ mode: 'recovery', readyEventName: 'ready-followup' });
        await expect(worker.waitForEvent('ready-followup')).resolves.toMatchObject({
            name: 'ready-followup',
        });
    });

    it('pauses a reader after durable token flush and prevents it crossing new intent', async () => {
        const reader = await spawn({ mode: 'recovery' });
        const exclusive = await spawn({ mode: 'recovery' });
        const acquiringReader = reader.request<any>('recoveryAcquireReader', {
            pauseEvent: 'reader-after-token-flush',
            barrierId: 'reader-token-flushed',
        });
        await reader.waitForBarrier('reader-token-flushed', 'reader-after-token-flush');

        const acquiredExclusive = await exclusive.request<any>('recoveryAcquireExclusive');
        expect(acquiredExclusive.tokenId).toMatch(/^[0-9a-f-]{36}$/i);
        await reader.releaseBarrier('reader-token-flushed');
        await pollObservable('raced reader removes its durable token', () => {
            const readersDirectory = path.join(
                testDirectory,
                '.file-state.sqlite3.recovery-gate',
                'readers',
            );
            return fs.readdirSync(readersDirectory).length === 0;
        });

        await exclusive.request('recoveryReleaseGate');
        const acquiredReader = await acquiringReader;
        expect(acquiredReader.tokenId).toMatch(/^[0-9a-f-]{36}$/i);
        await reader.request('recoveryReleaseGate');
    });

    it('treats a reader paused after intent recheck as open until its exact token releases', async () => {
        const reader = await spawn({ mode: 'recovery' });
        const exclusive = await spawn({ mode: 'recovery' });
        const acquiringReader = reader.request<any>('recoveryAcquireReader', {
            pauseEvent: 'reader-after-intent-recheck',
            barrierId: 'reader-rechecked-intent',
        });
        await reader.waitForBarrier('reader-rechecked-intent', 'reader-after-intent-recheck');
        await exclusive.request('recoveryAcquireExclusive', {
            pauseEvent: 'exclusive-waiting-for-readers',
            barrierId: 'rechecked-reader-drain',
        });
        const draining = exclusive.request('recoveryWaitReaders');
        await exclusive.waitForBarrier('rechecked-reader-drain', 'exclusive-waiting-for-readers');

        await reader.releaseBarrier('reader-rechecked-intent');
        await acquiringReader;
        await exclusive.releaseBarrier('rechecked-reader-drain');
        await reader.request('recoveryReleaseGate');
        await draining;
        await exclusive.request('recoveryReleaseGate');
    });

    it('cannot drain an open connection and admits no new reader across exclusive intent', async () => {
        const existingReader = await spawn({ mode: 'recovery' });
        const exclusive = await spawn({ mode: 'recovery' });
        const lateReader = await spawn({ mode: 'recovery' });
        await existingReader.request('recoveryAcquireReader');
        await exclusive.request('recoveryAcquireExclusive', {
            pauseEvent: 'exclusive-waiting-for-readers',
            barrierId: 'exclusive-waiting',
        });
        const draining = exclusive.request('recoveryWaitReaders');
        await exclusive.waitForBarrier('exclusive-waiting', 'exclusive-waiting-for-readers');

        const lateAcquire = lateReader.request('recoveryAcquireReader');
        const gateDirectory = path.join(testDirectory, '.file-state.sqlite3.recovery-gate');
        expect(fs.existsSync(path.join(gateDirectory, 'exclusive-intent'))).toBe(true);
        expect(fs.readdirSync(path.join(gateDirectory, 'readers'))).toHaveLength(1);

        await exclusive.releaseBarrier('exclusive-waiting');
        await existingReader.request('recoveryReleaseGate');
        await draining;
        expect(fs.readdirSync(path.join(gateDirectory, 'readers'))).toHaveLength(0);
        await exclusive.request('recoveryReleaseGate');
        await expect(lateAcquire).resolves.toMatchObject({ tokenId: expect.any(String) });
        await lateReader.request('recoveryReleaseGate');
    });

    it('leaves the exact killed-child token and requires explicit all-processes-closed reclamation', async () => {
        const crashedReader = await spawn({ mode: 'recovery' });
        const { tokenId } = await crashedReader.request<any>('recoveryAcquireReader');
        await crashedReader.crash();

        const exclusive = await spawn({ mode: 'recovery' });
        await exclusive.request('recoveryAcquireExclusive', {
            pauseEvent: 'exclusive-waiting-for-readers',
            barrierId: 'stale-reader-wait',
        });
        const draining = exclusive.request('recoveryWaitReaders');
        await exclusive.waitForBarrier('stale-reader-wait', 'exclusive-waiting-for-readers');
        const inventory = await exclusive.request<any>('recoveryInspect');
        expect(inventory.readerTokenIds).toEqual([tokenId]);
        await expect(exclusive.request('recoveryReclaimReader', { tokenId: 'wrong-token' }))
            .rejects.toMatchObject({ category: 'recovery', operation: 'reader-token-reclaim' });
        expect((await exclusive.request<any>('recoveryInspect')).readerTokenIds).toEqual([tokenId]);

        await exclusive.request('recoveryReclaimReader', { tokenId });
        await exclusive.releaseBarrier('stale-reader-wait');
        await draining;
        await exclusive.request('recoveryReleaseGate');
    });

    it('rejects request and barrier waiters promptly when a paused child is killed', async () => {
        const worker = await spawn({ mode: 'store' });
        const request = worker.request('cas', {
            path: '/killed.csv', expectedRevision: 0, state: {}, barrierId: 'killed-cas',
        });
        await worker.waitForBarrier('killed-cas', 'before-cas');
        const unmatchedBarrier = worker.waitForBarrier('never-reached');
        await worker.crash();
        await expect(request).rejects.toThrow('SQLite worker exited');
        await expect(unmatchedBarrier).rejects.toThrow('SQLite worker exited');
    });

    it.each(SQLITE_INITIALIZATION_DURABLE_CUT_POINTS)(
        'a killed initializer at %s resumes in a fresh process without serving a partial main',
        async (cutPoint) => {
            fs.rmSync(databasePath(), { force: true });
            const initializer = await spawn({ mode: 'recovery' });
            const initializing = initializer.request('recoveryInitialize', {
                exclusive: true,
                pauseEvent: cutPoint,
                barrierId: `initialize-${cutPoint}`,
            });
            await initializer.waitForBarrier(`initialize-${cutPoint}`, cutPoint);
            const exactIntent = exclusiveIntentToken();
            await initializer.crash();
            await expect(initializing).rejects.toThrow('SQLite worker exited');
            expect(exclusiveIntentToken()).toBe(exactIntent);
            await reclaimCrashedExclusive(exactIntent);

            const entries = fs.readdirSync(testDirectory);
            const candidateNames = entries.filter((name) => name.includes('.init-candidate.'));
            const fresh = await spawn({ mode: 'recovery' });
            if (fs.existsSync(databasePath())) {
                await expect(fresh.request('recoveryInitialize', { exclusive: true }))
                    .resolves.toMatchObject({ installed: false });
            } else {
                expect(candidateNames).toHaveLength(1);
                await expect(fresh.request('recoveryResumeCandidate'))
                    .resolves.toMatchObject({ installed: true });
            }
            const direct = inspectionDatabase();
            expect(direct.prepare('SELECT database_id FROM state_meta').get()?.database_id)
                .toBe(`test-database:${databasePath()}`);
            expect(direct.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
            direct.close();
        },
        15_000,
    );

    it.each(PRESERVATION_CRASH_CASES)(
        'resumes safely when killed after $label ($event occurrence $occurrence)',
        async (crashCase) => {
            const sourcePaths = [databasePath(), `${databasePath()}-journal`] as const;
            const originalContents = [
                fs.readFileSync(sourcePaths[0]),
                Buffer.from('durable-journal-evidence'),
            ] as const;
            fs.writeFileSync(sourcePaths[1], originalContents[1], { mode: 0o600 });
            const barrierId = `preserve-${crashCase.event}-${crashCase.occurrence}`;
            const preserver = await spawn({ mode: 'recovery' });
            const preserving = preserver.request('recoveryPreserve', {
                pauseEvent: crashCase.event,
                pauseOccurrence: crashCase.occurrence,
                barrierId,
            });
            const barrier = await preserver.waitForBarrier(
                barrierId,
                crashCase.event,
                crashCase.occurrence,
            );
            expect(barrier.value).toMatchObject({ occurrence: crashCase.occurrence });
            const exactIntent = exclusiveIntentToken();
            await preserver.crash();
            await expect(preserving).rejects.toThrow('SQLite worker exited');
            expect(exclusiveIntentToken()).toBe(exactIntent);
            await reclaimCrashedExclusive(exactIntent);

            const gateDirectory = path.join(testDirectory, '.file-state.sqlite3.recovery-gate');
            const blockPath = path.join(gateDirectory, 'recovery-block.json');
            expect(fs.existsSync(blockPath)).toBe(crashCase.blockExists);
            const recoveryDirectoryName = fs.readdirSync(testDirectory)
                .find((name) => name.startsWith('file-state.sqlite3.recovery.'));
            expect(recoveryDirectoryName).toBeDefined();
            const recoveryDirectory = path.join(testDirectory, recoveryDirectoryName!);
            const targetPaths = [
                path.join(recoveryDirectory, 'file-state.sqlite3'),
                path.join(recoveryDirectory, 'file-state.sqlite3-journal'),
            ] as const;
            const manifestPath = path.join(recoveryDirectory, 'manifest.json');
            if (crashCase.manifestState === 'absent') {
                expect(fs.existsSync(manifestPath)).toBe(false);
                expect(fs.readdirSync(recoveryDirectory)).toEqual([]);
            } else {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                expect(manifest.state).toBe(crashCase.manifestState);
                expect(manifest.members.map((member: any) => ({
                    sourceName: member.sourceName,
                    targetName: member.targetName,
                    installed: member.installed,
                    sourceRemoved: member.sourceRemoved,
                }))).toEqual([
                    {
                        sourceName: 'file-state.sqlite3',
                        targetName: 'file-state.sqlite3',
                        installed: crashCase.memberProgress[0][0],
                        sourceRemoved: crashCase.memberProgress[0][1],
                    },
                    {
                        sourceName: 'file-state.sqlite3-journal',
                        targetName: 'file-state.sqlite3-journal',
                        installed: crashCase.memberProgress[1][0],
                        sourceRemoved: crashCase.memberProgress[1][1],
                    },
                ]);
            }
            for (let index = 0; index < sourcePaths.length; index += 1) {
                expect(fs.existsSync(sourcePaths[index])).toBe(crashCase.sourceExists[index]);
                expect(fs.existsSync(targetPaths[index])).toBe(crashCase.targetExists[index]);
                if (crashCase.sourceExists[index]) {
                    expect(fs.readFileSync(sourcePaths[index])).toEqual(originalContents[index]);
                }
                if (crashCase.targetExists[index]) {
                    expect(fs.readFileSync(targetPaths[index])).toEqual(originalContents[index]);
                }
                if (crashCase.sourceExists[index] && crashCase.targetExists[index]) {
                    expect(fs.statSync(sourcePaths[index]).ino).toBe(fs.statSync(targetPaths[index]).ino);
                }
            }

            if (crashCase.restart === 'preserve') {
                const fresh = await spawn({ mode: 'recovery' });
                await fresh.request('recoveryPreserve');
            } else if (crashCase.restart === 'resume') {
                await expect(open_sqlite_file_state_store(databasePath(), database.options))
                    .rejects.toMatchObject({ category: 'recovery' });
                const fresh = await spawn({ mode: 'recovery' });
                await fresh.request('recoveryResumePreserve');
            }

            expect(fs.existsSync(sourcePaths[0])).toBe(false);
            expect(fs.existsSync(sourcePaths[1])).toBe(false);
            expect(fs.readFileSync(targetPaths[0])).toEqual(originalContents[0]);
            expect(fs.readFileSync(targetPaths[1])).toEqual(originalContents[1]);
            const completedManifest = JSON.parse(fs.readFileSync(
                path.join(recoveryDirectory, 'manifest.json'),
                'utf8',
            ));
            expect(completedManifest).toMatchObject({
                state: 'complete',
                members: [
                    { installed: true, sourceRemoved: true },
                    { installed: true, sourceRemoved: true },
                ],
            });
            expect(fs.existsSync(blockPath)).toBe(false);
        },
        15_000,
    );
});
