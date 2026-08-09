import { randomUUID } from 'node:crypto';
import { compare_authority } from './authority-order';
import {
    decode_stored_per_file_state,
    type PerFileState,
    type StoredPerFileState,
} from './types';

const STATE_FORMAT = 'tableViewer.fileState.v1';
const STALE_STAGE_MS = 24 * 60 * 60 * 1000;
const EXHAUSTION_SENTINEL = Number.MAX_SAFE_INTEGER;
export const DEFAULT_MAX_STORED_FILES = 10_000;

export interface FileStateSnapshot {
    state: StoredPerFileState;
    revision: number;
}

export interface DurableFileAuthority {
    commitSequence: number;
    authorityRevision: number;
    physicalRevision: number;
    projectionRevision: number;
    physicalDigest?: string;
}

export type AuthorityTransactionKind = 'physical' | 'projection';

export interface AuthorityTransactionStageInput {
    id: string;
    kind: AuthorityTransactionKind;
    ordinal: number;
    expectedStateRevision: number;
    expectedCommitSequence: number;
    nextState?: PerFileState;
    physicalDigest?: string;
}

export type AuthorityTransactionStageResult =
    | { type: 'staged' }
    | { type: 'conflict'; snapshot: FileStateSnapshot; authority: DurableFileAuthority };

export interface AuthorityTransactionInspection {
    snapshot: FileStateSnapshot;
    authority: DurableFileAuthority;
    stagePresent: boolean;
}

export type AuthorityTransactionFinalizeResult =
    | { type: 'finalized'; snapshot: FileStateSnapshot; authority: DurableFileAuthority }
    | { type: 'conflict'; snapshot: FileStateSnapshot; authority: DurableFileAuthority };

export type FileStateCompareAndSetResult =
    | { type: 'committed'; snapshot: FileStateSnapshot; authority: DurableFileAuthority }
    | { type: 'conflict'; snapshot: FileStateSnapshot; authority: DurableFileAuthority };

export interface FileStateWriteBasis {
    readonly expectedAuthorityRevision: number;
    readonly expectedPhysicalRevision?: number;
    readonly expectedProjectionRevision?: number;
    readonly recoveryRecordId?: string;
}

export interface PendingEditCopyBasis {
    readonly destinationRecoveryEntryId?: string;
    readonly destinationRecoveryRecordId?: string;
}

export interface FileStateLease {
    release(): Promise<void>;
}

export type FileStateCopyResult =
    | { readonly type: 'copied'; readonly source: FileStateSnapshot; readonly destination: FileStateSnapshot }
    | { readonly type: 'sourceAbsent'; readonly source: FileStateSnapshot; readonly destination: FileStateSnapshot }
    | { readonly type: 'destinationExists'; readonly destination: FileStateSnapshot }
    | { readonly type: 'sourceBusy' }
    | { readonly type: 'recoveryRequired' }
    | { readonly type: 'unsupported' };

export interface FileStateStore {
    read(file_path: string): Promise<FileStateSnapshot>;
    compare_and_set(
        file_path: string,
        expected_revision: number,
        state: PerFileState,
        validate?: () => boolean | undefined,
        basis?: FileStateWriteBasis,
    ): Promise<FileStateCompareAndSetResult>;
    canonicalize_path?(
        canonical_path: string,
        canonical_key: (file_path: string) => string,
    ): Promise<void>;
    lease_entry?(
        canonical_path: string,
        canonical_key: (file_path: string) => string,
        copy_from_if_absent?: string,
        copy_id?: string,
        pending_edit_basis?: PendingEditCopyBasis,
    ): Promise<FileStateLease>;
    copy_entry_if_absent?(
        source_path: string,
        destination_path: string,
        copy_id: string,
        pending_edit_basis?: PendingEditCopyBasis,
    ): Promise<FileStateCopyResult>;
    touch(file_path: string): Promise<void>;
}

export interface AuthorityFileStateStore extends FileStateStore {
    read_authority(file_path: string): Promise<DurableFileAuthority>;
    stage_authority_transaction(
        file_path: string,
        stage: AuthorityTransactionStageInput,
    ): Promise<AuthorityTransactionStageResult>;
    finalize_authority_transaction(
        file_path: string,
        stage_id: string,
    ): Promise<AuthorityTransactionFinalizeResult>;
    inspect_authority_transaction(
        file_path: string,
        stage_id: string,
    ): Promise<AuthorityTransactionInspection>;
    discard_authority_transaction(file_path: string, stage_id: string): Promise<void>;
    cleanup_authority_transactions(file_path: string, now?: number): Promise<void>;
}

/** Compatibility port for the existing whole-envelope Memento/JSON backends. */
export interface FileStatePersistenceMedium {
    readonly runtime_key: object;
    read(): unknown;
    write(envelope: unknown): Promise<void>;
}

export type CanonicalizationRevisionPolicy =
    | 'preserve-winner-revision'
    | 'allocate-revision-when-target-absent';

export interface PersistedKeyedStateEntryMetadata {
    readonly path: string;
    readonly stateRevision: number;
    readonly hasPendingEdits: boolean;
    readonly authority: DurableFileAuthority;
    readonly recencyOrder: bigint;
    readonly updatedAtMs?: number;
    readonly touchedAtMs?: number;
    readonly recoveryEntryId: string;
    readonly recoveryRecordId?: string;
    readonly copyProvenance?: {
        readonly id: string;
        readonly sourcePath: string;
        readonly sourceRevision: number;
    };
    readonly authorityStageCount?: number;
    readonly oldestAuthorityStageCreatedAtMs?: number;
}

export interface PersistedKeyedStateEntry extends PersistedKeyedStateEntryMetadata {
    readonly stateJson: string;
}

export interface PersistedAuthorityStageRecord extends AuthorityTransactionStageInput {
    readonly createdAt: number;
}

export interface PersistedCompleteKeyedStateEntry {
    readonly entry: PersistedKeyedStateEntry;
    readonly stages: readonly PersistedAuthorityStageRecord[];
}

export interface KeyedStateStoreMetadata {
    readonly nextRevision: number;
    readonly absenceRevision: number;
    readonly nextRecencyOrder: bigint;
    readonly updatedAtMs?: number;
}

export interface KeyedStateReadTransaction {
    metadata(): KeyedStateStoreMetadata;
    read_entry_metadata(path: string): PersistedKeyedStateEntryMetadata | undefined;
    read_entry(path: string): PersistedCompleteKeyedStateEntry | undefined;
    read_authority_stages(path: string): readonly PersistedAuthorityStageRecord[];
    scan_entry_metadata(): readonly PersistedKeyedStateEntryMetadata[];
    entry_is_leased(path: string): boolean;
}

export interface KeyedStateWriteTransaction extends KeyedStateReadTransaction {
    allocate_revision(): number;
    allocate_recency_order(): bigint;
    set_absence_revision(revision: number): void;
    set_updated_at(timestamp: number): void;
    write_entry(value: PersistedCompleteKeyedStateEntry): void;
    insert_empty_entry(value: PersistedKeyedStateEntryMetadata): void;
    write_entry_metadata(value: PersistedKeyedStateEntryMetadata): void;
    write_authority_stages(
        path: string,
        stages: readonly PersistedAuthorityStageRecord[],
    ): void;
    delete_authority_stages_before(boundary: number): readonly string[];
    delete_entry(path: string): void;
    insert_lease(lease_id: string, path: string): void;
    move_leases(source_paths: readonly string[], destination_path: string): void;
    delete_lease(lease_id: string): boolean;
}

export type KeyedStateMutationKind =
    | 'compareAndSet'
    | 'canonicalize'
    | 'copy'
    | 'stageAuthority'
    | 'finalizeAuthority'
    | 'discardAuthority'
    | 'cleanupAuthority'
    | 'touch'
    | 'lease'
    | 'releaseLease'
    | 'retention';

export interface KeyedFileStatePersistence {
    readonly runtime_key: object;
    readonly canonicalization_revision_policy: CanonicalizationRevisionPolicy;
    readonly supports_recovery_records?: boolean;
    read_transaction<T>(body: (tx: KeyedStateReadTransaction) => T): Promise<T>;
    write_transaction<T>(
        kind: KeyedStateMutationKind,
        body: (tx: KeyedStateWriteTransaction) => T,
    ): Promise<T>;
    close(): Promise<void>;
}

export function require_synchronous_transaction_result<T>(result: T): T {
    if (is_thenable(result)) {
        throw new TypeError('Keyed persistence transaction callbacks must be synchronous.');
    }
    return result;
}

interface PersistedAuthorityStage extends AuthorityTransactionStageInput {
    createdAt: number;
}

interface PersistedEntry {
    revision: number;
    state: StoredPerFileState;
    hasPendingEdits?: boolean;
    authority?: DurableFileAuthority;
    stages?: Record<string, PersistedAuthorityStage>;
    updatedAt?: number;
    touchedAt?: number;
    copyProvenance?: { id: string; sourcePath: string; sourceRevision: number };
}

interface PersistedStateEnvelope {
    format: typeof STATE_FORMAT;
    nextRevision: number;
    absenceRevision: number;
    updatedAt?: number;
    entries: Record<string, PersistedEntry>;
}

interface StateRuntime {
    pending: Promise<unknown>;
    readonly leases: Map<string, string>;
    closed: boolean;
    closePromise?: Promise<void>;
}

type LegacyStoredStateMap = Record<string, StoredPerFileState>;
const runtime_by_key = new WeakMap<object, StateRuntime>();

function runtime_for(runtime_key: object): StateRuntime {
    let runtime = runtime_by_key.get(runtime_key);
    if (!runtime) {
        runtime = {
            pending: Promise.resolve(),
            leases: new Map(),
            closed: false,
        };
        runtime_by_key.set(runtime_key, runtime);
    }
    return runtime;
}

function enqueue<T>(runtime: StateRuntime, operation: () => Promise<T>): Promise<T> {
    if (runtime.closed) {
        return Promise.reject(new Error('File-state persistence is closed.'));
    }
    const result = runtime.pending.then(operation, operation);
    runtime.pending = result.then(() => undefined, () => undefined);
    return result;
}

/** Drain all semantic work admitted through the one queue interned by runtime identity. */
export function drain_keyed_state_runtime(runtime_key: object): Promise<void> {
    return runtime_for(runtime_key).pending.then(() => undefined);
}

function close_keyed_state_runtime(runtime_key: object): Promise<void> {
    const runtime = runtime_for(runtime_key);
    if (runtime.closePromise) return runtime.closePromise;
    runtime.closed = true;
    runtime.closePromise = runtime.pending.then(() => undefined);
    return runtime.closePromise;
}

function is_thenable(value: unknown): boolean {
    return value !== null
        && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as { then?: unknown }).then === 'function';
}

function assert_safe_counter(value: unknown, name: string, allow_sentinel = false): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`Persisted ${name} must be a non-negative safe integer.`);
    }
    if (!allow_sentinel && value === EXHAUSTION_SENTINEL) {
        throw new RangeError(`Persisted ${name} is exhausted.`);
    }
    return value as number;
}

function empty_authority(): DurableFileAuthority {
    return {
        commitSequence: 0,
        authorityRevision: 0,
        physicalRevision: 0,
        projectionRevision: 0,
    };
}

function decode_authority(value: unknown): DurableFileAuthority {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Persisted authority must be an object.');
    }
    const source = value as Partial<DurableFileAuthority>;
    const authority: DurableFileAuthority = {
        commitSequence: assert_safe_counter(source.commitSequence, 'commit sequence'),
        authorityRevision: assert_safe_counter(source.authorityRevision, 'authority revision'),
        physicalRevision: assert_safe_counter(source.physicalRevision, 'physical revision'),
        projectionRevision: assert_safe_counter(source.projectionRevision, 'projection revision'),
    };
    if (source.physicalDigest !== undefined) {
        if (typeof source.physicalDigest !== 'string') {
            throw new TypeError('Persisted physical digest must be a string.');
        }
        authority.physicalDigest = source.physicalDigest;
    }
    return authority;
}

function decode_stage(value: unknown): PersistedAuthorityStage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Persisted authority stage must be an object.');
    }
    const stage = structuredClone(value) as PersistedAuthorityStage;
    if (typeof stage.id !== 'string' || (stage.kind !== 'physical' && stage.kind !== 'projection')) {
        throw new TypeError('Persisted authority stage identity is invalid.');
    }
    assert_safe_counter(stage.ordinal, 'authority stage ordinal', true);
    assert_safe_counter(stage.expectedStateRevision, 'authority stage state revision');
    assert_safe_counter(stage.expectedCommitSequence, 'authority stage commit sequence');
    assert_safe_counter(stage.createdAt, 'authority stage creation timestamp', true);
    if (stage.nextState !== undefined) {
        stage.nextState = decode_stored_per_file_state(stage.nextState) as PerFileState;
    }
    if (stage.physicalDigest !== undefined && typeof stage.physicalDigest !== 'string') {
        throw new TypeError('Persisted authority stage digest must be a string.');
    }
    return stage;
}

export function state_has_pending_edits(state: StoredPerFileState): boolean {
    const pending = (state as PerFileState).pendingEdits;
    return !!pending && Object.keys(pending).length > 0;
}

function max_timestamp(existing: number | undefined, captured: number): number {
    return Math.max(existing ?? captured, captured);
}

function decode_entry(value: unknown): PersistedEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Persisted file-state entry must be an object.');
    }
    const source = value as PersistedEntry;
    const entry: PersistedEntry = {
        revision: assert_safe_counter(source.revision, 'state revision'),
        state: decode_stored_per_file_state(source.state),
    };
    if (source.hasPendingEdits !== undefined) {
        entry.hasPendingEdits = state_has_pending_edits(entry.state);
    }
    if (source.authority !== undefined) entry.authority = decode_authority(source.authority);
    if (source.stages !== undefined) {
        if (!source.stages || typeof source.stages !== 'object' || Array.isArray(source.stages)) {
            throw new TypeError('Persisted authority stages must be an object.');
        }
        const stages = Object.entries(source.stages).map(([id, stage]) => {
            const decoded = decode_stage(stage);
            if (decoded.id !== id) throw new TypeError('Persisted authority stage key does not match its id.');
            return [id, decoded] as const;
        });
        if (stages.length > 0) entry.stages = Object.fromEntries(stages);
    }
    for (const [source_key, target_key] of [
        ['updatedAt', 'updatedAt'],
        ['touchedAt', 'touchedAt'],
    ] as const) {
        const timestamp = source[source_key];
        if (timestamp !== undefined) entry[target_key] = assert_safe_counter(timestamp, source_key, true);
    }
    if (source.copyProvenance !== undefined) {
        const provenance = source.copyProvenance;
        if (
            !provenance
            || typeof provenance.id !== 'string'
            || typeof provenance.sourcePath !== 'string'
        ) throw new TypeError('Persisted copy provenance is invalid.');
        entry.copyProvenance = {
            id: provenance.id,
            sourcePath: provenance.sourcePath,
            sourceRevision: assert_safe_counter(provenance.sourceRevision, 'copy source revision'),
        };
    }
    return entry;
}

function is_envelope(value: unknown): value is PersistedStateEnvelope {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && (value as { format?: unknown }).format === STATE_FORMAT;
}

function get_all_state(medium: FileStatePersistenceMedium): PersistedStateEnvelope {
    const stored = medium.read();
    if (is_envelope(stored)) {
        const source = stored as PersistedStateEnvelope & { tombstones?: Record<string, unknown> };
        if (!source.entries || typeof source.entries !== 'object' || Array.isArray(source.entries)) {
            throw new TypeError('Persisted file-state envelope entries must be an object.');
        }
        const entries = Object.fromEntries(
            Object.entries(source.entries).map(([path, entry]) => [path, decode_entry(entry)]),
        );
        const tombstones = source.tombstones && typeof source.tombstones === 'object'
            ? Object.values(source.tombstones).map((value) => assert_safe_counter(value, 'tombstone revision'))
            : [];
        const absenceRevision = Math.max(
            assert_safe_counter(source.absenceRevision ?? 0, 'absence revision'),
            0,
            ...tombstones,
        );
        const requiredNext = Math.max(
            1,
            absenceRevision + 1,
            ...Object.values(entries).map((entry) => entry.revision + 1),
        );
        const declaredNext = assert_safe_counter(
            source.nextRevision ?? requiredNext,
            'next revision',
            true,
        );
        if (declaredNext < requiredNext) {
            throw new TypeError('Persisted next revision is behind durable state.');
        }
        const envelope: PersistedStateEnvelope = {
            format: STATE_FORMAT,
            nextRevision: declaredNext,
            absenceRevision,
            entries,
        };
        if (source.updatedAt !== undefined) {
            envelope.updatedAt = assert_safe_counter(source.updatedAt, 'store timestamp', true);
        }
        return envelope;
    }
    const entries: Record<string, PersistedEntry> = {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [path, state] of Object.entries(stored as LegacyStoredStateMap)) {
            const decoded = decode_stored_per_file_state(state);
            entries[path] = { revision: 0, state: decoded };
        }
    }
    return { format: STATE_FORMAT, nextRevision: 1, absenceRevision: 0, entries };
}

function authority_for_entry(entry: PersistedEntry | undefined): DurableFileAuthority {
    return structuredClone(entry?.authority ?? empty_authority());
}

function metadata_from_entry(
    path: string,
    entry: PersistedEntry,
    recencyOrder: bigint,
): PersistedKeyedStateEntryMetadata {
    const stages = Object.values(entry.stages ?? {});
    const metadata: PersistedKeyedStateEntryMetadata = {
        path,
        stateRevision: entry.revision,
        hasPendingEdits: state_has_pending_edits(entry.state),
        authority: authority_for_entry(entry),
        recencyOrder,
        recoveryEntryId: path,
        authorityStageCount: stages.length,
    };
    if (entry.updatedAt !== undefined) metadata_with(metadata, 'updatedAtMs', entry.updatedAt);
    if (entry.touchedAt !== undefined) metadata_with(metadata, 'touchedAtMs', entry.touchedAt);
    if (entry.copyProvenance) metadata_with(metadata, 'copyProvenance', structuredClone(entry.copyProvenance));
    if (stages.length > 0) {
        metadata_with(metadata, 'oldestAuthorityStageCreatedAtMs', Math.min(...stages.map((stage) => stage.createdAt)));
    }
    return metadata;
}

function metadata_with<K extends keyof PersistedKeyedStateEntryMetadata>(
    target: PersistedKeyedStateEntryMetadata,
    key: K,
    value: PersistedKeyedStateEntryMetadata[K],
): void {
    (target as unknown as Record<K, PersistedKeyedStateEntryMetadata[K]>)[key] = value;
}

function complete_from_entry(
    path: string,
    entry: PersistedEntry,
    recencyOrder: bigint,
): PersistedCompleteKeyedStateEntry {
    return {
        entry: {
            ...metadata_from_entry(path, entry, recencyOrder),
            stateJson: JSON.stringify(entry.state),
        },
        stages: Object.values(entry.stages ?? {}).map((stage) => structuredClone(stage)),
    };
}

/**
 * Adapt the historical exact envelope to keyed transactions. Recency and recovery
 * identity are projected from key order/path and are not added to the envelope.
 */
export function create_keyed_file_state_persistence(
    medium: FileStatePersistenceMedium,
): KeyedFileStatePersistence {
    const run = async <T>(
        writable: boolean,
        body: (tx: KeyedStateWriteTransaction) => T,
    ): Promise<T> => {
        const all = get_all_state(medium);
        const order = new Map(
            Object.keys(all.entries).map((path, index) => [path, BigInt(index + 1)]),
        );
        let changed = false;
        let leasesChanged = false;
        const transactionLeases = new Map(runtime_for(medium.runtime_key).leases);
        let nextRecencyOrder = BigInt(Object.keys(all.entries).length + 1);
        const mark_changed = (): void => { changed = true; };
        const ordered_paths = (): string[] => [...Object.keys(all.entries)].sort((left, right) => {
            const leftOrder = order.get(left) ?? 0n;
            const rightOrder = order.get(right) ?? 0n;
            return leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : 0;
        });
        const tx: KeyedStateWriteTransaction = {
            metadata: () => ({
                nextRevision: all.nextRevision,
                absenceRevision: all.absenceRevision,
                nextRecencyOrder,
                ...(all.updatedAt === undefined ? {} : { updatedAtMs: all.updatedAt }),
            }),
            read_entry_metadata(path) {
                const entry = all.entries[path];
                return entry ? metadata_from_entry(path, entry, order.get(path) ?? 0n) : undefined;
            },
            read_entry(path) {
                const entry = all.entries[path];
                return entry ? complete_from_entry(path, entry, order.get(path) ?? 0n) : undefined;
            },
            read_authority_stages(path) {
                return Object.values(all.entries[path]?.stages ?? {}).map((stage) => (
                    structuredClone(stage)
                ));
            },
            scan_entry_metadata: () => ordered_paths().map((path) => (
                metadata_from_entry(path, all.entries[path], order.get(path) ?? 0n)
            )),
            entry_is_leased(path) {
                for (const leasedPath of transactionLeases.values()) {
                    if (leasedPath === path) return true;
                }
                return false;
            },
            allocate_revision() {
                if (all.nextRevision >= EXHAUSTION_SENTINEL) {
                    throw new RangeError('File-state revision space is exhausted.');
                }
                mark_changed();
                const revision = all.nextRevision;
                all.nextRevision += 1;
                return revision;
            },
            allocate_recency_order() {
                const recency = nextRecencyOrder;
                nextRecencyOrder += 1n;
                return recency;
            },
            set_absence_revision(revision) {
                assert_safe_counter(revision, 'absence revision');
                if (all.absenceRevision !== revision) {
                    mark_changed();
                    all.absenceRevision = revision;
                }
            },
            set_updated_at(timestamp) {
                assert_safe_counter(timestamp, 'store timestamp', true);
                const next = max_timestamp(all.updatedAt, timestamp);
                if (next !== all.updatedAt) {
                    mark_changed();
                    all.updatedAt = next;
                }
            },
            write_entry(value) {
                const decoded = decode_stored_per_file_state(JSON.parse(value.entry.stateJson));
                const previous = all.entries[value.entry.path];
                const hasPendingEdits = state_has_pending_edits(decoded);
                const authority = decode_authority(value.entry.authority);
                const entry: PersistedEntry = {
                    revision: assert_safe_counter(value.entry.stateRevision, 'state revision'),
                    state: decoded,
                };
                if (previous?.hasPendingEdits !== undefined) entry.hasPendingEdits = hasPendingEdits;
                if (
                    previous?.authority !== undefined
                    || !authorities_exactly_equal(authority, empty_authority())
                ) entry.authority = authority;
                if (value.entry.updatedAtMs !== undefined) entry.updatedAt = value.entry.updatedAtMs;
                if (value.entry.touchedAtMs !== undefined) entry.touchedAt = value.entry.touchedAtMs;
                if (value.entry.copyProvenance) entry.copyProvenance = structuredClone(value.entry.copyProvenance);
                if (value.stages.length > 0) {
                    entry.stages = Object.fromEntries(value.stages.map((stage) => {
                        const decodedStage = decode_stage(stage);
                        return [decodedStage.id, decodedStage];
                    }));
                }
                all.entries[value.entry.path] = entry;
                order.set(value.entry.path, value.entry.recencyOrder);
                mark_changed();
            },
            insert_empty_entry(value) {
                if (all.entries[value.path]) {
                    throw new Error('Cannot insert an empty entry over an existing entry.');
                }
                const authority = decode_authority(value.authority);
                const entry: PersistedEntry = {
                    revision: assert_safe_counter(value.stateRevision, 'state revision'),
                    state: {},
                };
                if (!authorities_exactly_equal(authority, empty_authority())) entry.authority = authority;
                if (value.updatedAtMs !== undefined) entry.updatedAt = value.updatedAtMs;
                if (value.touchedAtMs !== undefined) entry.touchedAt = value.touchedAtMs;
                if (value.copyProvenance) entry.copyProvenance = structuredClone(value.copyProvenance);
                all.entries[value.path] = entry;
                order.set(value.path, value.recencyOrder);
                mark_changed();
            },
            write_entry_metadata(value) {
                const entry = all.entries[value.path];
                if (!entry) throw new Error('Cannot update metadata for an absent entry.');
                entry.revision = assert_safe_counter(value.stateRevision, 'state revision');
                const authority = decode_authority(value.authority);
                if (
                    entry.authority !== undefined
                    || !authorities_exactly_equal(authority, empty_authority())
                ) entry.authority = authority;
                if (value.updatedAtMs === undefined) delete entry.updatedAt;
                else entry.updatedAt = value.updatedAtMs;
                if (value.touchedAtMs === undefined) delete entry.touchedAt;
                else entry.touchedAt = value.touchedAtMs;
                if (value.copyProvenance === undefined) delete entry.copyProvenance;
                else entry.copyProvenance = structuredClone(value.copyProvenance);
                order.set(value.path, value.recencyOrder);
                mark_changed();
            },
            write_authority_stages(path, stages) {
                const entry = all.entries[path];
                if (!entry) throw new Error('Cannot update stages for an absent entry.');
                if (stages.length === 0) delete entry.stages;
                else {
                    entry.stages = Object.fromEntries(stages.map((stage) => {
                        const decodedStage = decode_stage(stage);
                        return [decodedStage.id, decodedStage];
                    }));
                }
                mark_changed();
            },
            delete_authority_stages_before(boundary) {
                const affected: string[] = [];
                for (const [path, entry] of Object.entries(all.entries)) {
                    const stages = Object.values(entry.stages ?? {});
                    const retained = stages.filter((stage) => stage.createdAt >= boundary);
                    if (retained.length === stages.length) continue;
                    if (retained.length === 0) delete entry.stages;
                    else entry.stages = Object.fromEntries(retained.map((stage) => [stage.id, stage]));
                    affected.push(path);
                    mark_changed();
                }
                return affected;
            },
            delete_entry(path) {
                if (!all.entries[path]) return;
                delete all.entries[path];
                order.delete(path);
                mark_changed();
            },
            insert_lease(leaseId, path) {
                if (transactionLeases.has(leaseId)) {
                    throw new Error('Cannot insert a duplicate file-state lease id.');
                }
                transactionLeases.set(leaseId, path);
                leasesChanged = true;
            },
            move_leases(sourcePaths, destinationPath) {
                const sources = new Set(sourcePaths);
                for (const [leaseId, path] of transactionLeases) {
                    if (!sources.has(path) || path === destinationPath) continue;
                    transactionLeases.set(leaseId, destinationPath);
                    leasesChanged = true;
                }
            },
            delete_lease(leaseId) {
                const deleted = transactionLeases.delete(leaseId);
                leasesChanged = leasesChanged || deleted;
                return deleted;
            },
        };
        const result = require_synchronous_transaction_result(body(tx));
        if (writable && changed) {
            all.entries = Object.fromEntries(ordered_paths().map((path) => [path, all.entries[path]]));
            await medium.write(all);
        }
        if (writable && leasesChanged) {
            const leases = runtime_for(medium.runtime_key).leases;
            leases.clear();
            for (const [leaseId, path] of transactionLeases) leases.set(leaseId, path);
        }
        return result;
    };

    const persistence: KeyedFileStatePersistence = {
        runtime_key: medium.runtime_key,
        canonicalization_revision_policy: 'preserve-winner-revision',
        read_transaction: (body) => run(false, body),
        write_transaction: (_kind, body) => run(true, body),
        close: () => close_keyed_state_runtime(medium.runtime_key),
    };
    return persistence;
}

function decode_complete_state(value: PersistedCompleteKeyedStateEntry): StoredPerFileState {
    return decode_stored_per_file_state(JSON.parse(value.entry.stateJson));
}

function snapshot_from_complete(
    value: PersistedCompleteKeyedStateEntry | undefined,
    absenceRevision: number,
): FileStateSnapshot {
    return value
        ? { state: decode_complete_state(value), revision: value.entry.stateRevision }
        : { state: {}, revision: absenceRevision };
}

function clone_complete(value: PersistedCompleteKeyedStateEntry): PersistedCompleteKeyedStateEntry {
    return structuredClone(value);
}

function write_complete(
    tx: KeyedStateWriteTransaction,
    value: PersistedCompleteKeyedStateEntry,
): void {
    const state = decode_complete_state(value);
    tx.write_entry({
        entry: {
            ...value.entry,
            stateJson: JSON.stringify(state),
            hasPendingEdits: state_has_pending_edits(state),
            authorityStageCount: value.stages.length,
            ...(value.stages.length === 0 ? {} : {
                oldestAuthorityStageCreatedAtMs: Math.min(...value.stages.map((stage) => stage.createdAt)),
            }),
        },
        stages: value.stages.map((stage) => structuredClone(stage)),
    });
}

function cleanup_stale_stages(
    tx: KeyedStateWriteTransaction,
    now: number,
): boolean {
    const affectedPaths = tx.delete_authority_stages_before(now - STALE_STAGE_MS);
    for (const path of affectedPaths) {
        const metadata = tx.read_entry_metadata(path);
        if (metadata?.copyProvenance) {
            tx.write_entry_metadata({ ...metadata, copyProvenance: undefined });
        }
    }
    return affectedPaths.length > 0;
}

function evict_entries(
    tx: KeyedStateWriteTransaction,
    max: number,
    protectedPaths: ReadonlySet<string>,
): boolean {
    const ordinary = tx.scan_entry_metadata().filter((entry) => (
        !protectedPaths.has(entry.path)
        && !tx.entry_is_leased(entry.path)
        && !entry.hasPendingEdits
        && entry.authorityStageCount === 0
    ));
    const excess = ordinary.length - Math.max(1, max);
    if (excess <= 0) return false;
    const victims = ordinary
        .sort((left, right) => left.recencyOrder < right.recencyOrder ? -1 : 1)
        .slice(0, excess);
    const absenceRevision = tx.allocate_revision();
    for (const victim of victims) tx.delete_entry(victim.path);
    tx.set_absence_revision(absenceRevision);
    return true;
}

function run_retention(
    tx: KeyedStateWriteTransaction,
    max: number,
    protectedPaths: ReadonlySet<string>,
    now: number,
): boolean {
    const cleaned = cleanup_stale_stages(tx, now);
    return evict_entries(tx, max, protectedPaths) || cleaned;
}

function ensure_authority_incrementable(value: number, name: string): void {
    if (value >= EXHAUSTION_SENTINEL - 1) {
        throw new RangeError(`${name} is exhausted.`);
    }
}

function serialized_states_equal(left: StoredPerFileState, right: StoredPerFileState): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function pending_json(state: StoredPerFileState): string | undefined {
    const pending = (state as PerFileState).pendingEdits;
    return pending && Object.keys(pending).length > 0 ? JSON.stringify(pending) : undefined;
}

function authorities_exactly_equal(left: DurableFileAuthority, right: DurableFileAuthority): boolean {
    return left.commitSequence === right.commitSequence
        && left.authorityRevision === right.authorityRevision
        && left.physicalRevision === right.physicalRevision
        && left.projectionRevision === right.projectionRevision
        && left.physicalDigest === right.physicalDigest;
}

function choose_canonical_winner(
    values: readonly PersistedCompleteKeyedStateEntry[],
    canonicalPath: string,
): PersistedCompleteKeyedStateEntry {
    return values.reduce((left, right) => {
        const relation = compare_authority(left.entry.authority, right.entry.authority);
        if (relation === 'dominates') return left;
        if (relation === 'dominated') return right;
        if (relation === 'divergent') {
            throw new Error('Cannot canonicalize divergent durable file authority.');
        }
        if (left.entry.stateRevision !== right.entry.stateRevision) {
            return left.entry.stateRevision > right.entry.stateRevision ? left : right;
        }
        if (left.entry.path === canonicalPath) return left;
        if (right.entry.path === canonicalPath) return right;
        return left.entry.recencyOrder <= right.entry.recencyOrder ? left : right;
    });
}

function assert_pending_canonicalization_safe(
    candidates: readonly PersistedCompleteKeyedStateEntry[],
    winner: PersistedCompleteKeyedStateEntry,
): void {
    const decoded = candidates.map((candidate) => ({
        candidate,
        pending: pending_json(decode_complete_state(candidate)),
    }));
    const pendingCandidates = decoded.filter((value) => value.pending !== undefined);
    if (pendingCandidates.length === 0) return;
    const winnerPending = pending_json(decode_complete_state(winner));
    if (!winnerPending) {
        throw new Error('Cannot canonicalize pending edits into a different complete winner.');
    }
    for (const value of pendingCandidates) {
        if (
            value.pending !== winnerPending
            || !authorities_exactly_equal(value.candidate.entry.authority, winner.entry.authority)
        ) {
            throw new Error('Cannot canonicalize divergent pending edits or authority.');
        }
    }
}

function canonicalize_in_transaction(
    tx: KeyedStateWriteTransaction,
    canonicalPath: string,
    canonicalKey: (filePath: string) => string,
    policy: CanonicalizationRevisionPolicy,
): ReadonlySet<string> | undefined {
    const matches = tx.scan_entry_metadata().filter((entry) => (
        entry.path === canonicalPath || canonicalKey(entry.path) === canonicalPath
    ));
    if (matches.length <= 1 && matches[0]?.path === canonicalPath) return undefined;
    if (matches.length === 0) return undefined;
    const candidates = matches.map((metadata) => {
        const complete = tx.read_entry(metadata.path);
        if (!complete) throw new Error('Canonicalization candidate disappeared inside its transaction.');
        return complete;
    });
    const winner = choose_canonical_winner(candidates, canonicalPath);
    assert_pending_canonicalization_safe(candidates, winner);

    const existingTarget = candidates.find((candidate) => candidate.entry.path === canonicalPath);
    const targetRecency = existingTarget?.entry.recencyOrder ?? tx.allocate_recency_order();
    const targetRevision = !existingTarget && policy === 'allocate-revision-when-target-absent'
        ? tx.allocate_revision()
        : winner.entry.stateRevision;
    const next = clone_complete(winner);
    const winnerMovedUnchanged = !existingTarget
        && targetRevision === winner.entry.stateRevision;
    (next as { entry: PersistedKeyedStateEntry }).entry = {
        ...next.entry,
        path: canonicalPath,
        stateRevision: targetRevision,
        recencyOrder: targetRecency,
    };
    if (targetRevision !== winner.entry.stateRevision) {
        (next as { stages: readonly PersistedAuthorityStageRecord[] }).stages = next.stages.map((stage) => ({
            ...stage,
            expectedStateRevision: stage.expectedStateRevision === winner.entry.stateRevision
                ? targetRevision
                : stage.expectedStateRevision,
        }));
    }
    if (!winnerMovedUnchanged && winner.entry.path !== canonicalPath) {
        delete (next.entry as { copyProvenance?: unknown }).copyProvenance;
    }
    const candidatePaths = candidates.map((candidate) => candidate.entry.path);
    tx.move_leases(candidatePaths, canonicalPath);
    for (const candidate of candidates) tx.delete_entry(candidate.entry.path);
    write_complete(tx, next);
    const deletedAliases = candidates.some((candidate) => candidate.entry.path !== canonicalPath);
    if (deletedAliases) tx.set_absence_revision(tx.allocate_revision());

    return new Set(candidates.map((candidate) => candidate.entry.path));
}

function copy_in_transaction(
    tx: KeyedStateWriteTransaction,
    sourcePath: string,
    destinationPath: string,
    copyId: string,
    capturedAt: number,
    max: number,
    pendingBasis?: PendingEditCopyBasis,
): FileStateCopyResult {
    const metadata = tx.metadata();
    const destination = tx.read_entry(destinationPath);
    if (
        destination?.entry.copyProvenance?.id === copyId
        && destination.entry.copyProvenance.sourcePath === sourcePath
    ) {
        const sourceRevision = destination.entry.copyProvenance.sourceRevision;
        const state = decode_complete_state(destination);
        const result: FileStateCopyResult = {
            type: 'copied',
            source: { state: structuredClone(state), revision: sourceRevision },
            destination: snapshot_from_complete(destination, metadata.absenceRevision),
        };
        const changed = run_retention(
            tx,
            max,
            new Set([sourcePath, destinationPath]),
            capturedAt,
        );
        if (changed) tx.set_updated_at(capturedAt);
        return result;
    }
    if (destination) {
        const result: FileStateCopyResult = {
            type: 'destinationExists',
            destination: snapshot_from_complete(destination, metadata.absenceRevision),
        };
        const changed = run_retention(tx, max, new Set([sourcePath, destinationPath]), capturedAt);
        if (changed) tx.set_updated_at(capturedAt);
        return result;
    }
    const sourceBeforeCleanup = tx.read_entry(sourcePath);
    if (!sourceBeforeCleanup) {
        const result: FileStateCopyResult = {
            type: 'sourceAbsent',
            source: { state: {}, revision: metadata.absenceRevision },
            destination: { state: {}, revision: metadata.absenceRevision },
        };
        const changed = run_retention(tx, max, new Set([sourcePath, destinationPath]), capturedAt);
        if (changed) tx.set_updated_at(capturedAt);
        return result;
    }
    const sourceState = decode_complete_state(sourceBeforeCleanup);
    if (state_has_pending_edits(sourceState)) {
        if (
            pendingBasis?.destinationRecoveryRecordId !== undefined
            || pendingBasis?.destinationRecoveryEntryId !== undefined
        ) return { type: 'recoveryRequired' };
    }

    cleanup_stale_stages(tx, capturedAt);
    const source = tx.read_entry(sourcePath);
    if (!source) throw new Error('Copy source disappeared inside its transaction.');
    const sourceSnapshot = snapshot_from_complete(source, metadata.absenceRevision);
    const revision = tx.allocate_revision();
    const state = decode_complete_state(source);
    const copied: PersistedCompleteKeyedStateEntry = {
        entry: {
            ...source.entry,
            path: destinationPath,
            stateRevision: revision,
            stateJson: JSON.stringify(state),
            hasPendingEdits: state_has_pending_edits(state),
            recencyOrder: tx.allocate_recency_order(),
            updatedAtMs: capturedAt,
            recoveryEntryId: pendingBasis?.destinationRecoveryEntryId ?? destinationPath,
            ...(pendingBasis?.destinationRecoveryRecordId === undefined
                ? {}
                : { recoveryRecordId: pendingBasis.destinationRecoveryRecordId }),
            copyProvenance: {
                id: copyId,
                sourcePath,
                sourceRevision: source.entry.stateRevision,
            },
        },
        stages: source.stages.map((stage) => ({
            ...stage,
            expectedStateRevision: stage.expectedStateRevision === source.entry.stateRevision
                ? revision
                : stage.expectedStateRevision,
        })),
    };
    write_complete(tx, copied);
    evict_entries(tx, max, new Set([sourcePath, destinationPath]));
    tx.set_updated_at(capturedAt);
    return {
        type: 'copied',
        source: sourceSnapshot,
        destination: snapshot_from_complete(copied, metadata.absenceRevision),
    };
}

/** Create the shared semantic core over a normalized keyed persistence port. */
export function create_keyed_authority_store(
    persistence: KeyedFileStatePersistence,
    get_max_stored?: () => number,
): AuthorityFileStateStore {
    const runtime = runtime_for(persistence.runtime_key);
    const getMax = get_max_stored ?? (() => DEFAULT_MAX_STORED_FILES);
    const readTransaction = <T>(
        body: (tx: KeyedStateReadTransaction) => T,
    ): Promise<T> => enqueue(runtime, () => persistence.read_transaction(body));
    const writeTransaction = <T>(
        kind: KeyedStateMutationKind,
        body: (tx: KeyedStateWriteTransaction) => T,
    ): Promise<T> => enqueue(runtime, () => persistence.write_transaction(kind, body));
    return {
        read(filePath) {
            return readTransaction((tx) => (
                snapshot_from_complete(tx.read_entry(filePath), tx.metadata().absenceRevision)
            ));
        },

        compare_and_set(filePath, expectedRevision, state, validate, basis) {
            // Proposal capture and structural validation happen before queue admission.
            const proposed = decode_stored_per_file_state(state);
            const proposedJson = JSON.stringify(proposed);
            const capturedAt = Date.now();
            return writeTransaction('compareAndSet', (tx) => {
                const currentEntry = tx.read_entry(filePath);
                const current = snapshot_from_complete(currentEntry, tx.metadata().absenceRevision);
                const authority = structuredClone(currentEntry?.entry.authority ?? empty_authority());
                // Exact once, and before every stale/unsupported guard.
                const validation = validate?.();
                const validationPasses = validation === undefined || validation === true;
                const basisMatches = basis === undefined
                    ? true
                    : ((basis.recoveryRecordId === undefined
                        || (persistence.supports_recovery_records === true
                            && basis.recoveryRecordId.length > 0))
                    && authority.authorityRevision === basis.expectedAuthorityRevision
                    && (basis.expectedPhysicalRevision === undefined
                        || authority.physicalRevision === basis.expectedPhysicalRevision)
                    && (basis.expectedProjectionRevision === undefined
                        || authority.projectionRevision === basis.expectedProjectionRevision));
                if (
                    !validationPasses
                    || current.revision !== expectedRevision
                    || !basisMatches
                ) return { type: 'conflict', snapshot: current, authority };

                const revision = tx.allocate_revision();
                const complete: PersistedCompleteKeyedStateEntry = {
                    entry: {
                        path: filePath,
                        stateRevision: revision,
                        stateJson: proposedJson,
                        hasPendingEdits: state_has_pending_edits(proposed),
                        authority,
                        recencyOrder: tx.allocate_recency_order(),
                        updatedAtMs: max_timestamp(currentEntry?.entry.updatedAtMs, capturedAt),
                        ...(currentEntry?.entry.touchedAtMs === undefined
                            ? {}
                            : { touchedAtMs: currentEntry.entry.touchedAtMs }),
                        recoveryEntryId: currentEntry?.entry.recoveryEntryId ?? filePath,
                        ...(basis?.recoveryRecordId === undefined
                            ? {}
                            : { recoveryRecordId: basis.recoveryRecordId }),
                        authorityStageCount: currentEntry?.stages.length ?? 0,
                        ...(currentEntry?.entry.oldestAuthorityStageCreatedAtMs === undefined
                            ? {}
                            : { oldestAuthorityStageCreatedAtMs: currentEntry.entry.oldestAuthorityStageCreatedAtMs }),
                    },
                    stages: currentEntry?.stages.map((stage) => structuredClone(stage)) ?? [],
                };
                write_complete(tx, complete);
                run_retention(tx, getMax(), new Set(), capturedAt);
                tx.set_updated_at(capturedAt);
                return {
                    type: 'committed',
                    snapshot: { state: structuredClone(proposed), revision },
                    authority: structuredClone(authority),
                };
            });
        },

        read_authority(filePath) {
            return readTransaction((tx) => (
                structuredClone(tx.read_entry_metadata(filePath)?.authority ?? empty_authority())
            ));
        },

        stage_authority_transaction(filePath, input) {
            const capturedAt = Date.now();
            const captured: PersistedAuthorityStageRecord = {
                ...structuredClone(input),
                ...(input.nextState === undefined
                    ? {}
                    : { nextState: decode_stored_per_file_state(input.nextState) as PerFileState }),
                createdAt: capturedAt,
            };
            return writeTransaction('stageAuthority', (tx) => {
                const absenceRevision = tx.metadata().absenceRevision;
                let metadata = tx.read_entry_metadata(filePath);
                const revision = metadata?.stateRevision ?? absenceRevision;
                const authority = structuredClone(metadata?.authority ?? empty_authority());
                if (
                    revision !== captured.expectedStateRevision
                    || authority.commitSequence !== captured.expectedCommitSequence
                ) {
                    const current = metadata ? tx.read_entry(filePath) : undefined;
                    return {
                        type: 'conflict',
                        snapshot: snapshot_from_complete(current, absenceRevision),
                        authority,
                    };
                }

                if (!metadata) {
                    metadata = {
                        path: filePath,
                        stateRevision: absenceRevision,
                        hasPendingEdits: false,
                        authority,
                        recencyOrder: tx.allocate_recency_order(),
                        recoveryEntryId: filePath,
                        authorityStageCount: 0,
                    };
                    tx.insert_empty_entry(metadata);
                } else if (metadata.copyProvenance) {
                    const { copyProvenance: _copyProvenance, ...withoutProvenance } = metadata;
                    metadata = withoutProvenance;
                    tx.write_entry_metadata(metadata);
                }
                const stages = tx.read_authority_stages(filePath);
                tx.write_authority_stages(filePath, [
                    ...stages.filter((stage) => stage.id !== captured.id),
                    captured,
                ]);
                run_retention(tx, getMax(), new Set(), capturedAt);
                tx.set_updated_at(capturedAt);
                return { type: 'staged' };
            });
        },

        finalize_authority_transaction(filePath, stageId) {
            const capturedAt = Date.now();
            return writeTransaction('finalizeAuthority', (tx) => {
                const current = tx.read_entry(filePath);
                const snapshot = snapshot_from_complete(current, tx.metadata().absenceRevision);
                const authority = structuredClone(current?.entry.authority ?? empty_authority());
                const stage = current?.stages.find((candidate) => candidate.id === stageId);
                if (
                    !current
                    || !stage
                    || snapshot.revision !== stage.expectedStateRevision
                    || authority.commitSequence !== stage.expectedCommitSequence
                ) return { type: 'conflict', snapshot, authority };

                ensure_authority_incrementable(authority.commitSequence, 'Authority commit sequence');
                const nextAuthority: DurableFileAuthority = {
                    ...authority,
                    commitSequence: authority.commitSequence + 1,
                };
                if (stage.kind === 'projection') {
                    ensure_authority_incrementable(authority.projectionRevision, 'Projection revision');
                    ensure_authority_incrementable(authority.authorityRevision, 'Authority revision');
                    nextAuthority.projectionRevision += 1;
                    nextAuthority.authorityRevision += 1;
                } else if (authority.physicalDigest !== stage.physicalDigest) {
                    ensure_authority_incrementable(authority.physicalRevision, 'Physical revision');
                    ensure_authority_incrementable(authority.authorityRevision, 'Authority revision');
                    nextAuthority.physicalRevision += 1;
                    nextAuthority.authorityRevision += 1;
                    if (stage.physicalDigest === undefined) delete nextAuthority.physicalDigest;
                    else nextAuthority.physicalDigest = stage.physicalDigest;
                }

                const oldState = decode_complete_state(current);
                const nextState = stage.nextState === undefined
                    ? oldState
                    : decode_stored_per_file_state(stage.nextState);
                const stateChanged = !serialized_states_equal(oldState, nextState);
                const revision = stateChanged ? tx.allocate_revision() : current.entry.stateRevision;
                const complete = clone_complete(current);
                (complete as { entry: PersistedKeyedStateEntry }).entry = {
                    ...complete.entry,
                    stateRevision: revision,
                    stateJson: JSON.stringify(nextState),
                    hasPendingEdits: state_has_pending_edits(nextState),
                    authority: nextAuthority,
                    recencyOrder: tx.allocate_recency_order(),
                    updatedAtMs: max_timestamp(current.entry.updatedAtMs, capturedAt),
                };
                delete (complete.entry as { copyProvenance?: unknown }).copyProvenance;
                (complete as { stages: readonly PersistedAuthorityStageRecord[] }).stages = complete.stages
                    .filter((candidate) => candidate.id !== stageId);
                write_complete(tx, complete);
                run_retention(tx, getMax(), new Set(), capturedAt);
                tx.set_updated_at(capturedAt);
                return {
                    type: 'finalized',
                    snapshot: { state: structuredClone(nextState), revision },
                    authority: structuredClone(nextAuthority),
                };
            });
        },

        inspect_authority_transaction(filePath, stageId) {
            return readTransaction((tx) => {
                const current = tx.read_entry(filePath);
                return {
                    snapshot: snapshot_from_complete(current, tx.metadata().absenceRevision),
                    authority: structuredClone(current?.entry.authority ?? empty_authority()),
                    stagePresent: current?.stages.some((stage) => stage.id === stageId) ?? false,
                };
            });
        },

        discard_authority_transaction(filePath, stageId) {
            const capturedAt = Date.now();
            return writeTransaction('discardAuthority', (tx) => {
                const stages = tx.read_authority_stages(filePath);
                if (!stages.some((stage) => stage.id === stageId)) return;
                tx.write_authority_stages(
                    filePath,
                    stages.filter((stage) => stage.id !== stageId),
                );
                const metadata = tx.read_entry_metadata(filePath);
                if (metadata?.copyProvenance) {
                    const { copyProvenance: _copyProvenance, ...withoutProvenance } = metadata;
                    tx.write_entry_metadata(withoutProvenance);
                }
                run_retention(tx, getMax(), new Set(), capturedAt);
                tx.set_updated_at(capturedAt);
            });
        },

        cleanup_authority_transactions(_filePath, now = Date.now()) {
            const capturedAt = now;
            return writeTransaction('cleanupAuthority', (tx) => {
                const changed = run_retention(tx, getMax(), new Set(), now);
                if (changed) tx.set_updated_at(capturedAt);
            });
        },

        canonicalize_path(canonicalPath, canonicalKey) {
            const capturedAt = Date.now();
            return writeTransaction('canonicalize', (tx) => {
                const movedPaths = canonicalize_in_transaction(
                    tx,
                    canonicalPath,
                    canonicalKey,
                    persistence.canonicalization_revision_policy,
                );
                const retained = run_retention(
                    tx,
                    getMax(),
                    new Set([canonicalPath]),
                    capturedAt,
                );
                if (movedPaths || retained) tx.set_updated_at(capturedAt);
            });
        },

        lease_entry(canonicalPath, canonicalKey, copyFromIfAbsent, copyId, pendingBasis) {
            const capturedAt = Date.now();
            const leaseId = randomUUID();
            let releasePromise: Promise<void> | undefined;
            const lease: FileStateLease = {
                release(): Promise<void> {
                    if (releasePromise) return releasePromise;
                    const releaseCapturedAt = Date.now();
                    const attempt = writeTransaction('releaseLease', (tx) => {
                        if (!tx.delete_lease(leaseId)) return;
                        if (run_retention(
                            tx,
                            getMax(),
                            new Set(),
                            releaseCapturedAt,
                        )) tx.set_updated_at(releaseCapturedAt);
                    });
                    releasePromise = attempt.catch((error: unknown) => {
                        releasePromise = undefined;
                        throw error;
                    });
                    return releasePromise;
                },
            };
            return writeTransaction('lease', (tx) => {
                const movedPaths = canonicalize_in_transaction(
                    tx,
                    canonicalPath,
                    canonicalKey,
                    persistence.canonicalization_revision_policy,
                );
                if (copyFromIfAbsent) {
                    const result = copy_in_transaction(
                        tx,
                        copyFromIfAbsent,
                        canonicalPath,
                        copyId ?? `lease:${copyFromIfAbsent}:${canonicalPath}`,
                        capturedAt,
                        getMax(),
                        pendingBasis,
                    );
                    if (result.type === 'sourceBusy' || result.type === 'recoveryRequired') {
                        throw new Error(`Cannot lease copied entry: ${result.type}.`);
                    }
                    if (movedPaths) tx.set_updated_at(capturedAt);
                } else {
                    const retained = run_retention(
                        tx,
                        getMax(),
                        new Set([canonicalPath]),
                        capturedAt,
                    );
                    if (movedPaths || retained) tx.set_updated_at(capturedAt);
                }
                tx.insert_lease(leaseId, canonicalPath);
            }).then(() => lease);
        },

        copy_entry_if_absent(sourcePath, destinationPath, copyId, pendingBasis) {
            const capturedAt = Date.now();
            return writeTransaction('copy', (tx) => copy_in_transaction(
                tx,
                sourcePath,
                destinationPath,
                copyId,
                capturedAt,
                getMax(),
                pendingBasis,
            ));
        },

        touch(filePath) {
            const capturedAt = Date.now();
            return writeTransaction('touch', (tx) => {
                const current = tx.read_entry_metadata(filePath);
                let changed = false;
                if (current) {
                    tx.write_entry_metadata({
                        ...current,
                        recencyOrder: tx.allocate_recency_order(),
                        touchedAtMs: max_timestamp(current.touchedAtMs, capturedAt),
                    });
                    changed = true;
                }
                changed = run_retention(tx, getMax(), new Set(), capturedAt) || changed;
                if (changed) tx.set_updated_at(capturedAt);
            });
        },
    };
}

/** Source-compatible constructor; all behavior is delegated to the keyed core. */
export function create_authority_store(
    medium: FileStatePersistenceMedium | KeyedFileStatePersistence,
    get_max_stored?: () => number,
): AuthorityFileStateStore {
    const persistence = 'read_transaction' in medium
        ? medium
        : create_keyed_file_state_persistence(medium);
    return create_keyed_authority_store(persistence, get_max_stored);
}
