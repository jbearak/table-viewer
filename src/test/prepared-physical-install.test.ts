import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    inspect_prepared_physical_install,
    prepare_physical_install,
    reconcile_prepared_physical_install,
    reopen_prepared_physical_install,
    type PreparedInstallDurableOperations,
} from '../prepared-physical-install';
import { identify_physical_resource, PhysicalResourceLockManager } from '../physical-resource-lock';

describe('prepared physical installs', () => {
    let directory: string;
    let target: string;
    let manager: PhysicalResourceLockManager;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-prepared-install-'));
        target = path.join(directory, 'data.csv');
        fs.writeFileSync(target, 'old\n');
        manager = new PhysicalResourceLockManager({ lockRoot: path.join(directory, 'locks') });
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('flushes original, intended, manifest, and bundle in order without touching target', async () => {
        const lock = await manager.acquire(target);
        expect(lock).not.toBeNull();
        const events: string[] = [];
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
            onEvent: (event) => events.push(event),
        });
        expect(events).toEqual([
            'bundle-directory-durable',
            'backup-durable',
            'intended-durable',
            'lock-set-extended',
            'manifest-durable',
            'bundle-complete',
        ]);
        expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
        expect(await bundle.verify()).toBe(true);
        expect(await bundle.inspectTarget()).toBe('expected');
        await bundle.cleanup();
        await lock?.release();
    });

    it('extends the lock set for intended object identity and supports reconciliation', async () => {
        const lock = await manager.acquire(target);
        expect(lock).not.toBeNull();
        const originalLockKey = lock!.physicalResourceLockKey;
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        expect(bundle.physicalResourceLockKey).not.toBe(originalLockKey);
        expect(fs.readdirSync(path.join(directory, 'locks')).filter((name) => name.endsWith('.lock')))
            .toHaveLength(3);
        expect(inspect_prepared_physical_install(bundle.directory)).toMatchObject({
            type: 'valid',
            preparedInstallId: bundle.preparedInstallId,
        });
        expect(reconcile_prepared_physical_install(target, bundle.directory).type)
            .toBe('targetExpected');
        fs.writeFileSync(target, 'new\n');
        expect(reconcile_prepared_physical_install(target, bundle.directory).type)
            .toBe('targetIntended');
        fs.writeFileSync(target, 'third-party\n');
        expect(reconcile_prepared_physical_install(target, bundle.directory))
            .toEqual({ type: 'recoveryRequired', reason: 'targetOther' });
        await bundle.cleanup();
        await lock!.release();
    });

    it('locks the pinned intended identity rather than a substituted intended path', async () => {
        const lock = await manager.acquire(target);
        expect(lock).not.toBeNull();
        const preparedInstallId = 'ac'.repeat(32);
        const bundleDirectory = path.join(directory, `.table-viewer-prepared-${preparedInstallId}`);
        const intendedPath = path.join(bundleDirectory, 'intended.bin');
        const pinnedIntended = path.join(directory, 'pinned-intended.bin');
        const pinnedAlias = path.join(directory, 'pinned-intended-alias.bin');
        const substituteAlias = path.join(directory, 'substitute-alias.bin');

        await expect(prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
            randomBytes: () => Buffer.from(preparedInstallId, 'hex'),
            onEvent(event) {
                if (event === 'intended-durable') {
                    fs.renameSync(intendedPath, pinnedIntended);
                    fs.linkSync(pinnedIntended, pinnedAlias);
                    fs.writeFileSync(intendedPath, 'attacker\n', { mode: 0o600 });
                    fs.linkSync(intendedPath, substituteAlias);
                }
                if (event === 'lock-set-extended') throw new Error('injected after extension');
            },
        })).rejects.toThrow(/injected after extension/);

        const pinnedIdentity = identify_physical_resource(pinnedIntended);
        const pinnedAliasIdentity = identify_physical_resource(pinnedAlias);
        const pinnedObjectMember = pinnedIdentity.lockMemberNames.find((name) =>
            pinnedAliasIdentity.lockMemberNames.includes(name))!;
        const substituteIdentity = identify_physical_resource(intendedPath);
        const substituteAliasIdentity = identify_physical_resource(substituteAlias);
        const substituteObjectMember = substituteIdentity.lockMemberNames.find((name) =>
            substituteAliasIdentity.lockMemberNames.includes(name))!;
        const lockMembers = fs.readdirSync(path.join(directory, 'locks'))
            .filter((name) => name.endsWith('.lock'));
        expect(lockMembers).toContain(pinnedObjectMember);
        expect(lockMembers).not.toContain(substituteObjectMember);
        expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
        await lock!.release();
    });

    it('prepares a hardlinked target while retaining object-wide exclusion', async () => {
        const alias = path.join(directory, 'alias.csv');
        fs.linkSync(target, alias);
        const lock = await manager.acquire(alias);
        const bundle = await prepare_physical_install({
            targetPath: alias,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        expect(await bundle.verify()).toBe(true);
        await bundle.cleanup();
        await lock!.release();
    });

    it('leaves the target unchanged when preparation fails at every durable cut point', async () => {
        for (const cutPoint of [
            'bundle-directory-durable',
            'backup-durable',
            'intended-durable',
            'lock-set-extended',
            'manifest-durable',
        ] as const) {
            const lock = await manager.acquire(target);
            await expect(prepare_physical_install({
                targetPath: target,
                expectedOriginal: Buffer.from('old\n'),
                intended: Buffer.from('new\n'),
                hostLock: lock!,
                onEvent(event) {
                    if (event === cutPoint) throw Object.assign(new Error('injected full'), { code: 'ENOSPC' });
                },
            })).rejects.toMatchObject({ code: 'ENOSPC' });
            expect(fs.readFileSync(target, 'utf8'), cutPoint).toBe('old\n');
            await lock?.release();
        }
    });

    it.each([
        { failure: 'ENOSPC', writeCall: 2, writeError: 'ENOSPC', short: false, fileFsyncCall: 0, directoryFsyncCall: 0, expectedInspection: 'incomplete' },
        { failure: 'write', writeCall: 2, writeError: 'write', short: false, fileFsyncCall: 0, directoryFsyncCall: 0, expectedInspection: 'incomplete' },
        { failure: 'short write', writeCall: 3, writeError: '', short: true, fileFsyncCall: 0, directoryFsyncCall: 0, expectedInspection: 'tampered' },
        { failure: 'file fsync', writeCall: 0, writeError: '', short: false, fileFsyncCall: 2, directoryFsyncCall: 0, expectedInspection: 'incomplete' },
        { failure: 'directory fsync before contents', writeCall: 0, writeError: '', short: false, fileFsyncCall: 0, directoryFsyncCall: 1, expectedInspection: 'incomplete' },
        { failure: 'directory fsync after manifest', writeCall: 0, writeError: '', short: false, fileFsyncCall: 0, directoryFsyncCall: 4, expectedInspection: 'valid' },
    ] as const)(
        'preserves target and restart evidence after injected $failure failure',
        async ({ writeCall, writeError, short, fileFsyncCall, directoryFsyncCall, expectedInspection }) => {
            const lock = await manager.acquire(target);
            expect(lock).not.toBeNull();
            let writes = 0;
            let fileFsyncs = 0;
            let directoryFsyncs = 0;
            const operations: PreparedInstallDurableOperations = {
                write(descriptor, bytes) {
                    writes += 1;
                    if (writes === writeCall) {
                        if (short) {
                            return fs.writeSync(descriptor, bytes, 0, Math.floor(bytes.byteLength / 2));
                        }
                        throw Object.assign(new Error(`injected ${writeError}`), {
                            code: writeError === 'ENOSPC' ? 'ENOSPC' : 'EIO',
                        });
                    }
                    return fs.writeSync(descriptor, bytes, 0, bytes.byteLength);
                },
                fsyncFile(descriptor) {
                    fileFsyncs += 1;
                    if (fileFsyncs === fileFsyncCall) throw new Error('injected file fsync');
                    fs.fsyncSync(descriptor);
                },
                fsyncDirectory(descriptor) {
                    directoryFsyncs += 1;
                    if (directoryFsyncs === directoryFsyncCall) {
                        throw new Error('injected directory fsync');
                    }
                    fs.fsyncSync(descriptor);
                },
            };
            const preparedInstallId = 'ab'.repeat(32);
            const bundleDirectory = path.join(
                directory,
                `.table-viewer-prepared-${preparedInstallId}`,
            );

            await expect(prepare_physical_install({
                targetPath: target,
                expectedOriginal: Buffer.from('old\n'),
                intended: Buffer.from('new\n'),
                hostLock: lock!,
                randomBytes: () => Buffer.from(preparedInstallId, 'hex'),
                durableOperations: operations,
            })).rejects.toThrow(/injected|short/);

            expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
            expect(fs.existsSync(bundleDirectory)).toBe(true);
            expect(inspect_prepared_physical_install(bundleDirectory).type)
                .toBe(expectedInspection);
            await lock!.release();
            expect(fs.readdirSync(path.join(directory, 'locks')).filter((name) => name.endsWith('.lock')))
                .toEqual([]);
            expect(fs.existsSync(bundleDirectory)).toBe(true);
        },
    );

    it('rejects a stale expected original before creating a bundle', async () => {
        const lock = await manager.acquire(target);
        await expect(prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('stale\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        })).rejects.toThrow(/no longer matches/);
        expect(fs.readdirSync(directory).some((name) => name.startsWith('.table-viewer-prepared-')))
            .toBe(false);
        expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
        await lock?.release();
    });

    it('detects tampered and hardlinked private bundle members', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        const intended = path.join(bundle.directory, 'intended.bin');
        const alias = path.join(directory, 'stolen-intended.bin');
        fs.linkSync(intended, alias);
        expect(await bundle.verify()).toBe(false);
        fs.unlinkSync(alias);
        fs.writeFileSync(intended, 'evil\n');
        expect(await bundle.verify()).toBe(false);
        expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
        await bundle.cleanup();
        await lock?.release();
    });

    it('supports durable restart inspection and target reconciliation', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });

        expect(inspect_prepared_physical_install(bundle.directory)).toMatchObject({
            type: 'valid',
            preparedInstallId: bundle.preparedInstallId,
            expectedLength: 4,
            intendedLength: 4,
        });
        expect(reconcile_prepared_physical_install(target, bundle.directory).type)
            .toBe('targetExpected');
        fs.writeFileSync(target, 'new\n');
        expect(reconcile_prepared_physical_install(target, bundle.directory).type)
            .toBe('targetIntended');
        fs.writeFileSync(target, 'external\n');
        expect(reconcile_prepared_physical_install(target, bundle.directory))
            .toEqual({ type: 'recoveryRequired', reason: 'targetOther' });

        await bundle.cleanup();
        await lock?.release();
    });

    it('binds conditional fences to the requested expected or intended target digest', async () => {
        const lock = await manager.acquire(target);
        if (!lock) throw new Error('expected lock');
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock,
        });
        const acquired: string[] = [];
        const io = bundle.createReservedIo({
            platformEnforced: true,
            async acquire(_targetPath, expectedPhysicalDigest) {
                acquired.push(expectedPhysicalDigest);
                return {
                    type: 'acquired',
                    fence: {
                        async install() { return { displacedPhysicalDigest: bundle.expectedPhysicalDigest }; },
                        async verifyInstalledDurable() { return true; },
                        async release() {},
                    },
                };
            },
        });
        expect(await io.acquireConditionalInstallFence('expected')).toBe('acquired');
        await io.releaseConditionalInstallFence();
        fs.writeFileSync(target, 'new\n');
        expect(await io.acquireConditionalInstallFence('intended')).toBe('acquired');
        await io.releaseConditionalInstallFence();
        expect(acquired).toEqual([
            bundle.expectedPhysicalDigest,
            bundle.intendedPhysicalDigest,
        ]);
        await bundle.cleanup();
        await lock.release();
    });

    it('keeps active fences adapter-local and rejects duplicate acquisition', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        let finishAcquire!: () => void;
        const blocked = new Promise<void>((resolve) => { finishAcquire = resolve; });
        let acquisition = 0;
        const installer = {
            platformEnforced: true as const,
            async acquire() {
                acquisition += 1;
                if (acquisition === 1) await blocked;
                return {
                    type: 'acquired' as const,
                    fence: {
                        async install() { return { displacedPhysicalDigest: bundle.expectedPhysicalDigest }; },
                        async verifyInstalledDurable() { return true; },
                        async release() {},
                    },
                };
            },
        };
        const first = bundle.createReservedIo(installer);
        const second = bundle.createReservedIo(installer);
        const pending = first.acquireConditionalInstallFence('expected');
        await expect(first.releaseConditionalInstallFence())
            .rejects.toThrow(/acquisition is in progress/);
        await expect(first.acquireConditionalInstallFence('expected'))
            .rejects.toThrow(/already held/);
        expect(await second.acquireConditionalInstallFence('expected')).toBe('acquired');
        finishAcquire();
        expect(await pending).toBe('acquired');
        await expect(first.acquireConditionalInstallFence('expected'))
            .rejects.toThrow(/already held/);
        await first.releaseConditionalInstallFence();
        await second.releaseConditionalInstallFence();
        await bundle.cleanup();
        await lock!.release();
    });

    it('retains a fence after failed release and rejects acquisition while release is pending', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        let releaseAttempt = 0;
        let finishRelease!: () => void;
        const blockedRelease = new Promise<void>((resolve) => { finishRelease = resolve; });
        const io = bundle.createReservedIo({
            platformEnforced: true,
            async acquire() {
                return {
                    type: 'acquired',
                    fence: {
                        async install() { return { displacedPhysicalDigest: bundle.expectedPhysicalDigest }; },
                        async verifyInstalledDurable() { return true; },
                        async release() {
                            releaseAttempt += 1;
                            if (releaseAttempt === 1) throw new Error('injected fence release failure');
                            await blockedRelease;
                        },
                    },
                };
            },
        });
        expect(await io.acquireConditionalInstallFence('expected')).toBe('acquired');
        await expect(io.releaseConditionalInstallFence()).rejects.toThrow(/release failure/);
        await expect(io.acquireConditionalInstallFence('expected')).rejects.toThrow(/already held/);
        const pendingRelease = io.releaseConditionalInstallFence();
        await expect(io.acquireConditionalInstallFence('expected')).rejects.toThrow(/already held/);
        finishRelease();
        await pendingRelease;
        expect(await io.acquireConditionalInstallFence('expected')).toBe('acquired');
        finishRelease();
        await io.releaseConditionalInstallFence();
        await bundle.cleanup();
        await lock!.release();
    });

    it('keeps the fence held while install and durable verification are pending', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        let finishInstall!: () => void;
        let finishVerify!: () => void;
        const installBlocked = new Promise<void>((resolve) => { finishInstall = resolve; });
        const verifyBlocked = new Promise<void>((resolve) => { finishVerify = resolve; });
        const io = bundle.createReservedIo({
            platformEnforced: true,
            async acquire() {
                return {
                    type: 'acquired',
                    fence: {
                        async install() {
                            await installBlocked;
                            return { displacedPhysicalDigest: bundle.expectedPhysicalDigest };
                        },
                        async verifyInstalledDurable() {
                            await verifyBlocked;
                            return true;
                        },
                        async release() {},
                    },
                };
            },
        });
        expect(await io.acquireConditionalInstallFence('expected')).toBe('acquired');
        const installing = io.installPreparedBundle();
        await expect(io.releaseConditionalInstallFence()).rejects.toThrow(/operation is in progress/);
        finishInstall();
        await installing;
        const verifying = io.verifyInstalledDurable();
        await expect(io.releaseConditionalInstallFence()).rejects.toThrow(/operation is in progress/);
        finishVerify();
        expect(await verifying).toBe(true);
        await io.releaseConditionalInstallFence();
        await bundle.cleanup();
        await lock!.release();
    });

    it('pins the conditional source identity and never installs a swapped intended file', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        let installs = 0;
        const io = bundle.createReservedIo({
            platformEnforced: true,
            async acquire(_targetPath, expectedDigest, contract) {
                expect(expectedDigest).toBe(bundle.expectedPhysicalDigest);
                expect(contract.expectedTarget.physicalDigest).toBe(bundle.expectedPhysicalDigest);
                expect(contract.source.physicalDigest).toBe(bundle.intendedPhysicalDigest);
                return {
                    type: 'acquired',
                    fence: {
                        async install() {
                            installs += 1;
                            fs.writeFileSync(target, fs.readFileSync(contract.source.path));
                            return { displacedPhysicalDigest: bundle.expectedPhysicalDigest };
                        },
                        async verifyInstalledDurable() { return true; },
                        async release() {},
                    },
                };
            },
        });
        expect(await io.acquireConditionalInstallFence('expected')).toBe('acquired');
        const intendedPath = path.join(bundle.directory, 'intended.bin');
        fs.renameSync(intendedPath, path.join(bundle.directory, 'displaced-intended.bin'));
        fs.writeFileSync(intendedPath, 'attacker\n', { mode: 0o600 });
        await expect(io.installPreparedBundle()).rejects.toThrow(/source identity changed/);
        expect(installs).toBe(0);
        expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
        await io.releaseConditionalInstallFence();
        await bundle.cleanup();
        await lock!.release();
    });

    it('reopens and verifies an atomically installed bundle after the source was consumed', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        const io = bundle.createReservedIo({
            platformEnforced: true,
            async acquire(_targetPath, expectedDigest, contract) {
                expect(expectedDigest).toBe(bundle.expectedPhysicalDigest);
                return {
                    type: 'acquired',
                    fence: {
                        async install() {
                            fs.renameSync(contract.source.path, target);
                            const targetDescriptor = fs.openSync(target, fs.constants.O_RDONLY);
                            try {
                                fs.fsyncSync(targetDescriptor);
                            } finally {
                                fs.closeSync(targetDescriptor);
                            }
                            const parentDescriptor = fs.openSync(
                                path.dirname(target),
                                fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
                            );
                            try {
                                fs.fsyncSync(parentDescriptor);
                            } finally {
                                fs.closeSync(parentDescriptor);
                            }
                            return { displacedPhysicalDigest: bundle.expectedPhysicalDigest };
                        },
                        async verifyInstalledDurable(candidate) { return candidate.verify(); },
                        async release() {},
                    },
                };
            },
        });
        expect(await io.acquireConditionalInstallFence('expected')).toBe('acquired');
        await io.installPreparedBundle();
        expect(fs.existsSync(path.join(bundle.directory, 'intended.bin'))).toBe(false);
        expect(await io.verifyInstalledDurable()).toBe(true);
        await io.releaseConditionalInstallFence();

        const restartedManager = new PhysicalResourceLockManager({
            lockRoot: path.join(directory, 'locks'),
        });
        const reconstructed = restartedManager.attest_reservation_lock(target, {
            hostLockId: bundle.hostLockId,
            physicalResourceLockKey: bundle.physicalResourceLockKey,
        });
        expect(reconstructed).not.toBeNull();
        const reopened = reopen_prepared_physical_install({
            targetPath: target,
            directory: bundle.directory,
            hostLock: reconstructed!,
        });
        expect(await reopened.verify()).toBe(true);
        const installedIdentity = fs.lstatSync(target, { bigint: true });
        const restartedIo = reopened.createReservedIo({
            platformEnforced: true,
            async acquire(acquiredTarget, expectedDigest, contract) {
                expect(acquiredTarget).toBe(target);
                expect(expectedDigest).toBe(bundle.intendedPhysicalDigest);
                expect(contract.expectedTarget.objectIdentity).toMatchObject({
                    device: installedIdentity.dev.toString(),
                    inode: installedIdentity.ino.toString(),
                });
                expect(contract.source.path).toBe(target);
                return { type: 'conflict' };
            },
        });
        expect(await restartedIo.acquireConditionalInstallFence('intended')).toBe('conflict');
        const replacement = path.join(directory, 'same-bytes-replacement.csv');
        fs.writeFileSync(replacement, 'new\n');
        fs.renameSync(replacement, target);
        expect(await reopened.verify()).toBe(false);
        expect(await reopened.cleanup()).toBe('pending');
        await reconstructed!.release();
    });

    it('rejects restart when intended bytes were written into the old target object', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        fs.writeFileSync(target, 'new\n');
        fs.unlinkSync(path.join(bundle.directory, 'intended.bin'));
        expect(() => reopen_prepared_physical_install({
            targetPath: target,
            directory: bundle.directory,
            hostLock: lock!,
        })).toThrow(/tampered/);
        expect(await bundle.verify()).toBe(false);
        expect(await bundle.cleanup()).toBe('pending');
        await lock!.release();
    });

    it('never replaces a preexisting cleanup quarantine claim', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        const quarantine = path.join(directory, `.table-viewer-prepared-cleanup-${bundle.preparedInstallId}`);
        fs.mkdirSync(quarantine, { mode: 0o700 });
        await expect(bundle.cleanup()).rejects.toMatchObject({ code: 'EEXIST' });
        expect(fs.statSync(quarantine).isDirectory()).toBe(true);
        expect(fs.existsSync(bundle.directory)).toBe(true);
        fs.rmdirSync(quarantine);
        await bundle.cleanup();
        await lock!.release();
    });

    it('does not delete a bundle directory substituted between cleanup claim and rename', async () => {
        const lock = await manager.acquire(target);
        let evidence = '';
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
            onEvent(event) {
                if (event !== 'bundle-cleanup-claim-durable') return;
                evidence = `${bundle.directory}.evidence`;
                fs.renameSync(bundle.directory, evidence);
                fs.mkdirSync(bundle.directory, { mode: 0o700 });
                fs.writeFileSync(path.join(bundle.directory, 'replacement-owner'), 'keep\n');
            },
        });
        await expect(bundle.cleanup()).rejects.toThrow(/bundle identity changed/);
        expect(fs.readFileSync(path.join(bundle.directory, 'replacement-owner'), 'utf8')).toBe('keep\n');
        expect(fs.existsSync(evidence)).toBe(true);
        await lock!.release();
    });

    it('retains quarantined evidence and never deletes a substituted path', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        expect(await bundle.cleanup()).toBe('pending');
        const quarantine = path.join(directory, `.table-viewer-prepared-cleanup-${bundle.preparedInstallId}`);
        const evidencePath = path.join(quarantine, path.basename(bundle.directory));
        const savedEvidence = `${evidencePath}.saved`;
        fs.renameSync(evidencePath, savedEvidence);
        fs.mkdirSync(evidencePath, { mode: 0o700 });
        fs.writeFileSync(path.join(evidencePath, 'replacement-owner'), 'keep\n');
        await expect(bundle.cleanup()).rejects.toThrow(/bundle identity changed/);
        expect(fs.readFileSync(path.join(evidencePath, 'replacement-owner'), 'utf8')).toBe('keep\n');
        expect(fs.existsSync(savedEvidence)).toBe(true);
        await lock!.release();
    });

    it('retries identity-bound cleanup after parent fsync failure without deleting a replacement', async () => {
        const lock = await manager.acquire(target);
        let directoryFsyncs = 0;
        let cleanupPhase = false;
        const operations: PreparedInstallDurableOperations = {
            write: (descriptor, bytes) => fs.writeSync(descriptor, bytes, 0, bytes.byteLength),
            fsyncFile: (descriptor) => fs.fsyncSync(descriptor),
            fsyncDirectory(descriptor) {
                directoryFsyncs += 1;
                if (cleanupPhase && directoryFsyncs === 3) {
                    throw new Error('injected cleanup parent fsync');
                }
                fs.fsyncSync(descriptor);
            },
        };
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
            durableOperations: operations,
        });
        directoryFsyncs = 0;
        cleanupPhase = true;
        await expect(bundle.cleanup()).rejects.toThrow(/cleanup parent fsync/);
        expect(fs.existsSync(bundle.directory)).toBe(false);
        const quarantine = path.join(directory, `.table-viewer-prepared-cleanup-${bundle.preparedInstallId}`);
        expect(fs.existsSync(quarantine)).toBe(true);
        const evidence = `${quarantine}.evidence`;
        fs.renameSync(quarantine, evidence);
        fs.mkdirSync(quarantine, { mode: 0o700 });
        fs.writeFileSync(path.join(quarantine, 'replacement-owner'), 'keep\n');
        await expect(bundle.cleanup()).rejects.toThrow(/quarantine identity changed/);
        expect(fs.readFileSync(path.join(quarantine, 'replacement-owner'), 'utf8')).toBe('keep\n');
        fs.rmSync(quarantine, { recursive: true });
        fs.renameSync(evidence, quarantine);
        expect(await bundle.cleanup()).toBe('pending');
        expect(fs.existsSync(quarantine)).toBe(true);
        await lock!.release();
    });

    it('reopens a durable bundle with an exact reservation-attested crash-left lock set', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        const restartedManager = new PhysicalResourceLockManager({ lockRoot: path.join(directory, 'locks') });
        const reconstructed = restartedManager.attest_reservation_lock(target, {
            hostLockId: bundle.hostLockId,
            physicalResourceLockKey: bundle.physicalResourceLockKey,
        });
        expect(reconstructed).not.toBeNull();
        const reopened = reopen_prepared_physical_install({
            targetPath: target,
            directory: bundle.directory,
            hostLock: reconstructed!,
        });
        expect(await reopened.verify()).toBe(true);
        const io = reopened.createReservedIo({
            platformEnforced: true,
            async acquire(_targetPath, _digest, contract) {
                expect(() => {
                    (contract.source.objectIdentity as { inode: string }).inode = '999';
                }).toThrow();
                return { type: 'conflict' };
            },
        });
        expect(await io.acquireConditionalInstallFence('expected')).toBe('conflict');
        expect(await reopened.verify()).toBe(true);
        expect(reopened).toMatchObject({
            preparedInstallId: bundle.preparedInstallId,
            hostLockId: bundle.hostLockId,
            physicalResourceLockKey: bundle.physicalResourceLockKey,
        });
        await reopened.cleanup();
        await reconstructed!.release();
        await lock!.release();
    });

    it('reports unsupported rather than falling back to an unconditional install', async () => {
        const lock = await manager.acquire(target);
        const bundle = await prepare_physical_install({
            targetPath: target,
            expectedOriginal: Buffer.from('old\n'),
            intended: Buffer.from('new\n'),
            hostLock: lock!,
        });
        const io = bundle.createReservedIo();
        expect(await io.verifyHostLock()).toBe(true);
        expect(await io.verifyPreparedBundle()).toBe(true);
        expect(await io.acquireConditionalInstallFence('expected')).toBe('unsupported');
        await expect(io.installPreparedBundle()).rejects.toThrow(/fence is not held/);
        expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
        await io.releaseConditionalInstallFence();
        await bundle.cleanup();
        await lock?.release();
    });
});
