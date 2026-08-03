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
): FileIdentity[] {
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
    return protectedIdentities;
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
}): void {
    const originalSourcePaths = [
        ...(options.originalSourcePath === undefined ? [] : [options.originalSourcePath]),
        ...(options.originalSourcePaths ?? []),
    ];
    const protectedIdentities = assert_safe_target(
        options.targetPath,
        options.stateRootPath,
        originalSourcePaths,
    );
    const targetExisted = existing_file_identity(path.resolve(options.targetPath)) !== undefined;
    options.beforeOpen?.();
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const descriptor = fs.openSync(
        options.targetPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollow,
        0o600,
    );
    try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile()
            || protectedIdentities.some((value) => same_identity(value, identity(opened)))) {
            throw new UnsafeRecoveryExportTargetError();
        }
        // Re-resolve after open to catch a parent-directory alias swap where feasible.
        const refreshedProtectedIdentities = assert_safe_target(
            options.targetPath,
            options.stateRootPath,
            originalSourcePaths,
        );
        if (refreshedProtectedIdentities.some((value) => same_identity(value, identity(opened)))) {
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
        const directoryDescriptor = fs.openSync(path.dirname(path.resolve(options.targetPath)), 'r');
        try {
            fs.fsyncSync(directoryDescriptor);
        } finally {
            fs.closeSync(directoryDescriptor);
        }
    }
}
