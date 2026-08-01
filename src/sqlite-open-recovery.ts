import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
    initialize_sqlite_file_state_schema,
    SQLITE_FILE_STATE_APPLICATION_ID,
    SQLITE_FILE_STATE_PROTOCOL_VERSION,
    type SqliteFileStateIdentity,
    type SqliteFileStateMigrationOptions,
} from './sqlite-file-state-schema';
import {
    categorize_sqlite_file_state_error,
    sqlite_file_state_error,
    sqlite_file_state_recovery_error,
    sqlite_file_state_schema_error,
    SqliteFileStateError,
} from './sqlite-file-state-errors';
import { validate_sqlite_file_state_database } from './sqlite-file-state-validation';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
const SQLITE_HEADER_BYTES = 100;
const APPLICATION_ID_OFFSET = 68;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const EXCLUSIVE_INTENT_NAME = 'exclusive-intent';
const READERS_DIRECTORY_NAME = 'readers';
const RECOVERY_BLOCK_NAME = 'recovery-block.json';
const MANIFEST_NAME = 'manifest.json';
const CANDIDATE_MARKER = '.init-candidate.';
const RECOVERY_MARKER = '.recovery.';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF']);

export const SQLITE_INITIALIZATION_DURABLE_CUT_POINTS = [
    'candidate-after-schema',
    'candidate-after-close',
    'candidate-after-file-flush',
    'candidate-after-directory-flush',
    'candidate-after-install',
] as const;

export const SQLITE_PRESERVATION_DURABLE_CUT_POINTS = [
    'preserve-after-recovery-directory-flush',
    'preserve-after-manifest-flush',
    'preserve-after-blockade-flush',
    'preserve-after-member-install',
    'preserve-after-member-source-removal',
    'preserve-after-progress-flush',
    'preserve-after-complete-flush',
    'preserve-after-blockade-removal',
] as const;

export type SqliteInitializationDurableCutPoint =
    typeof SQLITE_INITIALIZATION_DURABLE_CUT_POINTS[number];
export type SqlitePreservationDurableCutPoint =
    typeof SQLITE_PRESERVATION_DURABLE_CUT_POINTS[number];

export type SqliteOpenRecoveryEvent =
    | 'reader-before-intent-check'
    | 'reader-before-token-create'
    | 'reader-after-token-flush'
    | 'reader-after-intent-recheck'
    | 'reader-retrying'
    | 'exclusive-after-intent-flush'
    | 'exclusive-waiting-for-readers'
    | 'exclusive-readers-drained'
    | 'inventory-complete'
    | 'candidate-after-schema'
    | 'candidate-after-close'
    | 'candidate-after-file-flush'
    | 'candidate-after-directory-flush'
    | 'candidate-before-install'
    | 'candidate-after-install'
    | 'winner-validated'
    | 'preserve-after-recovery-directory-flush'
    | 'preserve-after-manifest-flush'
    | 'preserve-after-blockade-flush'
    | 'preserve-after-member-install'
    | 'preserve-after-member-source-removal'
    | 'preserve-after-progress-flush'
    | 'preserve-after-complete-flush'
    | 'preserve-after-blockade-removal';

export interface SqliteOpenRecoveryHooks {
    readonly onEvent?: (event: SqliteOpenRecoveryEvent) => void | Promise<void>;
    /** Observable polling hook. The default yields one event-loop turn, never a fixed delay. */
    readonly yieldControl?: () => void | Promise<void>;
    /** Injectable only for deterministic directory-durability failure tests. */
    readonly fsyncDirectory?: (descriptor: number) => void;
}

export interface SqliteBasenameMember {
    readonly kind: 'main' | 'journal' | 'wal' | 'shm' | 'candidate';
    readonly name: string;
    readonly size: number;
    readonly device: bigint;
    readonly inode: bigint;
}

export interface SqliteBasenameInventory {
    readonly main: SqliteBasenameMember | undefined;
    readonly journal: SqliteBasenameMember | undefined;
    readonly wal: SqliteBasenameMember | undefined;
    readonly shm: SqliteBasenameMember | undefined;
    readonly candidates: readonly SqliteBasenameMember[];
    readonly recoveryBlocked: boolean;
    readonly recoveryDirectories: number;
    readonly incompleteRecoveryDirectories: number;
}

export interface SqliteRawHeader {
    readonly applicationId: number;
    readonly pageSize: number;
    readonly readVersion: number;
    readonly writeVersion: number;
}

interface GatePaths {
    readonly canonicalPath: string;
    readonly parentDirectory: string;
    readonly basename: string;
    readonly gateDirectory: string;
    readonly readersDirectory: string;
    readonly exclusiveIntentPath: string;
    readonly recoveryBlockPath: string;
}

export interface ManagedDirectoryIdentity {
    readonly directoryPath: string;
    readonly physicalPath: string;
    readonly physicalParentPath: string;
    readonly device: bigint;
    readonly inode: bigint;
}

interface GateDirectoryIdentities {
    readonly gate: ManagedDirectoryIdentity;
    readonly readers: ManagedDirectoryIdentity;
}

export interface SqliteSharedReaderGate {
    readonly kind: 'shared-reader';
    readonly canonicalPath: string;
    readonly tokenId: string;
    release(): Promise<void>;
}

export interface SqliteExclusiveRecoveryGate {
    readonly kind: 'exclusive-recovery';
    readonly canonicalPath: string;
    readonly tokenId: string;
    listReaderTokenIds(): readonly string[];
    reclaimStaleReaderToken(tokenId: string, confirmation: SqliteAllProcessesClosedConfirmation): Promise<void>;
    waitForReaders(): Promise<void>;
    release(): Promise<void>;
}

const exclusiveGateIdentities = new WeakMap<SqliteExclusiveRecoveryGate, GateDirectoryIdentities>();

export interface SqliteAllProcessesClosedConfirmation {
    readonly allProcessesClosed: true;
}

export interface SqliteRecoveryGateInventory {
    readonly exclusiveIntentTokenId?: string;
    readonly readerTokenIds: readonly string[];
    readonly recoveryBlocked: boolean;
}

export interface SqliteOpenedDatabase {
    readonly database: DatabaseSync;
    readonly inventory: SqliteBasenameInventory;
    readonly canonicalPath: string;
    /** Close SQLite while retaining the exact shared-reader token. */
    closeDatabase(): Promise<void>;
    /** Replace the SQLite connection while transferring the exact retained reader token. */
    replaceConnection(options?: SqliteOpenExistingOptions): Promise<SqliteOpenedDatabase>;
    /** Close SQLite, if needed, and release the retained shared-reader token. */
    close(): Promise<void>;
}

export interface SqliteCandidateRecognition {
    readonly recognized: boolean;
    readonly identityMatches: boolean;
    readonly applicationId: number;
    readonly userVersion?: number;
}

export interface SqliteInitializationResult {
    readonly installed: boolean;
    readonly wonInstallation: boolean;
    readonly candidatePath?: string;
    readonly database: SqliteOpenedDatabase;
}

interface ManifestMember {
    readonly kind: SqliteBasenameMember['kind'];
    readonly sourceName: string;
    readonly targetName: string;
    readonly size: number;
    readonly device: string;
    readonly inode: string;
    readonly installed: boolean;
    readonly sourceRemoved: boolean;
}

interface RecoveryManifest {
    readonly format: 'tableViewer.sqliteRecovery.v1';
    readonly generation: string;
    readonly state: 'moving' | 'complete';
    readonly members: readonly ManifestMember[];
}

interface RecoveryBlock {
    readonly format: 'tableViewer.sqliteRecoveryBlock.v1';
    readonly generation: string;
    readonly recoveryDirectoryName: string;
}

export interface SqlitePreservationResult {
    readonly recoveryDirectory: string;
    readonly generation: string;
    readonly memberCount: number;
}

export interface SqliteOpenExistingOptions extends SqliteOpenRecoveryHooks {
    readonly expectedApplicationId?: number;
    readonly validate?: (database: DatabaseSync) => void;
    readonly timeoutMs?: number;
}

export interface SqliteInitializeOptions extends SqliteOpenRecoveryHooks {
    readonly expectedApplicationId?: number;
    readonly supportedProtocol?: number;
    readonly timeoutMs?: number;
    readonly gate?: SqliteSharedReaderGate | SqliteExclusiveRecoveryGate;
}

export interface SqlitePreserveOptions extends SqliteOpenRecoveryHooks {
    readonly gate: SqliteExclusiveRecoveryGate;
}

export interface SqliteResumeCandidateOptions extends SqliteOpenRecoveryHooks {
    readonly gate: SqliteExclusiveRecoveryGate;
    readonly expectedApplicationId?: number;
    readonly supportedProtocol?: number;
    readonly timeoutMs?: number;
}

export function resolve_sqlite_canonical_path(databasePath: string): string {
    try {
        const resolved = path.resolve(databasePath);
        const basename = path.basename(resolved);
        const parentDirectory = fs.realpathSync.native(path.dirname(resolved));
        const canonicalPath = path.join(parentDirectory, basename);
        try {
            const stat = fs.lstatSync(canonicalPath);
            if (stat.isSymbolicLink()) {
                throw sqlite_file_state_error('inaccessible', { operation: 'canonical-main-symlink' });
            }
        } catch (error) {
            if (!is_node_error(error) || error.code !== 'ENOENT') throw error;
        }
        return canonicalPath;
    } catch (error) {
        throw safe_error('canonical-path', error);
    }
}

function gate_paths(canonicalPath: string): GatePaths {
    const resolved = resolve_sqlite_canonical_path(canonicalPath);
    const parentDirectory = path.dirname(resolved);
    const basename = path.basename(resolved);
    const gateDirectory = path.join(parentDirectory, `.${basename}.recovery-gate`);
    return {
        canonicalPath: resolved,
        parentDirectory,
        basename,
        gateDirectory,
        readersDirectory: path.join(gateDirectory, READERS_DIRECTORY_NAME),
        exclusiveIntentPath: path.join(gateDirectory, EXCLUSIVE_INTENT_NAME),
        recoveryBlockPath: path.join(gateDirectory, RECOVERY_BLOCK_NAME),
    };
}

async function emit(hooks: SqliteOpenRecoveryHooks | undefined, event: SqliteOpenRecoveryEvent): Promise<void> {
    await hooks?.onEvent?.(event);
}

async function yield_control(hooks: SqliteOpenRecoveryHooks | undefined): Promise<void> {
    if (hooks?.yieldControl) {
        await hooks.yieldControl();
        return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function is_node_error(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

export function safe_error(operation: string, error: unknown): SqliteFileStateError {
    if (error instanceof SqliteFileStateError) return error;
    if (is_node_error(error)) {
        switch (error.code) {
            case 'EROFS':
                return sqlite_file_state_error('readonly', { operation });
            case 'EACCES':
            case 'EPERM':
            case 'ENOENT':
            case 'ENOTDIR':
                return sqlite_file_state_error('inaccessible', { operation });
            case 'ENOSPC':
            case 'EDQUOT':
                return sqlite_file_state_error('full', { operation });
            case 'EBUSY':
            case 'EAGAIN':
            case 'EEXIST':
                return sqlite_file_state_error('contention', { operation });
            case 'EIO':
                return sqlite_file_state_error('io', { operation });
        }
    }
    const candidate = error as { errcode?: unknown } | null;
    if (typeof candidate?.errcode === 'number') {
        return categorize_sqlite_file_state_error(error, { operation });
    }
    return sqlite_file_state_recovery_error({ operation });
}

export function capture_managed_directory(
    directoryPath: string,
    physicalParentPath: string,
    operation: string,
): ManagedDirectoryIdentity {
    const stat = fs.lstatSync(directoryPath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw sqlite_file_state_recovery_error({ operation });
    }
    const physicalPath = fs.realpathSync.native(directoryPath);
    if (path.dirname(physicalPath) !== physicalParentPath
        || physicalPath !== path.join(physicalParentPath, path.basename(directoryPath))) {
        throw sqlite_file_state_recovery_error({ operation });
    }
    const stable = fs.lstatSync(directoryPath, { bigint: true });
    if (!stable.isDirectory() || stable.isSymbolicLink()
        || stable.dev !== stat.dev || stable.ino !== stat.ino) {
        throw sqlite_file_state_recovery_error({ operation });
    }
    return {
        directoryPath,
        physicalPath,
        physicalParentPath,
        device: stat.dev,
        inode: stat.ino,
    };
}

export function assert_managed_directory(identity: ManagedDirectoryIdentity, operation: string): void {
    const actual = capture_managed_directory(
        identity.directoryPath,
        identity.physicalParentPath,
        operation,
    );
    if (actual.physicalPath !== identity.physicalPath
        || actual.device !== identity.device || actual.inode !== identity.inode) {
        throw sqlite_file_state_recovery_error({ operation });
    }
}

function ensure_managed_directory(
    directoryPath: string,
    physicalParentPath: string,
    operation: string,
): ManagedDirectoryIdentity {
    try {
        fs.mkdirSync(directoryPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
        if (!is_node_error(error) || error.code !== 'EEXIST') throw error;
    }
    const identity = capture_managed_directory(directoryPath, physicalParentPath, operation);
    assert_managed_directory(identity, operation);
    fs.chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
    assert_managed_directory(identity, operation);
    return identity;
}

function ensure_private_gate(
    paths: GatePaths,
    hooks?: SqliteOpenRecoveryHooks,
): GateDirectoryIdentities {
    const gate = ensure_managed_directory(
        paths.gateDirectory,
        paths.parentDirectory,
        'gate-directory-verify',
    );
    const readers = ensure_managed_directory(
        paths.readersDirectory,
        gate.physicalPath,
        'readers-directory-verify',
    );
    assert_managed_directory(gate, 'gate-directory-flush');
    flush_directory(paths.parentDirectory, hooks);
    assert_managed_directory(readers, 'readers-directory-flush');
    assert_managed_directory(gate, 'gate-directory-flush');
    flush_directory(paths.gateDirectory, hooks);
    return { gate, readers };
}

function flush_file(filePath: string): void {
    const descriptor = fs.openSync(filePath, 'r');
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

export function assert_sqlite_directory_durability_supported(
    directoryPath: string,
    fsyncDirectory: (descriptor: number) => void = fs.fsyncSync,
    platform: NodeJS.Platform = process.platform,
): void {
    // Node exposes no proven Windows primitive for durably flushing directory-entry
    // changes. Refuse the backend explicitly instead of treating a skipped flush as
    // durable success. Tests may inject a capability implementation at the operation
    // boundary, but production never assumes one exists.
    if (platform === 'win32' && fsyncDirectory === fs.fsyncSync) {
        throw sqlite_file_state_error('unsupported', { operation: 'directory-durability' });
    }
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(directoryPath, 'r');
        fsyncDirectory(descriptor);
    } catch (error) {
        if (is_node_error(error) && UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(error.code ?? '')) {
            throw sqlite_file_state_error('unsupported', { operation: 'directory-durability' });
        }
        throw error;
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function flush_directory(directoryPath: string, hooks?: SqliteOpenRecoveryHooks): void {
    assert_sqlite_directory_durability_supported(
        directoryPath,
        hooks?.fsyncDirectory ?? fs.fsyncSync,
    );
}

function write_private_file_exclusive(filePath: string, data: string): void {
    const descriptor = fs.openSync(filePath, 'wx', PRIVATE_FILE_MODE);
    let primaryError: unknown;
    try {
        fs.writeFileSync(descriptor, data, 'utf8');
        fs.fsyncSync(descriptor);
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        try {
            fs.closeSync(descriptor);
        } catch (error) {
            if (primaryError === undefined) throw error;
        }
    }
}

function replace_private_json(
    filePath: string,
    value: unknown,
    hooks?: SqliteOpenRecoveryHooks,
): void {
    const temporaryPath = `${filePath}.tmp.${randomUUID()}`;
    let renamed = false;
    try {
        write_private_file_exclusive(temporaryPath, JSON.stringify(value));
        fs.renameSync(temporaryPath, filePath);
        renamed = true;
    } catch (error) {
        if (!renamed) {
            try {
                fs.unlinkSync(temporaryPath);
            } catch {
                // Preserve the primary creation, write, flush, or rename failure.
            }
        }
        throw error;
    }
    // Once rename succeeds the temporary pathname no longer exists; a later
    // directory-flush failure must leave the installed replacement as evidence.
    flush_directory(path.dirname(filePath), hooks);
}

function exact_token_matches(
    filePath: string,
    tokenId: string,
    parentIdentity: ManagedDirectoryIdentity,
): boolean {
    assert_managed_directory(parentIdentity, 'managed-token-parent');
    try {
        return fs.readFileSync(filePath, 'utf8') === tokenId;
    } catch {
        return false;
    }
}

function existing_reader_token_ids(
    paths: GatePaths,
    identities: GateDirectoryIdentities,
): string[] {
    assert_managed_directory(identities.gate, 'gate-directory-readers');
    assert_managed_directory(identities.readers, 'readers-directory-list');
    const tokenIds: string[] = [];
    for (const entry of fs.readdirSync(paths.readersDirectory, { withFileTypes: true })) {
        if (!entry.name.endsWith('.reader')) continue;
        const tokenId = entry.name.slice(0, -'.reader'.length);
        if (!entry.isFile() || !UUID_PATTERN.test(tokenId)) {
            throw sqlite_file_state_recovery_error({ operation: 'reader-token-inventory' });
        }
        tokenIds.push(tokenId);
    }
    return tokenIds.sort();
}

export async function acquire_sqlite_shared_reader_gate(
    canonicalPath: string,
    hooks?: SqliteOpenRecoveryHooks,
): Promise<SqliteSharedReaderGate> {
    const paths = gate_paths(canonicalPath);
    try {
        const identities = ensure_private_gate(paths, hooks);
        for (;;) {
            await emit(hooks, 'reader-before-intent-check');
            assert_managed_directory(identities.gate, 'reader-intent-check');
            if (fs.existsSync(paths.exclusiveIntentPath)) {
                await emit(hooks, 'reader-retrying');
                await yield_control(hooks);
                continue;
            }
            const tokenId = randomUUID();
            const tokenPath = path.join(paths.readersDirectory, `${tokenId}.reader`);
            await emit(hooks, 'reader-before-token-create');
            try {
                assert_managed_directory(identities.readers, 'reader-token-create');
                write_private_file_exclusive(tokenPath, tokenId);
            } catch (error) {
                if (is_node_error(error) && error.code === 'EEXIST') continue;
                throw error;
            }
            assert_managed_directory(identities.readers, 'reader-token-flush');
            flush_directory(paths.readersDirectory, hooks);
            await emit(hooks, 'reader-after-token-flush');
            assert_managed_directory(identities.gate, 'reader-intent-recheck');
            const intentAppeared = fs.existsSync(paths.exclusiveIntentPath);
            await emit(hooks, 'reader-after-intent-recheck');
            if (intentAppeared) {
                if (!exact_token_matches(tokenPath, tokenId, identities.readers)) {
                    throw sqlite_file_state_recovery_error({ operation: 'reader-token-verify' });
                }
                assert_managed_directory(identities.readers, 'reader-token-remove');
                fs.unlinkSync(tokenPath);
                assert_managed_directory(identities.readers, 'reader-token-remove-flush');
                flush_directory(paths.readersDirectory, hooks);
                await emit(hooks, 'reader-retrying');
                await yield_control(hooks);
                continue;
            }
            let released = false;
            return {
                kind: 'shared-reader',
                canonicalPath: paths.canonicalPath,
                tokenId,
                async release(): Promise<void> {
                    if (released) return;
                    if (!exact_token_matches(tokenPath, tokenId, identities.readers)) {
                        throw sqlite_file_state_recovery_error({ operation: 'reader-token-release' });
                    }
                    assert_managed_directory(identities.readers, 'reader-token-release');
                    fs.unlinkSync(tokenPath);
                    assert_managed_directory(identities.readers, 'reader-token-release-flush');
                    flush_directory(paths.readersDirectory, hooks);
                    released = true;
                },
            };
        }
    } catch (error) {
        throw safe_error('reader-gate-acquire', error);
    }
}

export async function acquire_sqlite_exclusive_recovery_gate(
    canonicalPath: string,
    hooks?: SqliteOpenRecoveryHooks,
): Promise<SqliteExclusiveRecoveryGate> {
    const paths = gate_paths(canonicalPath);
    const tokenId = randomUUID();
    try {
        const identities = ensure_private_gate(paths, hooks);
        assert_managed_directory(identities.gate, 'exclusive-intent-create');
        write_private_file_exclusive(paths.exclusiveIntentPath, tokenId);
        assert_managed_directory(identities.gate, 'exclusive-intent-flush');
        flush_directory(paths.gateDirectory, hooks);
        await emit(hooks, 'exclusive-after-intent-flush');
        let released = false;
        const gate: SqliteExclusiveRecoveryGate = {
            kind: 'exclusive-recovery',
            canonicalPath: paths.canonicalPath,
            tokenId,
            listReaderTokenIds(): readonly string[] {
                return existing_reader_token_ids(paths, identities);
            },
            async reclaimStaleReaderToken(
                staleTokenId: string,
                confirmation: SqliteAllProcessesClosedConfirmation,
            ): Promise<void> {
                if (confirmation.allProcessesClosed !== true || released
                    || !UUID_PATTERN.test(staleTokenId)) {
                    throw sqlite_file_state_recovery_error({ operation: 'reader-token-reclaim' });
                }
                const inventory = existing_reader_token_ids(paths, identities);
                if (!inventory.includes(staleTokenId)) {
                    throw sqlite_file_state_recovery_error({ operation: 'reader-token-reclaim' });
                }
                const tokenPath = path.join(paths.readersDirectory, `${staleTokenId}.reader`);
                if (!exact_token_matches(tokenPath, staleTokenId, identities.readers)) {
                    throw sqlite_file_state_recovery_error({ operation: 'reader-token-reclaim' });
                }
                assert_managed_directory(identities.readers, 'reader-token-reclaim');
                fs.unlinkSync(tokenPath);
                assert_managed_directory(identities.readers, 'reader-token-reclaim-flush');
                flush_directory(paths.readersDirectory, hooks);
            },
            async waitForReaders(): Promise<void> {
                if (released) throw sqlite_file_state_recovery_error({ operation: 'exclusive-gate-wait' });
                for (;;) {
                    if (existing_reader_token_ids(paths, identities).length === 0) {
                        await emit(hooks, 'exclusive-readers-drained');
                        return;
                    }
                    await emit(hooks, 'exclusive-waiting-for-readers');
                    await yield_control(hooks);
                }
            },
            async release(): Promise<void> {
                if (released) return;
                assert_managed_directory(identities.gate, 'exclusive-gate-release-check');
                if (fs.existsSync(paths.recoveryBlockPath)) {
                    throw sqlite_file_state_recovery_error({ operation: 'exclusive-gate-blocked-release' });
                }
                if (!exact_token_matches(paths.exclusiveIntentPath, tokenId, identities.gate)) {
                    throw sqlite_file_state_recovery_error({ operation: 'exclusive-gate-release' });
                }
                assert_managed_directory(identities.gate, 'exclusive-gate-release');
                fs.unlinkSync(paths.exclusiveIntentPath);
                assert_managed_directory(identities.gate, 'exclusive-gate-release-flush');
                flush_directory(paths.gateDirectory, hooks);
                released = true;
            },
        };
        exclusiveGateIdentities.set(gate, identities);
        return gate;
    } catch (error) {
        throw safe_error('exclusive-gate-acquire', error);
    }
}

export function inspect_sqlite_recovery_gate(canonicalPath: string): SqliteRecoveryGateInventory {
    const paths = gate_paths(canonicalPath);
    try {
        const identities = ensure_private_gate(paths);
        let exclusiveIntentTokenId: string | undefined;
        try {
            assert_managed_directory(identities.gate, 'exclusive-intent-inspect');
            const value = fs.readFileSync(paths.exclusiveIntentPath, 'utf8');
            if (!/^[0-9a-f-]{36}$/i.test(value)) {
                throw sqlite_file_state_recovery_error({ operation: 'exclusive-intent-inspect' });
            }
            exclusiveIntentTokenId = value;
        } catch (error) {
            if (!is_node_error(error) || error.code !== 'ENOENT') throw error;
        }
        return {
            exclusiveIntentTokenId,
            readerTokenIds: existing_reader_token_ids(paths, identities),
            recoveryBlocked: fs.existsSync(paths.recoveryBlockPath),
        };
    } catch (error) {
        throw safe_error('recovery-gate-inspect', error);
    }
}

export async function reclaim_stale_sqlite_exclusive_intent(
    canonicalPath: string,
    exactTokenId: string,
    confirmation: SqliteAllProcessesClosedConfirmation,
): Promise<void> {
    const paths = gate_paths(canonicalPath);
    try {
        const identities = ensure_private_gate(paths);
        if (confirmation.allProcessesClosed !== true
            || !exact_token_matches(paths.exclusiveIntentPath, exactTokenId, identities.gate)) {
            throw sqlite_file_state_recovery_error({ operation: 'exclusive-intent-reclaim' });
        }
        assert_managed_directory(identities.gate, 'exclusive-intent-reclaim');
        fs.unlinkSync(paths.exclusiveIntentPath);
        assert_managed_directory(identities.gate, 'exclusive-intent-reclaim-flush');
        flush_directory(paths.gateDirectory);
    } catch (error) {
        throw safe_error('exclusive-intent-reclaim', error);
    }
}

function member_for(filePath: string, kind: SqliteBasenameMember['kind']): SqliteBasenameMember | undefined {
    try {
        const stat = fs.lstatSync(filePath, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw sqlite_file_state_recovery_error({ operation: 'inventory-member-type' });
        }
        return {
            kind,
            name: path.basename(filePath),
            size: Number(stat.size),
            device: stat.dev,
            inode: stat.ino,
        };
    } catch (error) {
        if (is_node_error(error) && error.code === 'ENOENT') return undefined;
        throw error;
    }
}

export async function inventory_sqlite_basename(
    canonicalPath: string,
    hooks?: SqliteOpenRecoveryHooks,
): Promise<SqliteBasenameInventory> {
    const paths = gate_paths(canonicalPath);
    try {
        const identities = ensure_private_gate(paths, hooks);
        assert_managed_directory(identities.gate, 'inventory-gate-directory');
        const names = fs.readdirSync(paths.parentDirectory, { withFileTypes: true });
        const candidates = names
            .filter((entry) => entry.name.startsWith(`${paths.basename}${CANDIDATE_MARKER}`))
            .map((entry) => member_for(path.join(paths.parentDirectory, entry.name), 'candidate'))
            .filter((member): member is SqliteBasenameMember => member !== undefined)
            .sort((left, right) => left.name.localeCompare(right.name));
        const recoveryDirectoryNames = names
            .filter((entry) => entry.name.startsWith(`${paths.basename}${RECOVERY_MARKER}`))
            .map((entry) => entry.name);
        const incompleteRecoveryDirectories = recoveryDirectoryNames.filter((name) => {
            try {
                const recoveryIdentity = capture_recovery_directory(paths, name);
                const recoveryDirectory = recoveryIdentity.directoryPath;
                assert_managed_directory(recoveryIdentity, 'inventory-recovery-manifest');
                const manifest = validate_manifest(
                    JSON.parse(fs.readFileSync(
                        path.join(recoveryDirectory, MANIFEST_NAME),
                        'utf8',
                    )),
                    paths,
                    name,
                );
                if (manifest.state !== 'complete') return true;
                validate_completed_preservation(paths, recoveryDirectory, manifest, recoveryIdentity);
                return false;
            } catch {
                return true;
            }
        }).length;
        const inventory: SqliteBasenameInventory = {
            main: member_for(paths.canonicalPath, 'main'),
            journal: member_for(`${paths.canonicalPath}-journal`, 'journal'),
            wal: member_for(`${paths.canonicalPath}-wal`, 'wal'),
            shm: member_for(`${paths.canonicalPath}-shm`, 'shm'),
            candidates,
            recoveryBlocked: (() => {
                assert_managed_directory(identities.gate, 'inventory-recovery-block');
                return fs.existsSync(paths.recoveryBlockPath);
            })(),
            recoveryDirectories: recoveryDirectoryNames.length,
            incompleteRecoveryDirectories,
        };
        await emit(hooks, 'inventory-complete');
        return inventory;
    } catch (error) {
        throw safe_error('raw-inventory', error);
    }
}

export function read_sqlite_raw_header(
    databasePath: string,
    expectedApplicationId: number,
): SqliteRawHeader {
    let descriptor: number | undefined;
    try {
        const stat = fs.statSync(databasePath);
        if (!stat.isFile() || stat.size < SQLITE_HEADER_BYTES) {
            throw sqlite_file_state_schema_error({ operation: 'raw-header' });
        }
        descriptor = fs.openSync(databasePath, 'r');
        const header = Buffer.alloc(SQLITE_HEADER_BYTES);
        const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
        if (bytesRead !== SQLITE_HEADER_BYTES || !header.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
            throw sqlite_file_state_schema_error({ operation: 'raw-header' });
        }
        const applicationId = header.readUInt32BE(APPLICATION_ID_OFFSET);
        if (applicationId === 0 || applicationId !== expectedApplicationId) {
            throw sqlite_file_state_schema_error({ operation: 'raw-application-id' });
        }
        const writeVersion = header[18];
        const readVersion = header[19];
        if (writeVersion !== 1 || readVersion !== 1) {
            throw sqlite_file_state_schema_error({ operation: 'raw-journal-version' });
        }
        const encodedPageSize = header.readUInt16BE(16);
        return {
            applicationId,
            pageSize: encodedPageSize === 1 ? 65_536 : encodedPageSize,
            writeVersion,
            readVersion,
        };
    } catch (error) {
        throw safe_error('raw-header', error);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function has_absence_evidence(inventory: SqliteBasenameInventory): boolean {
    return inventory.journal !== undefined
        || inventory.wal !== undefined
        || inventory.shm !== undefined
        || inventory.candidates.length > 0
        || inventory.recoveryBlocked
        || inventory.incompleteRecoveryDirectories > 0;
}

function assert_preflight_inventory(inventory: SqliteBasenameInventory): void {
    if (inventory.recoveryBlocked) {
        throw sqlite_file_state_recovery_error({ operation: 'recovery-blocked' });
    }
    if (!inventory.main || inventory.main.size === 0) {
        if (inventory.main?.size === 0 || has_absence_evidence(inventory)) {
            throw sqlite_file_state_recovery_error({ operation: 'absent-main-evidence' });
        }
        return;
    }
    if (inventory.wal || inventory.shm) {
        throw sqlite_file_state_schema_error({ operation: 'delete-journal-sidecar' });
    }
}

function sqlite_rw_uri(databasePath: string): string {
    return `${pathToFileURL(databasePath).href}?mode=rw`;
}

function apply_connection_policy(database: DatabaseSync): void {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA trusted_schema = OFF');
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA secure_delete = ON');
    if (database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') {
        throw sqlite_file_state_schema_error({ operation: 'journal-policy' });
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
        throw sqlite_file_state_schema_error({ operation: 'foreign-key-check' });
    }
}

async function open_existing_under_gate(
    canonicalPath: string,
    gate: SqliteSharedReaderGate | SqliteExclusiveRecoveryGate,
    options: SqliteOpenExistingOptions,
    releaseGateOnClose: boolean,
): Promise<SqliteOpenedDatabase> {
    let database: DatabaseSync | undefined;
    try {
        const inventory = await inventory_sqlite_basename(canonicalPath, options);
        assert_preflight_inventory(inventory);
        if (!inventory.main || inventory.main.size === 0) {
            throw sqlite_file_state_recovery_error({ operation: 'open-missing-main' });
        }
        read_sqlite_raw_header(canonicalPath, options.expectedApplicationId ?? SQLITE_FILE_STATE_APPLICATION_ID);
        database = new DatabaseSync(sqlite_rw_uri(path.resolve(canonicalPath)), {
            enableDoubleQuotedStringLiterals: false,
            timeout: options.timeoutMs ?? 0,
        });
        apply_connection_policy(database);
        options.validate?.(database);
        let databaseClosed = false;
        let gateReleased = !releaseGateOnClose;
        const closeDatabase = async (): Promise<void> => {
            if (databaseClosed) return;
            try {
                database?.close();
            } finally {
                database = undefined;
                databaseClosed = true;
            }
        };
        return {
            database,
            inventory,
            canonicalPath,
            closeDatabase,
            async replaceConnection(
                replacementOptions: SqliteOpenExistingOptions = {},
            ): Promise<SqliteOpenedDatabase> {
                if (gateReleased) {
                    throw sqlite_file_state_recovery_error({ operation: 'sqlite-replace-connection' });
                }
                await closeDatabase();
                gateReleased = true;
                return open_existing_under_gate(
                    canonicalPath,
                    gate,
                    replacementOptions,
                    true,
                );
            },
            async close(): Promise<void> {
                if (databaseClosed && gateReleased) return;
                let closeError: unknown;
                try {
                    await closeDatabase();
                } catch (error) {
                    closeError = error;
                }
                if (!gateReleased) {
                    try {
                        await gate.release();
                        gateReleased = true;
                    } catch (error) {
                        closeError ??= error;
                    }
                }
                if (closeError) throw safe_error('sqlite-close', closeError);
            },
        };
    } catch (error) {
        try {
            database?.close();
        } catch {
            // Preserve the first failure.
        }
        if (releaseGateOnClose) {
            try {
                await gate.release();
            } catch {
                // Preserve the first failure.
            }
        }
        throw safe_error('sqlite-open-existing', error);
    }
}

export async function open_existing_sqlite_database(
    canonicalPath: string,
    options: SqliteOpenExistingOptions = {},
): Promise<SqliteOpenedDatabase> {
    const resolved = resolve_sqlite_canonical_path(canonicalPath);
    const gate = await acquire_sqlite_shared_reader_gate(resolved, options);
    return open_existing_under_gate(resolved, gate, options, true);
}

function scalar_bigint(database: DatabaseSync, sql: string, column: string): bigint | undefined {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    const value = statement.get()?.[column];
    return typeof value === 'bigint' ? value : undefined;
}

function validate_exact_v1_database(
    database: DatabaseSync,
    identity: SqliteFileStateIdentity,
    supportedProtocol: number,
): void {
    apply_connection_policy(database);
    validate_sqlite_file_state_database(database, { identity, supportedProtocol });
}

export function recognize_sqlite_initialization_candidate(
    candidatePath: string,
    identity: SqliteFileStateIdentity,
    expectedApplicationId = SQLITE_FILE_STATE_APPLICATION_ID,
    supportedProtocol = SQLITE_FILE_STATE_PROTOCOL_VERSION,
): SqliteCandidateRecognition {
    let database: DatabaseSync | undefined;
    let applicationId = expectedApplicationId;
    let userVersion: bigint | undefined;
    try {
        const header = read_sqlite_raw_header(candidatePath, expectedApplicationId);
        applicationId = header.applicationId;
        // Raw preflight already proved this exact candidate exists. readOnly prevents
        // creation and must not be combined with the URI's mode=rw access request.
        database = new DatabaseSync(path.resolve(candidatePath), {
            readOnly: true,
            enableDoubleQuotedStringLiterals: false,
        });
        userVersion = scalar_bigint(database, 'PRAGMA user_version', 'user_version');
        validate_exact_v1_database(database, identity, supportedProtocol);
        return {
            recognized: true,
            identityMatches: true,
            applicationId,
            userVersion: userVersion === undefined ? undefined : Number(userVersion),
        };
    } catch {
        return {
            recognized: false,
            identityMatches: false,
            applicationId,
            userVersion: userVersion === undefined ? undefined : Number(userVersion),
        };
    } finally {
        database?.close();
    }
}

async function build_candidate(
    paths: GatePaths,
    identity: SqliteFileStateIdentity,
    migration: SqliteFileStateMigrationOptions,
    expectedApplicationId: number,
    supportedProtocol: number,
    hooks: SqliteOpenRecoveryHooks,
): Promise<string> {
    const candidatePath = path.join(paths.parentDirectory, `${paths.basename}${CANDIDATE_MARKER}${randomUUID()}`);
    let database: DatabaseSync | undefined;
    try {
        database = new DatabaseSync(candidatePath, {
            enableDoubleQuotedStringLiterals: false,
        });
        initialize_sqlite_file_state_schema(database, identity, migration);
        await emit(hooks, 'candidate-after-schema');
        database.close();
        database = undefined;
        await emit(hooks, 'candidate-after-close');
        for (const suffix of ['-journal', '-wal', '-shm']) {
            if (fs.existsSync(`${candidatePath}${suffix}`)) {
                throw sqlite_file_state_recovery_error({ operation: 'candidate-sidecar' });
            }
        }
        fs.chmodSync(candidatePath, PRIVATE_FILE_MODE);
        flush_file(candidatePath);
        await emit(hooks, 'candidate-after-file-flush');
        flush_directory(paths.parentDirectory, hooks);
        await emit(hooks, 'candidate-after-directory-flush');
        const recognition = recognize_sqlite_initialization_candidate(
            candidatePath,
            identity,
            expectedApplicationId,
            supportedProtocol,
        );
        if (!recognition.recognized || !recognition.identityMatches) {
            throw sqlite_file_state_recovery_error({ operation: 'candidate-validation' });
        }
        return candidatePath;
    } catch (error) {
        try {
            database?.close();
        } catch {
            // Preserve the first failure.
        }
        throw safe_error('candidate-build', error);
    }
}

function remove_exact_candidate(
    candidatePath: string,
    expected: fs.BigIntStats,
    hooks?: SqliteOpenRecoveryHooks,
): void {
    const actual = fs.statSync(candidatePath, { bigint: true });
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
        throw sqlite_file_state_recovery_error({ operation: 'candidate-cleanup-identity' });
    }
    fs.unlinkSync(candidatePath);
    flush_directory(path.dirname(candidatePath), hooks);
}

export async function initialize_sqlite_database_no_clobber(
    canonicalPath: string,
    identity: SqliteFileStateIdentity,
    migration: SqliteFileStateMigrationOptions,
    options: SqliteInitializeOptions = {},
): Promise<SqliteInitializationResult> {
    const resolved = resolve_sqlite_canonical_path(canonicalPath);
    const paths = gate_paths(resolved);
    const expectedApplicationId = options.expectedApplicationId ?? SQLITE_FILE_STATE_APPLICATION_ID;
    const supportedProtocol = options.supportedProtocol ?? SQLITE_FILE_STATE_PROTOCOL_VERSION;
    const suppliedGate = options.gate;
    const gate = suppliedGate ?? await acquire_sqlite_shared_reader_gate(resolved, options);
    let candidatePath: string | undefined;
    let openedDatabase: SqliteOpenedDatabase | undefined;
    try {
        if (gate.canonicalPath !== resolved) {
            throw sqlite_file_state_recovery_error({ operation: 'initialization-gate-path' });
        }
        if (gate.kind === 'exclusive-recovery') {
            assert_exclusive_gate(paths, gate);
            await gate.waitForReaders();
            assert_exclusive_gate(paths, gate);
        }
        const inventory = await inventory_sqlite_basename(resolved, options);
        assert_preflight_inventory(inventory);
        if (inventory.main) {
            const database = openedDatabase = await open_existing_under_gate(resolved, gate, {
                ...options,
                expectedApplicationId,
                validate(db) {
                    validate_exact_v1_database(db, identity, supportedProtocol);
                },
            }, suppliedGate === undefined);
            await emit(options, 'winner-validated');
            return { installed: false, wonInstallation: false, database };
        }
        candidatePath = await build_candidate(
            paths,
            identity,
            migration,
            expectedApplicationId,
            supportedProtocol,
            options,
        );
        await emit(options, 'candidate-before-install');
        const recognition = recognize_sqlite_initialization_candidate(
            candidatePath,
            identity,
            expectedApplicationId,
            supportedProtocol,
        );
        if (!recognition.recognized || !recognition.identityMatches) {
            throw sqlite_file_state_schema_error({ operation: 'candidate-install-validation' });
        }
        const candidateStat = fs.statSync(candidatePath, { bigint: true });
        let wonInstallation = false;
        try {
            fs.linkSync(candidatePath, resolved);
            wonInstallation = true;
            flush_directory(paths.parentDirectory, options);
            await emit(options, 'candidate-after-install');
        } catch (error) {
            if (!is_node_error(error) || error.code !== 'EEXIST') throw error;
        }
        const database = openedDatabase = await open_existing_under_gate(resolved, gate, {
            ...options,
            expectedApplicationId,
            validate(db) {
                validate_exact_v1_database(db, identity, supportedProtocol);
            },
        }, suppliedGate === undefined);
        await emit(options, 'winner-validated');
        if (wonInstallation || identity.productKind === 'desktop') {
            remove_exact_candidate(candidatePath, candidateStat, options);
            candidatePath = undefined;
        }
        return {
            installed: wonInstallation,
            wonInstallation,
            candidatePath,
            database,
        };
    } catch (error) {
        if (openedDatabase) {
            try {
                await openedDatabase.close();
            } catch {
                // Preserve the first failure; close attempts database before owned token release.
            }
        } else if (suppliedGate === undefined) {
            try {
                await gate.release();
            } catch {
                // Preserve the first failure.
            }
        }
        throw safe_error('no-clobber-initialize', error);
    }
}

export async function install_recognized_sqlite_candidate_no_clobber(
    canonicalPath: string,
    candidatePath: string,
    identity: SqliteFileStateIdentity,
    options: SqliteResumeCandidateOptions,
): Promise<SqliteInitializationResult> {
    const resolved = resolve_sqlite_canonical_path(canonicalPath);
    const resolvedCandidate = resolve_sqlite_canonical_path(candidatePath);
    const paths = gate_paths(resolved);
    const expectedApplicationId = options.expectedApplicationId ?? SQLITE_FILE_STATE_APPLICATION_ID;
    const supportedProtocol = options.supportedProtocol ?? SQLITE_FILE_STATE_PROTOCOL_VERSION;
    let openedDatabase: SqliteOpenedDatabase | undefined;
    try {
        assert_exclusive_gate(paths, options.gate);
        await options.gate.waitForReaders();
        assert_exclusive_gate(paths, options.gate);
        if (path.dirname(resolvedCandidate) !== paths.parentDirectory
            || !path.basename(resolvedCandidate).startsWith(`${paths.basename}${CANDIDATE_MARKER}`)) {
            throw sqlite_file_state_recovery_error({ operation: 'candidate-resume-path' });
        }
        const inventory = await inventory_sqlite_basename(resolved, options);
        if (inventory.recoveryBlocked || inventory.journal || inventory.wal || inventory.shm
            || inventory.incompleteRecoveryDirectories > 0 || inventory.main?.size === 0
            || !inventory.candidates.some((candidate) => candidate.name === path.basename(resolvedCandidate))) {
            throw sqlite_file_state_recovery_error({ operation: 'candidate-resume-inventory' });
        }
        await emit(options, 'candidate-before-install');
        const recognition = recognize_sqlite_initialization_candidate(
            resolvedCandidate,
            identity,
            expectedApplicationId,
            supportedProtocol,
        );
        if (!recognition.recognized || !recognition.identityMatches) {
            throw sqlite_file_state_schema_error({ operation: 'candidate-resume-validation' });
        }
        const candidateStat = fs.statSync(resolvedCandidate, { bigint: true });
        let wonInstallation = false;
        if (!inventory.main) {
            try {
                fs.linkSync(resolvedCandidate, resolved);
                wonInstallation = true;
                flush_directory(paths.parentDirectory, options);
                await emit(options, 'candidate-after-install');
            } catch (error) {
                if (!is_node_error(error) || error.code !== 'EEXIST') throw error;
            }
        }
        const database = openedDatabase = await open_existing_under_gate(resolved, options.gate, {
            ...options,
            expectedApplicationId,
            validate(db) {
                validate_exact_v1_database(db, identity, supportedProtocol);
            },
        }, false);
        await emit(options, 'winner-validated');
        const canonicalStat = fs.statSync(resolved, { bigint: true });
        const exactInstalledIncarnation = canonicalStat.dev === candidateStat.dev
            && canonicalStat.ino === candidateStat.ino;
        if (exactInstalledIncarnation || identity.productKind === 'desktop') {
            remove_exact_candidate(resolvedCandidate, candidateStat, options);
        }
        return {
            installed: wonInstallation,
            wonInstallation,
            candidatePath: exactInstalledIncarnation || identity.productKind === 'desktop'
                ? undefined
                : resolvedCandidate,
            database,
        };
    } catch (error) {
        if (openedDatabase) {
            try { await openedDatabase.close(); } catch { /* Preserve the first failure. */ }
        }
        throw safe_error('candidate-resume-install', error);
    }
}

function inventory_preservable_members(inventory: SqliteBasenameInventory): SqliteBasenameMember[] {
    return [inventory.main, inventory.journal, inventory.wal, inventory.shm, ...inventory.candidates]
        .filter((member): member is SqliteBasenameMember => member !== undefined);
}

function initial_recovery_manifest(
    generation: string,
    members: readonly SqliteBasenameMember[],
): RecoveryManifest {
    return {
        format: 'tableViewer.sqliteRecovery.v1',
        generation,
        state: 'moving',
        members: members.map((member) => ({
            kind: member.kind,
            sourceName: member.name,
            targetName: member.name,
            size: member.size,
            device: member.device.toString(),
            inode: member.inode.toString(),
            installed: false,
            sourceRemoved: false,
        })),
    };
}

function valid_unsigned_integer_string(value: unknown): value is string {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
    try {
        return BigInt(value) >= 0n;
    } catch {
        return false;
    }
}

function expected_member_kind(paths: GatePaths, name: string): SqliteBasenameMember['kind'] | undefined {
    if (name === paths.basename) return 'main';
    if (name === `${paths.basename}-journal`) return 'journal';
    if (name === `${paths.basename}-wal`) return 'wal';
    if (name === `${paths.basename}-shm`) return 'shm';
    const candidatePrefix = `${paths.basename}${CANDIDATE_MARKER}`;
    if (name.startsWith(candidatePrefix) && UUID_PATTERN.test(name.slice(candidatePrefix.length))) {
        return 'candidate';
    }
    return undefined;
}

function capture_recovery_directory(
    paths: GatePaths,
    recoveryDirectoryName: string,
): ManagedDirectoryIdentity {
    if (path.basename(recoveryDirectoryName) !== recoveryDirectoryName
        || !recoveryDirectoryName.startsWith(`${paths.basename}${RECOVERY_MARKER}`)) {
        throw sqlite_file_state_recovery_error({ operation: 'recovery-directory-name' });
    }
    return capture_managed_directory(
        path.join(paths.parentDirectory, recoveryDirectoryName),
        paths.parentDirectory,
        'recovery-directory-verify',
    );
}

function find_empty_pre_manifest_preservation(
    paths: GatePaths,
): {
    recoveryDirectory: string;
    recoveryIdentity: ManagedDirectoryIdentity;
    generation: string;
} | undefined {
    const recoveryPrefix = `${paths.basename}${RECOVERY_MARKER}`;
    const candidates = fs.readdirSync(paths.parentDirectory, { withFileTypes: true })
        .filter((entry) => entry.name.startsWith(recoveryPrefix))
        .flatMap((entry) => {
            const generation = entry.name.slice(recoveryPrefix.length);
            if (!UUID_PATTERN.test(generation)) return [];
            try {
                const recoveryIdentity = capture_recovery_directory(paths, entry.name);
                assert_managed_directory(recoveryIdentity, 'pre-manifest-recovery-directory');
                if (fs.readdirSync(recoveryIdentity.directoryPath).length !== 0) return [];
                return [{
                    recoveryDirectory: recoveryIdentity.directoryPath,
                    recoveryIdentity,
                    generation,
                }];
            } catch {
                return [];
            }
        });
    return candidates.length === 1 ? candidates[0] : undefined;
}

function validate_manifest(
    value: unknown,
    paths: GatePaths,
    recoveryDirectoryName: string,
    expectedGeneration?: string,
): RecoveryManifest {
    const candidate = value as Partial<RecoveryManifest> | null;
    const generation = candidate?.generation;
    if (candidate?.format !== 'tableViewer.sqliteRecovery.v1'
        || typeof generation !== 'string'
        || !UUID_PATTERN.test(generation)
        || (expectedGeneration !== undefined && generation !== expectedGeneration)
        || recoveryDirectoryName !== `${paths.basename}${RECOVERY_MARKER}${generation}`
        || (candidate.state !== 'moving' && candidate.state !== 'complete')
        || !Array.isArray(candidate.members)) {
        throw sqlite_file_state_recovery_error({ operation: 'recovery-manifest' });
    }
    const names = new Set<string>();
    const kinds = new Set<SqliteBasenameMember['kind']>();
    for (const member of candidate.members) {
        const valueMember = member as Partial<ManifestMember> | null;
        const sourceName = valueMember?.sourceName;
        const targetName = valueMember?.targetName;
        const kind = valueMember?.kind;
        if (!valueMember || typeof sourceName !== 'string' || typeof targetName !== 'string'
            || sourceName !== targetName
            || path.basename(sourceName) !== sourceName
            || sourceName === '.' || sourceName === '..'
            || expected_member_kind(paths, sourceName) !== kind
            || typeof valueMember.size !== 'number' || !Number.isSafeInteger(valueMember.size)
            || valueMember.size < 0
            || !valid_unsigned_integer_string(valueMember.device)
            || !valid_unsigned_integer_string(valueMember.inode)
            || typeof valueMember.installed !== 'boolean'
            || typeof valueMember.sourceRemoved !== 'boolean'
            || (valueMember.sourceRemoved && !valueMember.installed)
            || names.has(sourceName)
            || (kind !== 'candidate' && kinds.has(kind as SqliteBasenameMember['kind']))) {
            throw sqlite_file_state_recovery_error({ operation: 'recovery-manifest-member' });
        }
        names.add(sourceName);
        kinds.add(kind as SqliteBasenameMember['kind']);
    }
    return candidate as RecoveryManifest;
}

function find_unblocked_preservation(
    paths: GatePaths,
): { recoveryDirectory: string; recoveryIdentity: ManagedDirectoryIdentity; manifest: RecoveryManifest } | undefined {
    const candidates = fs.readdirSync(paths.parentDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${paths.basename}${RECOVERY_MARKER}`))
        .flatMap((entry) => {
            try {
                const recoveryIdentity = capture_recovery_directory(paths, entry.name);
                const recoveryDirectory = recoveryIdentity.directoryPath;
                assert_managed_directory(recoveryIdentity, 'orphan-recovery-manifest');
                const manifest = validate_manifest(
                    JSON.parse(fs.readFileSync(path.join(recoveryDirectory, MANIFEST_NAME), 'utf8')),
                    paths,
                    entry.name,
                );
                return manifest.state === 'moving'
                    ? [{ recoveryDirectory, recoveryIdentity, manifest }]
                    : [];
            } catch {
                return [];
            }
        });
    if (candidates.length === 0) return undefined;
    if (candidates.length !== 1) {
        throw sqlite_file_state_recovery_error({ operation: 'orphan-preservation-count' });
    }
    const candidate = candidates[0];
    for (const member of candidate.manifest.members) {
        assert_managed_directory(candidate.recoveryIdentity, 'orphan-recovery-directory');
        if (member.installed || member.sourceRemoved
            || !stat_matches(path.join(paths.parentDirectory, member.sourceName), member)
            || fs.existsSync(path.join(candidate.recoveryDirectory, member.targetName))) {
            throw sqlite_file_state_recovery_error({ operation: 'orphan-preservation-state' });
        }
    }
    return candidate;
}

function read_recovery_block(
    paths: GatePaths,
    gateIdentity: ManagedDirectoryIdentity,
): RecoveryBlock | undefined {
    try {
        assert_managed_directory(gateIdentity, 'recovery-block-read');
        const value = JSON.parse(fs.readFileSync(paths.recoveryBlockPath, 'utf8')) as Partial<RecoveryBlock>;
        if (value.format !== 'tableViewer.sqliteRecoveryBlock.v1'
            || typeof value.generation !== 'string'
            || !UUID_PATTERN.test(value.generation)
            || value.recoveryDirectoryName !== `${paths.basename}${RECOVERY_MARKER}${value.generation}`) {
            throw sqlite_file_state_recovery_error({ operation: 'recovery-block' });
        }
        return value as RecoveryBlock;
    } catch (error) {
        if (is_node_error(error) && error.code === 'ENOENT') return undefined;
        throw error;
    }
}

function stat_matches(filePath: string, member: ManifestMember): boolean {
    try {
        const stat = fs.lstatSync(filePath, { bigint: true });
        return stat.isFile()
            && Number(stat.size) === member.size
            && stat.dev.toString() === member.device
            && stat.ino.toString() === member.inode;
    } catch (error) {
        if (is_node_error(error) && error.code === 'ENOENT') return false;
        throw error;
    }
}

function path_entry_is_absent(filePath: string): boolean {
    try {
        fs.lstatSync(filePath);
        return false;
    } catch (error) {
        if (is_node_error(error) && error.code === 'ENOENT') return true;
        throw error;
    }
}

function validate_completed_preservation(
    paths: GatePaths,
    recoveryDirectory: string,
    manifest: RecoveryManifest,
    recoveryIdentity = capture_recovery_directory(paths, path.basename(recoveryDirectory)),
): void {
    if (manifest.state !== 'complete') {
        throw sqlite_file_state_recovery_error({ operation: 'preserve-complete-state' });
    }
    for (const member of manifest.members) {
        assert_managed_directory(recoveryIdentity, 'preserve-complete-directory');
        if (!member.installed || !member.sourceRemoved
            || !stat_matches(path.join(recoveryDirectory, member.targetName), member)
            || !path_entry_is_absent(path.join(paths.parentDirectory, member.sourceName))) {
            throw sqlite_file_state_recovery_error({ operation: 'preserve-complete-validation' });
        }
    }
}

function remove_recovery_block(
    paths: GatePaths,
    gateIdentity: ManagedDirectoryIdentity,
    hooks?: SqliteOpenRecoveryHooks,
): void {
    assert_managed_directory(gateIdentity, 'recovery-block-remove');
    fs.unlinkSync(paths.recoveryBlockPath);
    assert_managed_directory(gateIdentity, 'recovery-block-remove-flush');
    flush_directory(paths.gateDirectory, hooks);
}

async function advance_preservation(
    paths: GatePaths,
    recoveryDirectory: string,
    recoveryIdentity: ManagedDirectoryIdentity,
    gateIdentity: ManagedDirectoryIdentity,
    initialManifest: RecoveryManifest,
    hooks: SqliteOpenRecoveryHooks,
): Promise<RecoveryManifest> {
    let manifest = initialManifest;
    const manifestPath = path.join(recoveryDirectory, MANIFEST_NAME);
    for (let index = 0; index < manifest.members.length; index += 1) {
        assert_managed_directory(recoveryIdentity, 'preserve-recovery-directory');
        assert_managed_directory(gateIdentity, 'preserve-gate-directory');
        let member = manifest.members[index];
        const sourcePath = path.join(paths.parentDirectory, member.sourceName);
        const targetPath = path.join(recoveryDirectory, member.targetName);
        if (!member.installed) {
            const sourceMatches = stat_matches(sourcePath, member);
            const targetMatches = stat_matches(targetPath, member);
            if (!targetMatches) {
                if (!sourceMatches) throw sqlite_file_state_recovery_error({ operation: 'preserve-source-missing' });
                assert_managed_directory(recoveryIdentity, 'preserve-target-install');
                fs.linkSync(sourcePath, targetPath);
                assert_managed_directory(recoveryIdentity, 'preserve-target-flush');
                flush_file(targetPath);
                flush_directory(recoveryDirectory, hooks);
                await emit(hooks, 'preserve-after-member-install');
            }
            member = { ...member, installed: true };
            manifest = {
                ...manifest,
                members: manifest.members.map((value, memberIndex) => memberIndex === index ? member : value),
            };
            assert_managed_directory(recoveryIdentity, 'preserve-manifest-update');
            replace_private_json(manifestPath, manifest, hooks);
            await emit(hooks, 'preserve-after-progress-flush');
        }
        if (!member.sourceRemoved) {
            const sourceMatches = stat_matches(sourcePath, member);
            const targetMatches = stat_matches(targetPath, member);
            if (!targetMatches) throw sqlite_file_state_recovery_error({ operation: 'preserve-target-missing' });
            if (sourceMatches) {
                fs.unlinkSync(sourcePath);
                flush_directory(paths.parentDirectory, hooks);
                await emit(hooks, 'preserve-after-member-source-removal');
            } else if (!path_entry_is_absent(sourcePath)) {
                throw sqlite_file_state_recovery_error({ operation: 'preserve-source-changed' });
            }
            member = { ...member, sourceRemoved: true };
            manifest = {
                ...manifest,
                members: manifest.members.map((value, memberIndex) => memberIndex === index ? member : value),
            };
            assert_managed_directory(recoveryIdentity, 'preserve-manifest-update');
            replace_private_json(manifestPath, manifest, hooks);
            await emit(hooks, 'preserve-after-progress-flush');
        }
    }
    for (const member of manifest.members) {
        assert_managed_directory(recoveryIdentity, 'preserve-final-validation');
        if (!stat_matches(path.join(recoveryDirectory, member.targetName), member)
            || !path_entry_is_absent(path.join(paths.parentDirectory, member.sourceName))) {
            throw sqlite_file_state_recovery_error({ operation: 'preserve-validation' });
        }
    }
    manifest = { ...manifest, state: 'complete' };
    assert_managed_directory(recoveryIdentity, 'preserve-complete-manifest');
    replace_private_json(manifestPath, manifest, hooks);
    assert_managed_directory(recoveryIdentity, 'preserve-complete-flush');
    flush_directory(recoveryDirectory, hooks);
    await emit(hooks, 'preserve-after-complete-flush');
    assert_managed_directory(recoveryIdentity, 'preserve-before-unblock');
    remove_recovery_block(paths, gateIdentity, hooks);
    await emit(hooks, 'preserve-after-blockade-removal');
    return manifest;
}

function assert_exclusive_gate(
    paths: GatePaths,
    gate: SqliteExclusiveRecoveryGate,
): GateDirectoryIdentities {
    const identities = exclusiveGateIdentities.get(gate);
    if (!identities
        || gate.canonicalPath !== paths.canonicalPath
        || !exact_token_matches(paths.exclusiveIntentPath, gate.tokenId, identities.gate)) {
        throw sqlite_file_state_recovery_error({ operation: 'exclusive-gate-verify' });
    }
    assert_managed_directory(identities.readers, 'exclusive-readers-verify');
    return identities;
}

export async function preserve_sqlite_basename_set(
    canonicalPath: string,
    options: SqlitePreserveOptions,
): Promise<SqlitePreservationResult> {
    const paths = gate_paths(canonicalPath);
    try {
        let gateIdentities = assert_exclusive_gate(paths, options.gate);
        await options.gate.waitForReaders();
        gateIdentities = assert_exclusive_gate(paths, options.gate);
        const existingBlock = read_recovery_block(paths, gateIdentities.gate);
        if (existingBlock) return resume_sqlite_basename_preservation(canonicalPath, options);
        const inventory = await inventory_sqlite_basename(canonicalPath, options);
        if (inventory.incompleteRecoveryDirectories > 0) {
            let orphan = find_unblocked_preservation(paths);
            if (!orphan && inventory.incompleteRecoveryDirectories === 1) {
                const preManifest = find_empty_pre_manifest_preservation(paths);
                if (preManifest) {
                    const members = inventory_preservable_members(inventory);
                    if (members.some((member) => expected_member_kind(paths, member.name) !== member.kind)) {
                        throw sqlite_file_state_recovery_error({ operation: 'preserve-member-name' });
                    }
                    const manifest = initial_recovery_manifest(preManifest.generation, members);
                    assert_managed_directory(preManifest.recoveryIdentity, 'pre-manifest-recovery-create');
                    if (fs.readdirSync(preManifest.recoveryDirectory).length !== 0) {
                        throw sqlite_file_state_recovery_error({ operation: 'pre-manifest-recovery-state' });
                    }
                    write_private_file_exclusive(
                        path.join(preManifest.recoveryDirectory, MANIFEST_NAME),
                        JSON.stringify(manifest),
                    );
                    assert_managed_directory(preManifest.recoveryIdentity, 'pre-manifest-recovery-flush');
                    flush_directory(preManifest.recoveryDirectory, options);
                    await emit(options, 'preserve-after-manifest-flush');
                    orphan = { ...preManifest, manifest };
                }
            }
            if (!orphan) {
                throw sqlite_file_state_recovery_error({ operation: 'orphan-preservation-manifest' });
            }
            const block: RecoveryBlock = {
                format: 'tableViewer.sqliteRecoveryBlock.v1',
                generation: orphan.manifest.generation,
                recoveryDirectoryName: path.basename(orphan.recoveryDirectory),
            };
            assert_managed_directory(gateIdentities.gate, 'orphan-recovery-block-create');
            write_private_file_exclusive(paths.recoveryBlockPath, JSON.stringify(block));
            assert_managed_directory(gateIdentities.gate, 'orphan-recovery-block-flush');
            flush_directory(paths.gateDirectory, options);
            await emit(options, 'preserve-after-blockade-flush');
            const completed = await advance_preservation(
                paths,
                orphan.recoveryDirectory,
                orphan.recoveryIdentity,
                gateIdentities.gate,
                orphan.manifest,
                options,
            );
            return {
                recoveryDirectory: orphan.recoveryDirectory,
                generation: completed.generation,
                memberCount: completed.members.length,
            };
        }
        const members = inventory_preservable_members(inventory);
        if (members.some((member) => expected_member_kind(paths, member.name) !== member.kind)) {
            throw sqlite_file_state_recovery_error({ operation: 'preserve-member-name' });
        }
        const generation = randomUUID();
        const recoveryDirectoryName = `${paths.basename}${RECOVERY_MARKER}${generation}`;
        const recoveryDirectory = path.join(paths.parentDirectory, recoveryDirectoryName);
        fs.mkdirSync(recoveryDirectory, { mode: PRIVATE_DIRECTORY_MODE });
        const recoveryIdentity = capture_recovery_directory(paths, recoveryDirectoryName);
        assert_managed_directory(recoveryIdentity, 'recovery-directory-create-flush');
        flush_directory(paths.parentDirectory, options);
        await emit(options, 'preserve-after-recovery-directory-flush');
        const manifest = initial_recovery_manifest(generation, members);
        assert_managed_directory(recoveryIdentity, 'recovery-manifest-create');
        write_private_file_exclusive(path.join(recoveryDirectory, MANIFEST_NAME), JSON.stringify(manifest));
        assert_managed_directory(recoveryIdentity, 'recovery-manifest-flush');
        flush_directory(recoveryDirectory, options);
        await emit(options, 'preserve-after-manifest-flush');
        const block: RecoveryBlock = {
            format: 'tableViewer.sqliteRecoveryBlock.v1',
            generation,
            recoveryDirectoryName,
        };
        assert_managed_directory(gateIdentities.gate, 'recovery-block-create');
        write_private_file_exclusive(paths.recoveryBlockPath, JSON.stringify(block));
        assert_managed_directory(gateIdentities.gate, 'recovery-block-flush');
        flush_directory(paths.gateDirectory, options);
        await emit(options, 'preserve-after-blockade-flush');
        const completed = await advance_preservation(
            paths,
            recoveryDirectory,
            recoveryIdentity,
            gateIdentities.gate,
            manifest,
            options,
        );
        return { recoveryDirectory, generation, memberCount: completed.members.length };
    } catch (error) {
        throw safe_error('preserve-basename', error);
    }
}

export async function resume_sqlite_basename_preservation(
    canonicalPath: string,
    options: SqlitePreserveOptions,
): Promise<SqlitePreservationResult> {
    const paths = gate_paths(canonicalPath);
    try {
        let gateIdentities = assert_exclusive_gate(paths, options.gate);
        await options.gate.waitForReaders();
        gateIdentities = assert_exclusive_gate(paths, options.gate);
        const block = read_recovery_block(paths, gateIdentities.gate);
        if (!block) throw sqlite_file_state_recovery_error({ operation: 'resume-no-block' });
        const recoveryIdentity = capture_recovery_directory(paths, block.recoveryDirectoryName);
        const recoveryDirectory = recoveryIdentity.directoryPath;
        assert_managed_directory(recoveryIdentity, 'resume-recovery-manifest');
        const manifest = validate_manifest(
            JSON.parse(fs.readFileSync(path.join(recoveryDirectory, MANIFEST_NAME), 'utf8')),
            paths,
            block.recoveryDirectoryName,
            block.generation,
        );
        if (manifest.state === 'complete') {
            validate_completed_preservation(paths, recoveryDirectory, manifest, recoveryIdentity);
            remove_recovery_block(paths, gateIdentities.gate, options);
            await emit(options, 'preserve-after-blockade-removal');
            return {
                recoveryDirectory,
                generation: manifest.generation,
                memberCount: manifest.members.length,
            };
        }
        const completed = await advance_preservation(
            paths,
            recoveryDirectory,
            recoveryIdentity,
            gateIdentities.gate,
            manifest,
            options,
        );
        return {
            recoveryDirectory,
            generation: completed.generation,
            memberCount: completed.members.length,
        };
    } catch (error) {
        throw safe_error('resume-preservation', error);
    }
}
