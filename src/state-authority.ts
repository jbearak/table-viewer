import type {
    AuthorityFileStateStore,
    AuthorityTransactionFinalizeResult,
    AuthorityTransactionStageInput,
    AuthorityTransactionStageResult,
    DurableFileAuthority,
    FileStateStore,
} from './state';
import type { PerFileState } from './types';

interface FallbackEntry {
    authority: DurableFileAuthority;
    stages: Map<string, AuthorityTransactionStageInput>;
}

const fallback = new Map<string, FallbackEntry>();

function empty(): DurableFileAuthority {
    return {
        commitSequence: 0,
        authorityRevision: 0,
        physicalRevision: 0,
        projectionRevision: 0,
    };
}

function entry(_store: FileStateStore, path: string): FallbackEntry {
    let value = fallback.get(path);
    if (!value) {
        value = { authority: empty(), stages: new Map() };
        fallback.set(path, value);
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
    entry(store, path).stages.delete(id);
    return Promise.resolve();
}

export function with_in_memory_authority_transactions(
    store: FileStateStore,
): AuthorityFileStateStore {
    if (is_authority_store(store)) return store;
    return {
        ...store,
        read_authority: (path) => read_authority(store, path),
        stage_authority_transaction: (path, input) => stage_authority(store, path, input),
        finalize_authority_transaction: (path, id) => finalize_authority(store, path, id),
        inspect_authority_transaction: async (path, id) => ({
            snapshot: await store.read(path),
            authority: await read_authority(store, path),
            stagePresent: entry(store, path).stages.has(id),
        }),
        discard_authority_transaction: (path, id) => discard_authority(store, path, id),
        cleanup_authority_transactions: () => Promise.resolve(),
    };
}

export function release_authority_fallback(path: string): void {
    fallback.delete(path);
}

export function cleanup_authority(
    store: FileStateStore,
    path: string,
): Promise<void> {
    return is_authority_store(store)
        ? store.cleanup_authority_transactions(path)
        : Promise.resolve();
}
