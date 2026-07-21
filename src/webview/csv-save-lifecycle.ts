import type {
    CsvSaveLifecycle,
    CsvSaveOperation,
    PerFileState,
} from '../types';

export interface CsvSaveProjection {
    readonly authoritative: CsvSaveLifecycle;
    /**
     * The exact locally locked operation. Host revision ordering advances
     * `authoritative`, but only an active/terminal projection naming this exact
     * operation may replace or settle the lock.
     */
    readonly operation?: CsvSaveOperation;
}

export const INITIAL_CSV_SAVE_LIFECYCLE: CsvSaveLifecycle = Object.freeze({
    revision: 0,
    state: 'idle',
});

export const INITIAL_CSV_SAVE_PROJECTION: CsvSaveProjection = Object.freeze({
    authoritative: INITIAL_CSV_SAVE_LIFECYCLE,
});

function records_equal(
    left: Readonly<Record<string, string>>,
    right: Readonly<Record<string, string>>,
): boolean {
    const left_keys = Object.keys(left).sort();
    const right_keys = Object.keys(right).sort();
    return left_keys.length === right_keys.length
        && left_keys.every((key, index) => (
            key === right_keys[index] && left[key] === right[key]
        ));
}

export function csv_save_operations_equal(
    left: CsvSaveOperation | undefined,
    right: CsvSaveOperation | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    if (
        left.editSessionId !== right.editSessionId
        || left.saveRequestId !== right.saveRequestId
        || !records_equal(left.edits, right.edits)
    ) return false;
    const left_keys = Object.keys(left.dirtyEdits).sort();
    const right_keys = Object.keys(right.dirtyEdits).sort();
    return left_keys.length === right_keys.length
        && left_keys.every((key, index) => {
            const left_entry = left.dirtyEdits[key];
            const right_entry = right.dirtyEdits[key];
            return key === right_keys[index]
                && left_entry.value === right_entry.value
                && left_entry.base === right_entry.base;
        });
}

function remove_operation_owned_pending_edits(
    pending_edits: PerFileState['pendingEdits'],
    operation: CsvSaveOperation,
): PerFileState['pendingEdits'] {
    if (!pending_edits) return undefined;
    let removed = false;
    const retained = Object.fromEntries(Object.entries(pending_edits).filter(([key, pending]) => {
        const owned = operation.dirtyEdits[key];
        const matches = owned !== undefined && (typeof pending === 'string'
            ? pending === owned.value
            : pending.value === owned.value && pending.base === owned.base);
        if (matches) removed = true;
        return !matches;
    }));
    if (!removed) return pending_edits;
    return Object.keys(retained).length > 0 ? retained : undefined;
}

export function propose_csv_save(
    current: CsvSaveProjection,
    operation: CsvSaveOperation,
): CsvSaveProjection {
    if (current.operation) return current;
    return {
        authoritative: current.authoritative,
        operation,
    };
}

/**
 * Resolve pending edits at a hydration boundary for one current edit session.
 * A retained local/active operation wins only for its own session. A failed
 * operation restores only that same session, while success tombstones stale
 * operation-owned state unless the host has already granted a different one.
 */
export function resolve_csv_save_hydration(
    projection: Pick<CsvSaveProjection, 'authoritative' | 'operation'>,
    edit_session_id: string | undefined,
    pending_edits: PerFileState['pendingEdits'],
): PerFileState['pendingEdits'] {
    if (
        projection.operation
        && projection.operation.editSessionId === edit_session_id
    ) {
        return projection.operation.dirtyEdits;
    }

    const lifecycle = projection.authoritative;
    if (lifecycle.state === 'active' || lifecycle.state === 'failed') {
        return lifecycle.operation.editSessionId === edit_session_id
            ? lifecycle.operation.dirtyEdits
            : remove_operation_owned_pending_edits(
                pending_edits,
                lifecycle.operation,
            );
    }
    if (lifecycle.state === 'succeeded') {
        return remove_operation_owned_pending_edits(
            pending_edits,
            lifecycle.operation,
        );
    }
    return pending_edits;
}

/** Apply one host projection without using request IDs as ordering authority. */
export function reduce_csv_save_projection(
    current: CsvSaveProjection,
    incoming: CsvSaveLifecycle,
): CsvSaveProjection {
    const previous = current.authoritative;
    if (incoming.revision < previous.revision) return current;
    if (incoming.revision === previous.revision) {
        // One revision denotes one immutable host projection. Exact retries are
        // idempotent; a malformed same-revision mismatch has no authority to
        // replace the already-observed value either.
        return current;
    }

    if (incoming.state === 'idle') {
        return {
            authoritative: incoming,
            ...(current.operation ? { operation: current.operation } : {}),
        };
    }

    if (!current.operation) {
        return {
            authoritative: incoming,
            ...(incoming.state === 'active' ? { operation: incoming.operation } : {}),
        };
    }
    if (!csv_save_operations_equal(current.operation, incoming.operation)) {
        return {
            authoritative: incoming,
            operation: current.operation,
        };
    }
    return {
        authoritative: incoming,
        ...(incoming.state === 'active' ? { operation: incoming.operation } : {}),
    };
}
