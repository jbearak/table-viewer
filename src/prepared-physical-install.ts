import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { PreparedPhysicalInstall, ReservedPhysicalWriteIo } from './state';
import {
    assert_proven_local_filesystem,
    type HostPhysicalResourceLock,
} from './physical-resource-lock';

const BUNDLE_VERSION = 1 as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BACKUP_FILE = 'expected-original.bin';
const INTENDED_FILE = 'intended.bin';
const MANIFEST_FILE = 'manifest.v1.json';

export type PreparedInstallEvent =
    | 'bundle-directory-durable'
    | 'backup-durable'
    | 'intended-durable'
    | 'lock-set-extended'
    | 'manifest-durable'
    | 'bundle-complete'
    | 'bundle-cleanup-claim-durable'
    | 'bundle-cleanup-quarantined';

export interface PhysicalFileIdentity {
    readonly device: string;
    readonly inode: string;
    readonly size: number;
}

interface PreparedManifest {
    readonly version: 1;
    readonly preparedInstallId: string;
    readonly hostLockId: string;
    readonly previousPhysicalResourceLockKey: string;
    readonly physicalResourceLockKey: string;
    readonly expectedLength: number;
    readonly expectedPhysicalDigest: string;
    readonly expectedObjectIdentity: PhysicalFileIdentity;
    readonly intendedLength: number;
    readonly intendedPhysicalDigest: string;
    readonly intendedObjectIdentity: PhysicalFileIdentity;
}

export interface PreparedPhysicalInstallBundle extends PreparedPhysicalInstall {
    readonly expectedPhysicalDigest: string;
    readonly directory: string;
    verify(): Promise<boolean>;
    inspectTarget(): Promise<'expected' | 'intended' | 'other'>;
    createReservedIo(installer?: PlatformConditionalInstaller): ReservedPhysicalWriteIo;
    /** Cleanup is allowed only after the caller has proven the committed authority. */
    cleanup(): Promise<'pending'>;
}

export interface ConditionalInstallContract {
    readonly expectedTarget: {
        readonly physicalDigest: string;
        readonly length: number;
        readonly objectIdentity: PhysicalFileIdentity;
    };
    readonly source: {
        readonly path: string;
        readonly physicalDigest: string;
        readonly length: number;
        readonly objectIdentity: PhysicalFileIdentity;
    };
}

export interface ConditionalInstallFence {
    /** Installs the exact source object pinned by the acquisition contract. */
    install(): Promise<{ readonly displacedPhysicalDigest: string }>;
    verifyInstalledDurable(bundle: PreparedPhysicalInstallBundle): Promise<boolean>;
    release(): Promise<void>;
}

/** Implementations must atomically enforce the target and source contract, never precheck+rename. */
export interface PlatformConditionalInstaller {
    readonly platformEnforced: true;
    acquire(
        targetPath: string,
        expectedPhysicalDigest: string,
        contract: ConditionalInstallContract,
    ): Promise<{ readonly type: 'acquired'; readonly fence: ConditionalInstallFence }
        | { readonly type: 'conflict' }
        | { readonly type: 'unsupported' }>;
}

export interface PreparedInstallDurableOperations {
    write(descriptor: number, bytes: Uint8Array): number;
    fsyncFile(descriptor: number): void;
    fsyncDirectory(descriptor: number): void;
}

export interface PreparePhysicalInstallOptions {
    readonly targetPath: string;
    readonly expectedOriginal: Uint8Array;
    readonly intended: Uint8Array;
    readonly hostLock: HostPhysicalResourceLock;
    readonly randomBytes?: (size: number) => Buffer;
    readonly onEvent?: (event: PreparedInstallEvent) => void;
    readonly durableOperations?: PreparedInstallDurableOperations;
}

export interface ReopenPreparedPhysicalInstallOptions {
    readonly targetPath: string;
    readonly directory: string;
    readonly hostLock: HostPhysicalResourceLock;
    readonly durableOperations?: PreparedInstallDurableOperations;
}

export interface ResumePreparedPhysicalInstallCleanupOptions {
    readonly targetPath: string;
    readonly directory: string;
    readonly binding: PreparedPhysicalInstall;
    readonly durableOperations?: PreparedInstallDurableOperations;
}

export type PreparedPhysicalInstallInspection =
    | ({ readonly type: 'valid' } & PreparedManifest)
    | { readonly type: 'missing' | 'incomplete' | 'tampered' };

export type PreparedPhysicalInstallReconciliation =
    | { readonly type: 'targetExpected'; readonly bundle: PreparedPhysicalInstallInspection & { readonly type: 'valid' } }
    | { readonly type: 'targetIntended'; readonly bundle: PreparedPhysicalInstallInspection & { readonly type: 'valid' } }
    | { readonly type: 'recoveryRequired'; readonly reason: 'bundleMissing' | 'bundleIncomplete' | 'bundleTampered' | 'targetOther' };

function digest(bytes: Uint8Array): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

const default_durable_operations: PreparedInstallDurableOperations = {
    write(descriptor, bytes) {
        return fs.writeSync(descriptor, bytes, 0, bytes.byteLength);
    },
    fsyncFile(descriptor) {
        fs.fsyncSync(descriptor);
    },
    fsyncDirectory(descriptor) {
        fs.fsyncSync(descriptor);
    },
};

function platform_has_proven_directory_flush(): boolean {
    return process.platform === 'darwin' || process.platform === 'linux';
}

function flush_directory(
    directory: string,
    operations: PreparedInstallDurableOperations = default_durable_operations,
): void {
    if (!platform_has_proven_directory_flush()) {
        throw new Error('Durable directory flush is not proven on this platform');
    }
    const noFollow = fs.constants.O_NOFOLLOW;
    const directoryOnly = fs.constants.O_DIRECTORY;
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | noFollow | directoryOnly);
    try {
        operations.fsyncDirectory(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function write_durable(
    filePath: string,
    bytes: Uint8Array,
    operations: PreparedInstallDurableOperations,
): void {
    const descriptor = fs.openSync(filePath, 'wx', PRIVATE_FILE_MODE);
    try {
        const written = operations.write(descriptor, bytes);
        if (written !== bytes.byteLength) {
            throw Object.assign(new Error('Prepared install durable write was short'), { code: 'EIO' });
        }
        operations.fsyncFile(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function capture_file_identity(stat: fs.BigIntStats, requireSingleLink: boolean): PhysicalFileIdentity {
    if (!stat.isFile() || stat.isSymbolicLink() || (requireSingleLink && stat.nlink !== 1n) || stat.ino === 0n
        || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Prepared install object identity is not stable');
    }
    return Object.freeze({
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        size: Number(stat.size),
    });
}

function same_file_identity(left: PhysicalFileIdentity, right: PhysicalFileIdentity): boolean {
    return left.device === right.device && left.inode === right.inode && left.size === right.size;
}

function valid_file_identity(value: unknown): value is PhysicalFileIdentity {
    if (!value || typeof value !== 'object') return false;
    const identity = value as Partial<PhysicalFileIdentity>;
    return typeof identity.device === 'string' && /^\d+$/.test(identity.device)
        && typeof identity.inode === 'string' && /^[1-9]\d*$/.test(identity.inode)
        && Number.isSafeInteger(identity.size) && (identity.size ?? -1) >= 0;
}

function read_pinned_regular_file(
    filePath: string,
    requirePrivate = true,
    requireSingleLink = true,
): {
    readonly bytes: Buffer;
    readonly identity: PhysicalFileIdentity;
} | null {
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        const identity = capture_file_identity(opened, requireSingleLink);
        if (requirePrivate && process.platform !== 'win32'
            && (Number(opened.mode) & 0o077) !== 0) return null;
        const bytes = fs.readFileSync(descriptor);
        const current = fs.lstatSync(filePath, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink()
            || current.dev !== opened.dev || current.ino !== opened.ino) return null;
        return { bytes, identity };
    } catch {
        return null;
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function verify_directory_identity(directory: string, device: bigint, inode: bigint): boolean {
    try {
        const stat = fs.lstatSync(directory, { bigint: true });
        return stat.isDirectory() && !stat.isSymbolicLink()
            && stat.dev === device && stat.ino === inode;
    } catch {
        return false;
    }
}

function read_manifest(filePath: string): PreparedManifest | null {
    const opened = read_pinned_regular_file(filePath);
    if (!opened || opened.bytes.byteLength > 8192) return null;
    try {
        const value = JSON.parse(opened.bytes.toString('utf8')) as Partial<PreparedManifest>;
        if (value.version !== BUNDLE_VERSION
            || typeof value.preparedInstallId !== 'string'
            || !/^[0-9a-f]{64}$/.test(value.preparedInstallId)
            || typeof value.hostLockId !== 'string' || !/^[0-9a-f]{64}$/.test(value.hostLockId)
            || typeof value.previousPhysicalResourceLockKey !== 'string'
            || !/^[0-9a-f]{64}$/.test(value.previousPhysicalResourceLockKey)
            || typeof value.physicalResourceLockKey !== 'string'
            || !/^[0-9a-f]{64}$/.test(value.physicalResourceLockKey)
            || !Number.isSafeInteger(value.expectedLength) || (value.expectedLength ?? -1) < 0
            || !Number.isSafeInteger(value.intendedLength) || (value.intendedLength ?? -1) < 0
            || typeof value.expectedPhysicalDigest !== 'string'
            || !/^[0-9a-f]{64}$/.test(value.expectedPhysicalDigest)
            || typeof value.intendedPhysicalDigest !== 'string'
            || !/^[0-9a-f]{64}$/.test(value.intendedPhysicalDigest)
            || !valid_file_identity(value.expectedObjectIdentity)
            || !valid_file_identity(value.intendedObjectIdentity)) return null;
        return Object.freeze({
            version: BUNDLE_VERSION,
            preparedInstallId: value.preparedInstallId,
            hostLockId: value.hostLockId,
            previousPhysicalResourceLockKey: value.previousPhysicalResourceLockKey,
            physicalResourceLockKey: value.physicalResourceLockKey,
            expectedLength: value.expectedLength,
            expectedPhysicalDigest: value.expectedPhysicalDigest,
            expectedObjectIdentity: Object.freeze({ ...value.expectedObjectIdentity }),
            intendedLength: value.intendedLength,
            intendedPhysicalDigest: value.intendedPhysicalDigest,
            intendedObjectIdentity: Object.freeze({ ...value.intendedObjectIdentity }),
        }) as PreparedManifest;
    } catch {
        return null;
    }
}

export function inspect_prepared_physical_install(
    directory: string,
    installedTargetPath?: string,
): PreparedPhysicalInstallInspection {
    let directoryStat: fs.BigIntStats;
    try {
        directoryStat = fs.lstatSync(directory, { bigint: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { type: 'missing' };
        return { type: 'tampered' };
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || (process.platform !== 'win32' && (Number(directoryStat.mode) & 0o077) !== 0)) {
        return { type: 'tampered' };
    }
    const manifestPath = path.join(directory, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) return { type: 'incomplete' };
    const manifest = read_manifest(manifestPath);
    if (!manifest || path.basename(directory) !== `.table-viewer-prepared-${manifest.preparedInstallId}`) {
        return { type: 'tampered' };
    }
    const backup = read_pinned_regular_file(path.join(directory, BACKUP_FILE));
    const intended = read_pinned_regular_file(path.join(directory, INTENDED_FILE));
    if (!backup || backup.bytes.length !== manifest.expectedLength
        || digest(backup.bytes) !== manifest.expectedPhysicalDigest) {
        return { type: 'tampered' };
    }
    if (intended) {
        if (intended.bytes.length !== manifest.intendedLength
            || digest(intended.bytes) !== manifest.intendedPhysicalDigest
            || !same_file_identity(intended.identity, manifest.intendedObjectIdentity)) {
            return { type: 'tampered' };
        }
    } else {
        const installed = installedTargetPath
            ? read_pinned_regular_file(installedTargetPath, false, false)
            : null;
        if (!installed || installed.bytes.length !== manifest.intendedLength
            || digest(installed.bytes) !== manifest.intendedPhysicalDigest
            || !same_file_identity(installed.identity, manifest.intendedObjectIdentity)) {
            return { type: 'tampered' };
        }
    }
    return { type: 'valid', ...manifest };
}

export function reconcile_prepared_physical_install(
    targetPath: string,
    directory: string,
): PreparedPhysicalInstallReconciliation {
    const bundle = inspect_prepared_physical_install(directory, targetPath);
    if (bundle.type !== 'valid') {
        return {
            type: 'recoveryRequired',
            reason: bundle.type === 'missing'
                ? 'bundleMissing'
                : bundle.type === 'incomplete'
                    ? 'bundleIncomplete'
                    : 'bundleTampered',
        };
    }
    try {
        const targetDigest = digest(fs.readFileSync(targetPath));
        if (targetDigest === bundle.expectedPhysicalDigest) return { type: 'targetExpected', bundle };
        if (targetDigest === bundle.intendedPhysicalDigest) return { type: 'targetIntended', bundle };
    } catch {
        // A missing or unreadable target requires explicit recovery too.
    }
    return { type: 'recoveryRequired', reason: 'targetOther' };
}

function inspection_matches_binding(
    inspection: PreparedPhysicalInstallInspection,
    binding: PreparedPhysicalInstall,
): inspection is PreparedPhysicalInstallInspection & { readonly type: 'valid' } {
    return inspection.type === 'valid'
        && inspection.preparedInstallId === binding.preparedInstallId
        && inspection.hostLockId === binding.hostLockId
        && inspection.previousPhysicalResourceLockKey === binding.previousPhysicalResourceLockKey
        && inspection.physicalResourceLockKey === binding.physicalResourceLockKey
        && inspection.expectedPhysicalDigest === binding.expectedPhysicalDigest
        && inspection.intendedPhysicalDigest === binding.intendedPhysicalDigest;
}

/** Validates cleanup evidence left by process death without path-deleting it. */
export function resume_prepared_physical_install_cleanup(
    options: ResumePreparedPhysicalInstallCleanupOptions,
): 'pending' | 'notStarted' | 'missing' {
    assert_proven_local_filesystem(options.targetPath);
    const parent = path.dirname(options.directory);
    assert_proven_local_filesystem(parent);
    const quarantine = path.join(
        parent,
        `.table-viewer-prepared-cleanup-${options.binding.preparedInstallId}`,
    );
    const quarantinedDirectory = path.join(quarantine, path.basename(options.directory));
    const operations = options.durableOperations ?? default_durable_operations;
    let claim: fs.BigIntStats;
    try {
        claim = fs.lstatSync(quarantine, { bigint: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return fs.existsSync(options.directory) ? 'notStarted' : 'missing';
        }
        throw error;
    }
    if (!claim.isDirectory() || claim.isSymbolicLink()
        || (process.platform !== 'win32' && (Number(claim.mode) & 0o077) !== 0)) {
        throw new Error('Prepared install cleanup quarantine is invalid');
    }
    if (!fs.existsSync(quarantinedDirectory)) {
        return fs.existsSync(options.directory) ? 'notStarted' : 'missing';
    }
    if (!inspection_matches_binding(
        inspect_prepared_physical_install(quarantinedDirectory, options.targetPath),
        options.binding,
    )) {
        throw new Error('Prepared install cleanup evidence does not match its reservation');
    }
    if (!verify_directory_identity(quarantine, claim.dev, claim.ino)) {
        throw new Error('Prepared install cleanup quarantine identity changed');
    }
    flush_directory(quarantine, operations);
    if (!verify_directory_identity(quarantine, claim.dev, claim.ino)) {
        throw new Error('Prepared install cleanup quarantine identity changed');
    }
    flush_directory(parent, operations);
    if (!verify_directory_identity(quarantine, claim.dev, claim.ino)
        || !inspection_matches_binding(
            inspect_prepared_physical_install(quarantinedDirectory, options.targetPath),
            options.binding,
        )) {
        throw new Error('Prepared install cleanup evidence changed during durability retry');
    }
    return 'pending';
}

function build_bundle(options: {
    readonly targetPath: string;
    readonly directory: string;
    readonly identity: fs.BigIntStats;
    readonly manifest: PreparedManifest;
    readonly hostLock: HostPhysicalResourceLock;
    readonly operations: PreparedInstallDurableOperations;
    readonly onEvent?: (event: PreparedInstallEvent) => void;
}): PreparedPhysicalInstallBundle {
    const {
        targetPath,
        directory,
        identity,
        manifest,
        hostLock,
        operations,
        onEvent,
    } = options;
    const parent = path.dirname(directory);
    const intendedPath = path.join(directory, INTENDED_FILE);
    let cleaned = false;
    let cleanupStarted = false;
    let cleanupClaimDurable = false;
    let cleanupQuarantinedDurable = false;
    let quarantineIdentity: { readonly device: bigint; readonly inode: bigint } | null = null;
    const quarantine = path.join(parent, `.table-viewer-prepared-cleanup-${manifest.preparedInstallId}`);
    const quarantinedDirectory = path.join(quarantine, path.basename(directory));

    const verify = async (): Promise<boolean> => {
        if (cleaned || cleanupStarted || !verify_directory_identity(directory, identity.dev, identity.ino)) {
            return false;
        }
        const inspection = inspect_prepared_physical_install(directory, targetPath);
        return inspection.type === 'valid'
            && inspection.preparedInstallId === manifest.preparedInstallId
            && inspection.hostLockId === manifest.hostLockId
            && inspection.previousPhysicalResourceLockKey
                === manifest.previousPhysicalResourceLockKey
            && inspection.physicalResourceLockKey === manifest.physicalResourceLockKey
            && inspection.expectedLength === manifest.expectedLength
            && inspection.expectedPhysicalDigest === manifest.expectedPhysicalDigest
            && same_file_identity(
                inspection.expectedObjectIdentity,
                manifest.expectedObjectIdentity,
            )
            && inspection.intendedLength === manifest.intendedLength
            && inspection.intendedPhysicalDigest === manifest.intendedPhysicalDigest
            && same_file_identity(
                inspection.intendedObjectIdentity,
                manifest.intendedObjectIdentity,
            );
    };
    const inspectTarget = async (): Promise<'expected' | 'intended' | 'other'> => {
        try {
            const current = digest(fs.readFileSync(targetPath));
            if (current === manifest.expectedPhysicalDigest) return 'expected';
            if (current === manifest.intendedPhysicalDigest) return 'intended';
            return 'other';
        } catch {
            return 'other';
        }
    };

    const bundle: PreparedPhysicalInstallBundle = {
        preparedInstallId: manifest.preparedInstallId,
        intendedPhysicalDigest: manifest.intendedPhysicalDigest,
        expectedPhysicalDigest: manifest.expectedPhysicalDigest,
        hostLockId: manifest.hostLockId,
        previousPhysicalResourceLockKey: manifest.previousPhysicalResourceLockKey,
        physicalResourceLockKey: manifest.physicalResourceLockKey,
        directory,
        verify,
        inspectTarget,
        createReservedIo(installer = unsupported_conditional_installer): ReservedPhysicalWriteIo {
            let activeFence: ConditionalInstallFence | null = null;
            let acquiringFence = false;
            let releasingFence = false;
            let fenceOperation: 'installing' | 'verifying' | null = null;
            const binding = Object.freeze({
                preparedInstallId: manifest.preparedInstallId,
                hostLockId: manifest.hostLockId,
                physicalResourceLockKey: manifest.physicalResourceLockKey,
                expectedPhysicalDigest: manifest.expectedPhysicalDigest,
                intendedPhysicalDigest: manifest.intendedPhysicalDigest,
            });
            return Object.freeze({
                binding,
                verifyHostLock: async () => hostLock.hostLockId === manifest.hostLockId
                    && hostLock.physicalResourceLockKey === manifest.physicalResourceLockKey
                    && hostLock.verify(),
                verifyPreparedBundle: verify,
                inspectTarget,
                async acquireConditionalInstallFence(targetState: 'expected' | 'intended') {
                    if (!installer.platformEnforced) return 'unsupported';
                    if (activeFence || acquiringFence || releasingFence) {
                        throw new Error('Conditional installation fence is already held by this adapter');
                    }
                    const source = read_pinned_regular_file(intendedPath);
                    const currentTarget = read_pinned_regular_file(targetPath, false, false);
                    const expected = targetState === 'expected'
                        ? {
                            physicalDigest: manifest.expectedPhysicalDigest,
                            length: manifest.expectedLength,
                            objectIdentity: manifest.expectedObjectIdentity,
                        }
                        : currentTarget
                            && currentTarget.bytes.length === manifest.intendedLength
                            && digest(currentTarget.bytes) === manifest.intendedPhysicalDigest
                            ? {
                                physicalDigest: manifest.intendedPhysicalDigest,
                                length: manifest.intendedLength,
                                objectIdentity: currentTarget.identity,
                            }
                            : null;
                    if (!expected) throw new Error('Installed target identity changed');
                    const contractSource = targetState === 'expected'
                        ? source && source.bytes.length === manifest.intendedLength
                            && digest(source.bytes) === manifest.intendedPhysicalDigest
                            && same_file_identity(source.identity, manifest.intendedObjectIdentity)
                            ? {
                                path: intendedPath,
                                physicalDigest: manifest.intendedPhysicalDigest,
                                length: manifest.intendedLength,
                                objectIdentity: manifest.intendedObjectIdentity,
                            }
                            : null
                        : {
                            path: targetPath,
                            physicalDigest: manifest.intendedPhysicalDigest,
                            length: manifest.intendedLength,
                            objectIdentity: expected.objectIdentity,
                        };
                    if (!contractSource) throw new Error('Prepared install source identity changed');
                    acquiringFence = true;
                    try {
                        const result = await installer.acquire(targetPath, expected.physicalDigest, Object.freeze({
                            expectedTarget: Object.freeze(expected),
                            source: Object.freeze(contractSource),
                        }));
                        if (result.type === 'acquired') activeFence = result.fence;
                        return result.type;
                    } finally {
                        acquiringFence = false;
                    }
                },
                async installPreparedBundle() {
                    if (!activeFence || releasingFence) {
                        throw new Error('Conditional installation fence is not held');
                    }
                    if (fenceOperation) {
                        throw new Error('Conditional installation fence operation is already in progress');
                    }
                    const source = read_pinned_regular_file(intendedPath);
                    if (!source || digest(source.bytes) !== manifest.intendedPhysicalDigest
                        || !same_file_identity(source.identity, manifest.intendedObjectIdentity)) {
                        throw new Error('Prepared install source identity changed');
                    }
                    fenceOperation = 'installing';
                    try {
                        return await activeFence.install();
                    } finally {
                        fenceOperation = null;
                    }
                },
                async verifyInstalledDurable() {
                    if (!activeFence || releasingFence) return false;
                    if (fenceOperation) {
                        throw new Error('Conditional installation fence operation is already in progress');
                    }
                    fenceOperation = 'verifying';
                    try {
                        return await activeFence.verifyInstalledDurable(bundle);
                    } finally {
                        fenceOperation = null;
                    }
                },
                async releaseConditionalInstallFence() {
                    if (acquiringFence) {
                        throw new Error('Conditional installation fence acquisition is in progress');
                    }
                    if (fenceOperation) {
                        throw new Error('Conditional installation fence operation is in progress');
                    }
                    const fence = activeFence;
                    if (!fence) return;
                    if (releasingFence) {
                        throw new Error('Conditional installation fence release is already in progress');
                    }
                    releasingFence = true;
                    try {
                        await fence.release();
                        if (activeFence === fence) activeFence = null;
                    } finally {
                        releasingFence = false;
                    }
                },
            });
        },
        async cleanup() {
            if (cleaned) return 'pending';
            if (!cleanupStarted) {
                if (!verify_directory_identity(directory, identity.dev, identity.ino)) {
                    throw new Error('Prepared install bundle identity changed');
                }
                fs.mkdirSync(quarantine, { mode: PRIVATE_DIRECTORY_MODE });
                const claim = fs.lstatSync(quarantine, { bigint: true });
                if (!claim.isDirectory() || claim.isSymbolicLink()) {
                    throw new Error('Prepared install cleanup quarantine is invalid');
                }
                quarantineIdentity = { device: claim.dev, inode: claim.ino };
                cleanupStarted = true;
            }
            if (!quarantineIdentity
                || !verify_directory_identity(
                    quarantine,
                    quarantineIdentity.device,
                    quarantineIdentity.inode,
                )) {
                throw new Error('Prepared install cleanup quarantine identity changed');
            }
            if (!cleanupClaimDurable) {
                flush_directory(parent, operations);
                if (!verify_directory_identity(
                    quarantine,
                    quarantineIdentity.device,
                    quarantineIdentity.inode,
                )) {
                    throw new Error('Prepared install cleanup quarantine identity changed');
                }
                cleanupClaimDurable = true;
                onEvent?.('bundle-cleanup-claim-durable');
            }
            if (verify_directory_identity(directory, identity.dev, identity.ino)) {
                if (fs.existsSync(quarantinedDirectory)) {
                    throw new Error('Prepared install cleanup destination already exists');
                }
                fs.renameSync(directory, quarantinedDirectory);
            } else if (fs.existsSync(directory)) {
                throw new Error('Prepared install cleanup bundle identity changed');
            }
            if (!verify_directory_identity(quarantinedDirectory, identity.dev, identity.ino)) {
                throw new Error('Prepared install cleanup bundle identity changed');
            }
            if (!cleanupQuarantinedDurable) {
                flush_directory(quarantine, operations);
                if (!verify_directory_identity(quarantinedDirectory, identity.dev, identity.ino)) {
                    throw new Error('Prepared install cleanup bundle identity changed');
                }
                flush_directory(parent, operations);
                if (!verify_directory_identity(
                    quarantine,
                    quarantineIdentity.device,
                    quarantineIdentity.inode,
                ) || !verify_directory_identity(quarantinedDirectory, identity.dev, identity.ino)) {
                    throw new Error('Prepared install cleanup evidence changed during durability retry');
                }
                cleanupQuarantinedDurable = true;
                onEvent?.('bundle-cleanup-quarantined');
            }
            // Node exposes no descriptor-relative recursive deletion or atomic
            // no-replace directory removal primitive. Keep the exact, durable
            // quarantine as recovery evidence rather than path-delete it.
            return 'pending';
        },
    };
    return Object.freeze(bundle);
}

export async function prepare_physical_install(
    options: PreparePhysicalInstallOptions,
): Promise<PreparedPhysicalInstallBundle> {
    if (!platform_has_proven_directory_flush()) {
        throw new Error('Prepared installs are unsupported without proven directory durability');
    }
    assert_proven_local_filesystem(options.targetPath);
    assert_proven_local_filesystem(path.dirname(options.targetPath));
    if (!await options.hostLock.verify()) throw new Error('Physical resource lock is not held');
    const operations = options.durableOperations ?? default_durable_operations;
    const expected = Buffer.from(options.expectedOriginal);
    const intended = Buffer.from(options.intended);
    const expectedPhysicalDigest = digest(expected);
    const intendedPhysicalDigest = digest(intended);

    const observed = read_pinned_regular_file(options.targetPath, false, false);
    if (!observed || digest(observed.bytes) !== expectedPhysicalDigest) {
        throw new Error('Physical target no longer matches the expected original');
    }

    const preparedInstallId = (options.randomBytes ?? crypto.randomBytes)(32).toString('hex');
    if (!/^[0-9a-f]{64}$/.test(preparedInstallId)) throw new Error('Invalid prepared install token source');
    const previousPhysicalResourceLockKey = options.hostLock.physicalResourceLockKey;
    const parent = path.dirname(options.targetPath);
    const directory = path.join(parent, `.table-viewer-prepared-${preparedInstallId}`);
    fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
    const identity = fs.lstatSync(directory, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw new Error('Prepared install bundle is not a private directory');
    }
    fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
    try {
        flush_directory(parent, operations);
        options.onEvent?.('bundle-directory-durable');
        write_durable(path.join(directory, BACKUP_FILE), expected, operations);
        flush_directory(directory, operations);
        options.onEvent?.('backup-durable');
        const intendedPath = path.join(directory, INTENDED_FILE);
        write_durable(intendedPath, intended, operations);
        flush_directory(directory, operations);
        const intendedOpened = read_pinned_regular_file(intendedPath);
        if (!intendedOpened || digest(intendedOpened.bytes) !== intendedPhysicalDigest) {
            throw new Error('Prepared intended object could not be pinned');
        }
        options.onEvent?.('intended-durable');
        await options.hostLock.extendWithObjectIdentity(intendedOpened.identity);
        const physicalResourceLockKey = options.hostLock.physicalResourceLockKey;
        options.onEvent?.('lock-set-extended');
        const manifest: PreparedManifest = {
            version: BUNDLE_VERSION,
            preparedInstallId,
            hostLockId: options.hostLock.hostLockId,
            previousPhysicalResourceLockKey,
            physicalResourceLockKey,
            expectedLength: expected.length,
            expectedPhysicalDigest,
            expectedObjectIdentity: observed.identity,
            intendedLength: intended.length,
            intendedPhysicalDigest,
            intendedObjectIdentity: intendedOpened.identity,
        };
        write_durable(
            path.join(directory, MANIFEST_FILE),
            Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'),
            operations,
        );
        flush_directory(directory, operations);
        options.onEvent?.('manifest-durable');
        flush_directory(directory, operations);
        options.onEvent?.('bundle-complete');
        if (!await options.hostLock.verify()) {
            throw new Error('Physical resource identity changed during preparation');
        }
        const current = read_pinned_regular_file(options.targetPath, false, false);
        if (!current || digest(current.bytes) !== expectedPhysicalDigest
            || !same_file_identity(current.identity, observed.identity)) {
            throw new Error('Physical target changed during preparation');
        }
        return build_bundle({
            targetPath: options.targetPath,
            directory,
            identity,
            manifest,
            hostLock: options.hostLock,
            operations,
            onEvent: options.onEvent,
        });
    } catch (error) {
        // Preserve every durable partial bundle as restart evidence.
        throw error;
    }
}

export function reopen_prepared_physical_install(
    options: ReopenPreparedPhysicalInstallOptions,
): PreparedPhysicalInstallBundle {
    if (!platform_has_proven_directory_flush()) {
        throw new Error('Prepared installs are unsupported without proven directory durability');
    }
    assert_proven_local_filesystem(options.targetPath);
    assert_proven_local_filesystem(path.dirname(options.directory));
    const inspection = inspect_prepared_physical_install(options.directory, options.targetPath);
    if (inspection.type !== 'valid') {
        throw new Error(`Prepared install bundle is ${inspection.type}`);
    }
    if (options.hostLock.hostLockId !== inspection.hostLockId
        || options.hostLock.physicalResourceLockKey !== inspection.physicalResourceLockKey) {
        throw new Error('Prepared install lock binding does not match');
    }
    const identity = fs.lstatSync(options.directory, { bigint: true });
    return build_bundle({
        targetPath: options.targetPath,
        directory: options.directory,
        identity,
        manifest: inspection,
        hostLock: options.hostLock,
        operations: options.durableOperations ?? default_durable_operations,
    });
}

export const unsupported_conditional_installer: PlatformConditionalInstaller = {
    platformEnforced: true,
    async acquire() {
        return { type: 'unsupported' };
    },
};
