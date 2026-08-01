import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    identify_physical_resource,
    native_physical_edit_eligibility,
    physical_lock_root,
    PhysicalResourceLockManager,
} from '../physical-resource-lock';
import {
    reopen_prepared_physical_install,
    resume_prepared_physical_install_cleanup,
} from '../prepared-physical-install';

interface PhysicalLockWorker {
    readonly child: ChildProcess;
    request<T>(command: string, payload?: unknown): Promise<T>;
    waitForEvent<T>(type: string): Promise<T>;
    crash(): Promise<void>;
    close(): Promise<void>;
}

const WORKER_WAIT_TIMEOUT_MS = 5_000;
const physicalLockWorkerChildren = new Set<ChildProcess>();

function physical_object_identity(filePath: string): { readonly device: string; readonly inode: string } {
    const stat = fs.lstatSync(filePath, { bigint: true });
    return { device: stat.dev.toString(), inode: stat.ino.toString() };
}
const physicalLockWorkerExits = new WeakMap<ChildProcess, Promise<void>>();

function track_physical_lock_worker(child: ChildProcess): void {
    physicalLockWorkerChildren.add(child);
    physicalLockWorkerExits.set(child, new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
    }));
}

function worker_timeout(description: string): Error {
    return new Error(`Timed out waiting for physical lock worker ${description}.`);
}

async function terminate_physical_lock_worker(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        physicalLockWorkerChildren.delete(child);
        return;
    }
    const exited = physicalLockWorkerExits.get(child)
        ?? new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
        child.kill('SIGCONT');
    } catch {
        // SIGCONT is unavailable on some platforms and unnecessary for running children.
    }
    child.kill('SIGKILL');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(
                    () => reject(worker_timeout('termination')),
                    WORKER_WAIT_TIMEOUT_MS,
                );
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function spawn_physical_lock_worker(
    workerPath: string,
    target: string,
    lockRoot: string,
): Promise<PhysicalLockWorker> {
    const child = fork(workerPath, [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
            ...process.env,
            TABLE_VIEWER_PHYSICAL_LOCK_TARGET: target,
            TABLE_VIEWER_PHYSICAL_LOCK_ROOT: lockRoot,
        },
    });
    track_physical_lock_worker(child);
    let nextId = 1;
    const pending = new Map<number, {
        resolve(value: unknown): void;
        reject(error: unknown): void;
        timeout: ReturnType<typeof setTimeout>;
    }>();
    const events = new Map<string, unknown[]>();
    const eventWaiters = new Map<string, Array<{
        resolve(value: unknown): void;
        reject(error: unknown): void;
        timeout: ReturnType<typeof setTimeout>;
    }>>();
    let terminalError: Error | undefined;
    let ready!: () => void;
    let rejectReady!: (error: unknown) => void;
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
    const readiness = new Promise<void>((resolve, reject) => {
        ready = resolve;
        rejectReady = reject;
        readinessTimeout = setTimeout(
            () => reject(worker_timeout('readiness')),
            WORKER_WAIT_TIMEOUT_MS,
        );
    });
    const rejectOutstanding = (error: Error) => {
        if (terminalError) return;
        terminalError = error;
        rejectReady(error);
        for (const request of pending.values()) {
            clearTimeout(request.timeout);
            request.reject(error);
        }
        pending.clear();
        for (const waiters of eventWaiters.values()) {
            for (const waiter of waiters) {
                clearTimeout(waiter.timeout);
                waiter.reject(error);
            }
        }
        eventWaiters.clear();
    };
    child.on('message', (message: any) => {
        if (message.type === 'ready') {
            ready();
            return;
        }
        if (typeof message.type === 'string' && message.id === undefined) {
            const waiter = eventWaiters.get(message.type)?.shift();
            if (waiter) {
                clearTimeout(waiter.timeout);
                waiter.resolve(message);
            } else {
                const queued = events.get(message.type) ?? [];
                queued.push(message);
                events.set(message.type, queued);
            }
            return;
        }
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timeout);
        if (message.type === 'result') request.resolve(message.value);
        else request.reject(new Error(message.message));
    });
    child.once('error', (error) => rejectOutstanding(error));
    child.once('exit', (code, signal) => {
        physicalLockWorkerChildren.delete(child);
        rejectOutstanding(new Error(
            `Physical lock worker exited (code ${String(code)}, signal ${String(signal)}).`,
        ));
    });
    try {
        await readiness;
    } catch (error) {
        await terminate_physical_lock_worker(child);
        throw error;
    } finally {
        if (readinessTimeout) clearTimeout(readinessTimeout);
    }

    const worker: PhysicalLockWorker = {
        child,
        request<T>(command: string, payload: unknown = {}): Promise<T> {
            if (terminalError) return Promise.reject(terminalError);
            const id = nextId++;
            return new Promise<T>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    pending.delete(id);
                    reject(worker_timeout(`request ${command}`));
                }, WORKER_WAIT_TIMEOUT_MS);
                pending.set(id, {
                    resolve: (value) => resolve(value as T),
                    reject,
                    timeout,
                });
                child.send({ id, command, payload }, (error) => {
                    if (!error) return;
                    const request = pending.get(id);
                    if (!request) return;
                    pending.delete(id);
                    clearTimeout(request.timeout);
                    reject(error);
                });
            });
        },
        waitForEvent<T>(type: string): Promise<T> {
            const queued = events.get(type);
            if (queued?.length) return Promise.resolve(queued.shift() as T);
            if (terminalError) return Promise.reject(terminalError);
            return new Promise<T>((resolve, reject) => {
                let waiter!: {
                    resolve(value: unknown): void;
                    reject(error: unknown): void;
                    timeout: ReturnType<typeof setTimeout>;
                };
                const timeout = setTimeout(() => {
                    const waiters = eventWaiters.get(type);
                    const index = waiters?.indexOf(waiter) ?? -1;
                    if (index >= 0) waiters!.splice(index, 1);
                    reject(worker_timeout(`event ${type}`));
                }, WORKER_WAIT_TIMEOUT_MS);
                waiter = {
                    resolve: (value: unknown) => resolve(value as T),
                    reject,
                    timeout,
                };
                const waiters = eventWaiters.get(type) ?? [];
                waiters.push(waiter);
                eventWaiters.set(type, waiters);
            });
        },
        async crash(): Promise<void> {
            await terminate_physical_lock_worker(child);
        },
        async close(): Promise<void> {
            if (child.exitCode !== null || child.signalCode !== null) return;
            try {
                await worker.request('close');
                let timeout: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        physicalLockWorkerExits.get(child)!,
                        new Promise<never>((_, reject) => {
                            timeout = setTimeout(
                                () => reject(worker_timeout('graceful exit')),
                                WORKER_WAIT_TIMEOUT_MS,
                            );
                        }),
                    ]);
                } finally {
                    if (timeout) clearTimeout(timeout);
                }
            } catch (error) {
                await terminate_physical_lock_worker(child);
                throw error;
            }
        },
    };
    return worker;
}

describe('physical resource locks', () => {
    let directory: string;
    let target: string;
    let lockRoot: string;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-physical-lock-'));
        target = path.join(directory, 'private-name.csv');
        lockRoot = path.join(directory, 'locks');
        fs.writeFileSync(target, 'a,b\n1,2\n');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all([...physicalLockWorkerChildren].map((child) =>
            terminate_physical_lock_worker(child)));
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('selects one documented host-wide root per platform', () => {
        expect(physical_lock_root('darwin', {}, '/home/me')).toBe(
            path.join('/home/me', 'Library', 'Application Support', 'Table Viewer', 'physical-locks'),
        );
        expect(physical_lock_root('linux', {}, '/home/me')).toBe(
            path.join('/home/me', '.local', 'state', 'table-viewer', 'physical-locks'),
        );
        expect(physical_lock_root('linux', { XDG_STATE_HOME: '/state' }, '/home/me')).toBe(
            path.join('/state', 'table-viewer', 'physical-locks'),
        );
        expect(physical_lock_root('win32', { LOCALAPPDATA: 'C:\\Local' }, 'C:\\Users\\me'))
            .toBe('C:\\Local\\Table Viewer\\physical-locks');
    });

    it('fences non-file, remote, WSL/shared, and unsupported hosts to viewing', () => {
        expect(native_physical_edit_eligibility({ scheme: 'memfs', filePath: target }))
            .toEqual({ eligible: false, reason: 'non-file' });
        expect(native_physical_edit_eligibility({ scheme: 'file', filePath: target, remoteHost: true }))
            .toEqual({ eligible: false, reason: 'remote-host' });
        expect(native_physical_edit_eligibility({
            scheme: 'file', filePath: '/mnt/c/data.csv', platform: 'linux',
        })).toEqual({ eligible: false, reason: 'wsl' });
        expect(native_physical_edit_eligibility({
            scheme: 'file', filePath: target, platform: 'aix',
        })).toEqual({ eligible: false, reason: 'unsupported-platform' });
    });

    it('allows only proven local filesystem types and fails unknown types closed', () => {
        expect(native_physical_edit_eligibility({
            scheme: 'file',
            filePath: target,
            filesystemType: () => 0x12345678n,
        }))
            .toEqual({ eligible: false, reason: 'unverifiable-filesystem' });
        expect(native_physical_edit_eligibility({
            scheme: 'file',
            filePath: target,
            coordinationFilesystemType: () => 0x6969n,
        })).toEqual({ eligible: false, reason: 'shared-mount' });
        expect(native_physical_edit_eligibility({
            scheme: 'file', filePath: target, platform: 'win32',
        })).toEqual({ eligible: false, reason: 'unsupported-platform' });
    });

    it('rechecks the target filesystem during acquisition and fails unknown storage closed', async () => {
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            targetFilesystemType: () => 0x12345678n,
        });
        await expect(manager.acquire(target)).rejects.toThrow(/target filesystem is not proven local/);
        expect(fs.existsSync(lockRoot)).toBe(false);
    });

    it('binds target filesystem classification to the captured target inode', async () => {
        const displaced = path.join(directory, 'classified-target.csv');
        let swapped = false;
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            targetFilesystemType(descriptor) {
                const type = fs.statfsSync(`/dev/fd/${descriptor}`, { bigint: true }).type;
                if (!swapped) {
                    swapped = true;
                    fs.renameSync(target, displaced);
                    fs.writeFileSync(target, 'replacement\n');
                }
                return type;
            },
        });

        await expect(manager.acquire(target)).rejects.toThrow(/target filesystem is not proven local/);
        expect(fs.readFileSync(displaced, 'utf8')).toBe('a,b\n1,2\n');
        expect(fs.readFileSync(target, 'utf8')).toBe('replacement\n');
        expect(fs.existsSync(lockRoot)).toBe(false);
    });

    it('binds coordination filesystem classification to the captured root inode', async () => {
        const displaced = `${lockRoot}.classified`;
        let swapped = false;
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            filesystemType(descriptor) {
                const type = fs.statfsSync(`/dev/fd/${descriptor}`, { bigint: true }).type;
                if (!swapped) {
                    swapped = true;
                    fs.renameSync(lockRoot, displaced);
                    fs.mkdirSync(lockRoot, { mode: 0o700 });
                }
                return type;
            },
        });

        await expect(manager.acquire(target)).rejects.toThrow(/root changed during inspection/);
        expect(fs.readdirSync(lockRoot)).toEqual([]);
        expect(fs.readdirSync(displaced)).toEqual([]);
    });

    it('rolls back durable members if the target filesystem becomes unproven before return', async () => {
        let checks = 0;
        const localType = fs.statfsSync(target, { bigint: true }).type;
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            targetFilesystemType: () => {
                checks += 1;
                return checks === 1 ? localType : 0x12345678n;
            },
        });
        await expect(manager.acquire(target)).rejects.toThrow(/target filesystem is not proven local/);
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toEqual([]);
    });

    it('rechecks the created coordination root filesystem and rejects unknown storage', async () => {
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            filesystemType: () => 0x12345678n,
        });
        await expect(manager.acquire(target)).rejects.toThrow(/not proven local/);
        expect(fs.readdirSync(lockRoot)).toEqual([]);
    });

    it('fails closed when coordination directory durability cannot be established', async () => {
        let calls = 0;
        const manager = new PhysicalResourceLockManager({
            lockRoot: path.join(directory, 'new-parent', 'locks'),
            durableDirectoryOperations: {
                fsync(descriptor) {
                    calls += 1;
                    if (calls === 2) throw new Error('injected parent directory fsync failure');
                    fs.fsyncSync(descriptor);
                },
            },
        });
        await expect(manager.acquire(target)).rejects.toThrow(/parent directory fsync/);
        expect(fs.existsSync(path.join(directory, 'new-parent', 'locks'))).toBe(false);
    });

    it('rejects an insecure existing root without changing its mode', async () => {
        if (process.platform === 'win32') return;
        fs.mkdirSync(lockRoot, { mode: 0o755 });
        fs.chmodSync(lockRoot, 0o755);
        const manager = new PhysicalResourceLockManager({ lockRoot });

        await expect(manager.acquire(target)).rejects.toThrow(/not private/);
        expect(fs.statSync(lockRoot).mode & 0o777).toBe(0o755);
    });

    it('rejects a symlink root without changing the target', async () => {
        if (process.platform === 'win32') return;
        const symlink_target = path.join(directory, 'other-locks');
        fs.mkdirSync(symlink_target, { mode: 0o755 });
        fs.chmodSync(symlink_target, 0o755);
        fs.symlinkSync(symlink_target, lockRoot);
        const manager = new PhysicalResourceLockManager({ lockRoot });

        await expect(manager.acquire(target)).rejects.toThrow();
        expect(fs.statSync(symlink_target).mode & 0o777).toBe(0o755);
    });

    it('fails closed when the root becomes a symlink during handle inspection', async () => {
        if (process.platform === 'win32') return;
        fs.mkdirSync(lockRoot, { mode: 0o700 });
        const displaced = `${lockRoot}.displaced`;
        const symlink_target = path.join(directory, 'symlink-race-target');
        fs.mkdirSync(symlink_target, { mode: 0o700 });
        const original_realpath = fs.realpathSync.native;
        vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate) => {
            if (candidate !== lockRoot) return original_realpath(candidate);
            fs.renameSync(lockRoot, displaced);
            fs.symlinkSync(symlink_target, lockRoot);
            return original_realpath(candidate);
        });
        const manager = new PhysicalResourceLockManager({ lockRoot });

        await expect(manager.acquire(target)).rejects.toThrow();
        expect(fs.readdirSync(symlink_target)).toEqual([]);
    });

    it('fails closed when the root is replaced during handle inspection', async () => {
        if (process.platform === 'win32') return;
        fs.mkdirSync(lockRoot, { mode: 0o700 });
        const displaced = `${lockRoot}.displaced`;
        const original_realpath = fs.realpathSync.native;
        vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate) => {
            if (candidate !== lockRoot) return original_realpath(candidate);
            fs.renameSync(lockRoot, displaced);
            fs.mkdirSync(lockRoot, { mode: 0o700 });
            return original_realpath(candidate);
        });
        const manager = new PhysicalResourceLockManager({ lockRoot });

        await expect(manager.acquire(target)).rejects.toThrow(/changed during inspection/);
        expect(fs.readdirSync(lockRoot)).toEqual([]);
    });

    it('uses realpath plus object identity to collapse symlink and hardlink aliases', async () => {
        const symlink = path.join(directory, 'symlink.csv');
        const hardlink = path.join(directory, 'hardlink.csv');
        fs.symlinkSync(target, symlink);
        fs.linkSync(target, hardlink);
        const targetIdentity = identify_physical_resource(target);
        const symlinkIdentity = identify_physical_resource(symlink);
        const hardlinkIdentity = identify_physical_resource(hardlink);
        expect(symlinkIdentity.keyMembers).toEqual(targetIdentity.keyMembers);
        expect(hardlinkIdentity.keyMembers.some((member) =>
            targetIdentity.keyMembers.includes(member))).toBe(true);

        const manager = new PhysicalResourceLockManager({ lockRoot });
        const first = await manager.acquire(target);
        expect(first).not.toBeNull();
        expect(await manager.acquire(symlink)).toBeNull();
        expect(await manager.acquire(hardlink)).toBeNull();
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toHaveLength(2);
        await first?.release();
    });

    it('stores only hashed private names and rolls back a partial acquisition', async () => {
        const hardlink = path.join(directory, 'another-secret-name.csv');
        fs.linkSync(target, hardlink);
        const identity = identify_physical_resource(hardlink);
        const conflictName = identity.lockMemberNames[1];
        let injected = false;
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            onAcquisitionEvent(event) {
                if (injected || event.type !== 'member-durable' || event.memberCount !== 1) return;
                injected = true;
                fs.writeFileSync(path.join(lockRoot, conflictName), 'injected conflict\n', { mode: 0o600 });
            },
        });

        expect(await manager.acquire(hardlink)).toBeNull();
        const names = fs.readdirSync(lockRoot);
        expect(names.every((name) => /^[0-9a-f]{64}\.lock$/.test(name))).toBe(true);
        expect(names.join(' ')).not.toContain('secret');
        expect(names).toEqual([conflictName]);
        fs.unlinkSync(path.join(lockRoot, conflictName));
    });

    it.each(['write', 'fsync'] as const)(
        'removes a newly-created lock path after an injected %s failure',
        async (failurePoint) => {
            let failed = false;
            const manager = new PhysicalResourceLockManager({
                lockRoot,
                durableFileOperations: {
                    write(descriptor, bytes) {
                        if (!failed && failurePoint === 'write') {
                            failed = true;
                            fs.writeSync(descriptor, Buffer.from(bytes).subarray(0, 1));
                            throw new Error('injected lock write failure');
                        }
                        fs.writeFileSync(descriptor, bytes);
                    },
                    fsync(descriptor) {
                        if (!failed && failurePoint === 'fsync') {
                            failed = true;
                            throw new Error('injected lock fsync failure');
                        }
                        fs.fsyncSync(descriptor);
                    },
                },
            });

            await expect(manager.acquire(target)).rejects.toThrow(`injected lock ${failurePoint} failure`);
            expect(fs.readdirSync(lockRoot)).toEqual([]);
            await expect(manager.acquire(target)).resolves.not.toBeNull();
        },
    );

    it.each(['write', 'fsync'] as const)(
        'removes a newly-created marker path after an injected %s failure',
        (failurePoint) => {
            let failed = false;
            const manager = new PhysicalResourceLockManager({
                lockRoot,
                durableFileOperations: {
                    write(descriptor, bytes) {
                        if (!failed && failurePoint === 'write') {
                            failed = true;
                            fs.writeSync(descriptor, Buffer.from(bytes).subarray(0, 1));
                            throw new Error('injected marker write failure');
                        }
                        fs.writeFileSync(descriptor, bytes);
                    },
                    fsync(descriptor) {
                        if (!failed && failurePoint === 'fsync') {
                            failed = true;
                            throw new Error('injected marker fsync failure');
                        }
                        fs.fsyncSync(descriptor);
                    },
                },
            });

            const attestation = {
                allOtherTableViewerProcessesClosed: true,
                allOtherEditingProductsUpdated: true,
                currentProcessFencedFlushedAndViewOnly: true,
            } as const;
            expect(() => manager.install_activation_marker(attestation))
                .toThrow(`injected marker ${failurePoint} failure`);
            expect(fs.readdirSync(lockRoot)).toEqual([]);
            expect(() => manager.install_activation_marker(attestation)).not.toThrow();
        },
    );

    it('durably extends the lock set for a prepared replacement object', async () => {
        const replacement = path.join(directory, 'replacement.tmp');
        fs.writeFileSync(replacement, 'replacement\n');
        const manager = new PhysicalResourceLockManager({ lockRoot });
        const lock = await manager.acquire(target);
        expect(lock).not.toBeNull();
        const originalKey = lock!.physicalResourceLockKey;

        const extendedKey = await lock!.extendWithObjectIdentity(physical_object_identity(replacement));
        expect(extendedKey).not.toBe(originalKey);
        expect(lock!.physicalResourceLockKey).toBe(extendedKey);
        expect(await lock!.verify()).toBe(true);
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toHaveLength(3);

        await lock!.release();
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toEqual([]);
    });

    it('registers a durable extension member before later root verification fails', async () => {
        const replacement = path.join(directory, 'replacement.tmp');
        fs.writeFileSync(replacement, 'replacement\n');
        let armFailure = false;
        let injected = false;
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            durableFileOperations: {
                write: (descriptor, bytes) => fs.writeFileSync(descriptor, bytes),
                fsync(descriptor) {
                    fs.fsyncSync(descriptor);
                    if (!armFailure || injected) return;
                    injected = true;
                    const original = fs.realpathSync.native;
                    let failed = false;
                    vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate) => {
                        if (!failed && candidate === lockRoot) {
                            failed = true;
                            throw new Error('injected extension root verification failure');
                        }
                        return original(candidate);
                    });
                },
            },
        });
        const lock = await manager.acquire(target);
        armFailure = true;
        await expect(lock!.extendWithObjectIdentity(physical_object_identity(replacement)))
            .rejects.toThrow(/extension root verification/);
        vi.restoreAllMocks();
        expect(await lock!.verify()).toBe(true);
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toHaveLength(2);
        await lock!.release();
    });

    it('fails closed when the target identity drifts after acquisition', async () => {
        const manager = new PhysicalResourceLockManager({ lockRoot });
        const lock = await manager.acquire(target);
        expect(lock).not.toBeNull();
        const displaced = path.join(directory, 'displaced.csv');
        fs.renameSync(target, displaced);
        fs.writeFileSync(target, 'replacement\n');

        expect(await lock!.verify()).toBe(false);
        await expect(lock!.extendWithObjectIdentity(physical_object_identity(displaced)))
            .rejects.toThrow(/not held/);
        await lock!.release();
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toEqual([]);
    });

    it('registers each durable member before a later root verification failure', async () => {
        const original = fs.realpathSync.native;
        let lockRootInspections = 0;
        vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate) => {
            if (candidate === lockRoot) {
                lockRootInspections += 1;
                if (lockRootInspections === 3) throw new Error('injected root verification failure');
            }
            return original(candidate);
        });
        const manager = new PhysicalResourceLockManager({ lockRoot });
        await expect(manager.acquire(target)).rejects.toThrow(/root verification/);
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toEqual([]);
    });

    it('rolls back if the target identity changes after the lock tokens become durable', async () => {
        let changed = false;
        const displaced = path.join(directory, 'displaced.csv');
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            onAcquisitionEvent(event) {
                if (changed || event.type !== 'member-durable'
                    || event.memberCount !== event.totalMembers) return;
                changed = true;
                fs.renameSync(target, displaced);
                fs.writeFileSync(target, 'replacement\n');
            },
        });

        await expect(manager.acquire(target)).rejects.toThrow(/identity changed/);
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toEqual([]);
    });

    it('releases only exact tokens and never steals by age or PID', async () => {
        const manager = new PhysicalResourceLockManager({ lockRoot });
        const lock = await manager.acquire(target);
        expect(lock).not.toBeNull();
        const member = path.join(lockRoot, fs.readdirSync(lockRoot)[0]);
        const replacementToken = 'f'.repeat(64);
        const metadata = JSON.parse(fs.readFileSync(member, 'utf8'));
        fs.writeFileSync(member, `${JSON.stringify({
            ...metadata,
            hostLockId: replacementToken,
        })}\n`);
        await lock?.release();
        expect(fs.existsSync(member)).toBe(true);
        expect(() => manager.recover_attested_stale_lock(replacementToken, {
            allTableViewerProcessesClosed: false as true,
        })).toThrow(/attestation/);
        expect(manager.recover_attested_stale_lock(replacementToken, {
            allTableViewerProcessesClosed: true,
        })).toBe(1);
        expect(fs.existsSync(member)).toBe(false);
    });

    it('flushes temporary release-link mutations even when the token is wrong', async () => {
        let directoryFsyncs = 0;
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            durableDirectoryOperations: {
                fsync(descriptor) {
                    directoryFsyncs += 1;
                    fs.fsyncSync(descriptor);
                },
            },
        });
        const lock = await manager.acquire(target);
        directoryFsyncs = 0;
        expect(manager.recover_attested_stale_lock('f'.repeat(64), {
            allTableViewerProcessesClosed: true,
        })).toBe(0);
        expect(directoryFsyncs).toBeGreaterThan(0);
        await lock!.release();
    });

    it('retries the directory durability barrier after a release fsync failure', async () => {
        let failReleaseFlush = false;
        let failed = false;
        let retryFlushes = 0;
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            durableDirectoryOperations: {
                fsync(descriptor) {
                    if (failReleaseFlush && !failed) {
                        failed = true;
                        throw new Error('injected release directory fsync');
                    }
                    if (failed) retryFlushes += 1;
                    fs.fsyncSync(descriptor);
                },
            },
        });
        const lock = await manager.acquire(target);
        failReleaseFlush = true;
        await expect(lock!.release()).rejects.toThrow(/release directory fsync/);
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock')).length)
            .toBeGreaterThan(0);
        await lock!.release();
        expect(retryFlushes).toBeGreaterThan(0);
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toEqual([]);
    });

    it('binds release authorization metadata to the pinned candidate descriptor', async () => {
        const replacementToken = 'd'.repeat(64);
        let member = '';
        let quarantine = '';
        let authorizedMetadata = '';
        let substituted = false;
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            onReleaseCandidatePinned(candidate) {
                if (candidate !== member || substituted) return;
                substituted = true;
                fs.unlinkSync(quarantine);
                fs.writeFileSync(quarantine, authorizedMetadata, { mode: 0o600 });
            },
        });
        const lock = await manager.acquire(target);
        expect(lock).not.toBeNull();
        const memberName = fs.readdirSync(lockRoot).find((name) => name.endsWith('.lock'))!;
        member = path.join(lockRoot, memberName);
        authorizedMetadata = fs.readFileSync(member, 'utf8');
        const metadata = JSON.parse(authorizedMetadata);
        fs.writeFileSync(member, `${JSON.stringify({
            ...metadata,
            hostLockId: replacementToken,
        })}\n`, { mode: 0o600 });
        quarantine = path.join(lockRoot, `.release-v1-${memberName}-${lock!.hostLockId}`);

        await lock!.release();

        expect(substituted).toBe(true);
        expect(JSON.parse(fs.readFileSync(member, 'utf8')).hostLockId).toBe(replacementToken);
        expect(fs.readFileSync(quarantine, 'utf8')).toBe(authorizedMetadata);
        fs.unlinkSync(quarantine);
        expect(manager.recover_attested_stale_lock(replacementToken, {
            allTableViewerProcessesClosed: true,
        })).toBe(1);
    });

    it('binds release-pin reconciliation to one descriptor and preserves a replacement path', async () => {
        let pin = '';
        let replaced = false;
        const replacement = Buffer.from('replacement release pin');
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            onReleasePinCandidateRead(candidate) {
                if (candidate !== pin || replaced) return;
                replaced = true;
                fs.unlinkSync(candidate);
                fs.writeFileSync(candidate, replacement, { mode: 0o600 });
            },
        });
        const lock = await manager.acquire(target);
        expect(lock).not.toBeNull();
        const memberName = fs.readdirSync(lockRoot).find((name) => name.endsWith('.lock'))!;
        const member = path.join(lockRoot, memberName);
        pin = path.join(lockRoot, `.release-v1-${memberName}-${lock!.hostLockId}`);
        fs.linkSync(member, pin);

        expect(() => manager.discover_attested_stale_locks({
            allTableViewerProcessesClosed: true,
        })).toThrow(/release pin changed/);

        expect(replaced).toBe(true);
        expect(fs.readFileSync(pin)).toEqual(replacement);
        expect(JSON.parse(fs.readFileSync(member, 'utf8')).hostLockId).toBe(lock!.hostLockId);
    });

    it('never unlinks a replacement owner after exact-token release has pinned the old member', async () => {
        const replacementToken = 'e'.repeat(64);
        let member = '';
        let oldMetadata: any;
        let replaced = false;
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            onReleaseCandidatePinned(candidate) {
                if (replaced || candidate !== member) return;
                replaced = true;
                fs.unlinkSync(member);
                fs.writeFileSync(member, `${JSON.stringify({
                    ...oldMetadata,
                    hostLockId: replacementToken,
                })}\n`, { mode: 0o600 });
            },
        });
        const lock = await manager.acquire(target);
        expect(lock).not.toBeNull();
        const memberName = fs.readdirSync(lockRoot).find((name) => name.endsWith('.lock'))!;
        member = path.join(lockRoot, memberName);
        oldMetadata = JSON.parse(fs.readFileSync(member, 'utf8'));

        await lock!.release();
        expect(JSON.parse(fs.readFileSync(member, 'utf8')).hostLockId).toBe(replacementToken);
        expect(manager.recover_attested_stale_lock(replacementToken, {
            allTableViewerProcessesClosed: true,
        })).toBe(1);
    });

    it('rejects every pending event waiter when a worker exits', async () => {
        const workerPath = path.join(directory, 'physical-resource-lock-worker.cjs');
        await build({
            entryPoints: [path.resolve(__dirname, 'fixtures/physical-resource-lock-worker.ts')],
            outfile: workerPath,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node26',
            logLevel: 'silent',
        });
        const worker = await spawn_physical_lock_worker(workerPath, target, lockRoot);
        const waiterFailures = [
            worker.waitForEvent('never-first').then(() => null, (error: unknown) => error),
            worker.waitForEvent('never-second').then(() => null, (error: unknown) => error),
        ];

        await worker.crash();

        const errors = await Promise.all(waiterFailures);
        expect(errors).toHaveLength(2);
        for (const error of errors) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toMatch(/worker exited/);
        }
    });

    it('allows exactly one simultaneous multi-member owner without loser residue', async () => {
        const aliases = [
            path.join(directory, 'simultaneous-first.csv'),
            path.join(directory, 'simultaneous-second.csv'),
        ];
        for (const alias of aliases) fs.linkSync(target, alias);

        const workerPath = path.join(directory, 'physical-resource-lock-worker.cjs');
        await build({
            entryPoints: [path.resolve(__dirname, 'fixtures/physical-resource-lock-worker.ts')],
            outfile: workerPath,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node26',
            logLevel: 'silent',
        });
        const first = await spawn_physical_lock_worker(workerPath, aliases[0], lockRoot);
        const second = await spawn_physical_lock_worker(workerPath, aliases[1], lockRoot);
        try {
            const results = await Promise.all([
                first.request<{ hostLockId: string } | null>('acquire'),
                second.request<{ hostLockId: string } | null>('acquire'),
            ]);
            expect(results.filter((result) => result !== null)).toHaveLength(1);
            expect(results.filter((result) => result === null)).toHaveLength(1);
            const owner = results[0] ? first : second;
            const loser = results[0] ? second : first;
            const ownerToken = (results[0] ?? results[1])!.hostLockId;
            const lockFiles = fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'));
            expect(lockFiles).toHaveLength(2);
            expect(lockFiles.map((name) =>
                JSON.parse(fs.readFileSync(path.join(lockRoot, name), 'utf8')).hostLockId))
                .toEqual([ownerToken, ownerToken]);
            await expect(loser.request('acquire')).resolves.toBeNull();
            await owner.request('release');
            expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toEqual([]);
        } finally {
            await first.close();
            await second.close();
        }
    }, 15_000);

    it.each(['pinned', 'unlinked'] as const)(
        'does not reconcile a live release pin during ordinary acquisition at the %s cut',
        async (phase) => {
            const workerPath = path.join(directory, 'physical-resource-lock-worker.cjs');
            await build({
                entryPoints: [path.resolve(__dirname, 'fixtures/physical-resource-lock-worker.ts')],
                outfile: workerPath,
                bundle: true,
                platform: 'node',
                format: 'cjs',
                target: 'node26',
                logLevel: 'silent',
            });
            const owner = await spawn_physical_lock_worker(workerPath, target, lockRoot);
            const contender = await spawn_physical_lock_worker(workerPath, target, lockRoot);
            let resumed = false;
            try {
                const releaseRequest = owner.request('release-pause', { phase }).then(
                    () => undefined,
                    (error: unknown) => error,
                );
                await owner.waitForEvent('release-will-pause');
                await owner.waitForEvent('release-paused');
                await expect(contender.request('acquire')).resolves.toBeNull();
                owner.child.kill('SIGCONT');
                resumed = true;
                const releaseError = await releaseRequest;
                if (releaseError) throw releaseError;
                await expect(contender.request('acquire')).resolves.toMatchObject({
                    hostLockId: expect.stringMatching(/^[0-9a-f]{64}$/),
                });
                await contender.request('release');
            } finally {
                if (!resumed) owner.child.kill('SIGCONT');
                await owner.close();
                await contender.close();
            }
        },
        15_000,
    );

    it('leaves no alias residue when the shared object member has only a live release pin', async () => {
        const workerPath = path.join(directory, 'physical-resource-lock-worker.cjs');
        await build({
            entryPoints: [path.resolve(__dirname, 'fixtures/physical-resource-lock-worker.ts')],
            outfile: workerPath,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node26',
            logLevel: 'silent',
        });
        const alias = path.join(directory, 'live-release-alias.csv');
        fs.linkSync(target, alias);
        const ownerIdentity = identify_physical_resource(target);
        const aliasIdentity = identify_physical_resource(alias);
        const sharedMember = aliasIdentity.lockMemberNames.find((name) =>
            ownerIdentity.lockMemberNames.includes(name))!;
        const aliasMember = aliasIdentity.lockMemberNames.find((name) => name !== sharedMember)!;
        const owner = await spawn_physical_lock_worker(workerPath, target, lockRoot);
        const contender = await spawn_physical_lock_worker(workerPath, alias, lockRoot);
        let resumed = false;
        try {
            const releaseRequest = owner.request('release-pause', {
                phase: 'unlinked',
                memberName: sharedMember,
            }).then(() => undefined, (error: unknown) => error);
            await owner.waitForEvent('release-will-pause');
            await owner.waitForEvent('release-paused');
            expect(fs.existsSync(path.join(lockRoot, sharedMember))).toBe(false);
            expect(fs.readdirSync(lockRoot).some((name) =>
                name.startsWith(`.release-v1-${sharedMember}-`))).toBe(true);
            await expect(contender.request('acquire')).resolves.toBeNull();
            expect(fs.existsSync(path.join(lockRoot, aliasMember))).toBe(false);
            owner.child.kill('SIGCONT');
            resumed = true;
            const releaseError = await releaseRequest;
            if (releaseError) throw releaseError;
            await expect(contender.request('acquire')).resolves.toMatchObject({
                hostLockId: expect.stringMatching(/^[0-9a-f]{64}$/),
            });
            await contender.request('release');
        } finally {
            if (!resumed) owner.child.kill('SIGCONT');
            await owner.close();
            await contender.close();
        }
    }, 15_000);

    it('reconciles a release pin left by process death before reservation attestation', async () => {
        const workerPath = path.join(directory, 'physical-resource-lock-worker.cjs');
        await build({
            entryPoints: [path.resolve(__dirname, 'fixtures/physical-resource-lock-worker.ts')],
            outfile: workerPath,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node26',
            logLevel: 'silent',
        });
        const worker = await spawn_physical_lock_worker(workerPath, target, lockRoot);
        const requestFailure = worker.request('release-crash')
            .then(() => null, (error: unknown) => error);
        const binding = await worker.waitForEvent<{
            hostLockId: string;
            physicalResourceLockKey: string;
        }>('release-will-crash');
        expect(await requestFailure).toBeInstanceOf(Error);
        expect(fs.readdirSync(lockRoot).some((name) => name.startsWith('.release-v1-'))).toBe(true);
        const restarted = new PhysicalResourceLockManager({ lockRoot });
        const reconstructed = restarted.attest_reservation_lock(target, binding);
        expect(reconstructed).not.toBeNull();
        expect(fs.readdirSync(lockRoot).some((name) => name.startsWith('.release-v1-'))).toBe(false);
        await reconstructed!.release();
    }, 15_000);

    it('reopens a prepared bundle and reconstructs its exact lock after process death', async () => {
        const workerPath = path.join(directory, 'physical-resource-lock-worker.cjs');
        await build({
            entryPoints: [path.resolve(__dirname, 'fixtures/physical-resource-lock-worker.ts')],
            outfile: workerPath,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node26',
            logLevel: 'silent',
        });
        const worker = await spawn_physical_lock_worker(workerPath, target, lockRoot);
        const requestFailure = worker.request('prepare-crash', {
            expected: Buffer.from('a,b\n1,2\n').toString('base64'),
            intended: Buffer.from('a,b\n3,4\n').toString('base64'),
        }).then(() => null, (error: unknown) => error);
        const prepared = await worker.waitForEvent<{
            directory: string;
            preparedInstallId: string;
            hostLockId: string;
            physicalResourceLockKey: string;
        }>('prepared-before-crash');
        expect(await requestFailure).toBeInstanceOf(Error);

        const restarted = new PhysicalResourceLockManager({ lockRoot });
        const lock = restarted.attest_reservation_lock(target, prepared);
        expect(lock).not.toBeNull();
        const bundle = reopen_prepared_physical_install({
            targetPath: target,
            directory: prepared.directory,
            hostLock: lock!,
        });
        expect(bundle.preparedInstallId).toBe(prepared.preparedInstallId);
        expect(await bundle.verify()).toBe(true);
        await bundle.cleanup();
        await lock!.release();
        expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toEqual([]);
    }, 15_000);

    it.each(['claim', 'quarantined'] as const)(
        'retains prepared cleanup evidence after process death at the durable %s cut',
        async (crashAt) => {
            const workerPath = path.join(directory, 'physical-resource-lock-worker.cjs');
            await build({
                entryPoints: [path.resolve(__dirname, 'fixtures/physical-resource-lock-worker.ts')],
                outfile: workerPath,
                bundle: true,
                platform: 'node',
                format: 'cjs',
                target: 'node26',
                logLevel: 'silent',
            });
            const worker = await spawn_physical_lock_worker(workerPath, target, lockRoot);
            const requestFailure = worker.request('cleanup-crash', {
                crashAt,
                expected: Buffer.from('a,b\n1,2\n').toString('base64'),
                intended: Buffer.from('a,b\n3,4\n').toString('base64'),
            }).then(() => null, (error: unknown) => error);
            const cleanup = await worker.waitForEvent<{
                directory: string;
                binding: Parameters<typeof resume_prepared_physical_install_cleanup>[0]['binding'];
            }>('cleanup-will-crash');
            expect(await requestFailure).toBeInstanceOf(Error);
            const quarantine = path.join(
                path.dirname(cleanup.directory),
                `.table-viewer-prepared-cleanup-${cleanup.binding.preparedInstallId}`,
            );
            const evidence = path.join(quarantine, path.basename(cleanup.directory));
            expect(fs.existsSync(quarantine)).toBe(true);
            expect(fs.existsSync(cleanup.directory)).toBe(crashAt === 'claim');
            expect(fs.existsSync(evidence)).toBe(crashAt === 'quarantined');
            const resumeOptions = {
                targetPath: target,
                directory: cleanup.directory,
                binding: cleanup.binding,
            };
            expect(resume_prepared_physical_install_cleanup(resumeOptions))
                .toBe(crashAt === 'claim' ? 'notStarted' : 'pending');
            expect(fs.existsSync(crashAt === 'claim' ? cleanup.directory : evidence)).toBe(true);
            if (crashAt === 'claim') {
                fs.rmSync(cleanup.directory, { recursive: true });
                fs.rmdirSync(quarantine);
                expect(resume_prepared_physical_install_cleanup(resumeOptions)).toBe('missing');
                expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock')))
                    .toHaveLength(3);
            }
            const restarted = new PhysicalResourceLockManager({ lockRoot });
            expect(restarted.recover_attested_stale_lock(cleanup.binding.hostLockId, {
                allTableViewerProcessesClosed: true,
            })).toBe(3);
        },
        15_000,
    );

    it.each(['partial', 'full'] as const)(
        'discovers and recovers an attested %s pre-return crash without knowing the token',
        async (crashAt) => {
            const workerPath = path.join(directory, 'physical-resource-lock-worker.cjs');
            await build({
                entryPoints: [path.resolve(__dirname, 'fixtures/physical-resource-lock-worker.ts')],
                outfile: workerPath,
                bundle: true,
                platform: 'node',
                format: 'cjs',
                target: 'node26',
                logLevel: 'silent',
            });
            const worker = await spawn_physical_lock_worker(workerPath, target, lockRoot);
            await expect(worker.request('acquire-crash', { crashAt })).rejects.toThrow(/exited/);

            const manager = new PhysicalResourceLockManager({ lockRoot });
            const attestation = { allTableViewerProcessesClosed: true } as const;
            const discovered = manager.discover_attested_stale_locks(attestation);
            expect(discovered).toHaveLength(1);
            expect(discovered[0]).toMatchObject({ state: crashAt === 'partial' ? 'partial' : 'complete' });
            expect(discovered[0].hostLockId).toMatch(/^[0-9a-f]{64}$/);
            expect(discovered[0].presentMemberNames).toHaveLength(crashAt === 'partial' ? 1 : 2);
            expect(manager.recover_attested_stale_locks(attestation))
                .toBe(crashAt === 'partial' ? 1 : 2);
            expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toEqual([]);
            const reacquired = await manager.acquire(target);
            expect(reacquired).not.toBeNull();
            await reacquired!.release();
        },
        15_000,
    );

    it('enforces host-wide exclusion and exact stale recovery across real processes', async () => {
        const workerPath = path.join(directory, 'physical-resource-lock-worker.cjs');
        await build({
            entryPoints: [path.resolve(__dirname, 'fixtures/physical-resource-lock-worker.ts')],
            outfile: workerPath,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node26',
            logLevel: 'silent',
        });
        const owner = await spawn_physical_lock_worker(workerPath, target, lockRoot);
        const contender = await spawn_physical_lock_worker(workerPath, target, lockRoot);
        try {
            const acquired = await owner.request<{
                hostLockId: string;
                physicalResourceLockKey: string;
            }>('acquire');
            expect(acquired.hostLockId).toMatch(/^[0-9a-f]{64}$/);
            await expect(contender.request('acquire')).resolves.toBeNull();

            await owner.crash();
            await expect(contender.request('acquire')).resolves.toBeNull();
            const wrongToken = acquired.hostLockId === 'f'.repeat(64)
                ? '0'.repeat(64)
                : 'f'.repeat(64);
            await expect(contender.request('recover', { hostLockId: wrongToken })).resolves.toBe(0);
            await expect(contender.request('acquire')).resolves.toBeNull();
            await expect(contender.request('recover', { hostLockId: acquired.hostLockId }))
                .resolves.toBe(2);
            await expect(contender.request('acquire')).resolves.toMatchObject({
                hostLockId: expect.stringMatching(/^[0-9a-f]{64}$/),
                physicalResourceLockKey: acquired.physicalResourceLockKey,
            });
            await contender.request('release');
            expect(fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))).toEqual([]);
        } finally {
            await owner.crash();
            await contender.close();
        }
    }, 15_000);

    it('fails closed on inconsistent discovery metadata without deleting evidence', async () => {
        const manager = new PhysicalResourceLockManager({ lockRoot });
        const lock = await manager.acquire(target);
        expect(lock).not.toBeNull();
        const memberName = fs.readdirSync(lockRoot).find((name) => name.endsWith('.lock'))!;
        const memberPath = path.join(lockRoot, memberName);
        const metadata = JSON.parse(fs.readFileSync(memberPath, 'utf8'));
        fs.writeFileSync(memberPath, `${JSON.stringify({
            ...metadata,
            physicalResourceLockKey: 'f'.repeat(64),
        })}\n`);
        const attestation = { allTableViewerProcessesClosed: true } as const;

        expect(() => manager.discover_attested_stale_locks(attestation)).toThrow(/metadata set/);
        expect(() => manager.recover_attested_stale_locks(attestation)).toThrow(/metadata set/);
        expect(fs.existsSync(memberPath)).toBe(true);
    });

    it('inspects an absent marker without creating the coordination root', () => {
        const absentRoot = path.join(directory, 'absent', 'physical-locks');
        const manager = new PhysicalResourceLockManager({ lockRoot: absentRoot });

        expect(manager.inspect_activation_marker()).toEqual({ status: 'missing' });
        expect(fs.existsSync(absentRoot)).toBe(false);
    });

    it('fails closed on malformed or unverifiable existing marker state', () => {
        fs.mkdirSync(lockRoot, { mode: 0o700 });
        const manager = new PhysicalResourceLockManager({ lockRoot });
        const markerPath = path.join(lockRoot, 'physical-edit-protocol.v1');

        fs.writeFileSync(markerPath, 'not json\n', { mode: 0o600 });
        expect(manager.inspect_activation_marker()).toEqual({ status: 'invalid' });

        fs.unlinkSync(markerPath);
        fs.mkdirSync(markerPath, { mode: 0o700 });
        expect(manager.inspect_activation_marker()).toEqual({ status: 'invalid' });
    });

    it('fails closed when the marker is replaced during inspection', () => {
        const markerPath = path.join(lockRoot, 'physical-edit-protocol.v1');
        let markerBytes = Buffer.alloc(0);
        let replaceMarker = false;
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            onActivationMarkerCandidateRead() {
                if (!replaceMarker) return;
                fs.unlinkSync(markerPath);
                fs.writeFileSync(markerPath, markerBytes, { mode: 0o600 });
            },
        });
        const attestation = {
            allOtherTableViewerProcessesClosed: true,
            allOtherEditingProductsUpdated: true,
            currentProcessFencedFlushedAndViewOnly: true,
        } as const;
        manager.install_activation_marker(attestation);
        markerBytes = fs.readFileSync(markerPath);
        replaceMarker = true;

        expect(manager.inspect_activation_marker()).toEqual({ status: 'invalid' });
    });

    it('fails closed when an existing marker root filesystem is unverifiable', () => {
        fs.mkdirSync(lockRoot, { mode: 0o700 });
        const manager = new PhysicalResourceLockManager({
            lockRoot,
            filesystemType: () => 0x12345678n,
        });

        expect(manager.inspect_activation_marker()).toEqual({ status: 'invalid' });
    });

    it('requires current-process and other-product attestation and installs idempotently', () => {
        const manager = new PhysicalResourceLockManager({ lockRoot });
        expect(() => manager.install_activation_marker({
            allOtherTableViewerProcessesClosed: true,
            allOtherEditingProductsUpdated: false as true,
            currentProcessFencedFlushedAndViewOnly: true,
        })).toThrow(/attestation/);
        expect(manager.inspect_activation_marker()).toEqual({ status: 'missing' });
        const attestation = {
            allOtherTableViewerProcessesClosed: true,
            allOtherEditingProductsUpdated: true,
            currentProcessFencedFlushedAndViewOnly: true,
        } as const;
        manager.install_activation_marker(attestation);
        manager.install_activation_marker(attestation);
        expect(manager.inspect_activation_marker()).toEqual({ status: 'active', version: 1 });
    });
});
