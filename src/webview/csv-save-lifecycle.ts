import {
    dirty_entries_equal,
    dirty_entry_value_changed,
    is_strict_wire_dirty_entry,
    is_wire_save_correlation,
    sanitized_wire_save_maps,
    sanitized_wire_worksheet_target,
    save_lifecycle_correlation,
    worksheet_target_key,
    worksheet_target_matches,
    type CsvDirtyMap,
    type CsvSaveLifecycle,
    type CsvSaveOperation,
    type MalformedCsvSaveLifecycle,
    type CsvSaveWorksheetOperation,
    type SheetPendingEditCells,
    type TerminalCsvSaveLifecycle,
} from '../types';

export { save_lifecycle_correlation } from '../types';
import { is_plain_record } from '../plain-record';

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

interface EqualStringRecords {
    readonly left: Readonly<Record<string, string>>;
    readonly right: Readonly<Record<string, string>>;
    readonly count: number;
}

function equal_string_records(left: unknown, right: unknown): EqualStringRecords | undefined {
    if (!is_plain_record(left) || !is_plain_record(right)) return undefined;
    let left_count = 0;
    let right_count = 0;
    for (const key in left) {
        if (!Object.prototype.hasOwnProperty.call(left, key)) continue;
        left_count += 1;
        if (
            typeof left[key] !== 'string'
            || !Object.prototype.hasOwnProperty.call(right, key)
            || right[key] !== left[key]
        ) return undefined;
    }
    if (left === right) {
        return {
            left: left as Readonly<Record<string, string>>,
            right: right as Readonly<Record<string, string>>,
            count: left_count,
        };
    }
    for (const key in right) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) continue;
        right_count += 1;
        if (typeof right[key] !== 'string') return undefined;
    }
    if (left_count !== right_count) return undefined;
    return {
        left: left as Readonly<Record<string, string>>,
        right: right as Readonly<Record<string, string>>,
        count: left_count,
    };
}

function strict_dirty_maps_equal_and_agree(
    left: unknown,
    right: unknown,
    edits: Readonly<Record<string, string>>,
    edit_count: number,
): boolean {
    if (!is_plain_record(left) || !is_plain_record(right)) return false;
    let left_count = 0;
    let right_count = 0;
    let expected_edit_count = 0;
    for (const key in left) {
        if (!Object.prototype.hasOwnProperty.call(left, key)) continue;
        left_count += 1;
        const left_entry = left[key];
        const right_entry = right[key];
        if (
            !Object.prototype.hasOwnProperty.call(right, key)
            || !is_strict_wire_dirty_entry(left_entry)
            || !is_strict_wire_dirty_entry(right_entry)
            || !dirty_entries_equal(left_entry, right_entry)
        ) return false;

        if (dirty_entry_value_changed(left_entry)) {
            expected_edit_count += 1;
            if (
                !Object.prototype.hasOwnProperty.call(edits, key)
                || edits[key] !== left_entry.value
            ) return false;
        } else if (Object.prototype.hasOwnProperty.call(edits, key)) {
            return false;
        }
    }
    if (left === right) return expected_edit_count === edit_count;
    for (const key in right) {
        if (Object.prototype.hasOwnProperty.call(right, key)) right_count += 1;
    }
    return left_count === right_count && expected_edit_count === edit_count;
}

function sanitized_operation_worksheet(
    value: unknown,
): CsvSaveWorksheetOperation | undefined {
    if (!is_plain_record(value)) return undefined;
    const target = sanitized_wire_worksheet_target(value);
    const maps = sanitized_wire_save_maps(value.edits, value.dirtyEdits);
    if (!target || !maps) return undefined;
    return Object.freeze({ ...target, ...maps });
}

function worksheet_operations_equal(left: unknown, right: unknown): boolean {
    if (!is_plain_record(left) || !is_plain_record(right)) return false;
    const left_target = sanitized_wire_worksheet_target(left);
    const right_target = left === right
        ? left_target
        : sanitized_wire_worksheet_target(right);
    if (
        !left_target
        || !right_target
        || left_target.sheetIndex !== right_target.sheetIndex
        || left_target.sheetName !== right_target.sheetName
        || left_target.worksheetId !== right_target.worksheetId
    ) return false;

    const edits = equal_string_records(left.edits, right.edits);
    if (
        edits
        && strict_dirty_maps_equal_and_agree(
            left.dirtyEdits,
            right.dirtyEdits,
            edits.left,
            edits.count,
        )
    ) return true;

    // Save ingress intentionally drops malformed optional rich/link metadata and
    // writes the safe plain projection. Compare that rare malformed proposal by
    // the same canonical form so the normalized success can release its lock;
    // required fields and cross-map disagreement still fail the decoder.
    const safe_left = sanitized_wire_save_maps(left.edits, left.dirtyEdits);
    const safe_right = left === right
        ? safe_left
        : sanitized_wire_save_maps(right.edits, right.dirtyEdits);
    if (!safe_left || !safe_right) return false;
    const safe_edits = equal_string_records(safe_left.edits, safe_right.edits);
    return safe_edits !== undefined
        && strict_dirty_maps_equal_and_agree(
            safe_left.dirtyEdits,
            safe_right.dirtyEdits,
            safe_edits.left,
            safe_edits.count,
        );
}

export function save_operation_worksheets(
    operation: CsvSaveOperation | undefined,
): readonly CsvSaveWorksheetOperation[] {
    if (!is_plain_record(operation) || !Array.isArray(operation.worksheets)) return [];
    const worksheets: CsvSaveWorksheetOperation[] = [];
    const sheet_indices = new Set<number>();
    const target_keys = new Set<string>();
    for (const candidate of operation.worksheets) {
        const worksheet = sanitized_operation_worksheet(candidate);
        // Recovery is workbook-atomic just like host admission: one malformed
        // member invalidates the whole proposal instead of exposing a safe-looking
        // subset that could overwrite newer per-sheet state. Duplicate targets
        // are equally non-atomic: sequentially restoring them would replace the
        // same sheet store more than once.
        if (!worksheet) return [];
        const target_key = worksheet_target_key(worksheet);
        if (
            sheet_indices.has(worksheet.sheetIndex)
            || target_keys.has(target_key)
        ) return [];
        sheet_indices.add(worksheet.sheetIndex);
        target_keys.add(target_key);
        worksheets.push(worksheet);
    }
    return worksheets;
}

function operation_correlation(operation: unknown) {
    return is_wire_save_correlation(operation) ? operation : undefined;
}

function is_malformed_save_lifecycle(
    lifecycle: unknown,
): lifecycle is MalformedCsvSaveLifecycle {
    return is_plain_record(lifecycle)
        && lifecycle.state === 'failed'
        && lifecycle.failure === 'malformedRequest';
}

export function csv_save_operations_equal(
    left: CsvSaveOperation | undefined,
    right: CsvSaveOperation | undefined,
): boolean {
    if (left === undefined || right === undefined) return left === right;
    const left_correlation = operation_correlation(left);
    const right_correlation = operation_correlation(right);
    if (
        !left_correlation
        || !right_correlation
        || !is_plain_record(left)
        || !is_plain_record(right)
        || !Array.isArray(left.worksheets)
        || !Array.isArray(right.worksheets)
        || left.worksheets.length === 0
        || right.worksheets.length === 0
    ) return false;
    return left_correlation.editSessionId === right_correlation.editSessionId
        && left_correlation.saveRequestId === right_correlation.saveRequestId
        && left.worksheets.length === right.worksheets.length
        && left.worksheets.every((worksheet, index) => (
            worksheet_operations_equal(worksheet, right.worksheets[index])
        ));
}

/**
 * Whether a terminal host lifecycle settles one locally locked proposal.
 * Ordinary terminals require the full immutable payload. A malformed wire
 * request cannot be echoed as a valid CsvSaveOperation, so that one explicit
 * failure correlates by the renderer-generated session/request pair and leaves
 * restoration to the renderer's own locked operation.
 */
export function terminal_csv_save_settles_operation(
    lifecycle: TerminalCsvSaveLifecycle,
    operation: CsvSaveOperation,
): boolean {
    if (!is_plain_record(lifecycle)) return false;
    if (is_malformed_save_lifecycle(lifecycle)) {
        const authoritative = save_lifecycle_correlation(lifecycle);
        const local = operation_correlation(operation);
        return authoritative !== undefined
            && local !== undefined
            && authoritative.editSessionId === local.editSessionId
            && authoritative.saveRequestId === local.saveRequestId;
    }
    return 'operation' in lifecycle
        && csv_save_operations_equal(lifecycle.operation, operation);
}

export function remove_operation_owned_pending_edits(
    pending_edits: CsvDirtyMap | undefined,
    worksheet: CsvSaveWorksheetOperation,
): CsvDirtyMap | undefined;
export function remove_operation_owned_pending_edits(
    pending_edits: SheetPendingEditCells | undefined,
    worksheet: CsvSaveWorksheetOperation,
): SheetPendingEditCells | undefined;
export function remove_operation_owned_pending_edits(
    pending_edits: SheetPendingEditCells | undefined,
    worksheet: CsvSaveWorksheetOperation,
): SheetPendingEditCells | undefined {
    if (!pending_edits) return undefined;
    if (!is_plain_record(pending_edits)) return pending_edits;
    let retained: SheetPendingEditCells | undefined;
    let remaining = 0;
    for (const [key, pending] of Object.entries(pending_edits)) {
        const owned = worksheet.dirtyEdits[key];
        const valid_pending = typeof pending !== 'string'
            && is_strict_wire_dirty_entry(pending)
            ? pending
            : undefined;
        // Runs are part of the match: a pending entry whose formatting differs
        // from what the operation saved is a *newer* formatting-only edit and
        // must survive the tombstone. (The legacy string form carries no runs,
        // so equal value is the whole identity there.) A malformed pending entry
        // is retained rather than throwing or being mistaken for saved state.
        const matches = owned !== undefined && (typeof pending === 'string'
            ? pending === owned.value
            : valid_pending !== undefined
                && dirty_entries_equal(valid_pending, owned));
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
    let match: CsvSaveWorksheetOperation | undefined;
    for (const worksheet of save_operation_worksheets(operation)) {
        // Argument order is significant: the operation's captured identity is
        // authoritative. A stable ID must not fall back to a reused name/index,
        // while a legacy index-only operation may match richer current metadata.
        if (!worksheet_target_matches(worksheet, target)) continue;
        // Different captured identity forms can alias the same live worksheet.
        // Recovery must reject that whole ambiguous lookup rather than exposing
        // whichever operation member happened to come first.
        if (match) return undefined;
        match = worksheet;
    }
    return match;
}

export function resolve_csv_save_hydration_from_worksheets(
    projection: Pick<CsvSaveProjection, 'authoritative' | 'operation'>,
    edit_session_id: string | undefined,
    pending_edits: SheetPendingEditCells | undefined,
    proposed_worksheet: CsvSaveWorksheetOperation | undefined,
    authoritative_worksheet: CsvSaveWorksheetOperation | undefined,
): SheetPendingEditCells | undefined {
    if (
        projection.operation?.editSessionId === edit_session_id
        && proposed_worksheet
    ) return proposed_worksheet.dirtyEdits;

    const lifecycle = projection.authoritative;
    if (
        lifecycle.state === 'idle'
        || is_malformed_save_lifecycle(lifecycle)
        || !authoritative_worksheet
    ) return pending_edits;
    if (lifecycle.state === 'active' || lifecycle.state === 'failed') {
        return lifecycle.operation.editSessionId === edit_session_id
            ? authoritative_worksheet.dirtyEdits
            : remove_operation_owned_pending_edits(
                pending_edits,
                authoritative_worksheet,
            );
    }
    return remove_operation_owned_pending_edits(
        pending_edits,
        authoritative_worksheet,
    );
}

export function resolve_csv_save_hydration(
    projection: Pick<CsvSaveProjection, 'authoritative' | 'operation'>,
    edit_session_id: string | undefined,
    sheet_index: number,
    sheet_name: string | undefined,
    worksheet_id: string | undefined,
    pending_edits: SheetPendingEditCells | undefined,
): SheetPendingEditCells | undefined {
    const proposed_worksheet = projection.operation
        ? save_operation_worksheet(
            projection.operation,
            sheet_index,
            sheet_name,
            worksheet_id,
        )
        : undefined;
    const lifecycle = projection.authoritative;
    const authoritative_worksheet = lifecycle.state !== 'idle'
        && !is_malformed_save_lifecycle(lifecycle)
        ? save_operation_worksheet(
            lifecycle.operation,
            sheet_index,
            sheet_name,
            worksheet_id,
        )
        : undefined;
    return resolve_csv_save_hydration_from_worksheets(
        projection,
        edit_session_id,
        pending_edits,
        proposed_worksheet,
        authoritative_worksheet,
    );
}

export function is_valid_csv_save_lifecycle(
    value: unknown,
): value is CsvSaveLifecycle {
    if (
        !is_plain_record(value)
        || !Number.isSafeInteger(value.revision)
        || (value.revision as number) < 0
    ) return false;
    if (value.state === 'idle') return true;
    if (is_malformed_save_lifecycle(value)) {
        return save_lifecycle_correlation(value) !== undefined;
    }
    if (value.state === 'failed' && value.failure !== undefined) return false;
    if (
        value.state !== 'active'
        && value.state !== 'failed'
        && value.state !== 'succeeded'
    ) return false;
    return operation_correlation(value.operation) !== undefined
        && is_plain_record(value.operation)
        && Array.isArray(value.operation.worksheets);
}

/** Apply one host projection without using request IDs as ordering authority. */
export function reduce_csv_save_projection(
    current: CsvSaveProjection,
    incoming: CsvSaveLifecycle,
): CsvSaveProjection {
    if (!is_valid_csv_save_lifecycle(incoming)) return current;
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
    const matches = incoming.state === 'active'
        ? csv_save_operations_equal(current.operation, incoming.operation)
        : terminal_csv_save_settles_operation(incoming, current.operation);
    if (!matches) {
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
