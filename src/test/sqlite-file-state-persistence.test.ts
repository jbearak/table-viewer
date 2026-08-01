import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    create_keyed_authority_store,
    supports_coordinated_file_state,
    FileStateReservationBusyError,
    type AuthorityFileStateStore,
    type KeyedFileStatePersistence,
    type KeyedStateReadTransaction,
    type KeyedStateWriteTransaction,
    type ReservedPhysicalWriteIo,
} from '../state';
import {
    open_sqlite_file_state_persistence,
    open_sqlite_file_state_store,
    recover_stale_sqlite_coordination,
    reopen_reserved_physical_write,
} from '../sqlite-file-state-persistence';
import { SqliteFileStateError } from '../sqlite-file-state-errors';
import { inspect_sqlite_recovery_gate } from '../sqlite-open-recovery';
import { PhysicalResourceLockManager } from '../physical-resource-lock';
import {
    prepare_physical_install,
    type PlatformConditionalInstaller,
} from '../prepared-physical-install';
import { file_state_store_contract } from './file-state-store-contract';
import { SqliteTestDatabase } from './helpers/sqlite-test-database';

let tempDirectory: string;
let databaseCounter = 0;
let databases: SqliteTestDatabase[];

function sha256(bytes: Uint8Array): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function reservedIoBinding(
    preparedInstallId: string,
    hostLockId: string,
    physicalResourceLockKey: string,
    expectedPhysicalDigest: string,
    intendedPhysicalDigest: string,
) {
    return Object.freeze({
        preparedInstallId,
        hostLockId,
        physicalResourceLockKey,
        expectedPhysicalDigest,
        intendedPhysicalDigest,
    });
}

function freshDatabase(options: ConstructorParameters<typeof SqliteTestDatabase>[1] = {}) {
    const database = new SqliteTestDatabase(
        path.join(tempDirectory, `store-${databaseCounter++}`, 'file-state.sqlite3'),
        options,
    );
    databases.push(database);
    return database;
}

function deferredStore(
    database: SqliteTestDatabase,
    maxStoredFiles = 10_000,
): AuthorityFileStateStore {
    let opened: ReturnType<SqliteTestDatabase['openPersistence']> | undefined;
    const getOpened = (): ReturnType<SqliteTestDatabase['openPersistence']> => (
        opened ??= database.openPersistence()
    );
    const deferred: KeyedFileStatePersistence = {
        runtime_key: database.runtimeKey,
        canonicalization_revision_policy: 'allocate-revision-when-target-absent',
        read_transaction: (body) => getOpened().then((persistence) => persistence.read_transaction(body)),
        write_transaction: (kind, body) => getOpened().then((persistence) => (
            persistence.write_transaction(kind, body)
        )),
        close: async () => (await getOpened()).close(),
    };
    return create_keyed_authority_store(deferred, () => maxStoredFiles);
}

function instrumentPayloadIo(persistence: KeyedFileStatePersistence) {
    const counts = { reads: 0, writes: 0 };
    const readTx = (tx: KeyedStateReadTransaction): KeyedStateReadTransaction => ({
        ...tx,
        read_entry(path) {
            counts.reads += 1;
            return tx.read_entry(path);
        },
    });
    const writeTx = (tx: KeyedStateWriteTransaction): KeyedStateWriteTransaction => ({
        ...tx,
        read_entry(path) {
            counts.reads += 1;
            return tx.read_entry(path);
        },
        write_entry(value) {
            counts.writes += 1;
            tx.write_entry(value);
        },
    });
    return {
        counts,
        persistence: {
            ...persistence,
            read_transaction: (body) => persistence.read_transaction((tx) => body(readTx(tx))),
            write_transaction: (kind, body) => persistence.write_transaction(
                kind,
                (tx) => body(writeTx(tx)),
            ),
        } satisfies KeyedFileStatePersistence,
        reset() {
            counts.reads = 0;
            counts.writes = 0;
        },
    };
}

beforeEach(async () => {
    tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-sqlite-store-'));
    databases = [];
});

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(databases.map((database) => database.close()));
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
});

file_state_store_contract('SQLite backend', () => {
    const database = freshDatabase();
    return {
        create: (max = 10_000) => deferredStore(database, max),
        createIndependent: (max = 10_000) => deferredStore(database, max),
        seedEnvelope: (envelope) => database.seedEnvelope(envelope),
        inspect: () => database.inspect(),
        failNextWrite: () => database.failNextWrite(),
    };
}, {
    allocateRevisionWhenCanonicalTargetAbsent: true,
});

describe('SQLite file-state persistence', () => {
    it('opens through no-clobber initialization and exposes coordinated authority only for SQLite', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(
            database.databasePath,
            database.options,
        );
        expect(opened.persistence.canonicalization_revision_policy)
            .toBe('allocate-revision-when-target-absent');
        expect(supports_coordinated_file_state(opened.store)).toBe(true);
        expect(Object.keys(opened.store).sort()).toEqual([
            'acquire_edit_session',
            'canonicalize_path',
            'cleanup_authority_transactions',
            'compare_and_set',
            'copy_entry_if_absent',
            'discard_authority_transaction',
            'execute_reserved_physical_write',
            'finalize_authority_transaction',
            'inspect_authority_transaction',
            'lease_entry',
            'read',
            'read_authority',
            'reconcile_reserved_physical_write',
            'release_edit_session',
            'reserve_physical_write',
            'stage_authority_transaction',
            'touch',
        ]);
        await opened.close();
    });

    it('uses one nondefault supported protocol for initialization, runtime, and stale recovery', async () => {
        const database = freshDatabase();
        await database.initialize();
        const direct = new DatabaseSync(database.databasePath);
        direct.prepare(`UPDATE state_meta SET min_reader_protocol = ?, max_reader_protocol = ?,
            min_writer_protocol = ?, max_writer_protocol = ? WHERE singleton = 1`).run(7, 7, 7, 7);
        direct.close();

        const options = { ...database.options, supportedProtocol: 7 };
        const opened = await open_sqlite_file_state_store(database.databasePath, options);
        await opened.close();
        await expect(recover_stale_sqlite_coordination(
            database.databasePath,
            options,
            { allProcessesClosed: true },
        )).resolves.toBe(2);

        await expect(open_sqlite_file_state_persistence(database.databasePath, {
            ...options,
            initialization: { supportedProtocol: 6 },
        })).rejects.toMatchObject({
            category: 'protocol',
            metadata: { operation: 'supported-protocol-configuration', protocol: 7 },
        });
    });

    it('owns, reserves, freezes, and executes one fully bound physical write', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const store = opened.store;
        const initial = await store.compare_and_set('/owned.csv', 0, { activeSheetIndex: 1 });
        expect(initial.type).toBe('committed');
        await store.stage_authority_transaction('/owned.csv', {
            id: 'installed-original',
            kind: 'physical',
            ordinal: 1,
            expectedStateRevision: 1,
            expectedCommitSequence: 0,
            physicalDigest: 'original-digest',
        });
        const installed = await store.finalize_authority_transaction('/owned.csv', 'installed-original');
        expect(installed.type).toBe('finalized');
        if (installed.type !== 'finalized') throw new Error('expected installed authority');
        const hostLock = {
            hostLockId: 'host-lock',
            physicalResourceLockKey: 'resource-lock',
            verify: vi.fn(async () => true),
            release: vi.fn(async () => undefined),
        };
        const acquired = await store.acquire_edit_session('/owned.csv', (value) => value, hostLock);
        expect(acquired.type).toBe('acquired');
        if (acquired.type !== 'acquired') throw new Error('expected edit owner');
        const pending = await store.compare_and_set(
            '/owned.csv',
            1,
            { activeSheetIndex: 1, pendingEdits: { '0:0': 'recoverable' } },
            undefined,
            {
                expectedAuthorityRevision: installed.authority.authorityRevision,
                editOwner: acquired.session,
            },
        );
        expect(pending.type).toBe('committed');
        if (pending.type !== 'committed') throw new Error('expected pending state');
        await store.stage_authority_transaction('/owned.csv', {
            id: 'save-stage',
            kind: 'physical',
            ordinal: 2,
            expectedStateRevision: pending.snapshot.revision,
            expectedCommitSequence: installed.authority.commitSequence,
            nextState: { activeSheetIndex: 1 },
            physicalDigest: 'intended-digest',
        });
        const copyEntryIfAbsent = store.copy_entry_if_absent;
        if (!copyEntryIfAbsent) throw new Error('expected copy support');
        const copiedBeforeReservation = await copyEntryIfAbsent(
            '/owned.csv',
            '/copy.csv',
            'copy-before-reservation',
            { sourceEditOwner: acquired.session },
        );
        expect(copiedBeforeReservation.type).toBe('copied');
        const reserved = await store.reserve_physical_write('/owned.csv', acquired.session, {
            saveOperationId: 'save-operation',
            stageId: 'save-stage',
            expectedStateRevision: pending.snapshot.revision,
            expectedAuthority: installed.authority,
            preparedInstall: {
                preparedInstallId: 'prepared-install',
                expectedPhysicalDigest: 'original-digest',
                intendedPhysicalDigest: 'intended-digest',
                hostLockId: hostLock.hostLockId,
                previousPhysicalResourceLockKey: hostLock.physicalResourceLockKey,
                physicalResourceLockKey: hostLock.physicalResourceLockKey,
            },
        });
        expect(reserved.type).toBe('reserved');
        if (reserved.type !== 'reserved') throw new Error('expected reservation');
        await expect(store.reserve_physical_write('/owned.csv', acquired.session, {
            saveOperationId: 'save-operation',
            stageId: 'save-stage',
            expectedStateRevision: pending.snapshot.revision,
            expectedAuthority: installed.authority,
            preparedInstall: {
                preparedInstallId: 'prepared-install',
                expectedPhysicalDigest: 'original-digest',
                intendedPhysicalDigest: 'intended-digest',
                hostLockId: hostLock.hostLockId,
                previousPhysicalResourceLockKey: hostLock.physicalResourceLockKey,
                physicalResourceLockKey: hostLock.physicalResourceLockKey,
            },
        })).resolves.toEqual(reserved);
        const reservationReader = new DatabaseSync(database.databasePath, { readOnly: true });
        expect(reservationReader.prepare(`SELECT expected_physical_digest
            FROM file_write_reservations WHERE entry_path = ?`).get('/owned.csv'))
            .toEqual({ expected_physical_digest: 'original-digest' });
        reservationReader.close();
        const validatorError = new Error('validator wins');
        await expect(store.compare_and_set(
            '/owned.csv',
            pending.snapshot.revision,
            { activeSheetIndex: 9 },
            () => { throw validatorError; },
            { expectedAuthorityRevision: installed.authority.authorityRevision, editOwner: acquired.session },
        )).rejects.toBe(validatorError);
        await expect(store.touch('/owned.csv')).rejects.toBeInstanceOf(FileStateReservationBusyError);
        await expect(copyEntryIfAbsent(
            '/owned.csv', '/copy.csv', 'copy-before-reservation',
        )).resolves.toMatchObject({ type: 'copied' });
        await expect(copyEntryIfAbsent(
            '/owned.csv', '/blocked-copy.csv', 'blocked-copy', { sourceEditOwner: acquired.session },
        )).resolves.toEqual({ type: 'sourceBusy' });
        await store.cleanup_authority_transactions('/ignored.csv', Date.now() + 25 * 60 * 60 * 1000);
        await expect(store.inspect_authority_transaction('/owned.csv', 'save-stage')).resolves.toMatchObject({
            stagePresent: true,
        });

        const events: string[] = [];
        let releaseDurability!: () => void;
        let reportDurabilityStarted!: () => void;
        const durabilityStarted = new Promise<void>((resolve) => { reportDurabilityStarted = resolve; });
        const durabilityRelease = new Promise<void>((resolve) => { releaseDurability = resolve; });
        let executionTarget: 'expected' | 'intended' = 'expected';
        const executing = store.execute_reserved_physical_write(
            '/owned.csv',
            acquired.session,
            reserved.reservation,
            {
                binding: reservedIoBinding(
                    'prepared-install', 'host-lock', 'resource-lock',
                    'original-digest', 'intended-digest',
                ),
                verifyHostLock: async () => { events.push('host'); return true; },
                verifyPreparedBundle: async () => { events.push('bundle'); return true; },
                inspectTarget: async () => { events.push('target'); return executionTarget; },
                acquireConditionalInstallFence: async () => { events.push('fence'); return 'acquired'; },
                installPreparedBundle: async () => {
                    events.push('install');
                    executionTarget = 'intended';
                    return { displacedPhysicalDigest: 'original-digest' };
                },
                verifyInstalledDurable: async () => {
                    events.push('durable-start');
                    reportDurabilityStarted();
                    await durabilityRelease;
                    events.push('durable-finish');
                    return true;
                },
                releaseConditionalInstallFence: async () => { events.push('release'); },
            },
        );
        await durabilityStarted;
        const queuedRead = store.read('/owned.csv').then((value) => {
            events.push('read');
            return value;
        });
        releaseDurability();
        const result = await executing;
        await queuedRead;
        expect(result).toMatchObject({ type: 'committed', authority: { physicalDigest: 'intended-digest' } });
        expect(events).toEqual([
            'host', 'bundle', 'target', 'fence', 'host', 'install',
            'durable-start', 'durable-finish', 'target', 'release', 'read',
        ]);
        expect(await store.read('/owned.csv')).toMatchObject({
            state: { activeSheetIndex: 1 },
        });
        await store.release_edit_session('/owned.csv', acquired.session);
        expect(hostLock.release).not.toHaveBeenCalled();
        await opened.close();
    });

    it('reverifies the host lock inside the owner transaction without leaving a partial entry', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const verify = vi.fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        await expect(opened.store.acquire_edit_session('/released.csv', (value) => value, {
            hostLockId: 'released-host-lock',
            physicalResourceLockKey: 'released-resource-lock',
            verify,
            release: async () => undefined,
        })).resolves.toEqual({ type: 'busy' });
        expect(verify).toHaveBeenCalledTimes(2);

        const direct = new DatabaseSync(database.databasePath, { readOnly: true });
        expect(direct.prepare(`SELECT count(*) AS count FROM entries
            WHERE path = '/released.csv'`).get()?.count).toBe(0);
        expect(direct.prepare('SELECT count(*) AS count FROM edit_sessions').get()?.count).toBe(0);
        direct.close();
        await opened.close();
    });

    it('shares edit-session references across stores and reverifies an existing owner in-transaction', async () => {
        const database = freshDatabase();
        const first = await open_sqlite_file_state_store(database.databasePath, database.options);
        const second = await open_sqlite_file_state_store(database.databasePath, database.options);
        const verify = vi.fn(async () => true);
        const hostLock = {
            hostLockId: 'shared-host-lock',
            physicalResourceLockKey: 'shared-resource-lock',
            verify,
            release: async () => undefined,
        };
        const firstAcquired = await first.store.acquire_edit_session(
            '/shared.csv',
            (value) => value,
            hostLock,
        );
        if (firstAcquired.type !== 'acquired') throw new Error('expected first owner');
        const secondAcquired = await second.store.acquire_edit_session(
            '/shared.csv',
            (value) => value,
            hostLock,
        );
        expect(secondAcquired).toEqual(firstAcquired);
        expect(verify).toHaveBeenCalledTimes(4);

        await first.store.release_edit_session('/shared.csv', firstAcquired.session);
        const afterFirstRelease = new DatabaseSync(database.databasePath, { readOnly: true });
        expect(afterFirstRelease.prepare('SELECT count(*) AS count FROM edit_sessions').get()?.count)
            .toBe(1);
        afterFirstRelease.close();

        await second.store.release_edit_session('/shared.csv', firstAcquired.session);
        const afterSecondRelease = new DatabaseSync(database.databasePath, { readOnly: true });
        expect(afterSecondRelease.prepare('SELECT count(*) AS count FROM edit_sessions').get()?.count)
            .toBe(0);
        afterSecondRelease.close();
        await first.close();
        await second.close();
    });

    it('rejects an existing-owner reacquire when its in-transaction host-lock proof fails', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const verify = vi.fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const hostLock = {
            hostLockId: 'reacquire-host-lock',
            physicalResourceLockKey: 'reacquire-resource-lock',
            verify,
            release: async () => undefined,
        };
        const acquired = await opened.store.acquire_edit_session(
            '/reacquire.csv',
            (value) => value,
            hostLock,
        );
        if (acquired.type !== 'acquired') throw new Error('expected initial owner');
        await expect(opened.store.acquire_edit_session(
            '/reacquire.csv',
            (value) => value,
            hostLock,
        )).resolves.toEqual({ type: 'busy' });
        expect(verify).toHaveBeenCalledTimes(4);
        await opened.store.release_edit_session('/reacquire.csv', acquired.session);
        await opened.close();
    });

    it('preserves reserved state across pre- and post-fence throws, then reopens and reconciles', async () => {
        const database = freshDatabase();
        const recoverPath = path.join(tempDirectory, 'recover.csv');
        fs.writeFileSync(recoverPath, 'synthetic recovery target\n');
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const store = opened.store;
        const initial = await store.compare_and_set(recoverPath, 0, {
            activeSheetIndex: 3,
            pendingEdits: { '0:0': 'recover-me' },
        });
        if (initial.type !== 'committed') throw new Error('expected initial state');
        await store.stage_authority_transaction(recoverPath, {
            id: 'recover-original',
            kind: 'physical',
            ordinal: 1,
            expectedStateRevision: initial.snapshot.revision,
            expectedCommitSequence: 0,
            physicalDigest: 'authority-original',
        });
        const installed = await store.finalize_authority_transaction(
            recoverPath,
            'recover-original',
        );
        if (installed.type !== 'finalized') throw new Error('expected installed authority');
        const hostLock = {
            hostLockId: 'recover-host',
            physicalResourceLockKey: 'recover-resource',
            verify: async () => true,
            release: async () => undefined,
        };
        const acquired = await store.acquire_edit_session(recoverPath, (value) => value, hostLock);
        if (acquired.type !== 'acquired') throw new Error('expected recover owner');
        await store.stage_authority_transaction(recoverPath, {
            id: 'recover-save',
            kind: 'physical',
            ordinal: 2,
            expectedStateRevision: initial.snapshot.revision,
            expectedCommitSequence: installed.authority.commitSequence,
            nextState: { activeSheetIndex: 3 },
            physicalDigest: 'authority-intended',
        });
        const request = {
            saveOperationId: 'recover-operation',
            stageId: 'recover-save',
            expectedStateRevision: initial.snapshot.revision,
            expectedAuthority: installed.authority,
            preparedInstall: {
                preparedInstallId: 'recover-bundle',
                expectedPhysicalDigest: 'authority-original',
                intendedPhysicalDigest: 'authority-intended',
                hostLockId: hostLock.hostLockId,
                previousPhysicalResourceLockKey: hostLock.physicalResourceLockKey,
                physicalResourceLockKey: hostLock.physicalResourceLockKey,
            },
        } as const;
        const reserved = await store.reserve_physical_write(recoverPath, acquired.session, request);
        if (reserved.type !== 'reserved') throw new Error('expected recover reservation');

        const beforeFenceFailure = new Error('before fence');
        const preFenceRelease = vi.fn(async () => undefined);
        await expect(store.execute_reserved_physical_write(
            recoverPath,
            acquired.session,
            reserved.reservation,
            {
                binding: reservedIoBinding(
                    'recover-bundle', 'recover-host', 'recover-resource',
                    'authority-original', 'authority-intended',
                ),
                verifyHostLock: async () => true,
                verifyPreparedBundle: async () => { throw beforeFenceFailure; },
                inspectTarget: async () => 'expected',
                acquireConditionalInstallFence: async () => 'acquired',
                installPreparedBundle: async () => ({
                    displacedPhysicalDigest: 'authority-original',
                }),
                verifyInstalledDurable: async () => true,
                releaseConditionalInstallFence: preFenceRelease,
            },
        )).rejects.toBe(beforeFenceFailure);
        expect(preFenceRelease).not.toHaveBeenCalled();
        await expect(store.inspect_authority_transaction(recoverPath, 'recover-save'))
            .resolves.toMatchObject({ stagePresent: true, authority: installed.authority });
        await expect(store.read(recoverPath)).resolves.toEqual(initial.snapshot);

        let target: 'expected' | 'intended' = 'expected';
        const afterFenceFailure = new Error('after fence install');
        const postFenceRelease = vi.fn(async () => undefined);
        await expect(store.execute_reserved_physical_write(
            recoverPath,
            acquired.session,
            reserved.reservation,
            {
                binding: reservedIoBinding(
                    'recover-bundle', 'recover-host', 'recover-resource',
                    'authority-original', 'authority-intended',
                ),
                verifyHostLock: async () => true,
                verifyPreparedBundle: async () => true,
                inspectTarget: async () => target,
                acquireConditionalInstallFence: async () => 'acquired',
                installPreparedBundle: async () => {
                    target = 'intended';
                    throw afterFenceFailure;
                },
                verifyInstalledDurable: async () => true,
                releaseConditionalInstallFence: postFenceRelease,
            },
        )).rejects.toBe(afterFenceFailure);
        expect(postFenceRelease).toHaveBeenCalledTimes(1);

        target = 'expected';
        const operationError = new Error('install failed while fence held');
        const releaseError = new Error('fence release failed');
        await expect(store.execute_reserved_physical_write(
            recoverPath,
            acquired.session,
            reserved.reservation,
            {
                binding: reservedIoBinding(
                    'recover-bundle', 'recover-host', 'recover-resource',
                    'authority-original', 'authority-intended',
                ),
                verifyHostLock: async () => true,
                verifyPreparedBundle: async () => true,
                inspectTarget: async () => target,
                acquireConditionalInstallFence: async () => 'acquired',
                installPreparedBundle: async () => {
                    target = 'intended';
                    throw operationError;
                },
                verifyInstalledDurable: async () => true,
                releaseConditionalInstallFence: async () => { throw releaseError; },
            },
        )).rejects.toMatchObject({
            name: 'AggregateError',
            errors: [operationError, releaseError],
        });
        await expect(store.inspect_authority_transaction(recoverPath, 'recover-save'))
            .resolves.toMatchObject({ stagePresent: true, authority: installed.authority });
        await expect(store.read(recoverPath)).resolves.toEqual(initial.snapshot);
        const failureState = new DatabaseSync(database.databasePath, { readOnly: true });
        expect(failureState.prepare(`SELECT expected_state_revision, expected_physical_digest
            FROM file_write_reservations WHERE entry_path = ?`).get(recoverPath)).toEqual({
            expected_state_revision: initial.snapshot.revision,
            expected_physical_digest: 'authority-original',
        });
        expect(failureState.prepare(`SELECT count(*) AS count FROM authority_stages
            WHERE entry_path = ? AND stage_id = ?`).get(recoverPath, 'recover-save')?.count).toBe(1);
        failureState.close();
        await opened.close();

        const reopened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const reconcileRelease = vi.fn(async () => undefined);
        await expect(reopened.store.reconcile_reserved_physical_write(
            recoverPath,
            reserved.reservation.reservationId,
            {
                binding: reservedIoBinding(
                    'recover-bundle', 'recover-host', 'recover-resource',
                    'authority-original', 'authority-intended',
                ),
                verifyHostLock: async () => true,
                verifyPreparedBundle: async () => true,
                inspectTarget: async () => target,
                acquireConditionalInstallFence: async () => 'acquired',
                installPreparedBundle: async () => {
                    throw new Error('reconciliation must not reinstall');
                },
                verifyInstalledDurable: async () => true,
                releaseConditionalInstallFence: reconcileRelease,
            },
        )).resolves.toMatchObject({
            type: 'finalized',
            authority: {
                commitSequence: installed.authority.commitSequence + 1,
                authorityRevision: installed.authority.authorityRevision + 1,
                physicalRevision: installed.authority.physicalRevision + 1,
                physicalDigest: 'authority-intended',
            },
        });
        expect(reconcileRelease).toHaveBeenCalledTimes(1);
        await expect(reopened.store.read(recoverPath)).resolves.toEqual({
            revision: initial.snapshot.revision + 1,
            state: { activeSheetIndex: 3 },
        });
        await expect(reopened.store.inspect_authority_transaction(recoverPath, 'recover-save'))
            .resolves.toMatchObject({ stagePresent: false });
        const missingCleanup = await reopened.persistence.resume_prepared_install_cleanup(
            reserved.reservation.reservationId,
        );
        expect(missingCleanup).toMatchObject({
            type: 'observed',
            physicalState: 'missing',
            record: { reservationId: reserved.reservation.reservationId },
        });
        await expect(reopened.persistence.complete_prepared_install_cleanup(
            missingCleanup,
        )).resolves.toBe(true);
        await reopened.close();

        await recover_stale_sqlite_coordination(
            database.databasePath,
            database.options,
            { allProcessesClosed: true },
        );
        const finalOpen = await open_sqlite_file_state_store(database.databasePath, database.options);
        await expect(finalOpen.store.read(recoverPath)).resolves.toEqual({
            revision: initial.snapshot.revision + 1,
            state: { activeSheetIndex: 3 },
        });
        await finalOpen.close();
    });

    it('preserves reserved semantics on every returned failure and aborts targetExpected for retry', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const store = opened.store;
        const initial = await store.compare_and_set('/matrix.csv', 0, {
            activeSheetIndex: 4,
            pendingEdits: { '0:0': 'pending' },
        });
        if (initial.type !== 'committed') throw new Error('expected initial state');
        await store.stage_authority_transaction('/matrix.csv', {
            id: 'matrix-original',
            kind: 'physical',
            ordinal: 1,
            expectedStateRevision: initial.snapshot.revision,
            expectedCommitSequence: 0,
            physicalDigest: 'matrix-expected',
        });
        const installed = await store.finalize_authority_transaction('/matrix.csv', 'matrix-original');
        if (installed.type !== 'finalized') throw new Error('expected installed authority');
        const hostLock = {
            hostLockId: 'matrix-host',
            physicalResourceLockKey: 'matrix-resource',
            verify: async () => true,
            release: async () => undefined,
        };
        const acquired = await store.acquire_edit_session('/matrix.csv', (value) => value, hostLock);
        if (acquired.type !== 'acquired') throw new Error('expected matrix owner');
        await store.stage_authority_transaction('/matrix.csv', {
            id: 'matrix-save',
            kind: 'physical',
            ordinal: 2,
            expectedStateRevision: initial.snapshot.revision,
            expectedCommitSequence: installed.authority.commitSequence,
            nextState: { activeSheetIndex: 4 },
            physicalDigest: 'matrix-intended',
        });
        const request = {
            saveOperationId: 'matrix-operation',
            stageId: 'matrix-save',
            expectedStateRevision: initial.snapshot.revision,
            expectedAuthority: installed.authority,
            preparedInstall: {
                preparedInstallId: 'matrix-bundle',
                expectedPhysicalDigest: 'matrix-expected',
                intendedPhysicalDigest: 'matrix-intended',
                hostLockId: hostLock.hostLockId,
                previousPhysicalResourceLockKey: hostLock.physicalResourceLockKey,
                physicalResourceLockKey: hostLock.physicalResourceLockKey,
            },
        } as const;
        await expect(store.reserve_physical_write('/matrix.csv', acquired.session, {
            ...request,
            preparedInstall: {
                ...request.preparedInstall,
                expectedPhysicalDigest: 'not-durable-authority',
            },
        })).resolves.toMatchObject({ type: 'conflict', authority: installed.authority });
        const reserved = await store.reserve_physical_write('/matrix.csv', acquired.session, request);
        if (reserved.type !== 'reserved') throw new Error('expected matrix reservation');

        const inspectDurableState = () => {
            const direct = new DatabaseSync(database.databasePath, { readOnly: true });
            try {
                return {
                    entry: direct.prepare(`SELECT state_revision, state_json, has_pending_edits,
                        authority_commit_sequence, authority_revision, physical_revision,
                        projection_revision, physical_digest FROM entries WHERE path = ?`)
                        .get('/matrix.csv'),
                    reservation: direct.prepare(`SELECT reservation_id, save_operation_id, stage_id,
                        prepared_install_id, expected_state_revision, expected_physical_digest,
                        intended_physical_digest FROM file_write_reservations WHERE entry_path = ?`)
                        .get('/matrix.csv'),
                    stage: direct.prepare(`SELECT stage_id, expected_state_revision,
                        expected_commit_sequence, next_state_json, physical_digest
                        FROM authority_stages WHERE entry_path = ? AND stage_id = ?`)
                        .get('/matrix.csv', 'matrix-save'),
                };
            } finally {
                direct.close();
            }
        };
        const baseline = inspectDurableState();
        const binding = reservedIoBinding(
            'matrix-bundle', 'matrix-host', 'matrix-resource',
            'matrix-expected', 'matrix-intended',
        );
        const makeIo = (options: {
            readonly host?: boolean;
            readonly hosts?: readonly boolean[];
            readonly bundle?: boolean;
            readonly targets?: readonly ('expected' | 'intended' | 'other')[];
            readonly fence?: 'acquired' | 'conflict' | 'unsupported';
            readonly displaced?: string;
            readonly durable?: boolean;
            readonly binding?: ReservedPhysicalWriteIo['binding'];
            readonly release?: () => Promise<void>;
        } = {}) => {
            const targets = [...(options.targets ?? ['expected'])];
            const hosts = [...(options.hosts ?? [])];
            const release = vi.fn(options.release ?? (async () => undefined));
            const io: ReservedPhysicalWriteIo = {
                binding: options.binding ?? binding,
                verifyHostLock: async () => hosts.shift() ?? options.host ?? true,
                verifyPreparedBundle: async () => options.bundle ?? true,
                inspectTarget: async () => targets.shift() ?? targets.at(-1) ?? 'other',
                acquireConditionalInstallFence: async () => options.fence ?? 'acquired',
                installPreparedBundle: async () => ({
                    displacedPhysicalDigest: options.displaced ?? 'matrix-expected',
                }),
                verifyInstalledDurable: async () => options.durable ?? true,
                releaseConditionalInstallFence: release,
            };
            return { io, release };
        };
        const expectPreserved = () => expect(inspectDurableState()).toEqual(baseline);

        const conflictIo = makeIo();
        await expect(store.execute_reserved_physical_write(
            '/matrix.csv',
            acquired.session,
            { ...reserved.reservation, reservationId: 'wrong-reservation' },
            conflictIo.io,
        )).resolves.toMatchObject({ type: 'conflict', authority: installed.authority });
        expect(conflictIo.release).not.toHaveBeenCalled();
        expectPreserved();

        const mismatchedIo = makeIo({
            binding: { ...binding, hostLockId: 'wrong-host-lock' },
        });
        await expect(store.execute_reserved_physical_write(
            '/matrix.csv', acquired.session, reserved.reservation, mismatchedIo.io,
        )).resolves.toMatchObject({ type: 'conflict', authority: installed.authority });
        expect(mismatchedIo.release).not.toHaveBeenCalled();
        expectPreserved();

        const executeFailures = [
            { options: { host: false }, releases: 0 },
            { options: { bundle: false }, releases: 0 },
            { options: { targets: ['other'] as const }, releases: 0 },
            { options: { fence: 'conflict' as const }, releases: 0 },
            { options: { fence: 'unsupported' as const }, releases: 0 },
            { options: { hosts: [true, false] as const }, releases: 1 },
            { options: { targets: ['expected'] as const, displaced: 'wrong' }, releases: 1 },
            { options: { targets: ['expected'] as const, durable: false }, releases: 1 },
            { options: { targets: ['expected', 'other'] as const }, releases: 1 },
        ];
        for (const failure of executeFailures) {
            const attempt = makeIo(failure.options);
            await expect(store.execute_reserved_physical_write(
                '/matrix.csv', acquired.session, reserved.reservation, attempt.io,
            )).resolves.toMatchObject({ type: 'recoveryRequired' });
            expect(attempt.release).toHaveBeenCalledTimes(failure.releases);
            expectPreserved();
        }

        const executeThrowCases = [
            {
                name: 'initial host verification',
                releases: 0,
                create(error: Error) {
                    const attempt = makeIo();
                    attempt.io.verifyHostLock = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'bundle verification',
                releases: 0,
                create(error: Error) {
                    const attempt = makeIo();
                    attempt.io.verifyPreparedBundle = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'initial target inspection',
                releases: 0,
                create(error: Error) {
                    const attempt = makeIo();
                    attempt.io.inspectTarget = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'fence acquisition',
                releases: 0,
                create(error: Error) {
                    const attempt = makeIo();
                    attempt.io.acquireConditionalInstallFence = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'post-fence host verification',
                releases: 1,
                create(error: Error) {
                    const attempt = makeIo();
                    let calls = 0;
                    attempt.io.verifyHostLock = async () => {
                        calls += 1;
                        if (calls === 2) throw error;
                        return true;
                    };
                    return attempt;
                },
            },
            {
                name: 'install',
                releases: 1,
                create(error: Error) {
                    const attempt = makeIo();
                    attempt.io.installPreparedBundle = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'durability verification',
                releases: 1,
                create(error: Error) {
                    const attempt = makeIo({ targets: ['expected', 'intended'] });
                    attempt.io.verifyInstalledDurable = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'post-install target inspection',
                releases: 1,
                create(error: Error) {
                    const attempt = makeIo({ targets: ['expected'] });
                    let calls = 0;
                    attempt.io.inspectTarget = async () => {
                        calls += 1;
                        if (calls === 2) throw error;
                        return 'expected';
                    };
                    return attempt;
                },
            },
        ];
        for (const testCase of executeThrowCases) {
            const error = new Error(`execute ${testCase.name} threw`);
            const attempt = testCase.create(error);
            await expect(store.execute_reserved_physical_write(
                '/matrix.csv', acquired.session, reserved.reservation, attempt.io,
            )).rejects.toBe(error);
            expect(attempt.release).toHaveBeenCalledTimes(testCase.releases);
            expectPreserved();
        }

        let executeReleaseAttempts = 0;
        const executeCleanupPending = makeIo({
            targets: ['expected', 'intended'],
            release: async () => {
                executeReleaseAttempts += 1;
                if (executeReleaseAttempts === 1) throw new Error('execute release failed');
            },
        });
        await expect(store.execute_reserved_physical_write(
            '/matrix.csv', acquired.session, reserved.reservation, executeCleanupPending.io,
        )).resolves.toEqual({
            type: 'recoveryRequired',
            physicalWriteCommitted: true,
            conditionalFenceReleasePending: true,
        });
        expectPreserved();
        await expect(executeCleanupPending.io.releaseConditionalInstallFence()).resolves.toBeUndefined();
        expect(executeCleanupPending.release).toHaveBeenCalledTimes(2);

        const reconcileFailures = [
            { options: { binding: { ...binding, preparedInstallId: 'wrong' } }, releases: 0 },
            { options: { host: false }, releases: 0 },
            { options: { bundle: false }, releases: 0 },
            { options: { targets: ['other'] as const }, releases: 0 },
            { options: { targets: ['expected'] as const, fence: 'conflict' as const }, releases: 0 },
            { options: { targets: ['expected'] as const, fence: 'unsupported' as const }, releases: 0 },
            { options: { targets: ['expected', 'intended'] as const }, releases: 1 },
            { options: { targets: ['expected'] as const, hosts: [true, false] as const }, releases: 1 },
            { options: { targets: ['intended'] as const, fence: 'conflict' as const }, releases: 0 },
            { options: { targets: ['intended'] as const, hosts: [true, false] as const }, releases: 1 },
            { options: { targets: ['intended'] as const, fence: 'unsupported' as const }, releases: 0 },
            { options: { targets: ['intended'] as const, durable: false }, releases: 1 },
            { options: { targets: ['intended', 'other'] as const }, releases: 1 },
        ];
        for (const failure of reconcileFailures) {
            const attempt = makeIo(failure.options);
            await expect(store.reconcile_reserved_physical_write(
                '/matrix.csv', reserved.reservation.reservationId, attempt.io,
            )).resolves.toMatchObject({ type: 'recoveryRequired' });
            expect(attempt.release).toHaveBeenCalledTimes(failure.releases);
            expectPreserved();
        }

        const reconcileThrowCases = [
            {
                name: 'initial host verification',
                releases: 0,
                create(error: Error) {
                    const attempt = makeIo();
                    attempt.io.verifyHostLock = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'bundle verification',
                releases: 0,
                create(error: Error) {
                    const attempt = makeIo();
                    attempt.io.verifyPreparedBundle = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'initial target inspection',
                releases: 0,
                create(error: Error) {
                    const attempt = makeIo();
                    attempt.io.inspectTarget = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'expected fence acquisition',
                releases: 0,
                create(error: Error) {
                    const attempt = makeIo({ targets: ['expected'] });
                    attempt.io.acquireConditionalInstallFence = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'expected post-fence host verification',
                releases: 1,
                create(error: Error) {
                    const attempt = makeIo({ targets: ['expected'] });
                    let calls = 0;
                    attempt.io.verifyHostLock = async () => {
                        calls += 1;
                        if (calls === 2) throw error;
                        return true;
                    };
                    return attempt;
                },
            },
            {
                name: 'expected post-fence target inspection',
                releases: 1,
                create(error: Error) {
                    const attempt = makeIo({ targets: ['expected'] });
                    let calls = 0;
                    attempt.io.inspectTarget = async () => {
                        calls += 1;
                        if (calls === 2) throw error;
                        return 'expected';
                    };
                    return attempt;
                },
            },
            {
                name: 'intended fence acquisition',
                releases: 0,
                create(error: Error) {
                    const attempt = makeIo({ targets: ['intended'] });
                    attempt.io.acquireConditionalInstallFence = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'intended post-fence host verification',
                releases: 1,
                create(error: Error) {
                    const attempt = makeIo({ targets: ['intended'] });
                    let calls = 0;
                    attempt.io.verifyHostLock = async () => {
                        calls += 1;
                        if (calls === 2) throw error;
                        return true;
                    };
                    return attempt;
                },
            },
            {
                name: 'intended durability verification',
                releases: 1,
                create(error: Error) {
                    const attempt = makeIo({ targets: ['intended'] });
                    attempt.io.verifyInstalledDurable = async () => { throw error; };
                    return attempt;
                },
            },
            {
                name: 'intended post-fence target inspection',
                releases: 1,
                create(error: Error) {
                    const attempt = makeIo({ targets: ['intended'] });
                    let calls = 0;
                    attempt.io.inspectTarget = async () => {
                        calls += 1;
                        if (calls === 2) throw error;
                        return 'intended';
                    };
                    return attempt;
                },
            },
        ];
        for (const testCase of reconcileThrowCases) {
            const error = new Error(`reconcile ${testCase.name} threw`);
            const attempt = testCase.create(error);
            await expect(store.reconcile_reserved_physical_write(
                '/matrix.csv', reserved.reservation.reservationId, attempt.io,
            )).rejects.toBe(error);
            expect(attempt.release).toHaveBeenCalledTimes(testCase.releases);
            expectPreserved();
        }

        let finalizeReleaseAttempts = 0;
        const finalizeCleanupPending = makeIo({
            targets: ['intended', 'intended'],
            release: async () => {
                finalizeReleaseAttempts += 1;
                if (finalizeReleaseAttempts === 1) throw new Error('finalize release failed');
            },
        });
        await expect(store.reconcile_reserved_physical_write(
            '/matrix.csv', reserved.reservation.reservationId, finalizeCleanupPending.io,
        )).resolves.toEqual({
            type: 'recoveryRequired',
            physicalWriteCommitted: true,
            conditionalFenceReleasePending: true,
        });
        expectPreserved();
        await expect(finalizeCleanupPending.io.releaseConditionalInstallFence()).resolves.toBeUndefined();
        expect(finalizeCleanupPending.release).toHaveBeenCalledTimes(2);

        let abortReleaseAttempts = 0;
        const abortCleanupPending = makeIo({
            targets: ['expected', 'expected'],
            release: async () => {
                abortReleaseAttempts += 1;
                if (abortReleaseAttempts === 1) throw new Error('abort release failed');
            },
        });
        await expect(store.reconcile_reserved_physical_write(
            '/matrix.csv', reserved.reservation.reservationId, abortCleanupPending.io,
        )).resolves.toEqual({
            type: 'recoveryRequired',
            conditionalFenceReleasePending: true,
        });
        expectPreserved();
        await expect(abortCleanupPending.io.releaseConditionalInstallFence()).resolves.toBeUndefined();
        expect(abortCleanupPending.release).toHaveBeenCalledTimes(2);

        const targetExpected = makeIo({ targets: ['expected', 'expected'] });
        await expect(store.reconcile_reserved_physical_write(
            '/matrix.csv', reserved.reservation.reservationId, targetExpected.io,
        )).resolves.toEqual({ type: 'notInstalled' });
        expect(targetExpected.release).toHaveBeenCalledTimes(1);
        const aborted = inspectDurableState();
        expect(aborted).toEqual({
            ...baseline,
            entry: {
                ...baseline.entry,
                state_json: JSON.stringify({
                    activeSheetIndex: 4,
                    pendingEdits: { '0:0': 'pending' },
                }),
            },
            reservation: undefined,
        });
        await expect(store.read('/matrix.csv')).resolves.toEqual(initial.snapshot);
        await expect(store.inspect_authority_transaction('/matrix.csv', 'matrix-save'))
            .resolves.toMatchObject({ stagePresent: true, authority: installed.authority });

        const retried = await store.reserve_physical_write('/matrix.csv', acquired.session, request);
        expect(retried.type).toBe('reserved');
        if (retried.type !== 'reserved') throw new Error('expected retry reservation');
        expect(retried.reservation.reservationId).not.toBe(reserved.reservation.reservationId);
        await opened.close();
    });

    it('releases a canonicalized owner by durable session identity rather than its stale path', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        await opened.store.compare_and_set('/alias.csv', 0, { pendingEdits: { '0:0': 'pending' } });
        const acquired = await opened.store.acquire_edit_session('/alias.csv', (value) => value, {
            hostLockId: 'canonical-host',
            physicalResourceLockKey: 'canonical-resource',
            verify: async () => true,
            release: async () => undefined,
        });
        if (acquired.type !== 'acquired') throw new Error('expected canonical owner');
        await opened.store.canonicalize_path?.('/canonical.csv', () => '/canonical.csv');

        const moved = new DatabaseSync(database.databasePath, { readOnly: true });
        expect(moved.prepare('SELECT entry_path FROM edit_sessions').get()?.entry_path)
            .toBe('/canonical.csv');
        moved.close();

        await opened.store.release_edit_session('/alias.csv', acquired.session);
        const released = new DatabaseSync(database.databasePath, { readOnly: true });
        expect(released.prepare('SELECT count(*) AS count FROM edit_sessions').get()?.count).toBe(0);
        released.close();
        await opened.close();
    });

    it('updates the exact owner lock set from a real bundle and fences intended reconciliation', async () => {
        const database = freshDatabase();
        const target = path.join(tempDirectory, 'owned-real.csv');
        const expectedBytes = Buffer.from('old\n');
        const intendedBytes = Buffer.from('new\n');
        fs.writeFileSync(target, expectedBytes);
        const manager = new PhysicalResourceLockManager({
            lockRoot: path.join(tempDirectory, 'physical-locks'),
        });
        const hostLock = await manager.acquire(target);
        if (!hostLock) throw new Error('expected host lock');
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const initial = await opened.store.compare_and_set(target, 0, { activeSheetIndex: 1 });
        if (initial.type !== 'committed') throw new Error('expected initial state');
        await opened.store.stage_authority_transaction(target, {
            id: 'original',
            kind: 'physical',
            ordinal: 1,
            expectedStateRevision: initial.snapshot.revision,
            expectedCommitSequence: 0,
            physicalDigest: sha256(expectedBytes),
        });
        const installed = await opened.store.finalize_authority_transaction(target, 'original');
        if (installed.type !== 'finalized') throw new Error('expected original authority');
        const acquired = await opened.store.acquire_edit_session(target, (value) => value, hostLock);
        if (acquired.type !== 'acquired') throw new Error('expected edit owner');
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: expectedBytes,
            intended: intendedBytes,
            hostLock,
        });
        expect(bundle.previousPhysicalResourceLockKey).not.toBe(bundle.physicalResourceLockKey);
        await opened.store.stage_authority_transaction(target, {
            id: 'save-real',
            kind: 'physical',
            ordinal: 2,
            expectedStateRevision: initial.snapshot.revision,
            expectedCommitSequence: installed.authority.commitSequence,
            physicalDigest: bundle.intendedPhysicalDigest,
        });
        const reserved = await opened.store.reserve_physical_write(target, acquired.session, {
            saveOperationId: 'save-real-operation',
            stageId: 'save-real',
            expectedStateRevision: initial.snapshot.revision,
            expectedAuthority: installed.authority,
            preparedInstall: bundle,
        });
        expect(reserved.type).toBe('reserved');
        if (reserved.type !== 'reserved') throw new Error('expected real reservation');

        const direct = new DatabaseSync(database.databasePath, { readOnly: true });
        expect(direct.prepare(`SELECT physical_resource_lock_key FROM edit_sessions
            WHERE entry_path = ?`).get(target)?.physical_resource_lock_key)
            .toBe(bundle.physicalResourceLockKey);
        expect(direct.prepare(`SELECT physical_resource_lock_key FROM file_write_reservations
            WHERE entry_path = ?`).get(target)?.physical_resource_lock_key)
            .toBe(bundle.physicalResourceLockKey);
        direct.close();

        fs.writeFileSync(target, intendedBytes);
        const acquiredDigests: string[] = [];
        const installer: PlatformConditionalInstaller = {
            platformEnforced: true,
            async acquire(_targetPath, expectedPhysicalDigest) {
                acquiredDigests.push(expectedPhysicalDigest);
                return {
                    type: 'acquired',
                    fence: {
                        async install() { throw new Error('reconciliation must not reinstall'); },
                        async verifyInstalledDurable() { return true; },
                        async release() {},
                    },
                };
            },
        };
        const finalized = await opened.store.reconcile_reserved_physical_write(
            target,
            reserved.reservation.reservationId,
            bundle.createReservedIo(installer),
        );
        expect(finalized).toMatchObject({
            type: 'finalized',
            authority: { physicalDigest: bundle.intendedPhysicalDigest },
        });
        if (finalized.type !== 'finalized') throw new Error('expected finalized real reservation');
        expect(acquiredDigests).toEqual([bundle.intendedPhysicalDigest]);

        await expect(opened.persistence.discover_prepared_install_cleanups()).resolves.toEqual([{
            targetPath: target,
            reservationId: reserved.reservation.reservationId,
            saveOperationId: 'save-real-operation',
            stageId: 'save-real',
            preparedInstallId: bundle.preparedInstallId,
            hostLockId: bundle.hostLockId,
            previousPhysicalResourceLockKey: bundle.previousPhysicalResourceLockKey,
            physicalResourceLockKey: bundle.physicalResourceLockKey,
            expectedPhysicalDigest: bundle.expectedPhysicalDigest,
            intendedPhysicalDigest: bundle.intendedPhysicalDigest,
            finalizedAtMs: expect.any(Number),
        }]);
        const notStartedCleanup = await opened.persistence.resume_prepared_install_cleanup(
            reserved.reservation.reservationId,
        );
        expect(notStartedCleanup).toMatchObject({
            type: 'observed',
            physicalState: 'notStarted',
            record: { reservationId: reserved.reservation.reservationId },
        });
        await expect(opened.persistence.complete_prepared_install_cleanup(
            notStartedCleanup,
        )).resolves.toBe(false);
        await expect(opened.persistence.discover_prepared_install_cleanups())
            .resolves.toHaveLength(1);

        const ordinary = await opened.store.compare_and_set(
            target,
            initial.snapshot.revision,
            { activeSheetIndex: 9 },
            undefined,
            {
                expectedAuthorityRevision: finalized.authority.authorityRevision,
                editOwner: acquired.session,
            },
        );
        expect(ordinary.type).toBe('committed');
        expect(await opened.persistence.discover_prepared_install_cleanups()).toHaveLength(1);

        await bundle.cleanup();
        const pendingCleanup = await opened.persistence.resume_prepared_install_cleanup(
            reserved.reservation.reservationId,
        );
        expect(pendingCleanup).toMatchObject({
            type: 'observed',
            physicalState: 'pending',
            record: { reservationId: reserved.reservation.reservationId },
        });
        await expect(opened.persistence.complete_prepared_install_cleanup(
            pendingCleanup,
        )).resolves.toBe(false);
        await expect(opened.persistence.discover_prepared_install_cleanups())
            .resolves.toHaveLength(1);

        await fs.promises.rm(path.join(
            path.dirname(target),
            `.table-viewer-prepared-cleanup-${bundle.preparedInstallId}`,
        ), { recursive: true });
        const missingCleanup = await opened.persistence.resume_prepared_install_cleanup(
            reserved.reservation.reservationId,
        );
        expect(missingCleanup).toMatchObject({
            type: 'observed',
            physicalState: 'missing',
            record: { reservationId: reserved.reservation.reservationId },
        });
        if (missingCleanup.type !== 'observed') throw new Error('expected missing cleanup evidence');
        await expect(opened.persistence.complete_prepared_install_cleanup({
            ...missingCleanup,
            record: { ...missingCleanup.record, hostLockId: 'wrong-host-lock' },
        })).rejects.toMatchObject({
            category: 'recovery',
            metadata: { operation: 'prepared-install-cleanup-binding' },
        });
        await expect(opened.persistence.discover_prepared_install_cleanups())
            .resolves.toEqual([missingCleanup.record]);
        await opened.store.release_edit_session(target, acquired.session);
        await hostLock.release();
        await opened.close();

        let failCleanupCommit = true;
        const retrying = await open_sqlite_file_state_store(database.databasePath, {
            ...database.options,
            hooks: {
                commit(commit, rollback) {
                    if (!failCleanupCommit) {
                        commit();
                        return;
                    }
                    failCleanupCommit = false;
                    rollback();
                    throw new Error('injected cleanup completion failure');
                },
            },
        });
        await expect(retrying.persistence.complete_prepared_install_cleanup(
            missingCleanup,
        )).rejects.toBeInstanceOf(SqliteFileStateError);
        await expect(retrying.persistence.discover_prepared_install_cleanups())
            .resolves.toEqual([missingCleanup.type === 'observed' ? missingCleanup.record : undefined]);
        await expect(retrying.persistence.complete_prepared_install_cleanup(
            missingCleanup,
        )).resolves.toBe(true);
        await expect(retrying.persistence.discover_prepared_install_cleanups()).resolves.toEqual([]);
        await expect(retrying.persistence.complete_prepared_install_cleanup(
            missingCleanup,
        )).resolves.toBe(false);
        await expect(retrying.persistence.resume_prepared_install_cleanup(
            reserved.reservation.reservationId,
        )).resolves.toEqual({ type: 'notFound' });
        await retrying.close();
    });

    it('reopens and reconciles a real reservation using only durable restart evidence', async () => {
        const database = freshDatabase();
        const target = path.join(tempDirectory, 'restart-recovery.csv');
        const lockRoot = path.join(tempDirectory, 'restart-physical-locks');
        const expectedBytes = Buffer.from('before restart\n');
        const intendedBytes = Buffer.from('after restart\n');
        fs.writeFileSync(target, expectedBytes);

        const reservationId = await (async () => {
            const manager = new PhysicalResourceLockManager({ lockRoot });
            const hostLock = await manager.acquire(target);
            if (!hostLock) throw new Error('expected restart host lock');
            const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
            const initial = await opened.store.compare_and_set(target, 0, {
                activeSheetIndex: 2,
                pendingEdits: { '0:0': 'restart' },
            });
            if (initial.type !== 'committed') throw new Error('expected restart state');
            await opened.store.stage_authority_transaction(target, {
                id: 'restart-original',
                kind: 'physical',
                ordinal: 1,
                expectedStateRevision: initial.snapshot.revision,
                expectedCommitSequence: 0,
                physicalDigest: sha256(expectedBytes),
            });
            const installed = await opened.store.finalize_authority_transaction(
                target,
                'restart-original',
            );
            if (installed.type !== 'finalized') throw new Error('expected restart authority');
            const acquired = await opened.store.acquire_edit_session(target, (value) => value, hostLock);
            if (acquired.type !== 'acquired') throw new Error('expected restart owner');
            const bundle = await prepare_physical_install({
                targetPath: target,
                expectedOriginal: expectedBytes,
                intended: intendedBytes,
                hostLock,
            });
            await opened.store.stage_authority_transaction(target, {
                id: 'restart-save',
                kind: 'physical',
                ordinal: 2,
                expectedStateRevision: initial.snapshot.revision,
                expectedCommitSequence: installed.authority.commitSequence,
                nextState: { activeSheetIndex: 2 },
                physicalDigest: bundle.intendedPhysicalDigest,
            });
            const reserved = await opened.store.reserve_physical_write(target, acquired.session, {
                saveOperationId: 'restart-save-operation',
                stageId: 'restart-save',
                expectedStateRevision: initial.snapshot.revision,
                expectedAuthority: installed.authority,
                preparedInstall: bundle,
            });
            if (reserved.type !== 'reserved') throw new Error('expected restart reservation');

            // Simulate a process dying after the platform install and before SQLite finalization.
            fs.writeFileSync(target, intendedBytes);
            await opened.close();
            return reserved.reservation.reservationId;
        })();

        const reopened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const acquiredDigests: string[] = [];
        const installer: PlatformConditionalInstaller = {
            platformEnforced: true,
            async acquire(targetPath, expectedPhysicalDigest) {
                acquiredDigests.push(expectedPhysicalDigest);
                return {
                    type: 'acquired',
                    fence: {
                        async install() { throw new Error('restart reconciliation must not reinstall'); },
                        async verifyInstalledDurable(bundle) {
                            return sha256(fs.readFileSync(targetPath)) === bundle.intendedPhysicalDigest;
                        },
                        async release() {},
                    },
                };
            },
        };
        const recovered = await reopen_reserved_physical_write(reopened.persistence, {
            targetPath: target,
            lockManager: new PhysicalResourceLockManager({ lockRoot }),
            installer,
        });
        expect(recovered.type).toBe('reopened');
        if (recovered.type !== 'reopened') throw new Error('expected durable restart reconstruction');
        expect(recovered.reservation.reservationId).toBe(reservationId);
        await expect(reopened.store.reconcile_reserved_physical_write(
            target,
            recovered.reservation.reservationId,
            recovered.io,
        )).resolves.toMatchObject({
            type: 'finalized',
            authority: { physicalDigest: sha256(intendedBytes) },
        });
        expect(acquiredDigests).toEqual([sha256(intendedBytes)]);
        await recovered.cleanupPreparedInstall();
        const restartCleanup = await reopened.persistence.resume_prepared_install_cleanup(
            recovered.reservation.reservationId,
        );
        expect(restartCleanup).toMatchObject({
            type: 'observed',
            physicalState: 'pending',
            record: { reservationId: recovered.reservation.reservationId },
        });
        await expect(reopened.persistence.complete_prepared_install_cleanup(
            restartCleanup,
        )).resolves.toBe(false);
        await expect(reopened.persistence.discover_prepared_install_cleanups())
            .resolves.toEqual([restartCleanup.type === 'observed' ? restartCleanup.record : undefined]);
        await recovered.releaseHostLock();
        await expect(reopened.store.read(target)).resolves.toMatchObject({
            state: { activeSheetIndex: 2 },
        });
        await reopened.close();
    });

    it('fails closed when durable restart lock evidence is absent', async () => {
        const database = freshDatabase();
        const target = path.join(tempDirectory, 'missing-restart-lock.csv');
        const expectedBytes = Buffer.from('old\n');
        const intendedBytes = Buffer.from('new\n');
        fs.writeFileSync(target, expectedBytes);
        const lockRoot = path.join(tempDirectory, 'missing-restart-locks');
        const manager = new PhysicalResourceLockManager({ lockRoot });
        const hostLock = await manager.acquire(target);
        if (!hostLock) throw new Error('expected fail-closed host lock');
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const initial = await opened.store.compare_and_set(target, 0, {});
        if (initial.type !== 'committed') throw new Error('expected fail-closed state');
        await opened.store.stage_authority_transaction(target, {
            id: 'missing-original', kind: 'physical', ordinal: 1,
            expectedStateRevision: initial.snapshot.revision,
            expectedCommitSequence: 0,
            physicalDigest: sha256(expectedBytes),
        });
        const installed = await opened.store.finalize_authority_transaction(target, 'missing-original');
        if (installed.type !== 'finalized') throw new Error('expected fail-closed authority');
        const acquired = await opened.store.acquire_edit_session(target, (value) => value, hostLock);
        if (acquired.type !== 'acquired') throw new Error('expected fail-closed owner');
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: expectedBytes,
            intended: intendedBytes,
            hostLock,
        });
        await opened.store.stage_authority_transaction(target, {
            id: 'missing-save', kind: 'physical', ordinal: 2,
            expectedStateRevision: initial.snapshot.revision,
            expectedCommitSequence: installed.authority.commitSequence,
            physicalDigest: bundle.intendedPhysicalDigest,
        });
        const reserved = await opened.store.reserve_physical_write(target, acquired.session, {
            saveOperationId: 'missing-save-operation',
            stageId: 'missing-save',
            expectedStateRevision: initial.snapshot.revision,
            expectedAuthority: installed.authority,
            preparedInstall: bundle,
        });
        if (reserved.type !== 'reserved') throw new Error('expected fail-closed reservation');
        await hostLock.release();

        await expect(reopen_reserved_physical_write(opened.persistence, {
            targetPath: target,
            lockManager: new PhysicalResourceLockManager({ lockRoot }),
            installer: { platformEnforced: true, async acquire() { return { type: 'unsupported' }; } },
        })).resolves.toEqual({ type: 'recoveryRequired', reason: 'lockEvidenceMissing' });
        await opened.close();
    });

    it('reclaims only unreserved stale coordination after explicit all-processes-closed confirmation', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        await opened.store.compare_and_set('/pending-owner.csv', 0, {
            pendingEdits: { '0:0': 'recoverable' },
        });
        const acquired = await opened.store.acquire_edit_session(
            '/pending-owner.csv',
            (value) => value,
            {
                hostLockId: 'stale-host-lock',
                physicalResourceLockKey: 'stale-resource-lock',
                verify: async () => true,
                release: async () => undefined,
            },
        );
        expect(acquired.type).toBe('acquired');
        await opened.close();

        const nextGeneration = await recover_stale_sqlite_coordination(
            database.databasePath,
            database.options,
            { allProcessesClosed: true },
        );
        expect(nextGeneration).toBe(2);
        const direct = new DatabaseSync(database.databasePath, { readOnly: true });
        expect(direct.prepare('SELECT count(*) AS count FROM edit_sessions').get()?.count).toBe(0);
        expect(direct.prepare('SELECT count(*) AS count FROM writer_sessions').get()?.count).toBe(0);
        expect(direct.prepare(`SELECT has_pending_edits FROM entries
            WHERE path = ?`).get('/pending-owner.csv')?.has_pending_edits).toBe(1);
        direct.close();
    });

    it('fails stale recovery closed without advancing generation when a reservation remains', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(database.databasePath, database.options);
        const initial = await opened.store.compare_and_set('/reserved.csv', 0, {});
        if (initial.type !== 'committed') throw new Error('expected initial state');
        await opened.store.stage_authority_transaction('/reserved.csv', {
            id: 'reserved-original',
            kind: 'physical',
            ordinal: 1,
            expectedStateRevision: initial.snapshot.revision,
            expectedCommitSequence: 0,
            physicalDigest: 'reserved-expected',
        });
        const installed = await opened.store.finalize_authority_transaction(
            '/reserved.csv',
            'reserved-original',
        );
        if (installed.type !== 'finalized') throw new Error('expected installed authority');
        await opened.store.stage_authority_transaction('/reserved.csv', {
            id: 'reserved-stage',
            kind: 'physical',
            ordinal: 2,
            expectedStateRevision: initial.snapshot.revision,
            expectedCommitSequence: installed.authority.commitSequence,
            physicalDigest: 'reserved-intended',
        });
        const acquired = await opened.store.acquire_edit_session('/reserved.csv', (value) => value, {
            hostLockId: 'reserved-host',
            physicalResourceLockKey: 'reserved-lock-old',
            verify: async () => true,
            release: async () => undefined,
        });
        if (acquired.type !== 'acquired') throw new Error('expected reserved owner');
        const reserved = await opened.store.reserve_physical_write('/reserved.csv', acquired.session, {
            saveOperationId: 'reserved-operation',
            stageId: 'reserved-stage',
            expectedStateRevision: initial.snapshot.revision,
            expectedAuthority: installed.authority,
            preparedInstall: {
                preparedInstallId: 'reserved-bundle',
                expectedPhysicalDigest: 'reserved-expected',
                intendedPhysicalDigest: 'reserved-intended',
                hostLockId: 'reserved-host',
                previousPhysicalResourceLockKey: 'reserved-lock-old',
                physicalResourceLockKey: 'reserved-lock-new',
            },
        });
        expect(reserved.type).toBe('reserved');
        await opened.close();

        await expect(recover_stale_sqlite_coordination(
            database.databasePath,
            database.options,
            { allProcessesClosed: true },
        )).rejects.toMatchObject({
            category: 'recovery',
            metadata: { operation: 'coordination-reclaim-reservations', rowCount: 1 },
        });
        const direct = new DatabaseSync(database.databasePath, { readOnly: true });
        expect(direct.prepare(`SELECT coordination_generation FROM state_meta
            WHERE singleton = 1`).get()?.coordination_generation).toBe(1);
        expect(direct.prepare('SELECT count(*) AS count FROM file_write_reservations').get()?.count)
            .toBe(1);
        direct.close();
    });

    it('transfers one continuous shared gate token from initialization into the interned runtime', async () => {
        const database = freshDatabase();
        let initializationToken: string | undefined;
        let runtimeToken: string | undefined;
        const persistence = await open_sqlite_file_state_persistence(database.databasePath, {
            ...database.options,
            initialization: {
                onEvent(event) {
                    if (event === 'winner-validated') {
                        [initializationToken] = inspect_sqlite_recovery_gate(database.databasePath).readerTokenIds;
                    }
                },
            },
            hooks: {
                onEvent(event) {
                    if (event === 'before-session-register') {
                        [runtimeToken] = inspect_sqlite_recovery_gate(database.databasePath).readerTokenIds;
                    }
                },
            },
        });
        expect(initializationToken).toBeDefined();
        expect(runtimeToken).toBe(initializationToken);
        expect(inspect_sqlite_recovery_gate(database.databasePath).readerTokenIds).toEqual([
            initializationToken,
        ]);
        await persistence.close();
        expect(inspect_sqlite_recovery_gate(database.databasePath).readerTokenIds).toEqual([]);
    });

    it('closes the adopted database and releases its token when runtime option validation fails', async () => {
        const database = freshDatabase();
        await expect(open_sqlite_file_state_persistence(database.databasePath, {
            ...database.options,
            clientKind: '',
        })).rejects.toThrow(TypeError);
        expect(inspect_sqlite_recovery_gate(database.databasePath).readerTokenIds).toEqual([]);
        const direct = new DatabaseSync(database.databasePath);
        direct.close();
    });

    it('sanitizes public directory-creation failures without exposing native details', async () => {
        const database = freshDatabase();
        const nativeMessage = `permission denied: ${database.databasePath}`;
        vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce(Object.assign(new Error(nativeMessage), {
            code: 'EROFS',
        }));
        try {
            await open_sqlite_file_state_persistence(database.databasePath, database.options);
            throw new Error('expected sanitized failure');
        } catch (error) {
            expect(error).toBeInstanceOf(SqliteFileStateError);
            expect((error as SqliteFileStateError).category).toBe('readonly');
            expect((error as Error).message).not.toContain(database.databasePath);
            expect((error as Error).message).not.toContain(nativeMessage);
            expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
        }
    });

    it('keeps metadata-only operations free of entry payload I/O', async () => {
        const database = freshDatabase();
        const underlying = await database.openPersistence();
        const instrumented = instrumentPayloadIo(underlying);
        const store = create_keyed_authority_store(instrumented.persistence);
        await store.compare_and_set('/entry', 0, { activeSheetIndex: 1 });

        instrumented.reset();
        await store.read_authority('/entry');
        expect(instrumented.counts).toEqual({ reads: 0, writes: 0 });

        await store.touch!('/entry');
        expect(instrumented.counts).toEqual({ reads: 0, writes: 0 });

        await store.stage_authority_transaction('/entry', {
            id: 'stage',
            kind: 'projection',
            ordinal: 1,
            expectedStateRevision: 1,
            expectedCommitSequence: 0,
        });
        expect(instrumented.counts).toEqual({ reads: 0, writes: 0 });

        await store.discard_authority_transaction('/entry', 'stage');
        expect(instrumented.counts).toEqual({ reads: 0, writes: 0 });
    });

    it('bounds ordinary payload reads and copy reads to requested entries', async () => {
        const database = freshDatabase();
        const underlying = await database.openPersistence();
        const instrumented = instrumentPayloadIo(underlying);
        const store = create_keyed_authority_store(instrumented.persistence);
        for (let index = 0; index < 25; index += 1) {
            await store.compare_and_set(`/entry-${index}`, 0, { activeSheetIndex: index });
        }

        instrumented.reset();
        await store.read('/entry-12');
        expect(instrumented.counts).toEqual({ reads: 1, writes: 0 });

        instrumented.reset();
        await store.compare_and_set('/entry-12', 13, { activeSheetIndex: 99 });
        expect(instrumented.counts).toEqual({ reads: 1, writes: 1 });

        instrumented.reset();
        await store.copy_entry_if_absent!('/entry-12', '/copy', 'bounded-copy');
        expect(instrumented.counts.reads).toBeLessThanOrEqual(3);
        expect(instrumented.counts.writes).toBe(1);
    });

    it('renormalizes recency transactionally before SQLite integer exhaustion', async () => {
        const database = freshDatabase();
        const store = deferredStore(database);
        await store.compare_and_set('/old', 0, { activeSheetIndex: 1 });
        await store.compare_and_set('/new', 0, { activeSheetIndex: 2 });
        const direct = new DatabaseSync(database.databasePath);
        direct.prepare(`UPDATE state_meta SET next_recency_order = ?
            WHERE singleton = 1`).run(BigInt(Number.MAX_SAFE_INTEGER));
        direct.close();

        await store.touch!('/old');

        const inspected = database.inspect();
        expect(Object.keys(inspected.entries)).toEqual(['/new', '/old']);
        expect((await store.read('/old')).revision).toBe(1);
        await database.close();
        const reopened = deferredStore(database);
        expect((await reopened.read('/old')).revision).toBe(1);
        expect(Object.keys(database.inspect().entries)).toEqual(['/new', '/old']);
    });

    it('drains semantic operations admitted before close', async () => {
        const database = freshDatabase();
        const opened = await open_sqlite_file_state_store(
            database.databasePath,
            database.options,
        );
        const first = opened.store.compare_and_set('/first', 0, { activeSheetIndex: 1 });
        const second = opened.store.compare_and_set('/second', 0, { activeSheetIndex: 2 });
        const closing = opened.close();

        await expect(first).resolves.toMatchObject({ type: 'committed' });
        await expect(second).resolves.toMatchObject({ type: 'committed' });
        await expect(closing).resolves.toBeUndefined();
        expect(database.inspect().entries).toMatchObject({
            '/first': { revision: 1 },
            '/second': { revision: 2 },
        });
    });

    it('uses metadata, stage-age, and lease indexes without selecting state JSON', async () => {
        const database = freshDatabase();
        await database.initialize();
        const direct = new DatabaseSync(database.databasePath, { readOnly: true });
        const plans = [
            direct.prepare(`EXPLAIN QUERY PLAN SELECT path FROM entries
                ORDER BY recency_order, path`).all(),
            direct.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT entry_path
                FROM authority_stages INDEXED BY authority_stages_by_age
                WHERE created_at_ms < ?`).all(1000),
            direct.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM entry_leases
                WHERE current_entry_path = ? LIMIT 1`).all('/entry'),
        ].flat().map((row) => String(row.detail)).join('\n');
        direct.close();

        expect(plans).toContain('entries_by_recency');
        expect(plans).toContain('authority_stages_by_age');
        expect(plans).toContain('entry_leases_by_path');
        expect(plans).not.toContain('state_json');
    });
});
