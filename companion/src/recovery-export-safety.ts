import * as fs from 'node:fs';
import * as path from 'node:path';

export class UnsafeRecoveryExportTargetError extends Error {
    constructor() {
        super('Choose a location outside Table Viewer state and outside the original resource.');
        this.name = 'UnsafeRecoveryExportTargetError';
    }
}

interface FileIdentity {
    readonly device: bigint;
    readonly inode: bigint;
}

function identity(stat: fs.BigIntStats): FileIdentity {
    return { device: stat.dev, inode: stat.ino };
}

function same_identity(left: FileIdentity, right: FileIdentity): boolean {
    return left.device === right.device && left.inode === right.inode;
}

function is_within(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Resolve aliases in every existing ancestor without requiring the export file to exist. */
function physical_destination(targetPath: string, rejectLeafSymlink = true): string {
    const resolved = path.resolve(targetPath);
    let existing = resolved;
    const suffix: string[] = [];
    for (;;) {
        try {
            const stat = fs.lstatSync(existing);
            if (rejectLeafSymlink && existing === resolved && stat.isSymbolicLink()) {
                throw new UnsafeRecoveryExportTargetError();
            }
            const physical = fs.realpathSync.native(existing);
            return path.join(physical, ...suffix.reverse());
        } catch (error) {
            if (error instanceof UnsafeRecoveryExportTargetError) throw error;
            if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const parent = path.dirname(existing);
            if (parent === existing) throw error;
            suffix.push(path.basename(existing));
            existing = parent;
        }
    }
}

function existing_file_identity(filePath: string): FileIdentity | undefined {
    try {
        const stat = fs.statSync(filePath, { bigint: true });
        return stat.isFile() ? identity(stat) : undefined;
    } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

function collect_file_identities(root: string): FileIdentity[] {
    const identities: FileIdentity[] = [];
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return identities;
        throw error;
    }
    for (const entry of entries) {
        const entryPath = path.join(root, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) identities.push(...collect_file_identities(entryPath));
        else if (entry.isFile()) identities.push(identity(fs.lstatSync(entryPath, { bigint: true })));
    }
    return identities;
}

function assert_safe_target(
    targetPath: string,
    stateRootPath: string,
    originalSourcePaths: readonly string[],
): { protectedIdentities: FileIdentity[]; targetIdentity?: FileIdentity } {
    const resolvedTarget = path.resolve(targetPath);
    const physicalTarget = physical_destination(resolvedTarget);
    const resolvedStateRoot = path.resolve(stateRootPath);
    let physicalStateRoot = resolvedStateRoot;
    try {
        physicalStateRoot = fs.realpathSync.native(resolvedStateRoot);
    } catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (is_within(resolvedTarget, resolvedStateRoot) || is_within(physicalTarget, physicalStateRoot)) {
        throw new UnsafeRecoveryExportTargetError();
    }

    const protectedIdentities = collect_file_identities(resolvedStateRoot);
    for (const originalSourcePath of originalSourcePaths) {
        const resolvedSource = path.resolve(originalSourcePath);
        const physicalSource = physical_destination(resolvedSource, false);
        if (resolvedTarget === resolvedSource || physicalTarget === physicalSource) {
            throw new UnsafeRecoveryExportTargetError();
        }
        const sourceIdentity = existing_file_identity(resolvedSource);
        if (sourceIdentity) protectedIdentities.push(sourceIdentity);
    }

    const targetIdentity = existing_file_identity(resolvedTarget);
    if (targetIdentity && protectedIdentities.some((value) => same_identity(value, targetIdentity))) {
        throw new UnsafeRecoveryExportTargetError();
    }
    return { protectedIdentities, targetIdentity };
}

export function original_file_resource_path(resourceIdentity: Record<string, unknown>): string | undefined {
    if (resourceIdentity.scheme !== 'file' || typeof resourceIdentity.path !== 'string') return undefined;
    const uriPath = resourceIdentity.path;
    const authority = typeof resourceIdentity.authority === 'string' ? resourceIdentity.authority : '';
    if (process.platform === 'win32') {
        if (authority) return `\\\\${authority}${uriPath.replaceAll('/', '\\')}`;
        if (/^\/[A-Za-z]:\//.test(uriPath)) return uriPath.slice(1).replaceAll('/', '\\');
    }
    return authority ? `//${authority}${uriPath}` : uriPath;
}

/**
 * Write an export through a no-follow file descriptor. Validation uses the real
 * filesystem, then re-checks the opened inode before truncating an existing file.
 */
export function write_recovery_export_safely(options: {
    readonly targetPath: string;
    readonly stateRootPath: string;
    readonly originalSourcePath?: string;
    readonly originalSourcePaths?: readonly string[];
    readonly contents: string;
    readonly beforeOpen?: () => void;
    /** Test seams for platforms, notably Windows, without a usable O_NOFOLLOW. */
    readonly forceNoFollowUnavailable?: boolean;
    readonly noFollowFlagForTest?: number;
}): void {
    const originalSourcePaths = [
        ...(options.originalSourcePath === undefined ? [] : [options.originalSourcePath]),
        ...(options.originalSourcePaths ?? []),
    ];
    const { protectedIdentities, targetIdentity } = assert_safe_target(
        options.targetPath,
        options.stateRootPath,
        originalSourcePaths,
    );
    const targetExisted = targetIdentity !== undefined;
    const noFollowFlag = options.noFollowFlagForTest ?? fs.constants.O_NOFOLLOW;
    const noFollow = options.forceNoFollowUnavailable
        || process.platform === 'win32'
        || noFollowFlag === undefined
        || noFollowFlag === 0
        ? undefined
        : noFollowFlag;
    if (noFollow === undefined && targetExisted) {
        // Without a no-follow open, a leaf replacement can redirect the descriptor
        // after validation. This includes Windows/libuv's zero-valued placeholder.
        throw new UnsafeRecoveryExportTargetError();
    }
    const resolvedTarget = path.resolve(options.targetPath);
    options.beforeOpen?.();
    let descriptor: number;
    try {
        descriptor = fs.openSync(
            resolvedTarget,
            fs.constants.O_WRONLY
                | (targetExisted ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL)
                | (noFollow ?? 0),
            0o600,
        );
    } catch (error) {
        if (!targetExisted
            && error instanceof Error
            && (error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new UnsafeRecoveryExportTargetError();
        }
        throw error;
    }
    try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        const openedFileIdentity = identity(opened);
        if (!opened.isFile()
            || (targetIdentity !== undefined && !same_identity(targetIdentity, openedFileIdentity))
            || protectedIdentities.some((value) => same_identity(value, openedFileIdentity))) {
            throw new UnsafeRecoveryExportTargetError();
        }
        // Re-resolve after open before mutating the validated or exclusively created inode.
        const refreshed = assert_safe_target(
            resolvedTarget,
            options.stateRootPath,
            originalSourcePaths,
        );
        if (refreshed.targetIdentity === undefined
            || !same_identity(refreshed.targetIdentity, openedFileIdentity)
            || refreshed.protectedIdentities.some((value) => same_identity(value, openedFileIdentity))) {
            throw new UnsafeRecoveryExportTargetError();
        }
        if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
        fs.ftruncateSync(descriptor, 0);
        fs.writeFileSync(descriptor, options.contents, 'utf8');
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    if (!targetExisted && process.platform !== 'win32') {
        const directoryDescriptor = fs.openSync(path.dirname(resolvedTarget), 'r');
        try {
            fs.fsyncSync(directoryDescriptor);
        } finally {
            fs.closeSync(directoryDescriptor);
        }
    }
}
