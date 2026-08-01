import * as path from 'path';
import { PhysicalResourceLockManager, type HostPhysicalResourceLock } from '../../physical-resource-lock';
import { prepare_physical_install } from '../../prepared-physical-install';

interface WorkerRequest {
    readonly id: number;
    readonly command: 'acquire' | 'acquire-crash' | 'release-crash' | 'release-pause' | 'prepare-crash' | 'cleanup-crash' | 'recover' | 'release' | 'close';
    readonly payload: any;
}

const configuredTarget = process.env.TABLE_VIEWER_PHYSICAL_LOCK_TARGET;
const configuredLockRoot = process.env.TABLE_VIEWER_PHYSICAL_LOCK_ROOT;
if (!configuredTarget || !configuredLockRoot || !process.send) {
    throw new Error('Physical lock worker requires target, lock root, and IPC.');
}
const target = configuredTarget;
const lockRoot = configuredLockRoot;

const manager = new PhysicalResourceLockManager({ lockRoot });
let held: HostPhysicalResourceLock | null = null;

function send(message: unknown): void {
    process.send!(message);
}

function pause_at_release_cut(): void {
    process.send!({ type: 'release-paused' });
    process.kill(process.pid, 'SIGSTOP');
}

async function handle(request: WorkerRequest): Promise<unknown> {
    switch (request.command) {
        case 'acquire':
            held = await manager.acquire(target);
            return held && {
                hostLockId: held.hostLockId,
                physicalResourceLockKey: held.physicalResourceLockKey,
            };
        case 'acquire-crash': {
            const crashAt = request.payload.crashAt as 'partial' | 'full';
            const crashingManager = new PhysicalResourceLockManager({
                lockRoot,
                onAcquisitionEvent(event) {
                    const shouldCrash = crashAt === 'partial'
                        ? event.type === 'member-durable' && event.memberCount === 1
                        : event.type === 'lock-set-durable';
                    if (shouldCrash) process.kill(process.pid, 'SIGKILL');
                },
            });
            await crashingManager.acquire(target);
            throw new Error('Crash injection did not terminate the worker');
        }
        case 'release-crash': {
            const crashingManager = new PhysicalResourceLockManager({
                lockRoot,
                onReleaseCandidatePinned() {
                    process.kill(process.pid, 'SIGKILL');
                },
            });
            held = await crashingManager.acquire(target);
            if (!held) throw new Error('Expected physical lock for release crash fixture');
            await new Promise<void>((resolve, reject) => {
                process.send!({
                    type: 'release-will-crash',
                    hostLockId: held!.hostLockId,
                    physicalResourceLockKey: held!.physicalResourceLockKey,
                }, (error) => error ? reject(error) : resolve());
            });
            await held.release();
            throw new Error('Release crash injection did not terminate the worker');
        }
        case 'release-pause': {
            const phase = request.payload.phase as 'pinned' | 'unlinked';
            const requestedMemberName = request.payload.memberName as string | undefined;
            let paused = false;
            const pause = (memberPath: string) => {
                if (paused || (requestedMemberName && path.basename(memberPath) !== requestedMemberName)) return;
                paused = true;
                pause_at_release_cut();
            };
            const pausingManager = new PhysicalResourceLockManager({
                lockRoot,
                onReleaseCandidatePinned: phase === 'pinned' ? pause : undefined,
                onReleaseMemberUnlinked: phase === 'unlinked' ? pause : undefined,
            });
            held = await pausingManager.acquire(target);
            if (!held) throw new Error('Expected physical lock for release pause fixture');
            await new Promise<void>((resolve, reject) => {
                process.send!({
                    type: 'release-will-pause',
                    hostLockId: held!.hostLockId,
                    physicalResourceLockKey: held!.physicalResourceLockKey,
                }, (error) => error ? reject(error) : resolve());
            });
            await held.release();
            held = null;
            return null;
        }
        case 'prepare-crash': {
            held = await manager.acquire(target);
            if (!held) throw new Error('Expected physical lock for prepared crash fixture');
            const bundle = await prepare_physical_install({
                targetPath: target,
                expectedOriginal: Buffer.from(request.payload.expected, 'base64'),
                intended: Buffer.from(request.payload.intended, 'base64'),
                hostLock: held,
                randomBytes: () => Buffer.from('cd'.repeat(32), 'hex'),
            });
            await new Promise<void>((resolve, reject) => {
                process.send!({
                    type: 'prepared-before-crash',
                    directory: bundle.directory,
                    preparedInstallId: bundle.preparedInstallId,
                    hostLockId: bundle.hostLockId,
                    physicalResourceLockKey: bundle.physicalResourceLockKey,
                }, (error) => error ? reject(error) : resolve());
            });
            process.kill(process.pid, 'SIGKILL');
            throw new Error('Prepared crash injection did not terminate the worker');
        }
        case 'cleanup-crash': {
            const crashAt = request.payload.crashAt as 'claim' | 'quarantined' | undefined;
            held = await manager.acquire(target);
            if (!held) throw new Error('Expected physical lock for cleanup crash fixture');
            const bundle = await prepare_physical_install({
                targetPath: target,
                expectedOriginal: Buffer.from(request.payload.expected, 'base64'),
                intended: Buffer.from(request.payload.intended, 'base64'),
                hostLock: held,
                randomBytes: () => Buffer.from('de'.repeat(32), 'hex'),
                onEvent(event) {
                    const shouldCrash = crashAt === 'claim'
                        ? event === 'bundle-cleanup-claim-durable'
                        : event === 'bundle-cleanup-quarantined';
                    if (shouldCrash) process.kill(process.pid, 'SIGKILL');
                },
            });
            await new Promise<void>((resolve, reject) => {
                process.send!({
                    type: 'cleanup-will-crash',
                    directory: bundle.directory,
                    binding: {
                        preparedInstallId: bundle.preparedInstallId,
                        hostLockId: bundle.hostLockId,
                        previousPhysicalResourceLockKey: bundle.previousPhysicalResourceLockKey,
                        physicalResourceLockKey: bundle.physicalResourceLockKey,
                        expectedPhysicalDigest: bundle.expectedPhysicalDigest,
                        intendedPhysicalDigest: bundle.intendedPhysicalDigest,
                    },
                }, (error) => error ? reject(error) : resolve());
            });
            await bundle.cleanup();
            throw new Error('Cleanup crash injection did not terminate the worker');
        }
        case 'recover':
            return manager.recover_attested_stale_lock(request.payload.hostLockId, {
                allTableViewerProcessesClosed: true,
            });
        case 'release':
            await held?.release();
            held = null;
            return null;
        case 'close':
            await held?.release();
            held = null;
            return null;
    }
}

process.on('message', (request: WorkerRequest) => {
    void handle(request).then(
        (value) => {
            send({ type: 'result', id: request.id, value });
            if (request.command === 'close') process.disconnect?.();
        },
        (error: unknown) => send({
            type: 'error',
            id: request.id,
            message: error instanceof Error ? error.message : String(error),
        }),
    );
});

send({ type: 'ready', pid: process.pid });
