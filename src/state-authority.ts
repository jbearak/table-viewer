import type {
    AuthorityFileStateStore,
    AuthorityTransactionFinalizeResult,
    AuthorityTransactionStageInput,
    AuthorityTransactionStageResult,
    DurableFileAuthority,
    FileStateCopyResult,
    FileStateSnapshot,
    FileStateStore,
} from './state';
import type { PerFileState } from './types';

interface FallbackCopyProvenance {
    id: string;
    sourcePath: string;
    source: FileStateSnapshot;
    destination: FileStateSnapshot;
    resultType: 'copied' | 'sourceAbsent';
}

interface FallbackEntry {
    authority: DurableFileAuthority;
    stages: Map<string, AuthorityTransactionStageInput>;
    materialized: boolean;
    copyProvenance?: FallbackCopyProvenance;
}

interface FallbackRuntime {
    pending: Promise<unknown>;
}

const fallback = new WeakMap<FileStateStore, Map<string, FallbackEntry>>();
const fallback_owner = new WeakMap<FileStateStore, FileStateStore>();
const fallback_runtime = new WeakMap<FileStateStore, FallbackRuntime>();
const wrapped_store = new WeakMap<FileStateStore, AuthorityFileStateStore>();

function empty(): DurableFileAuthority {
    return {
        commitSequence: 0,
        authorityRevision: 0,
        physicalRevision: 0,
        projectionRevision: 0,
    };
}

function fallback_store(store: FileStateStore): FileStateStore {
    return fallback_owner.get(store) ?? store;
}

function runtime_for(store: FileStateStore): FallbackRuntime {
    const owner = fallback_store(store);
    let runtime = fallback_runtime.get(owner);
    if (!runtime) {
        runtime = { pending: Promise.resolve() };
        fallback_runtime.set(owner, runtime);
    }
    return runtime;
}

function enqueue_fallback<T>(
    store: FileStateStore,
    operation: () => Promise<T>,
): Promise<T> {
    const runtime = runtime_for(store);
    const result = runtime.pending.catch(() => {}).then(operation);
    runtime.pending = result;
    return result;
}

function entries_for(store: FileStateStore): Map<string, FallbackEntry> {
    const owner = fallback_store(store);
    let entries = fallback.get(owner);
    if (!entries) {
        entries = new Map();
        fallback.set(owner, entries);
    }
    return entries;
}

function entry(store: FileStateStore, path: string): FallbackEntry {
    const entries = entries_for(store);
    let value = entries.get(path);
    if (!value) {
        value = { authority: empty(), stages: new Map(), materialized: false };
        entries.set(path, value);
    }
    return value;
}

function is_authority_store(store: FileStateStore): store is AuthorityFileStateStore {
    const candidate = store as Partial<AuthorityFileStateStore>;
    return typeof candidate.read_authority === 'function'
        && typeof candidate.stage_authority_transaction === 'function'
        && typeof candidate.finalize_authority_transaction === 'function'
        && typeof candidate.inspect_authority_transaction === 'function'
        && typeof candidate.discard_authority_transaction === 'function'
        && typeof candidate.cleanup_authority_transactions === 'function';
}

export function read_authority(
    store: FileStateStore,
    path: string,
): Promise<DurableFileAuthority> {
    return is_authority_store(store)
        ? store.read_authority(path)
        : Promise.resolve(structuredClone(entry(store, path).authority));
}

export async function stage_authority(
    store: FileStateStore,
    path: string,
    input: AuthorityTransactionStageInput,
): Promise<AuthorityTransactionStageResult> {
    if (is_authority_store(store)) {
        return store.stage_authority_transaction(path, input);
    }
    const current = await store.read(path);
    const value = entry(store, path);
    if (
        current.revision !== input.expectedStateRevision
        || value.authority.commitSequence !== input.expectedCommitSequence
    ) {
        return {
            type: 'conflict',
            snapshot: current,
            authority: structuredClone(value.authority),
        };
    }
    value.materialized = true;
    delete value.copyProvenance;
    value.stages.set(input.id, structuredClone(input));
    return { type: 'staged' };
}

export async function finalize_authority(
    store: FileStateStore,
    path: string,
    id: string,
): Promise<AuthorityTransactionFinalizeResult> {
    if (is_authority_store(store)) {
        return store.finalize_authority_transaction(path, id);
    }
    const value = entry(store, path);
    const stage = value.stages.get(id);
    const current = await store.read(path);
    if (
        !stage
        || current.revision !== stage.expectedStateRevision
        || value.authority.commitSequence !== stage.expectedCommitSequence
    ) {
        return {
            type: 'conflict',
            snapshot: current,
            authority: structuredClone(value.authority),
        };
    }
    let snapshot = current;
    if (stage.nextState) {
        const committed = await store.compare_and_set(
            path,
            current.revision,
            stage.nextState as PerFileState,
        );
        if (committed.type === 'conflict') {
            return {
                type: 'conflict',
                snapshot: committed.snapshot,
                authority: structuredClone(value.authority),
            };
        }
        snapshot = committed.snapshot;
    }
    const next = structuredClone(value.authority);
    next.commitSequence += 1;
    if (stage.kind === 'projection') {
        next.projectionRevision += 1;
        next.authorityRevision += 1;
    } else if (next.physicalDigest !== stage.physicalDigest) {
        next.physicalRevision += 1;
        next.authorityRevision += 1;
        next.physicalDigest = stage.physicalDigest;
    }
    value.authority = next;
    value.materialized = true;
    delete value.copyProvenance;
    value.stages.delete(id);
    return { type: 'finalized', snapshot, authority: structuredClone(next) };
}

export function discard_authority(
    store: FileStateStore,
    path: string,
    id: string,
): Promise<void> {
    if (is_authority_store(store)) {
        return store.discard_authority_transaction(path, id);
    }
    const value = entry(store, path);
    delete value.copyProvenance;
    value.stages.delete(id);
    return Promise.resolve();
}

export function with_in_memory_authority_transactions(
    store: FileStateStore,
): AuthorityFileStateStore {
    if (is_authority_store(store)) return store;
    const existing = wrapped_store.get(store);
    if (existing) return existing;
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => (
        enqueue_fallback(store, operation)
    );
    const copy_complete_entry = async (
        source: string,
        destination: string,
        copy_id: string,
    ): Promise<FileStateCopyResult> => {
        const entries = entries_for(store);
        const destination_entry = entries.get(destination);
        const prior_copy = destination_entry?.copyProvenance;
        if (
            destination_entry?.materialized
            && prior_copy?.id === copy_id
            && prior_copy.sourcePath === source
        ) {
            const current_destination = await store.read(destination);
            if (current_destination.revision === prior_copy.destination.revision) {
                const snapshots = {
                    source: structuredClone(prior_copy.source),
                    destination: structuredClone(prior_copy.destination),
                };
                return prior_copy.resultType === 'copied'
                    ? { type: 'copied', ...snapshots }
                    : { type: 'sourceAbsent', ...snapshots };
            }
            delete destination_entry.copyProvenance;
            return {
                type: 'destinationExists',
                destination: current_destination,
            };
        }
        if (destination_entry?.materialized) {
            return {
                type: 'destinationExists',
                destination: await store.read(destination),
            };
        }
        const source_entry = entries.get(source);
        const source_metadata = source_entry?.materialized
            ? {
                authority: structuredClone(source_entry.authority),
                stages: new Map([...source_entry.stages].map(([id, stage]) => (
                    [id, structuredClone(stage)]
                ))),
            }
            : undefined;
        if (!store.copy_entry_if_absent) return { type: 'unsupported' };

        let result: FileStateCopyResult;
        try {
            result = await store.copy_entry_if_absent(source, destination, copy_id);
        } catch (first_error) {
            try {
                result = await store.copy_entry_if_absent(source, destination, copy_id);
            } catch {
                throw first_error;
            }
        }
        if (
            !source_metadata
            || (result.type !== 'copied' && result.type !== 'sourceAbsent')
        ) return result;

        const stages = new Map([...source_metadata.stages].map(([id, stage]) => {
            const copied_stage = structuredClone(stage);
            if (copied_stage.expectedStateRevision === result.source.revision) {
                copied_stage.expectedStateRevision = result.destination.revision;
            }
            return [id, copied_stage];
        }));
        entries.set(destination, {
            authority: source_metadata.authority,
            stages,
            materialized: true,
            copyProvenance: {
                id: copy_id,
                sourcePath: source,
                source: structuredClone(result.source),
                destination: structuredClone(result.destination),
                resultType: result.type,
            },
        });
        return result;
    };
    const wrapped: AuthorityFileStateStore = {
        ...store,
        read_authority: (path) => enqueue(() => read_authority(store, path)),
        stage_authority_transaction: (path, input) => enqueue(
            () => stage_authority(store, path, input),
        ),
        finalize_authority_transaction: (path, id) => enqueue(
            () => finalize_authority(store, path, id),
        ),
        inspect_authority_transaction: (path, id) => enqueue(async () => ({
            snapshot: await store.read(path),
            authority: await read_authority(store, path),
            stagePresent: entry(store, path).stages.has(id),
        })),
        discard_authority_transaction: (path, id) => enqueue(
            () => discard_authority(store, path, id),
        ),
        cleanup_authority_transactions: () => enqueue(() => Promise.resolve()),
        lease_entry: (path, canonical_key, copy_from_if_absent, copy_id) => enqueue(async () => {
            let source_lease: Awaited<ReturnType<NonNullable<FileStateStore['lease_entry']>>>
                | undefined;
            let destination_lease: Awaited<ReturnType<NonNullable<FileStateStore['lease_entry']>>>
                | undefined;
            try {
                if (store.lease_entry) {
                    if (copy_from_if_absent && copy_from_if_absent !== path) {
                        source_lease = await store.lease_entry(
                            copy_from_if_absent,
                            canonical_key,
                        );
                    }
                    destination_lease = await store.lease_entry(path, canonical_key);
                } else {
                    await store.canonicalize_path?.(path, canonical_key);
                    destination_lease = { release: async () => {} };
                }
                if (copy_from_if_absent) {
                    await copy_complete_entry(
                        copy_from_if_absent,
                        path,
                        copy_id ?? `lease:${copy_from_if_absent}:${path}`,
                    );
                }
                return destination_lease;
            } catch (error) {
                await destination_lease?.release().catch(() => {});
                throw error;
            } finally {
                await source_lease?.release().catch((error) => {
                    console.error('Failed to release provider migration source lease', error);
                });
            }
        }),
        copy_entry_if_absent: (source, destination, copy_id) => enqueue(
            () => copy_complete_entry(source, destination, copy_id),
        ),
    };
    fallback_owner.set(wrapped, store);
    wrapped_store.set(store, wrapped);
    return wrapped;
}

export function release_authority_fallback(store: FileStateStore, path: string): void {
    const owner = fallback_store(store);
    if (!fallback_runtime.has(owner)) {
        fallback.get(owner)?.delete(path);
        return;
    }
    void enqueue_fallback(owner, async () => {
        fallback.get(owner)?.delete(path);
    });
}

export function cleanup_authority(
    store: FileStateStore,
    path: string,
): Promise<void> {
    return is_authority_store(store)
        ? store.cleanup_authority_transactions(path)
        : Promise.resolve();
}
