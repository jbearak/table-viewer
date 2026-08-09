import type {
    DurableFileAuthority,
    FileStateCompareAndSetResult,
    FileStateSnapshot,
    FileStateStore,
} from '../../state';
import type { PerFileState, StoredPerFileState } from '../../types';

export function versioned_state_store(initial: StoredPerFileState = {}) {
    const authority: DurableFileAuthority = {
        commitSequence: 0,
        authorityRevision: 0,
        physicalRevision: 0,
        projectionRevision: 0,
    };
    const states = new Map<string, StoredPerFileState>();
    const revisions = new Map<string, number>();
    const copies = new Map<string, {
        id: string;
        sourcePath: string;
        source: FileStateSnapshot;
        destination: FileStateSnapshot;
    }>();

    const snapshot = (file_path: string): FileStateSnapshot => ({
        state: structuredClone(states.get(file_path) ?? initial),
        revision: revisions.get(file_path) ?? 0,
    });

    const store: FileStateStore = {
        async read(file_path) {
            return snapshot(file_path);
        },
        async compare_and_set(
            file_path,
            expected_revision,
            state,
            validate,
            basis,
        ): Promise<FileStateCompareAndSetResult> {
            const current = snapshot(file_path);
            const valid = validate === undefined || validate() === true;
            const basis_matches = !basis || (
                basis.recoveryRecordId === undefined
                && basis.expectedAuthorityRevision === authority.authorityRevision
                && (
                    basis.expectedPhysicalRevision === undefined
                    || basis.expectedPhysicalRevision === authority.physicalRevision
                )
                && (
                    basis.expectedProjectionRevision === undefined
                    || basis.expectedProjectionRevision === authority.projectionRevision
                )
            );
            if (current.revision !== expected_revision || !valid || !basis_matches) {
                return { type: 'conflict', snapshot: current, authority: structuredClone(authority) };
            }
            const revision = expected_revision + 1;
            states.set(file_path, structuredClone(state));
            revisions.set(file_path, revision);
            copies.delete(file_path);
            return {
                type: 'committed',
                snapshot: { state: structuredClone(state), revision },
                authority: structuredClone(authority),
            };
        },
        async copy_entry_if_absent(source_path, destination_path, copy_id) {
            if (states.has(destination_path) || revisions.has(destination_path)) {
                const prior = copies.get(destination_path);
                if (prior?.id === copy_id && prior.sourcePath === source_path) {
                    return {
                        type: 'copied',
                        source: structuredClone(prior.source),
                        destination: structuredClone(prior.destination),
                    };
                }
                return {
                    type: 'destinationExists',
                    destination: snapshot(destination_path),
                };
            }
            if (
                !states.has(source_path)
                && !revisions.has(source_path)
                && Object.keys(initial).length === 0
            ) {
                return {
                    type: 'sourceAbsent',
                    source: snapshot(source_path),
                    destination: snapshot(destination_path),
                };
            }
            const source = snapshot(source_path);
            const destination = {
                state: structuredClone(source.state),
                revision: 1,
            };
            states.set(destination_path, structuredClone(destination.state));
            revisions.set(destination_path, destination.revision);
            copies.set(destination_path, {
                id: copy_id,
                sourcePath: source_path,
                source: structuredClone(source),
                destination: structuredClone(destination),
            });
            return {
                type: 'copied',
                source,
                destination,
            };
        },
        async touch() {},
    };

    return {
        store,
        get_state(file_path: string): PerFileState {
            return structuredClone(states.get(file_path) ?? initial) as PerFileState;
        },
        revision(file_path: string): number {
            return revisions.get(file_path) ?? 0;
        },
    };
}
