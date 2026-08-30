import {
    dirty_entries_equal,
    dirty_entry_observed_base,
    dirty_entry_value_changed,
    dirty_entry_with_observed_file_base,
    is_strict_wire_dirty_entry,
    is_wire_save_correlation,
    make_observed_file_base,
    observed_file_bases_equal,
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
    type WorksheetPendingEdits,
    type WorksheetTarget,
} from '../types';
import {
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    own_pending_structural_changes,
    type PendingStructuralChanges,
} from '../pending-changes';

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

interface SanitizedWorksheetTargetMember {
    readonly source: Record<string, unknown>;
    readonly target: WorksheetTarget;
}

const STRUCTURAL_CHANGE_KEYS = new Set([
    'formatTemplates',
    'appendedRows',
    'tailRemovals',
    'appendBasis',
    'conflicts',
]);

function sanitized_structural_changes(value: unknown): PendingStructuralChanges | undefined {
    if (value === undefined) return EMPTY_PENDING_STRUCTURAL_CHANGES;
    if (
        !is_plain_record(value)
        || Object.keys(value).some((key) => !STRUCTURAL_CHANGE_KEYS.has(key))
        || value.formatTemplates === undefined
        || value.appendedRows === undefined
        || value.tailRemovals === undefined
        || value.conflicts === undefined
    ) return undefined;
    try {
        return own_pending_structural_changes(value);
    } catch {
        return undefined;
    }
}

function structural_changes_equal(left: unknown, right: unknown): boolean {
    const owned_left = sanitized_structural_changes(left);
    if (owned_left === undefined) return false;
    const owned_right = left === right
        ? owned_left
        : sanitized_structural_changes(right);
    return owned_right !== undefined
        && JSON.stringify(owned_left) === JSON.stringify(owned_right);
}

function sanitized_operation_worksheet_targets(
    operation: unknown,
): readonly SanitizedWorksheetTargetMember[] | undefined {
    if (
        !is_plain_record(operation)
        || !Array.isArray(operation.worksheets)
        || operation.worksheets.length === 0
    ) return undefined;
    const members: SanitizedWorksheetTargetMember[] = [];
    const sheet_indices = new Set<number>();
    const target_keys = new Set<string>();
    for (let index = 0; index < operation.worksheets.length; index += 1) {
        // Array iteration skips holes, so require every ordinal to be an owned
        // member before treating the collection as an atomic workbook payload.
        if (!Object.prototype.hasOwnProperty.call(operation.worksheets, index)) {
            return undefined;
        }
        const source = operation.worksheets[index];
        const target = sanitized_wire_worksheet_target(source);
        if (!target) return undefined;
        const target_key = worksheet_target_key(target);
        if (
            sheet_indices.has(target.sheetIndex)
            || target_keys.has(target_key)
        ) return undefined;
        sheet_indices.add(target.sheetIndex);
        target_keys.add(target_key);
        members.push({
            // A successful target decode proves that the source is a plain record.
            source: source as Record<string, unknown>,
            target,
        });
    }
    return members;
}

function sanitized_operation_worksheet(
    member: SanitizedWorksheetTargetMember,
): CsvSaveWorksheetOperation | undefined {
    const maps = sanitized_wire_save_maps(
        member.source.edits,
        member.source.dirtyEdits,
    );
    if (!maps) return undefined;
    const structural = sanitized_structural_changes(member.source.structuralChanges);
    if (structural === undefined) return undefined;
    return Object.freeze({
        ...member.target,
        ...maps,
        ...(member.source.structuralChanges === undefined
            ? {}
            : { structuralChanges: structural }),
    });
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
    let maps_equal = edits !== undefined
        && strict_dirty_maps_equal_and_agree(
            left.dirtyEdits,
            right.dirtyEdits,
            edits.left,
            edits.count,
        );
    if (!maps_equal) {
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
        maps_equal = safe_edits !== undefined
            && strict_dirty_maps_equal_and_agree(
                safe_left.dirtyEdits,
                safe_right.dirtyEdits,
                safe_edits.left,
                safe_edits.count,
            );
    }
    return maps_equal && structural_changes_equal(
        left.structuralChanges,
        right.structuralChanges,
    );
}

export function save_operation_worksheets(
    operation: CsvSaveOperation | undefined,
): readonly CsvSaveWorksheetOperation[] {
    const members = sanitized_operation_worksheet_targets(operation);
    if (!members) return [];
    const worksheets: CsvSaveWorksheetOperation[] = [];
    for (const member of members) {
        const worksheet = sanitized_operation_worksheet(member);
        // Recovery is workbook-atomic just like host admission: one malformed
        // member invalidates the whole proposal instead of exposing a safe-looking
        // subset that could overwrite newer per-sheet state. Target collection
        // validity and uniqueness were established by the shared shallow decoder.
        if (!worksheet) return [];
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
        const observed_saved_value = (() => {
            if (
                owned === undefined
                || valid_pending?.observedBase === undefined
                || !dirty_entries_equal(
                    valid_pending,
                    dirty_entry_with_observed_file_base(
                        owned,
                        valid_pending.observedBase,
                    ),
                )
            ) return false;
            const before_save = dirty_entry_observed_base(owned);
            const wrote_value = Object.prototype.hasOwnProperty.call(
                worksheet.edits,
                key,
            );
            const saved_file_side = make_observed_file_base(
                wrote_value ? owned.value : before_save.value,
                wrote_value ? owned.valueRuns : before_save.runs,
                owned.link === undefined ? undefined : owned.link,
            );
            return observed_file_bases_equal(
                valid_pending.observedBase,
                saved_file_side,
            );
        })();
        const matches = owned !== undefined && (typeof pending === 'string'
            ? pending === owned.value
            : valid_pending !== undefined
                && (
                    dirty_entries_equal(valid_pending, owned)
                    // A reload can observe the file write before its success
                    // terminal arrives. That observation is still the saved
                    // operation's entry, not a newer user edit.
                    || observed_saved_value
                ));
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

export function remove_operation_owned_pending_structural_changes(
    pending_changes: PendingStructuralChanges | WorksheetPendingEdits | undefined,
    worksheet: CsvSaveWorksheetOperation,
): PendingStructuralChanges | undefined {
    const owned = worksheet.structuralChanges;
    if (pending_changes === undefined) return undefined;
    const pending = own_pending_structural_changes(pending_changes);
    if (owned === undefined) return pending;
    const pending_row_ids = new Set(owned.appendedRows.map((row) => row.id));
    const removed_source_rows = new Set(
        owned.tailRemovals.map((removal) => removal.sourceRow),
    );
    // GridShell raises its save fence synchronously with capturing the operation,
    // so this pending identity cannot acquire a newer user edit while the save
    // runs. The receipt therefore settles the admitted append by ID. Retaining a
    // same-ID row here would represent the already-written row as another append.
    const appended_rows = pending.appendedRows.filter(
        (row) => !pending_row_ids.has(row.id),
    );
    const tail_removals = pending.tailRemovals.filter(
        (removal) => !removed_source_rows.has(removal.sourceRow),
    );
    if (
        appended_rows.length === pending.appendedRows.length
        && tail_removals.length === pending.tailRemovals.length
    ) return pending;
    const retained_template_ids = new Set(
        appended_rows.map((row) => row.formatTemplateId),
    );
    return own_pending_structural_changes({
        ...pending,
        formatTemplates: pending.formatTemplates.filter(
            (template) => retained_template_ids.has(template.id),
        ),
        appendedRows: appended_rows,
        tailRemovals: tail_removals,
        appendBasis: appended_rows.length === 0
            ? undefined
            : pending.appendBasis,
    });
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

export function resolve_csv_save_structural_hydration_from_worksheets(
    projection: Pick<CsvSaveProjection, 'authoritative' | 'operation'>,
    edit_session_id: string | undefined,
    pending_changes: PendingStructuralChanges | WorksheetPendingEdits | undefined,
    proposed_worksheet: CsvSaveWorksheetOperation | undefined,
    authoritative_worksheet: CsvSaveWorksheetOperation | undefined,
): PendingStructuralChanges | undefined {
    const pending = pending_changes === undefined
        ? undefined
        : own_pending_structural_changes(pending_changes);
    if (
        projection.operation?.editSessionId === edit_session_id
        && proposed_worksheet
    ) return proposed_worksheet.structuralChanges ?? EMPTY_PENDING_STRUCTURAL_CHANGES;

    const lifecycle = projection.authoritative;
    if (
        lifecycle.state === 'idle'
        || is_malformed_save_lifecycle(lifecycle)
        || !authoritative_worksheet
    ) return pending;
    if (lifecycle.state === 'active' || lifecycle.state === 'failed') {
        return lifecycle.operation.editSessionId === edit_session_id
            ? authoritative_worksheet.structuralChanges
                ?? EMPTY_PENDING_STRUCTURAL_CHANGES
            : pending;
    }
    if (
        edit_session_id !== undefined
        && lifecycle.operation.editSessionId !== edit_session_id
    ) return pending;
    return remove_operation_owned_pending_structural_changes(
        pending,
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
    if (operation_correlation(value.operation) === undefined) return false;
    // Keep malformed maps recoverable by a later correlation-only terminal, but
    // reject any target collection that cannot participate in atomic worksheet
    // recovery and could otherwise strand an active save lock.
    return sanitized_operation_worksheet_targets(value.operation) !== undefined;
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
