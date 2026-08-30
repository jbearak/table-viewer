/** Display-only composition of immutable source rows and structural overlays. */

import type {
    PendingAppendedRow,
    PendingStructuralChanges,
    PendingTailRemoval,
    RowIdentity,
} from '../pending-changes';

export type PendingProjectedRow =
    | {
        readonly kind: 'source';
        /** Absent until the raw source-display row is resident. */
        readonly identity?: Extract<RowIdentity, { kind: 'source' }>;
        readonly sourceDisplayRow: number;
    }
    | {
        readonly kind: 'removal';
        readonly identity: Extract<RowIdentity, { kind: 'source' }>;
        readonly removal: PendingTailRemoval;
        readonly intendedPhysicalRow: number;
    }
    | {
        readonly kind: 'pending';
        readonly identity: Extract<RowIdentity, { kind: 'pending' }>;
        readonly row: PendingAppendedRow;
        readonly intendedPhysicalRow: number;
    }
    | {
        readonly kind: 'replacement';
        readonly identity: Extract<RowIdentity, { kind: 'pending' }>;
        readonly removedIdentity: Extract<RowIdentity, { kind: 'source' }>;
        readonly removal: PendingTailRemoval;
        readonly row: PendingAppendedRow;
        readonly intendedPhysicalRow: number;
    };

export interface PendingRowProjection {
    readonly sourceRowCount: number;
    readonly deletedBandStart: number;
    readonly pendingBandStart: number;
    readonly rowCount: number;
    row_at(display_row: number): PendingProjectedRow | undefined;
    display_row_for_identity(identity: RowIdentity): number | undefined;
    /** Compress one host/source-display coordinate into the current source band. */
    display_row_for_source_display(source_display_row: number): number | undefined;
    display_row_for_tail_removal_id(append_history_id: string): number | undefined;
    /** Expand compressed source-band intervals back into host display space. */
    source_display_intervals(
        intervals: readonly { readonly start: number; readonly end: number }[],
    ): { start: number; end: number }[];
}

export interface PendingRowProjectionInput {
    /** Source-backed display rows after transforms, before tail-removal exclusion. */
    readonly sourceDisplayRowCount: number;
    readonly sourceRowAt: (source_display_row: number) => number | undefined;
    /** Host/core-owned inverse; avoids scanning a million-row projection. */
    readonly displayRowForSource: (source_row: number) => number | undefined;
    /** Physical file row count, before pending removals/appends. */
    readonly sourceRowCount: number;
    readonly changes: PendingStructuralChanges;
    /** Latest row payload for a topology-stable index. */
    readonly appendedRowAt?: (index: number) => PendingAppendedRow | undefined;
    /** Display positions occupied by visible tail removals in the source view. */
    readonly removedSourceDisplayRows?: readonly number[];
    /** Removal identities whose transformed inverse lookup has completed. */
    readonly projectedTailRemovalIds?: ReadonlySet<string>;
}

export function create_pending_row_projection(
    input: PendingRowProjectionInput,
): PendingRowProjection {
    const removed_source_display_rows = [...new Set(
        input.removedSourceDisplayRows ?? [],
    )].filter((row) => Number.isSafeInteger(row)
        && row >= 0
        && row < input.sourceDisplayRowCount)
        .sort((left, right) => left - right);
    const removed_display_set = new Set(removed_source_display_rows);
    const filtered_source_count = input.sourceDisplayRowCount
        - removed_source_display_rows.length;
    const first_not_less_than = (value: number): number => {
        let low = 0;
        let high = removed_source_display_rows.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (removed_source_display_rows[middle] < value) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    const first_greater_than = (value: number): number => {
        let low = 0;
        let high = removed_source_display_rows.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (removed_source_display_rows[middle] <= value) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    const raw_source_display_row = (filtered_row: number): number | undefined => {
        if (filtered_row < 0 || filtered_row >= filtered_source_count) return undefined;
        let low = filtered_row;
        let high = filtered_row + removed_source_display_rows.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            const retained_through_middle = middle + 1 - first_greater_than(middle);
            if (retained_through_middle >= filtered_row + 1) high = middle;
            else low = middle + 1;
        }
        return low;
    };
    const filtered_source_display_row = (raw_row: number): number | undefined => {
        if (removed_display_set.has(raw_row)) return undefined;
        const removed_before = first_not_less_than(raw_row);
        const filtered = raw_row - removed_before;
        return filtered >= 0 && filtered < filtered_source_count ? filtered : undefined;
    };
    const prospective_start = input.sourceRowCount - input.changes.tailRemovals.length;
    const projected_tail_removals = input.projectedTailRemovalIds === undefined
        ? input.changes.tailRemovals
        : input.changes.tailRemovals.filter((removal) =>
            input.projectedTailRemovalIds!.has(removal.appendHistoryId));
    const removal_by_row = new Map(
        projected_tail_removals.map((removal) => [removal.sourceRow, removal]),
    );
    const replaced_rows = new Set<number>();
    const pending_rows: Array<Extract<
        PendingProjectedRow,
        { kind: 'pending' | 'replacement' }
    > & { readonly rowIndex: number }> = input.changes.appendedRows.map((row, index) => {
        const intendedPhysicalRow = prospective_start + index;
        const removal = removal_by_row.get(intendedPhysicalRow);
        if (removal !== undefined) {
            replaced_rows.add(removal.sourceRow);
            return {
                kind: 'replacement',
                identity: { kind: 'pending', pendingRowId: row.id },
                removedIdentity: { kind: 'source', sourceRow: removal.sourceRow },
                removal,
                row,
                rowIndex: index,
                intendedPhysicalRow,
            };
        }
        return {
            kind: 'pending',
            identity: { kind: 'pending', pendingRowId: row.id },
            row,
            rowIndex: index,
            intendedPhysicalRow,
        };
    });
    const deleted_rows: Array<Extract<PendingProjectedRow, { kind: 'removal' }>> =
        projected_tail_removals
        .filter((removal) => !replaced_rows.has(removal.sourceRow))
        .map((removal) => ({
            kind: 'removal',
            identity: { kind: 'source', sourceRow: removal.sourceRow },
            removal,
            intendedPhysicalRow: removal.sourceRow,
        }));
    const pending_index_by_id = new Map<string, number>();
    const pending_index_by_removal_id = new Map<string, number>();
    const replacement_index_by_removed_source = new Map<number, number>();
    pending_rows.forEach((row, index) => {
        pending_index_by_id.set(row.identity.pendingRowId, index);
        if (row.kind === 'replacement') {
            pending_index_by_removal_id.set(row.removal.appendHistoryId, index);
            replacement_index_by_removed_source.set(row.removedIdentity.sourceRow, index);
        }
    });
    const deleted_index_by_removal_id = new Map(
        deleted_rows.map((row, index) => [row.removal.appendHistoryId, index]),
    );
    const deleted_index_by_source_row = new Map(
        deleted_rows.map((row, index) => [row.identity.sourceRow, index]),
    );
    const deletedBandStart = filtered_source_count;
    const pendingBandStart = filtered_source_count + deleted_rows.length;
    const rowCount = pendingBandStart + pending_rows.length;
    const current_pending_row = (
        projected: typeof pending_rows[number],
    ): Extract<PendingProjectedRow, { kind: 'pending' | 'replacement' }> => ({
        ...projected,
        row: input.appendedRowAt?.(projected.rowIndex) ?? projected.row,
    });
    const projection: PendingRowProjection = {
        sourceRowCount: filtered_source_count,
        deletedBandStart,
        pendingBandStart,
        rowCount,
        row_at: (display_row: number): PendingProjectedRow | undefined => {
            if (!Number.isSafeInteger(display_row) || display_row < 0 || display_row >= rowCount) {
                return undefined;
            }
            if (display_row < filtered_source_count) {
                const sourceDisplayRow = raw_source_display_row(display_row);
                const sourceRow = sourceDisplayRow === undefined
                    ? undefined
                    : input.sourceRowAt(sourceDisplayRow);
                return sourceDisplayRow === undefined ? undefined : {
                    kind: 'source' as const,
                    ...(sourceRow === undefined ? {} : {
                        identity: { kind: 'source' as const, sourceRow },
                    }),
                    sourceDisplayRow: sourceDisplayRow as number,
                };
            }
            if (display_row < pendingBandStart) {
                return deleted_rows[display_row - deletedBandStart];
            }
            return current_pending_row(pending_rows[display_row - pendingBandStart]);
        },
        display_row_for_identity: (identity: RowIdentity): number | undefined => {
            if (identity.kind === 'source') {
                const source_display_row = input.displayRowForSource(identity.sourceRow);
                const filtered_display_row = source_display_row === undefined
                    ? undefined
                    : filtered_source_display_row(source_display_row);
                if (
                    filtered_display_row === undefined
                ) {
                    const removed_index = deleted_index_by_source_row.get(identity.sourceRow);
                    if (removed_index !== undefined) return deletedBandStart + removed_index;
                    // A replacement row has two identities: the pending row the
                    // user edits and the saved source removal it coalesced with.
                    // Selection remapping must be able to follow either identity
                    // through the deletion→replacement topology transition.
                    const replacement_index = replacement_index_by_removed_source.get(
                        identity.sourceRow,
                    );
                    return replacement_index === undefined
                        ? undefined
                        : pendingBandStart + replacement_index;
                }
                return filtered_display_row;
            }
            const pending_index = pending_index_by_id.get(identity.pendingRowId);
            return pending_index === undefined ? undefined : pendingBandStart + pending_index;
        },
        display_row_for_source_display: (source_display_row: number): number | undefined => (
            Number.isSafeInteger(source_display_row)
                ? filtered_source_display_row(source_display_row)
                : undefined
        ),
        display_row_for_tail_removal_id: (append_history_id: string): number | undefined => {
            const deleted_index = deleted_index_by_removal_id.get(append_history_id);
            if (deleted_index !== undefined) return deletedBandStart + deleted_index;
            const pending_index = pending_index_by_removal_id.get(append_history_id);
            return pending_index === undefined ? undefined : pendingBandStart + pending_index;
        },
        source_display_intervals: (intervals) => intervals.flatMap((interval) => {
            const start = Math.max(0, interval.start);
            const end = Math.min(filtered_source_count - 1, interval.end);
            if (end < start) return [];
            const raw_start = raw_source_display_row(start);
            const raw_end = raw_source_display_row(end);
            if (raw_start === undefined || raw_end === undefined) return [];
            const out: Array<{ start: number; end: number }> = [];
            let segment_start = raw_start;
            for (const removed of removed_source_display_rows) {
                if (removed < raw_start) continue;
                if (removed > raw_end) break;
                if (removed > segment_start) out.push({ start: segment_start, end: removed - 1 });
                segment_start = removed + 1;
            }
            if (segment_start <= raw_end) out.push({ start: segment_start, end: raw_end });
            return out;
        }),
    };
    return Object.freeze(projection);
}
