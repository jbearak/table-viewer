import {
    dirty_entries_equal,
    worksheet_target_matches,
    type CsvSaveLifecycle,
    type CsvSaveOperation,
    type CsvSaveWorksheetOperation,
    type SheetPendingEditCells,
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
    const left_keys = Object.keys(left);
    if (left_keys.length !== Object.keys(right).length) return false;
    return left_keys.every((key) => right[key] === left[key]);
}

function dirty_maps_equal(
    left: CsvSaveWorksheetOperation['dirtyEdits'],
    right: CsvSaveWorksheetOperation['dirtyEdits'],
): boolean {
    const left_keys = Object.keys(left);
    if (left_keys.length !== Object.keys(right).length) return false;
    return left_keys.every((key) => {
        const left_entry = left[key];
        const right_entry = right[key];
        // Full durable identity, runs included: a formatting-only difference
        // is a different operation, exactly as it is a different dirty entry.
        return right_entry !== undefined && dirty_entries_equal(left_entry, right_entry);
    });
}

function worksheet_operations_equal(
    left: CsvSaveWorksheetOperation,
    right: CsvSaveWorksheetOperation,
): boolean {
    return left.sheetIndex === right.sheetIndex
        && left.sheetName === right.sheetName
        && left.worksheetId === right.worksheetId
        && records_equal(left.edits, right.edits)
        && dirty_maps_equal(left.dirtyEdits, right.dirtyEdits);
}

export function csv_save_operations_equal(
    left: CsvSaveOperation | undefined,
    right: CsvSaveOperation | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.editSessionId === right.editSessionId
        && left.saveRequestId === right.saveRequestId
        && left.worksheets.length === right.worksheets.length
        && left.worksheets.every((worksheet, index) => (
            worksheet_operations_equal(worksheet, right.worksheets[index])
        ));
}

function remove_operation_owned_pending_edits(
    pending_edits: SheetPendingEditCells | undefined,
    worksheet: CsvSaveWorksheetOperation,
): SheetPendingEditCells | undefined {
    if (!pending_edits) return undefined;
    let retained: SheetPendingEditCells | undefined;
    let remaining = 0;
    for (const [key, pending] of Object.entries(pending_edits)) {
        const owned = worksheet.dirtyEdits[key];
        // Runs are part of the match: a pending entry whose formatting differs
        // from what the operation saved is a *newer* formatting-only edit and
        // must survive the tombstone. (The legacy string form carries no runs,
        // so equal value is the whole identity there.)
        const matches = owned !== undefined && (typeof pending === 'string'
            ? pending === owned.value
            : dirty_entries_equal(pending, owned));
        if (matches) {
            retained ??= { ...pending_edits };
            delete retained[key];
        } else {
            remaining += 1;
        }
    }
    if (!retained) return pending_edits;
    return remaining > 0 ? retained : undefined;
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
export function save_operation_worksheet(
    operation: CsvSaveOperation,
    sheet_index: number,
    sheet_name: string | undefined,
    worksheet_id: string | undefined,
): CsvSaveWorksheetOperation | undefined {
    const target = {
        sheetIndex: sheet_index,
        sheetName: sheet_name,
        worksheetId: worksheet_id,
    };
    return operation.worksheets.find((worksheet) => (
        // Argument order is significant: the operation's captured identity is
        // authoritative. A stable ID must not fall back to a reused name/index,
        // while a legacy index-only operation may match richer current metadata.
        worksheet_target_matches(worksheet, target)
    ));
}

export function resolve_csv_save_hydration(
    projection: Pick<CsvSaveProjection, 'authoritative' | 'operation'>,
    edit_session_id: string | undefined,
    sheet_index: number,
    sheet_name: string | undefined,
    worksheet_id: string | undefined,
    pending_edits: SheetPendingEditCells | undefined,
): SheetPendingEditCells | undefined {
    if (
        projection.operation
        && projection.operation.editSessionId === edit_session_id
    ) {
        const worksheet = save_operation_worksheet(
            projection.operation,
            sheet_index,
            sheet_name,
            worksheet_id,
        );
        if (worksheet) return worksheet.dirtyEdits;
    }

    const lifecycle = projection.authoritative;
    if (lifecycle.state === 'idle') return pending_edits;
    const worksheet = save_operation_worksheet(
        lifecycle.operation,
        sheet_index,
        sheet_name,
        worksheet_id,
    );
    if (!worksheet) return pending_edits;
    if (lifecycle.state === 'active' || lifecycle.state === 'failed') {
        return lifecycle.operation.editSessionId === edit_session_id
            ? worksheet.dirtyEdits
            : remove_operation_owned_pending_edits(pending_edits, worksheet);
    }
    return remove_operation_owned_pending_edits(pending_edits, worksheet);
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
