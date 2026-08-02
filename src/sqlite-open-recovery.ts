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

/**
 * What inspection found in the gate, as a *classification* rather than a verdict.
 *
 * Every field is total: a marker is absent, valid, or malformed, and inspection
 * never throws for the third case. That totality is the whole point. Each of the
 * gate's durable markers is created by an `open`+`write`+`fsync` sequence, so a
 * crash between the `open` and the `write` leaves a zero-length file that parses
 * as nothing — and inspection runs *before*, and gates, the attested quarantine
 * that is the only thing allowed to clear such a file. An inspection that threw
 * there made every torn write permanently unrecoverable from inside the app: the
 * open failed, and the recovery action failed at the same line, with no in-app
 * escape at all.
 *
 * Genuine I/O failures — anything that is not ENOENT and not malformed content —
 * still throw, and still through `safe_error`, so no path reaches a caller.
 */
export interface SqliteRecoveryGateInventory {
    /** Present only for an intent whose contents are an exact token id. */
    readonly exclusiveIntentTokenId?: string;
    /** An intent file exists but carries no token id — a torn or foreign write. */
    readonly exclusiveIntentMalformed: boolean;
    /** Entries that are `<uuid>.reader` files containing that same uuid. */
    readonly readerTokenIds: readonly string[];
    /**
     * On-disk names of `*.reader` entries that are not tokens: an unparseable
     * name, a non-file, or a valid name whose contents are not its own id.
     *
     * Names, never contents, and never for an error message: this data is
     * crash- or attacker-controlled, so it may be used to *move* the entry and
     * nothing else. Nothing in this module puts it in a `SqliteFileStateError`.
     */
    readonly malformedReaderTokenNames: readonly string[];
    /** A well-formed blockade marker naming its exact generation directory. */
    readonly recoveryBlocked: boolean;
    /** A blockade marker exists but does not parse — a torn or foreign write. */
    readonly recoveryBlockMalformed: boolean;
}

/** Everything one attested quarantine run moved out of the live gate. */
export interface SqliteGateQuarantineResult {
    readonly movedCount: number;
    /** The generation subdirectory created for this run, absent when nothing
     *  was malformed and therefore nothing was created. */
    readonly generation?: string;
}

export interface SqliteGateQuarantineOptions extends SqliteOpenRecoveryHooks {
    /** The product's chosen name for the quarantine subtree inside the gate
     *  directory. A constant chosen by the caller, never derived from disk. */
    readonly quarantineDirectoryName?: string;
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

function capture_managed_directory(
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

function assert_managed_directory(identity: ManagedDirectoryIdentity, operation: string): void {
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

/**
 * The single definition of "this directory entry could be one of our tokens".
 *
 * Shared by the strict enforcer below and by `classify_reader_tokens`, for the
 * same reason `parse_recovery_block` is shared: these two answered the same
 * question from two independent copies of the predicate, they agreed only by
 * coincidence, and when the copies drifted the classifier stopped reporting a
 * shape the enforcer still refused — which is a permanent dead-end, since the
 * open then succeeds while every later preserve fails identically with no
 * in-app action able to clear it.
 *
 * Deliberately *name and file-type only*, which is the whole of what the
 * enforcer may consider. Contents are the classifier's additional question and
 * stay there: `existing_reader_token_ids` must treat a well-formed name as a
 * live peer's token regardless of what it holds, because refusing to guess
 * about a live reader is the point.
 *
 * Returns undefined when the entry is not `<uuid>.reader` *or* is not a regular
 * file — every token this module creates is both.
 *
 * The suffix is a separate question (`claims_reader_token_name`)
 * because both callers must first distinguish "not in our namespace at all",
 * which they *skip*, from "claims a token's name but is not one", which one
 * refuses and the other classifies. Deriving both from `READER_TOKEN_SUFFIX`
 * keeps that split from becoming a third place the suffix is spelled out — a
 * caller that pre-filtered on its own literal would silently see zero entries
 * if this one ever changed.
 */
const READER_TOKEN_SUFFIX = '.reader';

function claims_reader_token_name(entry: fs.Dirent): boolean {
    return entry.name.endsWith(READER_TOKEN_SUFFIX);
}

function reader_token_id_of(entry: fs.Dirent): string | undefined {
    if (!claims_reader_token_name(entry)) return undefined;
    const tokenId = entry.name.slice(0, -READER_TOKEN_SUFFIX.length);
    if (!entry.isFile() || !UUID_PATTERN.test(tokenId)) return undefined;
    return tokenId;
}

function existing_reader_token_ids(
    paths: GatePaths,
    identities: GateDirectoryIdentities,
): string[] {
    assert_managed_directory(identities.gate, 'gate-directory-readers');
    assert_managed_directory(identities.readers, 'readers-directory-list');
    const tokenIds: string[] = [];
    for (const entry of fs.readdirSync(paths.readersDirectory, { withFileTypes: true })) {
        if (!claims_reader_token_name(entry)) continue;
        const tokenId = reader_token_id_of(entry);
        // Enforcement: anything claiming a token's name that this module could
        // never have written is a refusal to guess, not a classification.
        if (tokenId === undefined) {
            throw sqlite_file_state_recovery_error({ operation: 'reader-token-inventory' });
        }
        tokenIds.push(tokenId);
    }
    return tokenIds.sort();
}

/**
 * The exact incarnation of a marker file at the moment it was classified.
 *
 * Carried from classification to the rename so the quarantine can prove it is
 * moving the same bytes it judged, rather than whatever now occupies the name.
 * Identity and size only — no timestamps, because a time comparison would be
 * the age-based reasoning this module refuses everywhere else.
 */
interface MarkerIdentity {
    readonly device: bigint;
    readonly inode: bigint;
    readonly size: bigint;
}

/** Undefined when the entry is absent or is not a regular file; a symlink is
 *  deliberately not followed, matching every other lstat in this module. */
function capture_marker_identity(filePath: string): MarkerIdentity | undefined {
    let stat: fs.BigIntStats;
    try {
        stat = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
        if (is_node_error(error) && error.code === 'ENOENT') return undefined;
        throw error;
    }
    if (!stat.isFile()) return undefined;
    return { device: stat.dev, inode: stat.ino, size: stat.size };
}

/**
 * A `*.reader` entry that is not a live token.
 *
 * `identity` is present only for a regular file, and `tokenId` only when the
 * *name* parsed as a uuid — i.e. when a later write could still make the entry
 * a genuine token, which an unparseable name never can.
 *
 * Both are optional because a non-regular file (a directory, symlink, or fifo
 * on a token's name) still has to be *reported and clearable*. Requiring an
 * identity here is precisely the regression this shape exists to prevent: such
 * an entry vanished from inspection while `existing_reader_token_ids` kept
 * refusing it, so the app opened normally and then failed every preserve
 * identically, with no in-app escape at all.
 */
interface MalformedReaderCandidate {
    readonly name: string;
    readonly tokenId?: string;
    readonly identity?: MarkerIdentity;
}

interface ClassifiedReaderTokens {
    readonly tokenIds: readonly string[];
    readonly malformedNames: readonly string[];
    readonly malformedCandidates: readonly MalformedReaderCandidate[];
}

/**
 * The non-throwing sibling of `existing_reader_token_ids`.
 *
 * A *classifier*, not a relaxed enforcer. `existing_reader_token_ids` stays
 * strict because its two callers — `waitForReaders` and `reclaimStaleReaderToken`
 * — are enforcement: neither may proceed past an entry it cannot account for.
 * This one answers the different question the quarantine and the recovery dialog
 * need, "what is here, and which of it was never a token", and it answers it for
 * every entry rather than stopping at the first surprise.
 *
 * Contents are checked here and deliberately not there: every token this module
 * creates is `<uuid>.reader` holding that same uuid, so a valid name with other
 * contents was never a live reader — but the strict inventory only validates the
 * name, so such an entry was counted as a live reader, failed
 * `reclaimStaleReaderToken`'s exact-token check, and left `waitForReaders`
 * spinning on a reader that never existed.
 *
 * A read failure that is not ENOENT is a genuine I/O condition and propagates;
 * only unreadable-as-a-token is a classification.
 */
function classify_reader_tokens(
    paths: GatePaths,
    identities: GateDirectoryIdentities,
): ClassifiedReaderTokens {
    assert_managed_directory(identities.gate, 'gate-directory-readers');
    assert_managed_directory(identities.readers, 'readers-directory-list');
    const tokenIds: string[] = [];
    const malformed: MalformedReaderCandidate[] = [];
    for (const entry of fs.readdirSync(paths.readersDirectory, { withFileTypes: true })) {
        if (!claims_reader_token_name(entry)) continue;
        const entryPath = path.join(paths.readersDirectory, entry.name);
        // Exactly the enforcer's predicate, shared rather than restated.
        const tokenId = reader_token_id_of(entry);
        if (tokenId === undefined) {
            // Reported whether or not an identity could be captured. A directory,
            // symlink, or fifo on a token's name has no `MarkerIdentity` — and
            // must still be visible here, because the enforcer refuses it and
            // only the attested quarantine can clear it. Dropping it for want of
            // an identity is what silently reinstated the dead-end.
            const unusable = capture_marker_identity(entryPath);
            malformed.push({
                name: entry.name,
                ...(unusable === undefined ? {} : { identity: unusable }),
            });
            continue;
        }
        // Captured before the contents are read, so the identity recorded is the
        // one whose bytes the classification below is about.
        const identity = capture_marker_identity(entryPath);
        // Raced away between the readdir and the stat: a live peer releasing its
        // own token, which is ordinary and not malformed.
        if (identity === undefined) continue;
        let contents: string;
        try {
            contents = fs.readFileSync(entryPath, 'utf8');
        } catch (error) {
            // ENOENT is a live peer releasing its own token between the readdir
            // and the read, which is the ordinary case and not malformed. Any
            // other errno is a real filesystem condition the caller must see.
            if (is_node_error(error) && error.code === 'ENOENT') continue;
            throw error;
        }
        if (contents === tokenId) tokenIds.push(tokenId);
        else malformed.push({ name: entry.name, tokenId, identity });
    }
    const malformedCandidates = [...malformed].sort((left, right) =>
        left.name.localeCompare(right.name));
    return {
        tokenIds: tokenIds.sort(),
        malformedNames: malformedCandidates.map((candidate) => candidate.name),
        malformedCandidates,
    };
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

/**
 * The single definition of what an exclusive-intent marker's contents must be.
 *
 * The block marker has `parse_recovery_block` and the reader token has
 * `reader_token_id_of`; this one was still stated twice — in the classifier and
 * again in the quarantine's re-check lambda. They cannot disagree today, being
 * the same constant over the same input, but that is exactly what was true of
 * every other pair here before it drifted.
 */
function parse_exclusive_intent(raw: string): string | undefined {
    return UUID_PATTERN.test(raw) ? raw : undefined;
}

/** Absent, an exact token id, or present-but-unparseable — never a throw for
 *  the third case, which is what a crash between the marker's `open` and its
 *  `write` leaves behind. */
function classify_exclusive_intent(
    paths: GatePaths,
    identities: GateDirectoryIdentities,
): { tokenId?: string; malformed: boolean; identity?: MarkerIdentity } {
    assert_managed_directory(identities.gate, 'exclusive-intent-inspect');
    // Absent, present-as-a-file, or present-as-something-else — all three are
    // classifications, none is a throw. A *directory* on this name made
    // `readFileSync` fail EISDIR, which is not ENOENT and so propagated: the
    // preflight refused the open and the preserve refused too, which is the same
    // dialog loop with no exit that totality exists to prevent.
    const present = fs.lstatSync(paths.exclusiveIntentPath, { throwIfNoEntry: false });
    if (present === undefined) return { malformed: false };
    if (!present.isFile()) return { malformed: true };
    // Captured before the read, so the identity belongs to the bytes classified.
    const identity = capture_marker_identity(paths.exclusiveIntentPath);
    let value: string;
    try {
        value = fs.readFileSync(paths.exclusiveIntentPath, 'utf8');
    } catch (error) {
        if (is_node_error(error) && error.code === 'ENOENT') return { malformed: false };
        throw error;
    }
    const tokenId = parse_exclusive_intent(value);
    if (tokenId === undefined) return { malformed: true, identity };
    return { tokenId, malformed: false };
}

/** The same three-way classification for the blockade marker. Deliberately not
 *  `read_recovery_block`, which throws on malformed JSON *and* is what the
 *  resume path calls: routing a torn marker to resume was dead-end (b). */
/**
 * The single definition of what a well-formed blockade marker is.
 *
 * Shared by the classifier below and by `read_recovery_block`, the enforcer,
 * and deliberately not duplicated between them. The two callers legitimately
 * differ in what they *do* with the answer — one classifies, one throws — but
 * if they ever differed in what they *accept*, dead-end (b) comes straight
 * back: a classifier laxer than the enforcer reports a torn marker as a
 * legitimate blockade, the desktop routes to
 * `resume_sqlite_basename_preservation` on that word, and the enforcer then
 * refuses to parse the very file the classifier vouched for — a loop no in-app
 * action can break.
 *
 * A test asserting the two agreed would only have pinned the shapes someone
 * thought to enumerate; there being one copy is what makes the drift
 * unrepresentable. ENOENT handling and the `assert_managed_directory` stage
 * names stay with each caller, because those genuinely differ.
 *
 * Returns undefined for "not a blockade marker", never throwing — including for
 * unparseable JSON, which is exactly what a crash between the marker's `open`
 * and its `write` leaves behind.
 */
function parse_recovery_block(raw: string, paths: GatePaths): RecoveryBlock | undefined {
    let value: Partial<RecoveryBlock>;
    try {
        value = JSON.parse(raw) as Partial<RecoveryBlock>;
    } catch {
        return undefined;
    }
    if (value?.format !== 'tableViewer.sqliteRecoveryBlock.v1'
        || typeof value.generation !== 'string'
        || !UUID_PATTERN.test(value.generation)
        || value.recoveryDirectoryName !== `${paths.basename}${RECOVERY_MARKER}${value.generation}`) {
        return undefined;
    }
    return value as RecoveryBlock;
}

function classify_recovery_block(
    paths: GatePaths,
    identities: GateDirectoryIdentities,
): { valid: boolean; malformed: boolean; identity?: MarkerIdentity } {
    assert_managed_directory(identities.gate, 'recovery-block-inspect');
    // Total over file types for the same reason as the intent marker above: a
    // directory here threw EISDIR out of `readFileSync` and blocked both the
    // open and the recovery action.
    const present = fs.lstatSync(paths.recoveryBlockPath, { throwIfNoEntry: false });
    if (present === undefined) return { valid: false, malformed: false };
    if (!present.isFile()) return { valid: false, malformed: true };
    // Captured before the read, so the identity belongs to the bytes classified.
    const identity = capture_marker_identity(paths.recoveryBlockPath);
    let raw: string;
    try {
        raw = fs.readFileSync(paths.recoveryBlockPath, 'utf8');
    } catch (error) {
        if (is_node_error(error) && error.code === 'ENOENT') return { valid: false, malformed: false };
        throw error;
    }
    // Present but unacceptable is the *malformed* case, not the absent one: the
    // file still obstructs everything a well-formed blockade would.
    return parse_recovery_block(raw, paths) === undefined
        ? { valid: false, malformed: true, identity }
        : { valid: true, malformed: false };
}

export function inspect_sqlite_recovery_gate(canonicalPath: string): SqliteRecoveryGateInventory {
    const paths = gate_paths(canonicalPath);
    try {
        const identities = ensure_private_gate(paths);
        const intent = classify_exclusive_intent(paths, identities);
        const readers = classify_reader_tokens(paths, identities);
        const block = classify_recovery_block(paths, identities);
        return {
            ...(intent.tokenId === undefined ? {} : { exclusiveIntentTokenId: intent.tokenId }),
            exclusiveIntentMalformed: intent.malformed,
            readerTokenIds: readers.tokenIds,
            malformedReaderTokenNames: readers.malformedNames,
            recoveryBlocked: block.valid,
            recoveryBlockMalformed: block.malformed,
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

const DEFAULT_GATE_QUARANTINE_DIRECTORY_NAME = 'quarantined-markers';

/**
 * Create one level of managed directory beneath an already-captured parent.
 *
 * Non-recursive on purpose, so it fails closed on EEXIST rather than following a
 * planted symlink, and captured immediately afterwards so the caller never holds
 * a path that nothing has verified. The `mkdirSync` is the one place a capture
 * cannot precede the use, because the directory does not exist yet.
 */
function create_managed_child_directory(
    parent: ManagedDirectoryIdentity,
    name: string,
    operation: string,
    hooks: SqliteOpenRecoveryHooks | undefined,
): ManagedDirectoryIdentity {
    // Checked *before* the `mkdirSync`, not left to the capture afterwards. The
    // capture does reject a traversal name — but only after `mkdirSync` has
    // already created the directory somewhere outside this parent, and the
    // failing path then leaves it behind. `'../<basename>.recovery.<uuid>'` is
    // the worst shape: an empty, recovery-directory-shaped entry in the basename
    // namespace, which is exactly what `find_empty_pre_manifest_preservation`
    // selects and `inventory_sqlite_basename` counts as incomplete — the
    // primitive whose only job is restoring recoverability manufacturing an
    // unrecoverable state instead. Same discipline as `capture_recovery_directory`.
    if (path.basename(name) !== name || name === '' || name === '.' || name === '..') {
        throw sqlite_file_state_recovery_error({ operation: 'gate-quarantine-name' });
    }
    const childPath = path.join(parent.physicalPath, name);
    try {
        fs.mkdirSync(childPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
        // EEXIST is only tolerable for a directory we then prove is a real,
        // non-symlinked child of this exact parent; `capture_managed_directory`
        // is what proves it, so a planted link fails there rather than here.
        if (!is_node_error(error) || error.code !== 'EEXIST') throw error;
    }
    const identity = capture_managed_directory(childPath, parent.physicalPath, operation);
    // Flushed before anything is written inside, so a crash cannot leave a moved
    // marker in a directory whose own entry never reached the disk.
    assert_managed_directory(parent, operation);
    flush_directory(parent.physicalPath, hooks);
    return identity;
}

/**
 * Move every malformed gate marker out of the live gate, under the explicit
 * all-processes-closed attestation.
 *
 * The one primitive that may clear a marker inspection classified malformed, and
 * the reason inspection is allowed to be total: a torn `exclusive-intent`, a torn
 * `recovery-block.json`, and a `*.reader` entry that was never a token are each
 * unrecoverable from inside the app unless *something* attested may set them
 * aside, and nothing else is.
 *
 * The rules it does not bend:
 *
 * - it **moves**, never deletes. A torn marker is evidence about how the
 *   directory reached this state, and nothing in this module destroys evidence.
 * - a *valid* marker is untouched, including one that becomes valid *after*
 *   classification. A well-formed intent or reader token is indistinguishable
 *   from a live peer's, so clearing one stays the exclusive gate's exact-id path
 *   — and there is no PID, TTL, age, or heartbeat anywhere here, because
 *   reclaiming by time would let a momentarily slow live peer have its database
 *   moved out from under it. Each entry is therefore re-read and re-classified
 *   immediately before its rename, and the move refused on any change: the
 *   zero-length instant inside `write_private_file_exclusive` is a real window,
 *   not a theoretical one, and a peer that finishes its write inside it owns a
 *   live marker no matter what the earlier classification said.
 * - the quarantine subtree's name must be a plain basename, checked before any
 *   directory is created rather than after.
 * - without the attestation it refuses, before touching anything.
 * - every directory is *captured* before it is used, and every child is derived
 *   from its parent's verified `physicalPath` rather than joined onto a raw
 *   string. A symlinked *gate* is the case a leaf-only check cannot see: through
 *   one, `readers/` is a genuine directory that passes its own lstat while every
 *   path built from it resolves into the link target.
 */
export async function quarantine_malformed_sqlite_gate_markers(
    canonicalPath: string,
    confirmation: SqliteAllProcessesClosedConfirmation,
    options: SqliteGateQuarantineOptions = {},
): Promise<SqliteGateQuarantineResult> {
    const paths = gate_paths(canonicalPath);
    try {
        if (confirmation?.allProcessesClosed !== true) {
            throw sqlite_file_state_recovery_error({ operation: 'gate-quarantine-attestation' });
        }
        const identities = ensure_private_gate(paths, options);
        const intent = classify_exclusive_intent(paths, identities);
        const readers = classify_reader_tokens(paths, identities);
        const block = classify_recovery_block(paths, identities);
        if (!intent.malformed && !block.malformed && readers.malformedNames.length === 0) {
            return { movedCount: 0 };
        }
        const quarantineRoot = create_managed_child_directory(
            identities.gate,
            options.quarantineDirectoryName ?? DEFAULT_GATE_QUARANTINE_DIRECTORY_NAME,
            'gate-quarantine-directory',
            options,
        );
        // One fresh generation per run, so two runs cannot collide on a name and
        // nothing ever has to be overwritten to make room for evidence.
        const generation = randomUUID();
        const generationDirectory = create_managed_child_directory(
            quarantineRoot,
            generation,
            'gate-quarantine-directory',
            options,
        );
        let movedCount = 0;
        let movedFromReaders = false;
        let movedFromGate = false;
        // Re-asserted per move rather than once before the loop, matching
        // `advance_preservation`: one assertion up front covers the first rename
        // and leaves every later one running on a stale check.
        //
        // The *entry* is re-read too, immediately before its rename, and the
        // move is refused unless it is still the same incarnation and still
        // malformed. Asserting only the directory left a wide window — two
        // `mkdirSync`, two `flush_directory`, and a `capture_managed_directory`
        // separate classification from the first rename — and the shape that
        // fits through it is not hypothetical: it is exactly the transient
        // `write_private_file_exclusive` produces, `openSync('wx')` → *(a
        // zero-length file exists right here)* → `writeFileSync` → `fsync`. A
        // live peer mid-`acquire_sqlite_shared_reader_gate` therefore had its
        // token classified malformed and moved, then wrote into the moved file
        // and returned a gate it believed was live, while a fresh exclusive gate
        // saw no readers at all — a live reader evicted on content shape alone,
        // with none of the exact-id attestation this function's own contract
        // promises. Identity comparison, not liveness guessing: still no PID,
        // TTL, age, or heartbeat anywhere.
        const move = (
            source: ManagedDirectoryIdentity,
            name: string,
            stillMalformed: (contents: string) => boolean,
            expected: MarkerIdentity | undefined,
        ): void => {
            assert_managed_directory(source, 'gate-quarantine-move');
            assert_managed_directory(generationDirectory, 'gate-quarantine-move');
            const markerPath = path.join(source.physicalPath, name);
            if (expected === undefined) {
                // A non-regular file on a marker's name: a directory, a symlink,
                // a fifo. It has no identity to compare and no contents to
                // re-classify, but it is not nothing — the enforcers refuse it,
                // so it must still be clearable or it is a permanent dead-end.
                //
                // The become-valid race this function guards against cannot apply
                // here: nothing this module writes is ever a non-regular file, so
                // such an entry can never turn into one of our markers, and there
                // is no live peer whose work could be stolen. It is re-checked as
                // still-not-a-file immediately before the rename all the same, so
                // an entry replaced by a genuine marker in the meantime is left
                // alone. Renamed, not removed: `renameSync` moves a directory or
                // a symlink itself, so the evidence survives intact.
                const stillPresent = fs.lstatSync(markerPath, { throwIfNoEntry: false });
                if (stillPresent === undefined || stillPresent.isFile()) return;
                fs.renameSync(markerPath, path.join(generationDirectory.physicalPath, name));
                movedCount += 1;
                if (source === identities.readers) movedFromReaders = true;
                else movedFromGate = true;
                return;
            }
            const actual = capture_marker_identity(markerPath);
            // Vanished, replaced, or grown since classification: whatever is
            // there now was not what was classified, so it is not ours to move.
            // Refused rather than re-classified in place, because a marker that
            // is changing under us is precisely the live peer this must not
            // touch.
            //
            // device/inode/size is not a perfect incarnation test on its own — an
            // unlink-and-recreate can reuse the freed inode, and a same-length
            // replacement then matches all three. Adding `ctimeNs` was tried and
            // rejected: an in-place rewrite that leaves the marker *still
            // malformed* also changes ctime, so comparing it refuses markers this
            // primitive must move, which is the inert-primitive failure wearing a
            // different hat (the "bytes churn but never become a token" test
            // catches exactly that).
            //
            // It does not need to be perfect, because it is not the last gate. The
            // `stillMalformed` re-read below runs on the bytes actually present at
            // rename time, so the outcome that would matter — moving a marker a
            // live peer has since made *valid* — is refused there regardless of
            // whether the identity check was fooled. Identity narrows the window;
            // the contents re-check is what closes it.
            if (actual === undefined
                || actual.device !== expected.device
                || actual.inode !== expected.inode
                || actual.size !== expected.size) {
                return;
            }
            let contents: string;
            try {
                contents = fs.readFileSync(markerPath, 'utf8');
            } catch (error) {
                if (is_node_error(error) && error.code === 'ENOENT') return;
                throw error;
            }
            if (!stillMalformed(contents)) return;
            fs.renameSync(
                markerPath,
                path.join(generationDirectory.physicalPath, name),
            );
            movedCount += 1;
            if (source === identities.readers) movedFromReaders = true;
            else movedFromGate = true;
        };
        for (const candidate of readers.malformedCandidates) {
            move(
                identities.readers,
                candidate.name,
                // A `<uuid>.reader` is a token only when it holds that same uuid;
                // a name that never parsed as one can never become valid.
                (contents) => candidate.tokenId === undefined || contents !== candidate.tokenId,
                candidate.identity,
            );
        }
        // Gated on `malformed` alone, never on the identity being present: a
        // *non-file* marker is malformed and has no identity, and skipping it for
        // want of one is exactly the regression this guards. `move` takes the
        // undefined-identity branch for those.
        if (intent.malformed) {
            move(
                identities.gate,
                EXCLUSIVE_INTENT_NAME,
                (contents) => parse_exclusive_intent(contents) === undefined,
                intent.identity,
            );
        }
        if (block.malformed) {
            move(
                identities.gate,
                RECOVERY_BLOCK_NAME,
                (contents) => parse_recovery_block(contents, paths) === undefined,
                block.identity,
            );
        }
        // Flushed only where something actually moved, since a refused move
        // leaves the directory entry untouched.
        assert_managed_directory(generationDirectory, 'gate-quarantine-flush');
        flush_directory(generationDirectory.physicalPath, options);
        if (movedFromReaders) {
            assert_managed_directory(identities.readers, 'gate-quarantine-flush');
            flush_directory(identities.readers.physicalPath, options);
        }
        if (movedFromGate) {
            assert_managed_directory(identities.gate, 'gate-quarantine-flush');
            flush_directory(identities.gate.physicalPath, options);
        }
        return { movedCount, generation };
    } catch (error) {
        throw safe_error('gate-quarantine', error);
    }
}

/**
 * The single definition of "this name is in our candidate namespace".
 *
 * Extracted for the same reason as `parse_recovery_block` and
 * `reader_token_id_of`, and after the same defect: the inventory tested only the
 * prefix while `expected_member_kind` also required a uuid tail, so a
 * `<basename>.init-candidate.zzz` was counted as absence evidence that blocked
 * the open and then refused by name when the user reached for the very recovery
 * action the refusal pointed them at — `preserve-member-name`, with no in-app
 * escape. An interrupted install, a sync client, or a restore produces that file
 * without anyone hand-editing anything.
 *
 * **Prefix only, deliberately.** Reconciling the two on the *strict* rule would
 * have made the inventory ignore such a file, which is worse: it sits in the
 * namespace this module installs from, so ignoring it means initializing a fresh
 * database beside an unexplained artifact — precisely the "never initialize when
 * a candidate remains" rule the plan states. Accepting it as a preservable
 * member instead means the set-aside moves it with the rest of the set, which is
 * both honest and clearable.
 *
 * The narrower "is this a candidate *we* built" question still exists, but it is
 * answered by content — `recognize_sqlite_initialization_candidate` opens the
 * file and validates its schema and identity — not by trusting a filename.
 */
function is_candidate_member_name(paths: GatePaths, name: string): boolean {
    const candidatePrefix = `${paths.basename}${CANDIDATE_MARKER}`;
    return name.startsWith(candidatePrefix) && name.length > candidatePrefix.length;
}

/**
 * Refusing a non-regular file here is enforcement, and deliberately *not* the
 * classify-then-quarantine treatment the gate markers get.
 *
 * The rule "whatever the open path refuses on, the attested recovery path must be
 * able to clear" is scoped to **module-owned** namespaces. The recovery gate is
 * ours: we create every marker in it, so anything malformed there is our own
 * residue and clearing it is our responsibility. The basename set lives in the
 * user's `state/` directory, and a folder or link occupying one of its names was
 * put there by someone else — a sync client, a restore, a hand-edit. Moving it
 * would be Table Viewer silently touching state it did not create.
 *
 * So no action is offered rather than an action that fails: `obstructed` is
 * excluded from `can_preserve` in desktop/main/state-recovery-dialog.ts, and the
 * prose names the obstruction so the user can resolve it. That is the honest
 * shape — the dead-end this module eliminates is an *offered* action that fails
 * identically every time, not the absence of an offer.
 */
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
            .filter((entry) => is_candidate_member_name(paths, entry.name))
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
        // Same namespace predicate as the inventory and `expected_member_kind`.
        // The stronger question — is this a candidate *we* built — is answered
        // below by `recognize_sqlite_initialization_candidate`, which opens the
        // file and validates its schema and exact identity rather than trusting
        // its name.
        if (path.dirname(resolvedCandidate) !== paths.parentDirectory
            || !is_candidate_member_name(paths, path.basename(resolvedCandidate))) {
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
    if (is_candidate_member_name(paths, name)) return 'candidate';
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
        // Same acceptance predicate as `classify_recovery_block`, by
        // construction rather than by agreement — see `parse_recovery_block`.
        // Only the response differs: this is an enforcement path, so anything
        // the shared parser rejects is a refusal, never a classification.
        const value = parse_recovery_block(fs.readFileSync(paths.recoveryBlockPath, 'utf8'), paths);
        if (value === undefined) {
            throw sqlite_file_state_recovery_error({ operation: 'recovery-block' });
        }
        return value;
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
        // Completion is proven by the manifest and by the *preserved* bytes:
        // every member marked installed and source-removed, and every target
        // still the exact incarnation the manifest recorded.
        //
        // Deliberately *not* by the source name still being absent. Absence is
        // only meaningful while the move is in flight and the gate is still
        // exclusive, which is where `advance_preservation`'s final loop enforces
        // it — the sole remaining enforcement point, pinned by "refuses to mark a
        // move complete while a source name is reoccupied mid-move" in
        // src/test/sqlite-open-recovery.test.ts. Deleting the clause there while
        // this one is gone would let a preserve report `complete` over a source
        // member still sitting on its canonical name, so the two must move
        // together. Once the move is complete the gate is released and the app
        // legitimately re-creates `<basename>` — that is the entire point of
        // "Set Aside and Start Fresh" — so requiring absence here re-classified
        // every already-completed recovery directory as incomplete from the next
        // launch onward. `preserve_sqlite_basename_set` then took the orphan
        // branch, found no resumable manifest, and threw
        // `orphan-preservation-manifest`: recovery worked exactly once per
        // directory, and the second one had no in-app escape.
        if (!member.installed || !member.sourceRemoved
            || !stat_matches(path.join(recoveryDirectory, member.targetName), member)) {
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
    // The one place source-absence is enforced, and load-bearing precisely
    // because it is the only one: `validate_completed_preservation` deliberately
    // does not repeat it, since by the time a manifest says `complete` the gate
    // has been released and the app re-creates the canonical name on purpose.
    // Here the gate is still exclusive and the move is still in flight, so
    // anything back on a source name means the set is not the set the manifest
    // describes. Removing this clause would turn a loud refusal into a preserve
    // that reports success over a half-moved set; the test named in
    // `validate_completed_preservation`'s comment pins exactly that.
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
