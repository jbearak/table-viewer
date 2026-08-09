import {
    create_keyed_authority_store,
    create_keyed_file_state_persistence,
    type AuthorityFileStateStore,
    type DurableFileAuthority,
    type FileStateCompareAndSetResult,
    type FileStateCopyResult,
    type FileStatePersistenceMedium,
    type FileStateSnapshot,
    type FileStateStore,
} from './state';
import { SQLITE_PREPARED_INSTALL_STATE_KEY } from './sqlite-file-state-repository';
import {
    decode_stored_per_file_state,
    type PerFileState,
    type StoredPerFileState,
} from './types';

export interface OpenedCosmeticFileStateStore {
    readonly store: FileStateStore;
    close(): Promise<void>;
}

function cosmetic_state(value: unknown): StoredPerFileState {
    const decoded = decode_stored_per_file_state(value);
    delete (decoded as { pendingEdits?: unknown }).pendingEdits;
    delete (decoded as Record<string, unknown>)[SQLITE_PREPARED_INSTALL_STATE_KEY];
    return decoded;
}

function cosmetic_authority(): DurableFileAuthority {
    return {
        commitSequence: 0,
        authorityRevision: 0,
        physicalRevision: 0,
        projectionRevision: 0,
    };
}

function cosmetic_snapshot(snapshot: FileStateSnapshot): FileStateSnapshot {
    return {
        state: cosmetic_state(snapshot.state),
        revision: snapshot.revision,
    };
}

function cosmetic_compare_and_set_result(
    result: FileStateCompareAndSetResult,
): FileStateCompareAndSetResult {
    return {
        ...result,
        snapshot: cosmetic_snapshot(result.snapshot),
        authority: cosmetic_authority(),
    };
}

function cosmetic_copy_result(result: FileStateCopyResult): FileStateCopyResult {
    switch (result.type) {
        case 'copied':
        case 'sourceAbsent':
            return {
                ...result,
                source: cosmetic_snapshot(result.source),
                destination: cosmetic_snapshot(result.destination),
            };
        case 'destinationExists':
            return {
                ...result,
                destination: cosmetic_snapshot(result.destination),
            };
        default:
            return result;
    }
}

/**
 * Expose only the cosmetic FileStateStore surface over the shared semantic core.
 * Pending edits and internal physical-install lifecycle state are removed on both
 * sides of the boundary, authority is always projected as empty, and provider
 * migration uses the semantic core's atomic cosmetic-only copy operation.
 */
export function create_cosmetic_file_state_store(backing: AuthorityFileStateStore): FileStateStore {
    const store: FileStateStore = {
        async read(filePath) {
            return cosmetic_snapshot(await backing.read(filePath));
        },
        async compare_and_set(filePath, expectedRevision, state, validate, basis) {
            if (basis !== undefined) {
                throw new TypeError('Cosmetic file state does not accept a physical authority basis.');
            }
            const proposed = cosmetic_state(state) as PerFileState;
            return cosmetic_compare_and_set_result(await backing.compare_and_set(
                filePath,
                expectedRevision,
                proposed,
                validate,
            ));
        },
        touch(filePath) {
            return backing.touch(filePath);
        },
    };
    const copyCosmeticEntryIfAbsent = async (
        sourcePath: string,
        destinationPath: string,
        copyId: string,
    ): Promise<FileStateCopyResult> => cosmetic_copy_result(
        await backing.copy_cosmetic_entry_if_absent(sourcePath, destinationPath, copyId),
    );
    Object.defineProperty(store, 'copy_cosmetic_entry_if_absent', {
        value: copyCosmeticEntryIfAbsent,
    });
    store.copy_entry_if_absent = copyCosmeticEntryIfAbsent;
    return store;
}

/** Create a fresh, process-local cosmetic store with the normal keyed semantics. */
export function open_in_memory_cosmetic_file_state_store(
    getMaxStoredFiles?: () => number,
): OpenedCosmeticFileStateStore {
    let envelope: unknown = {};
    const medium: FileStatePersistenceMedium = {
        runtime_key: {},
        read: () => structuredClone(envelope),
        async write(value) {
            envelope = structuredClone(value);
        },
    };
    const persistence = create_keyed_file_state_persistence(medium);
    const backing = create_keyed_authority_store(persistence, getMaxStoredFiles);
    let closePromise: Promise<void> | undefined;
    return {
        store: create_cosmetic_file_state_store(backing),
        close() {
            closePromise ??= persistence.close();
            return closePromise;
        },
    };
}
