import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LOCK_FORMAT = 'tableViewer.physicalResourceLock.v1' as const;
const MARKER_FORMAT = 'table-viewer-physical-edit-protocol' as const;
const LOCK_PROTOCOL_VERSION = 1 as const;
const ACTIVATION_MARKER = 'physical-edit-protocol.v1';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_METADATA_BYTES = 1024;

const KNOWN_SHARED_FILESYSTEM_TYPES = new Set<bigint>([
    0x6969n, 0x517bn, 0xff534d42n, 0x65735546n, 0x564c5746n,
]);

const PROVEN_LOCAL_FILESYSTEM_TYPES: Readonly<Record<'darwin' | 'linux', ReadonlySet<bigint>>> = {
    darwin: new Set([
        0x1an, // APFS
    ]),
    linux: new Set([
        0xef53n, // ext2/ext3/ext4
        0x58465342n, // XFS
        0x9123683en, // Btrfs
    ]),
};

function platform_has_proven_directory_flush(platform: NodeJS.Platform): platform is 'darwin' | 'linux' {
    return platform === 'darwin' || platform === 'linux';
}

function classify_filesystem_type(
    platform: 'darwin' | 'linux',
    filesystemType: bigint,
): 'local' | 'shared' | 'unknown' {
    if (KNOWN_SHARED_FILESYSTEM_TYPES.has(filesystemType)) return 'shared';
    return PROVEN_LOCAL_FILESYSTEM_TYPES[platform].has(filesystemType) ? 'local' : 'unknown';
}

type FilesystemTypeInspector = (descriptor: number, canonicalPath: string) => bigint;

interface CapturedFilesystemPath {
    readonly canonicalPath: string;
    readonly stat: fs.BigIntStats;
    readonly filesystemType: bigint;
}

function capture_filesystem_path(
    candidate: string,
    filesystemType?: FilesystemTypeInspector,
): CapturedFilesystemPath {
    const canonicalPath = fs.realpathSync.native(candidate);
    const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
    const descriptor = fs.openSync(canonicalPath, fs.constants.O_RDONLY | noFollow);
    try {
        const stat = fs.fstatSync(descriptor, { bigint: true });
        // Node exposes no fstatfs. Keep the identity descriptor open across
        // classification and reject unless the path still names that inode.
        const type = filesystemType?.(descriptor, canonicalPath)
            ?? fs.statfsSync(canonicalPath, { bigint: true }).type;
        const current = fs.lstatSync(canonicalPath, { bigint: true });
        if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
            throw new Error('Physical filesystem path changed during inspection');
        }
        return { canonicalPath, stat, filesystemType: type };
    } finally {
        fs.closeSync(descriptor);
    }
}

export function assert_proven_local_filesystem(
    candidate: string,
    platform: NodeJS.Platform = process.platform,
    filesystemType?: FilesystemTypeInspector,
): void {
    if (!platform_has_proven_directory_flush(platform)) {
        throw new Error('Physical filesystem platform is unsupported');
    }
    const captured = capture_filesystem_path(candidate, filesystemType);
    if (classify_filesystem_type(platform, captured.filesystemType) !== 'local') {
        throw new Error('Physical filesystem is not proven local');
    }
}

function nearest_existing_ancestor(candidate: string): string {
    let current = path.resolve(candidate);
    while (true) {
        try {
            fs.lstatSync(current);
            return current;
        } catch (error) {
            if (!is_node_error(error) || error.code !== 'ENOENT') throw error;
            const parent = path.dirname(current);
            if (parent === current) throw error;
            current = parent;
        }
    }
}

export type PhysicalEditEligibility =
    | { readonly eligible: true; readonly lockRoot: string }
    | {
        readonly eligible: false;
        readonly reason:
            | 'non-file'
            | 'remote-host'
            | 'shared-mount'
            | 'wsl'
            | 'unsupported-platform'
            | 'unverifiable-filesystem';
      };

export interface PhysicalResourceIdentity {
    readonly canonicalPath: string;
    /** Domain-separated identities, sorted by their deterministic lock filename. */
    readonly keyMembers: readonly string[];
    readonly lockMemberNames: readonly string[];
    readonly physicalResourceLockKey: string;
}

export interface PhysicalObjectIdentity {
    readonly device: string;
    readonly inode: string;
}

export interface HostPhysicalResourceLock {
    readonly hostLockId: string;
    readonly physicalResourceLockKey: string;
    readonly identity: PhysicalResourceIdentity;
    verify(): Promise<boolean>;
    /** Adds an already-pinned replacement object's stable identity under the same token. */
    extendWithObjectIdentity(identity: PhysicalObjectIdentity): Promise<string>;
    /** Deletes only members which still contain this exact opaque token. */
    release(): Promise<void>;
}

export type PhysicalLockAcquisitionEvent =
    | { readonly type: 'member-durable'; readonly memberCount: number; readonly totalMembers: number }
    | { readonly type: 'lock-set-durable'; readonly memberCount: number };

export interface PhysicalLockManagerOptions {
    readonly lockRoot: string;
    readonly platform?: NodeJS.Platform;
    readonly randomBytes?: (size: number) => Buffer;
    readonly durableFileOperations?: {
        write(descriptor: number, bytes: Uint8Array): void;
        fsync(descriptor: number): void;
    };
    readonly durableDirectoryOperations?: {
        fsync(descriptor: number): void;
    };
    /** Test/host crash instrumentation. Called only after the named state is durable. */
    readonly onAcquisitionEvent?: (event: PhysicalLockAcquisitionEvent) => void;
    /** Test/host crash instrumentation after a release candidate is identity-pinned. */
    readonly onReleaseCandidatePinned?: (memberPath: string) => void;
    readonly onReleaseMemberUnlinked?: (memberPath: string) => void;
    /** Test-only race instrumentation after marker bytes are read from a pinned descriptor. */
    readonly onActivationMarkerCandidateRead?: () => void;
    readonly filesystemType?: FilesystemTypeInspector;
    readonly targetFilesystemType?: FilesystemTypeInspector;
}

export type ActivationMarkerInspection =
    | { readonly status: 'missing' }
    | { readonly status: 'active'; readonly version: 1 }
    | { readonly status: 'invalid' };

export interface AllProductsClosedAttestation {
    readonly allTableViewerProcessesClosed: true;
}

export interface PhysicalEditActivationAttestation {
    readonly allOtherTableViewerProcessesClosed: true;
    readonly allOtherEditingProductsUpdated: true;
    readonly currentProcessFencedFlushedAndViewOnly: true;
}

interface LockMetadata {
    readonly format: typeof LOCK_FORMAT;
    readonly version: 1;
    readonly hostLockId: string;
    readonly physicalResourceLockKey: string;
    readonly lockMemberNames: readonly string[];
}

export interface AttestedStalePhysicalLock {
    readonly hostLockId: string;
    readonly physicalResourceLockKey: string;
    readonly expectedMemberNames: readonly string[];
    readonly presentMemberNames: readonly string[];
    readonly state: 'partial' | 'complete';
}

/** Durable reservation fields sufficient to attest, never guess, a crash-left lock set. */
export interface PhysicalLockReservationMetadata {
    readonly hostLockId: string;
    readonly physicalResourceLockKey: string;
}

interface RootIdentity {
    readonly realPath: string;
    readonly device: bigint;
    readonly inode: bigint;
    readonly filesystemType: bigint;
}

function sha256(domain: string, values: readonly string[]): string {
    const digest = crypto.createHash('sha256');
    digest.update(`table-viewer\0${domain}\0v1\0`, 'utf8');
    for (const value of values) {
        const bytes = Buffer.from(value, 'utf8');
        digest.update(`${bytes.length}:`, 'ascii');
        digest.update(bytes);
        digest.update('\0', 'utf8');
    }
    return digest.digest('hex');
}

function stable_json(value: object): Buffer {
    return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function is_node_error(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function assert_private_directory(stat: fs.Stats | fs.BigIntStats): void {
    if (process.platform === 'win32') return;
    if ((Number(stat.mode) & 0o077) !== 0) {
        throw new Error('Physical coordination storage is not private');
    }
    const getuid = process.getuid;
    if (getuid && Number(stat.uid) !== getuid()) {
        throw new Error('Physical coordination storage has the wrong owner');
    }
}

function directory_open_flags(): number {
    const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
    const directoryOnly = process.platform === 'win32' ? 0 : fs.constants.O_DIRECTORY;
    return fs.constants.O_RDONLY | noFollow | directoryOnly;
}

function inspect_private_directory(
    directory: string,
    changedMessage: string,
    filesystemType?: FilesystemTypeInspector,
): RootIdentity {
    const descriptor = fs.openSync(directory, directory_open_flags());
    try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isDirectory()) throw new Error('Physical coordination root is invalid');
        assert_private_directory(opened);
        const realPath = fs.realpathSync.native(directory);
        // Keep the root descriptor open across the path-only statfs API and
        // reject unless the directory entry still names the captured inode.
        const type = filesystemType?.(descriptor, realPath)
            ?? fs.statfsSync(realPath, { bigint: true }).type;
        const current = fs.lstatSync(directory, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink()
            || current.dev !== opened.dev || current.ino !== opened.ino) {
            throw new Error(changedMessage);
        }
        assert_private_directory(current);
        return {
            realPath,
            device: opened.dev,
            inode: opened.ino,
            filesystemType: type,
        };
    } finally {
        fs.closeSync(descriptor);
    }
}

function capture_private_directory(
    directory: string,
    directoryOperations: NonNullable<PhysicalLockManagerOptions['durableDirectoryOperations']>,
    filesystemType?: FilesystemTypeInspector,
): RootIdentity {
    if (!platform_has_proven_directory_flush(process.platform)) {
        throw new Error('Durable coordination directories are not proven on this platform');
    }
    const absolute = path.resolve(directory);
    const missing: string[] = [];
    let existing = absolute;
    while (true) {
        try {
            fs.lstatSync(existing);
            break;
        } catch (error) {
            if (!is_node_error(error) || error.code !== 'ENOENT') throw error;
            missing.push(existing);
            const parent = path.dirname(existing);
            if (parent === existing) throw new Error('Physical coordination root has no durable parent');
            existing = parent;
        }
    }
    for (const component of missing.reverse()) {
        const parent = path.dirname(component);
        let created = false;
        try {
            fs.mkdirSync(component, { mode: PRIVATE_DIRECTORY_MODE });
            created = true;
        } catch (error) {
            if (!is_node_error(error) || error.code !== 'EEXIST') throw error;
        }
        const descriptor = fs.openSync(component, directory_open_flags());
        try {
            const opened = fs.fstatSync(descriptor, { bigint: true });
            if (!opened.isDirectory()) throw new Error('Physical coordination root is invalid');
            assert_private_directory(opened);
            if (created) fs.fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
            directoryOperations.fsync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        flush_directory(parent, directoryOperations);
    }
    const identity = inspect_private_directory(
        directory,
        'Physical coordination root changed during inspection',
        filesystemType,
    );
    if (classify_filesystem_type(process.platform, identity.filesystemType) !== 'local') {
        throw new Error('Physical coordination root filesystem is not proven local');
    }
    return identity;
}

function assert_same_root(directory: string, expected: RootIdentity): void {
    const current = inspect_private_directory(directory, 'Physical coordination root changed');
    if (current.device !== expected.device || current.inode !== expected.inode
        || current.realPath !== expected.realPath) {
        throw new Error('Physical coordination root changed');
    }
}

function flush_directory(
    directory: string,
    operations: NonNullable<PhysicalLockManagerOptions['durableDirectoryOperations']> = {
        fsync: (descriptor) => fs.fsyncSync(descriptor),
    },
): void {
    if (!platform_has_proven_directory_flush(process.platform)) {
        throw new Error('Durable directory flush is not proven on this platform');
    }
    const descriptor = fs.openSync(directory, directory_open_flags());
    try {
        operations.fsync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function remove_exact_created_file(
    filePath: string,
    opened: fs.BigIntStats,
    directoryOperations?: NonNullable<PhysicalLockManagerOptions['durableDirectoryOperations']>,
): void {
    if (!exact_file_still_present(filePath, opened)) return;
    fs.unlinkSync(filePath);
    flush_directory(path.dirname(filePath), directoryOperations);
}

function write_new_durable(
    filePath: string,
    bytes: Uint8Array,
    operations: NonNullable<PhysicalLockManagerOptions['durableFileOperations']>,
    directoryOperations?: NonNullable<PhysicalLockManagerOptions['durableDirectoryOperations']>,
): fs.BigIntStats {
    const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
    const descriptor = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        PRIVATE_FILE_MODE,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    let failure: unknown;
    try {
        operations.write(descriptor, bytes);
        operations.fsync(descriptor);
    } catch (error) {
        failure = error;
    }
    try {
        fs.closeSync(descriptor);
    } catch (error) {
        failure ??= error;
    }
    if (failure !== undefined) {
        try {
            remove_exact_created_file(filePath, opened, directoryOperations);
        } catch (cleanupError) {
            throw new AggregateError(
                [failure, cleanupError],
                'Failed to clean up an incomplete physical coordination file',
            );
        }
        throw failure;
    }
    return opened;
}

function canonical_case_path(filePath: string, platform: NodeJS.Platform): string {
    const real = fs.realpathSync.native(filePath);
    const normalized = path.normalize(real);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function physical_lock_root(
    platform: NodeJS.Platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string | null {
    if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Table Viewer', 'physical-locks');
    }
    if (platform === 'win32') {
        const local = environment.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
        return path.win32.join(local, 'Table Viewer', 'physical-locks');
    }
    if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
        const state = environment.XDG_STATE_HOME || path.join(home, '.local', 'state');
        return path.join(state, 'table-viewer', 'physical-locks');
    }
    return null;
}

export function native_physical_edit_eligibility(options: {
    readonly scheme: string;
    readonly filePath: string;
    readonly remoteHost?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly home?: string;
    readonly filesystemType?: FilesystemTypeInspector;
    readonly coordinationFilesystemType?: FilesystemTypeInspector;
}): PhysicalEditEligibility {
    if (options.scheme.toLowerCase() !== 'file') return { eligible: false, reason: 'non-file' };
    if (options.remoteHost) return { eligible: false, reason: 'remote-host' };
    const platform = options.platform ?? process.platform;
    const environment = options.environment ?? process.env;
    const root = physical_lock_root(platform, environment, options.home);
    if (!root || !platform_has_proven_directory_flush(platform)) {
        return { eligible: false, reason: 'unsupported-platform' };
    }
    if (platform === 'linux' && (
        environment.WSL_DISTRO_NAME !== undefined
        || environment.WSL_INTEROP !== undefined
        || /^\/mnt(?:\/|$)/.test(path.resolve(options.filePath))
    )) return { eligible: false, reason: 'wsl' };

    try {
        const target = capture_filesystem_path(options.filePath, options.filesystemType);
        if (!target.stat.isFile()) return { eligible: false, reason: 'unverifiable-filesystem' };
        const targetClassification = classify_filesystem_type(platform, target.filesystemType);
        if (targetClassification === 'shared') return { eligible: false, reason: 'shared-mount' };
        if (targetClassification !== 'local') {
            return { eligible: false, reason: 'unverifiable-filesystem' };
        }
        const rootAncestor = capture_filesystem_path(
            nearest_existing_ancestor(root),
            options.coordinationFilesystemType,
        );
        const rootClassification = classify_filesystem_type(platform, rootAncestor.filesystemType);
        if (rootClassification === 'shared') return { eligible: false, reason: 'shared-mount' };
        if (rootClassification !== 'local') {
            return { eligible: false, reason: 'unverifiable-filesystem' };
        }
    } catch {
        return { eligible: false, reason: 'unverifiable-filesystem' };
    }
    return { eligible: true, lockRoot: root };
}

function object_lock_member(
    identity: PhysicalObjectIdentity,
): { readonly member: string; readonly name: string } {
    if (!/^\d+$/.test(identity.device) || !/^[1-9]\d*$/.test(identity.inode)) {
        throw new Error('Physical edit object identity is invalid');
    }
    const member = `filesystem-object\0${identity.device}\0${identity.inode}`;
    return { member, name: `${sha256('physical-lock-member', [member])}.lock` };
}

function identity_from_stat(
    canonicalPath: string,
    stat: fs.BigIntStats,
    platform: NodeJS.Platform,
): PhysicalResourceIdentity {
    if (!stat.isFile()) throw new Error('Physical edit target is not a regular file');
    const normalizedPath = path.normalize(canonicalPath);
    const identityPath = platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
    const rawMembers = [
        `canonical-path\0${identityPath}`,
        ...(stat.ino === 0n ? [] : [`filesystem-object\0${stat.dev.toString()}\0${stat.ino.toString()}`]),
    ];
    const ordered = rawMembers
        .map((member) => ({
            member,
            name: `${sha256('physical-lock-member', [member])}.lock`,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    const keyMembers = Object.freeze(ordered.map(({ member }) => member));
    const lockMemberNames = Object.freeze(ordered.map(({ name }) => name));
    return Object.freeze({
        canonicalPath: identityPath,
        keyMembers,
        lockMemberNames,
        physicalResourceLockKey: sha256('physical-lock-set', lockMemberNames),
    });
}

export function identify_physical_resource(
    filePath: string,
    platform: NodeJS.Platform = process.platform,
): PhysicalResourceIdentity {
    const canonicalPath = canonical_case_path(filePath, platform);
    return identity_from_stat(canonicalPath, fs.statSync(canonicalPath, { bigint: true }), platform);
}

function parse_lock_metadata(bytes: Buffer): LockMetadata | null {
    try {
        const value = JSON.parse(bytes.toString('utf8')) as Partial<LockMetadata>;
        if (value.format !== LOCK_FORMAT
            || value.version !== LOCK_PROTOCOL_VERSION
            || typeof value.hostLockId !== 'string'
            || !/^[0-9a-f]{64}$/.test(value.hostLockId)
            || typeof value.physicalResourceLockKey !== 'string'
            || !/^[0-9a-f]{64}$/.test(value.physicalResourceLockKey)
            || !Array.isArray(value.lockMemberNames)
            || value.lockMemberNames.length === 0
            || value.lockMemberNames.some((name) =>
                typeof name !== 'string' || !/^[0-9a-f]{64}\.lock$/.test(name))) return null;
        const lockMemberNames = [...value.lockMemberNames].sort();
        if (new Set(lockMemberNames).size !== lockMemberNames.length
            || lockMemberNames.some((name, index) => name !== value.lockMemberNames![index])
            || sha256('physical-lock-set', lockMemberNames) !== value.physicalResourceLockKey) return null;
        return {
            format: LOCK_FORMAT,
            version: LOCK_PROTOCOL_VERSION,
            hostLockId: value.hostLockId,
            physicalResourceLockKey: value.physicalResourceLockKey,
            lockMemberNames: Object.freeze(lockMemberNames),
        };
    } catch {
        return null;
    }
}

function read_regular_private_file(filePath: string): Buffer | null {
    let descriptor: number | undefined;
    try {
        const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
        const stat = fs.fstatSync(descriptor, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_METADATA_BYTES)) return null;
        assert_private_directory(stat);
        return fs.readFileSync(descriptor);
    } catch {
        return null;
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function exact_file_still_present(filePath: string, opened: fs.BigIntStats): boolean {
    try {
        const current = fs.lstatSync(filePath, { bigint: true });
        return current.isFile() && !current.isSymbolicLink()
            && current.dev === opened.dev && current.ino === opened.ino;
    } catch {
        return false;
    }
}

type ActivationMarkerFileInspection =
    | { readonly status: 'missing' }
    | { readonly status: 'invalid' }
    | { readonly status: 'read'; readonly bytes: Buffer; readonly opened: fs.BigIntStats };

function inspect_activation_marker_file(
    filePath: string,
    onCandidateRead?: () => void,
): ActivationMarkerFileInspection {
    const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
    let descriptor: number;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
        return is_node_error(error) && error.code === 'ENOENT'
            ? { status: 'missing' }
            : { status: 'invalid' };
    }

    let result: ActivationMarkerFileInspection;
    try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n
            || opened.size > BigInt(MAX_METADATA_BYTES)) {
            result = { status: 'invalid' };
        } else {
            assert_private_directory(opened);
            const bytes = fs.readFileSync(descriptor);
            onCandidateRead?.();
            result = exact_file_still_present(filePath, opened)
                ? { status: 'read', bytes, opened }
                : { status: 'invalid' };
        }
    } catch {
        result = { status: 'invalid' };
    }
    try {
        fs.closeSync(descriptor);
    } catch {
        return { status: 'invalid' };
    }
    return result;
}

export class PhysicalResourceLockManager {
    private readonly lockRoot: string;
    private readonly platform: NodeJS.Platform;
    private readonly randomBytes: (size: number) => Buffer;
    private readonly durableFileOperations: NonNullable<
        PhysicalLockManagerOptions['durableFileOperations']
    >;
    private readonly durableDirectoryOperations: NonNullable<
        PhysicalLockManagerOptions['durableDirectoryOperations']
    >;
    private readonly onAcquisitionEvent?: (event: PhysicalLockAcquisitionEvent) => void;
    private readonly onReleaseCandidatePinned?: (memberPath: string) => void;
    private readonly onReleaseMemberUnlinked?: (memberPath: string) => void;
    private readonly onActivationMarkerCandidateRead?: () => void;
    private readonly filesystemType?: FilesystemTypeInspector;
    private readonly targetFilesystemType?: FilesystemTypeInspector;
    private releaseDirectoryFlushPending = false;

    constructor(options: PhysicalLockManagerOptions) {
        this.lockRoot = options.lockRoot;
        this.platform = options.platform ?? process.platform;
        this.randomBytes = options.randomBytes ?? crypto.randomBytes;
        this.durableFileOperations = options.durableFileOperations ?? {
            write: (descriptor, bytes) => fs.writeFileSync(descriptor, bytes),
            fsync: (descriptor) => fs.fsyncSync(descriptor),
        };
        this.durableDirectoryOperations = options.durableDirectoryOperations ?? {
            fsync: (descriptor) => fs.fsyncSync(descriptor),
        };
        this.onAcquisitionEvent = options.onAcquisitionEvent;
        this.onReleaseCandidatePinned = options.onReleaseCandidatePinned;
        this.onReleaseMemberUnlinked = options.onReleaseMemberUnlinked;
        this.onActivationMarkerCandidateRead = options.onActivationMarkerCandidateRead;
        this.filesystemType = options.filesystemType;
        this.targetFilesystemType = options.targetFilesystemType;
    }

    async acquire(filePath: string): Promise<HostPhysicalResourceLock | null> {
        const identity = this.capture_target_identity(filePath);
        const rootIdentity = capture_private_directory(
            this.lockRoot,
            this.durableDirectoryOperations,
            this.filesystemType,
        );
        if (this.releaseDirectoryFlushPending) {
            flush_directory(this.lockRoot, this.durableDirectoryOperations);
            this.releaseDirectoryFlushPending = false;
        }
        const hostLockId = this.randomBytes(32).toString('hex');
        if (!/^[0-9a-f]{64}$/.test(hostLockId)) throw new Error('Invalid physical lock token source');
        const metadata = stable_json({
            format: LOCK_FORMAT,
            version: LOCK_PROTOCOL_VERSION,
            hostLockId,
            physicalResourceLockKey: identity.physicalResourceLockKey,
            lockMemberNames: identity.lockMemberNames,
        });
        const members = identity.lockMemberNames.map((name) => path.join(this.lockRoot, name));
        const acquired: string[] = [];
        try {
            for (const member of members) {
                assert_same_root(this.lockRoot, rootIdentity);
                if (this.release_pin_exists_for_member(path.basename(member))) {
                    this.release_exact(acquired, hostLockId, rootIdentity);
                    return null;
                }
                try {
                    write_new_durable(member, metadata, this.durableFileOperations, this.durableDirectoryOperations);
                    // Register immediately after file durability. Any later root or
                    // callback failure must still know this exact token needs cleanup.
                    acquired.push(member);
                    assert_same_root(this.lockRoot, rootIdentity);
                    this.onAcquisitionEvent?.({
                        type: 'member-durable',
                        memberCount: acquired.length,
                        totalMembers: members.length,
                    });
                } catch (error) {
                    if (is_node_error(error) && error.code === 'EEXIST') {
                        this.release_exact(acquired, hostLockId, rootIdentity);
                        return null;
                    }
                    throw error;
                }
            }
            flush_directory(this.lockRoot, this.durableDirectoryOperations);
            assert_same_root(this.lockRoot, rootIdentity);
            if (!this.verify_exact(members, hostLockId, rootIdentity)) {
                this.release_exact(acquired, hostLockId, rootIdentity);
                throw new Error('Physical lock verification failed');
            }
            const currentIdentity = this.capture_target_identity(filePath);
            if (currentIdentity.canonicalPath !== identity.canonicalPath
                || currentIdentity.lockMemberNames.length !== identity.lockMemberNames.length
                || currentIdentity.lockMemberNames.some((name, index) =>
                    name !== identity.lockMemberNames[index])) {
                this.release_exact(acquired, hostLockId, rootIdentity);
                throw new Error('Physical resource identity changed during lock acquisition');
            }
            this.onAcquisitionEvent?.({ type: 'lock-set-durable', memberCount: members.length });
        } catch (error) {
            this.release_exact(acquired, hostLockId, rootIdentity);
            throw error;
        }

        let released = false;
        let physicalResourceLockKey = identity.physicalResourceLockKey;
        const targetIdentityIsCovered = (): boolean => {
            try {
                const current = this.capture_target_identity(filePath);
                const heldNames = new Set(members.map((member) => path.basename(member)));
                return current.canonicalPath === identity.canonicalPath
                    && current.lockMemberNames.every((name) => heldNames.has(name));
            } catch {
                return false;
            }
        };
        return Object.freeze({
            hostLockId,
            get physicalResourceLockKey() { return physicalResourceLockKey; },
            identity,
            verify: async () => {
                if (released || !this.root_matches(rootIdentity)) return false;
                try {
                    return this.verify_exact(members, hostLockId, rootIdentity)
                        && targetIdentityIsCovered();
                } catch {
                    return false;
                }
            },
            extendWithObjectIdentity: async (replacementIdentity: PhysicalObjectIdentity) => {
                if (released || !this.root_matches(rootIdentity)
                    || !this.verify_exact(members, hostLockId, rootIdentity)
                    || !targetIdentityIsCovered()) {
                    throw new Error('Physical resource lock is not held');
                }
                const object = object_lock_member(replacementIdentity);
                const memberPath = path.join(this.lockRoot, object.name);
                if (members.includes(memberPath)) return physicalResourceLockKey;
                const extended = [...members, memberPath].sort();
                const extendedNames = extended.map((member) => path.basename(member));
                const extendedKey = sha256('physical-lock-set', extendedNames);
                const extendedMetadata = stable_json({
                    format: LOCK_FORMAT,
                    version: LOCK_PROTOCOL_VERSION,
                    hostLockId,
                    physicalResourceLockKey: extendedKey,
                    lockMemberNames: extendedNames,
                });
                assert_same_root(this.lockRoot, rootIdentity);
                let extendedMemberDurable = false;
                try {
                    write_new_durable(
                        memberPath,
                        extendedMetadata,
                        this.durableFileOperations,
                        this.durableDirectoryOperations,
                    );
                    extendedMemberDurable = true;
                    assert_same_root(this.lockRoot, rootIdentity);
                } catch (error) {
                    if (is_node_error(error) && error.code === 'EEXIST') {
                        throw new Error('Replacement object identity is already locked');
                    }
                    if (extendedMemberDurable) {
                        this.release_exact([memberPath], hostLockId, rootIdentity);
                    }
                    throw error;
                }
                try {
                    flush_directory(this.lockRoot, this.durableDirectoryOperations);
                    assert_same_root(this.lockRoot, rootIdentity);
                    if (!this.verify_exact(extended, hostLockId, rootIdentity)) {
                        throw new Error('Extended physical lock verification failed');
                    }
                } catch (error) {
                    this.release_exact([memberPath], hostLockId, rootIdentity);
                    throw error;
                }
                members.splice(0, members.length, ...extended);
                physicalResourceLockKey = extendedKey;
                return physicalResourceLockKey;
            },
            release: async () => {
                if (released) return;
                this.release_exact(members, hostLockId, rootIdentity);
                released = true;
            },
        });
    }

    inspect_activation_marker(): ActivationMarkerInspection {
        let rootIdentity: RootIdentity;
        try {
            fs.lstatSync(this.lockRoot);
        } catch (error) {
            return is_node_error(error) && error.code === 'ENOENT'
                ? { status: 'missing' }
                : { status: 'invalid' };
        }
        try {
            if (!platform_has_proven_directory_flush(this.platform)) return { status: 'invalid' };
            rootIdentity = inspect_private_directory(
                this.lockRoot,
                'Physical coordination root changed during marker inspection',
                this.filesystemType,
            );
            if (classify_filesystem_type(this.platform, rootIdentity.filesystemType) !== 'local') {
                return { status: 'invalid' };
            }
            assert_same_root(this.lockRoot, rootIdentity);
        } catch {
            return { status: 'invalid' };
        }

        const markerPath = path.join(this.lockRoot, ACTIVATION_MARKER);
        const inspection = inspect_activation_marker_file(
            markerPath,
            this.onActivationMarkerCandidateRead,
        );
        try {
            assert_same_root(this.lockRoot, rootIdentity);
        } catch {
            return { status: 'invalid' };
        }
        if (inspection.status !== 'read') return inspection;
        if (!exact_file_still_present(markerPath, inspection.opened)) return { status: 'invalid' };
        try {
            const value = JSON.parse(inspection.bytes.toString('utf8')) as {
                format?: unknown;
                version?: unknown;
            };
            return value.format === MARKER_FORMAT && value.version === LOCK_PROTOCOL_VERSION
                ? { status: 'active', version: LOCK_PROTOCOL_VERSION }
                : { status: 'invalid' };
        } catch {
            return { status: 'invalid' };
        }
    }

    /**
     * The current process is already fenced, flushed, and view-only. Product UI
     * attests that every other Table Viewer process is closed and updated.
     */
    install_activation_marker(attestation: PhysicalEditActivationAttestation): void {
        if (attestation.allOtherTableViewerProcessesClosed !== true
            || attestation.allOtherEditingProductsUpdated !== true
            || attestation.currentProcessFencedFlushedAndViewOnly !== true) {
            throw new Error('Physical-edit activation attestation is required');
        }
        const rootIdentity = capture_private_directory(
            this.lockRoot,
            this.durableDirectoryOperations,
            this.filesystemType,
        );
        const markerPath = path.join(this.lockRoot, ACTIVATION_MARKER);
        let createdMarker: fs.BigIntStats | undefined;
        try {
            createdMarker = write_new_durable(markerPath, stable_json({
                format: MARKER_FORMAT,
                version: LOCK_PROTOCOL_VERSION,
            }), this.durableFileOperations, this.durableDirectoryOperations);
            assert_same_root(this.lockRoot, rootIdentity);
            flush_directory(this.lockRoot, this.durableDirectoryOperations);
            assert_same_root(this.lockRoot, rootIdentity);
        } catch (error) {
            if (is_node_error(error) && error.code === 'EEXIST') {
                if (this.inspect_activation_marker().status !== 'active') {
                    throw new Error('Physical-edit activation marker is invalid');
                }
            } else {
                if (createdMarker) {
                    try {
                        remove_exact_created_file(
                            markerPath,
                            createdMarker,
                            this.durableDirectoryOperations,
                        );
                    } catch (cleanupError) {
                        throw new AggregateError(
                            [error, cleanupError],
                            'Failed to clean up an incomplete physical-edit activation marker',
                        );
                    }
                }
                throw error;
            }
        }
        assert_same_root(this.lockRoot, rootIdentity);
        if (this.inspect_activation_marker().status !== 'active') {
            throw new Error('Physical-edit activation marker verification failed');
        }
    }

    /**
     * Reconstructs only the exact complete lock set named by durable reservation
     * metadata. This is the restart path for reservation reconciliation; it does
     * not infer ownership from PID, age, or an incomplete set.
     */
    attest_reservation_lock(
        targetPath: string,
        reservation: PhysicalLockReservationMetadata,
    ): HostPhysicalResourceLock | null {
        if (!/^[0-9a-f]{64}$/.test(reservation.hostLockId)
            || !/^[0-9a-f]{64}$/.test(reservation.physicalResourceLockKey)) {
            throw new Error('Physical reservation lock metadata is invalid');
        }
        this.capture_target_identity(targetPath);
        const rootIdentity = capture_private_directory(
            this.lockRoot,
            this.durableDirectoryOperations,
            this.filesystemType,
        );
        this.reconcile_release_pins(rootIdentity, {
            hostLockId: reservation.hostLockId,
            physicalResourceLockKey: null,
        });
        const declarations = fs.readdirSync(this.lockRoot)
            .filter((name) => /^[0-9a-f]{64}\.lock$/.test(name))
            .map((name) => read_regular_private_file(path.join(this.lockRoot, name)))
            .map((bytes) => bytes && parse_lock_metadata(bytes))
            .filter((metadata): metadata is LockMetadata => metadata !== null)
            .filter((metadata) => metadata.hostLockId === reservation.hostLockId
                && metadata.physicalResourceLockKey === reservation.physicalResourceLockKey);
        const declaration = declarations.find((metadata) =>
            metadata.lockMemberNames.length > 0
            && sha256('physical-lock-set', metadata.lockMemberNames)
                === reservation.physicalResourceLockKey);
        if (!declaration) return null;
        const members = declaration.lockMemberNames.map((name) => path.join(this.lockRoot, name));
        if (!this.verify_exact(members, reservation.hostLockId, rootIdentity)) return null;
        this.capture_target_identity(targetPath);
        const identity = this.capture_target_identity(targetPath);
        const heldNames = new Set(declaration.lockMemberNames);
        if (identity.lockMemberNames.some((name) => !heldNames.has(name))) return null;

        let released = false;
        return Object.freeze({
            hostLockId: reservation.hostLockId,
            physicalResourceLockKey: reservation.physicalResourceLockKey,
            identity,
            verify: async () => {
                if (released || !this.root_matches(rootIdentity)
                    || !this.verify_exact(members, reservation.hostLockId, rootIdentity)) return false;
                try {
                    this.capture_target_identity(targetPath);
                    const current = this.capture_target_identity(targetPath);
                    return current.canonicalPath === identity.canonicalPath
                        && current.lockMemberNames.every((name) => heldNames.has(name));
                } catch {
                    return false;
                }
            },
            extendWithObjectIdentity: async () => {
                throw new Error('A reconstructed reservation lock set is immutable');
            },
            release: async () => {
                if (released) return;
                this.release_exact(members, reservation.hostLockId, rootIdentity);
                released = true;
            },
        });
    }

    /**
     * Discovers locks left before their token could be returned to a caller.
     * No age, PID, TTL, or heartbeat is consulted. Every observed member must
     * carry valid metadata for the same token and a compatible declared set.
     */
    discover_attested_stale_locks(
        attestation: AllProductsClosedAttestation,
    ): readonly AttestedStalePhysicalLock[] {
        if (attestation.allTableViewerProcessesClosed !== true) {
            throw new Error('All-products-closed stale-lock discovery attestation is required');
        }
        const rootIdentity = capture_private_directory(
            this.lockRoot,
            this.durableDirectoryOperations,
            this.filesystemType,
        );
        this.reconcile_release_pins(rootIdentity);
        const names = fs.readdirSync(this.lockRoot)
            .filter((name) => /^[0-9a-f]{64}\.lock$/.test(name))
            .sort();
        const grouped = new Map<string, Array<{
            readonly name: string;
            readonly metadata: LockMetadata;
        }>>();
        for (const name of names) {
            assert_same_root(this.lockRoot, rootIdentity);
            const bytes = read_regular_private_file(path.join(this.lockRoot, name));
            const metadata = bytes && parse_lock_metadata(bytes);
            if (!metadata || !metadata.lockMemberNames.includes(name)) {
                throw new Error('Physical lock metadata set is invalid');
            }
            const records = grouped.get(metadata.hostLockId) ?? [];
            records.push({ name, metadata });
            grouped.set(metadata.hostLockId, records);
        }
        assert_same_root(this.lockRoot, rootIdentity);

        return Object.freeze([...grouped.entries()].map(([hostLockId, records]) => {
            const declarations = records
                .map(({ metadata }) => metadata)
                .sort((left, right) => right.lockMemberNames.length - left.lockMemberNames.length);
            const maximal = declarations[0];
            const maximalNames = new Set(maximal.lockMemberNames);
            if (declarations.some((metadata) =>
                metadata.lockMemberNames.some((name) => !maximalNames.has(name)))) {
                throw new Error('Physical lock metadata declarations are inconsistent');
            }
            const presentMemberNames = records.map(({ name }) => name).sort();
            if (presentMemberNames.some((name) => !maximalNames.has(name))) {
                throw new Error('Physical lock contains an undeclared member');
            }
            return Object.freeze({
                hostLockId,
                physicalResourceLockKey: maximal.physicalResourceLockKey,
                expectedMemberNames: Object.freeze([...maximal.lockMemberNames]),
                presentMemberNames: Object.freeze(presentMemberNames),
                state: presentMemberNames.length === maximal.lockMemberNames.length
                    ? 'complete' as const
                    : 'partial' as const,
            });
        }));
    }

    /** Recovers every exactly validated discovered token after cold attestation. */
    recover_attested_stale_locks(attestation: AllProductsClosedAttestation): number {
        const rootIdentity = capture_private_directory(
            this.lockRoot,
            this.durableDirectoryOperations,
            this.filesystemType,
        );
        const discovered = this.discover_attested_stale_locks(attestation);
        assert_same_root(this.lockRoot, rootIdentity);
        let removed = 0;
        for (const stale of discovered) {
            removed += this.release_exact(
                stale.presentMemberNames.map((name) => path.join(this.lockRoot, name)),
                stale.hostLockId,
                rootIdentity,
            );
        }
        return removed;
    }

    /** No age, PID, TTL, or heartbeat is consulted. */
    recover_attested_stale_lock(
        hostLockId: string,
        attestation: AllProductsClosedAttestation,
    ): number {
        if (attestation.allTableViewerProcessesClosed !== true
            || !/^[0-9a-f]{64}$/.test(hostLockId)) {
            throw new Error('Exact stale-lock recovery attestation is required');
        }
        const rootIdentity = capture_private_directory(
            this.lockRoot,
            this.durableDirectoryOperations,
            this.filesystemType,
        );
        this.reconcile_release_pins(rootIdentity, { hostLockId, physicalResourceLockKey: null });
        const members = fs.readdirSync(this.lockRoot)
            .filter((name) => /^[0-9a-f]{64}\.lock$/.test(name))
            .map((name) => path.join(this.lockRoot, name));
        assert_same_root(this.lockRoot, rootIdentity);
        return this.release_exact(members, hostLockId, rootIdentity);
    }

    private release_pin_exists_for_member(memberName: string): boolean {
        const prefix = `.release-v1-${memberName}-`;
        return fs.readdirSync(this.lockRoot).some((name) => name.startsWith(prefix));
    }

    private reconcile_release_pins(
        rootIdentity: RootIdentity,
        authority?: {
            readonly hostLockId: string;
            readonly physicalResourceLockKey: string | null;
        },
    ): void {
        const pinPattern = /^\.release-v1-([0-9a-f]{64}\.lock)-([0-9a-f]{64})$/;
        let mutated = false;
        for (const pinName of fs.readdirSync(this.lockRoot).sort()) {
            const match = pinPattern.exec(pinName);
            if (!match || (authority && match[2] !== authority.hostLockId)) continue;
            assert_same_root(this.lockRoot, rootIdentity);
            const pinPath = path.join(this.lockRoot, pinName);
            const memberPath = path.join(this.lockRoot, match[1]);
            const pinStat = fs.lstatSync(pinPath, { bigint: true });
            if (!pinStat.isFile() || pinStat.isSymbolicLink()
                || pinStat.size > BigInt(MAX_METADATA_BYTES)) {
                throw new Error('Physical release pin is invalid');
            }
            assert_private_directory(pinStat);
            const metadata = parse_lock_metadata(fs.readFileSync(pinPath));
            if (!metadata || metadata.hostLockId !== match[2]
                || (authority?.physicalResourceLockKey !== null
                    && authority?.physicalResourceLockKey !== undefined
                    && metadata.physicalResourceLockKey !== authority.physicalResourceLockKey)
                || !metadata.lockMemberNames.includes(match[1])) {
                throw new Error('Physical release pin metadata is invalid');
            }
            try {
                const memberStat = fs.lstatSync(memberPath, { bigint: true });
                if (memberStat.dev !== pinStat.dev || memberStat.ino !== pinStat.ino) {
                    throw new Error('Physical release pin conflicts with a replacement owner');
                }
                fs.unlinkSync(pinPath);
            } catch (error) {
                if (!is_node_error(error) || error.code !== 'ENOENT') throw error;
                fs.renameSync(pinPath, memberPath);
            }
            mutated = true;
        }
        if (mutated) {
            flush_directory(this.lockRoot, this.durableDirectoryOperations);
            assert_same_root(this.lockRoot, rootIdentity);
        }
    }

    private capture_target_identity(filePath: string): PhysicalResourceIdentity {
        try {
            if (!platform_has_proven_directory_flush(this.platform)) throw new Error('unsupported');
            const captured = capture_filesystem_path(filePath, this.targetFilesystemType);
            if (classify_filesystem_type(this.platform, captured.filesystemType) !== 'local') {
                throw new Error('unproven');
            }
            return identity_from_stat(captured.canonicalPath, captured.stat, this.platform);
        } catch {
            throw new Error('Physical target filesystem is not proven local');
        }
    }

    private root_matches(expected: RootIdentity): boolean {
        try {
            assert_same_root(this.lockRoot, expected);
            return true;
        } catch {
            return false;
        }
    }

    private verify_exact(
        members: readonly string[],
        hostLockId: string,
        rootIdentity: RootIdentity,
    ): boolean {
        const expectedNames = members.map((member) => path.basename(member)).sort();
        const expectedSet = new Set(expectedNames);
        let foundCompleteDeclaration = false;
        for (const member of members) {
            assert_same_root(this.lockRoot, rootIdentity);
            const bytes = read_regular_private_file(member);
            assert_same_root(this.lockRoot, rootIdentity);
            const metadata = bytes && parse_lock_metadata(bytes);
            const memberName = path.basename(member);
            if (!metadata || metadata.hostLockId !== hostLockId
                || !metadata.lockMemberNames.includes(memberName)
                || metadata.lockMemberNames.some((name) => !expectedSet.has(name))) return false;
            if (metadata.lockMemberNames.length === expectedNames.length
                && metadata.lockMemberNames.every((name, index) => name === expectedNames[index])) {
                foundCompleteDeclaration = true;
            }
        }
        return foundCompleteDeclaration;
    }

    private release_exact(
        members: readonly string[],
        hostLockId: string,
        rootIdentity: RootIdentity,
    ): number {
        this.reconcile_release_pins(rootIdentity, {
            hostLockId,
            physicalResourceLockKey: null,
        });
        let removed = 0;
        let failure: unknown;
        try {
            for (const member of members) {
                assert_same_root(this.lockRoot, rootIdentity);
                const quarantine = path.join(
                    this.lockRoot,
                    `.release-v1-${path.basename(member)}-${hostLockId}`,
                );
                let quarantineDescriptor: number | undefined;
                let pinned: fs.BigIntStats | undefined;
                try {
                    // Pin the candidate to a second name, then authorize and identify it
                    // through one O_NOFOLLOW descriptor. Path replacement cannot lend a
                    // different inode's token to the member being released.
                    fs.linkSync(member, quarantine);
                    this.releaseDirectoryFlushPending = true;
                    flush_directory(this.lockRoot, this.durableDirectoryOperations);
                    assert_same_root(this.lockRoot, rootIdentity);
                    this.releaseDirectoryFlushPending = false;
                    const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
                    quarantineDescriptor = fs.openSync(quarantine, fs.constants.O_RDONLY | noFollow);
                    pinned = fs.fstatSync(quarantineDescriptor, { bigint: true });
                    if (!pinned.isFile() || pinned.size > BigInt(MAX_METADATA_BYTES)) continue;
                    assert_private_directory(pinned);
                    this.onReleaseCandidatePinned?.(member);
                    const metadata = parse_lock_metadata(fs.readFileSync(quarantineDescriptor));
                    if (metadata?.hostLockId !== hostLockId) continue;
                    assert_same_root(this.lockRoot, rootIdentity);
                    const current = fs.lstatSync(member, { bigint: true });
                    if (!current.isFile() || current.isSymbolicLink()
                        || current.dev !== pinned.dev || current.ino !== pinned.ino) continue;
                    fs.unlinkSync(member);
                    this.releaseDirectoryFlushPending = true;
                    removed += 1;
                    this.onReleaseMemberUnlinked?.(member);
                } catch (error) {
                    if (!is_node_error(error) || error.code !== 'ENOENT') throw error;
                } finally {
                    if (quarantineDescriptor !== undefined) fs.closeSync(quarantineDescriptor);
                    if (pinned && exact_file_still_present(quarantine, pinned)) {
                        fs.unlinkSync(quarantine);
                        this.releaseDirectoryFlushPending = true;
                    }
                }
            }
        } catch (error) {
            failure = error;
        }
        try {
            if (this.releaseDirectoryFlushPending) {
                assert_same_root(this.lockRoot, rootIdentity);
                flush_directory(this.lockRoot, this.durableDirectoryOperations);
                assert_same_root(this.lockRoot, rootIdentity);
                this.releaseDirectoryFlushPending = false;
            }
        } catch (flushError) {
            if (failure !== undefined) {
                throw new AggregateError([failure, flushError], 'Physical lock release and flush failed');
            }
            throw flushError;
        }
        if (failure !== undefined) throw failure;
        return removed;
    }
}
