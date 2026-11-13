/**
 * Display-only composition of immutable source rows and structural overlays.
 *
 * Two modes. The **band mode** is today's: source rows in the host's display
 * order (sorted, filtered, or with hidden rows), then the deleted band of
 * Pending Tail Removals, then the append band. A Pending Row Removal stays at
 * its display position there, classified `removed`. The **layout mode** is
 * used when the worksheet has a row layout, its body view is untransformed,
 * and it has no Pending Tail Removal: fixed rows (at or above the Header Row)
 * first, then the row layout in prospective order with removals in place,
 * discarded tombstones skipped, and Pending Inserted Rows inline, then the
 * append band behind the existing boundary. Every lookup in layout mode is
 * `O(log R)` over the layout's segments.
 */

import type {
    PendingAppendedRow,
    PendingStructuralChanges,
    PendingTailRemoval,
    RowIdentity,
} from '../pending-changes';
import { appended_rows, pending_rows } from '../pending-changes';
import {
    index_row_layout,
    moved_source_rows,
    type RowLayoutIndex,
    type SourceInterval,
} from '../worksheet-layout';

/**
 * What a displayed row is: an unchanged `source` row, a Pending Inserted Row,
 * a Pending Row Removal, a Moved Row, a Pending Appended Row (including one
 * coalesced with a tail removal), or a Pending Tail Removal.
 */
export type ProjectedRowState =
    | 'source'
    | 'inserted'
    | 'removed'
    | 'moved'
    | 'appended'
    | 'tail-removal';

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
    /** Rows before the deleted band: source rows, and in layout mode inserted rows too. */
    readonly sourceRowCount: number;
    readonly deletedBandStart: number;
    readonly pendingBandStart: number;
    readonly rowCount: number;
    /** Whether the layout mode is in use (see the module comment). */
    readonly layoutMode: boolean;
    row_at(display_row: number): PendingProjectedRow | undefined;
    /** Undefined outside the grid, or for a source row whose identity is not yet resident. */
    row_state(display_row: number): ProjectedRowState | undefined;
    /**
     * The canonical row the displayed row will occupy after save, 0-based like
     * `RowIdentity.sourceRow`; undefined for rows save removes.
     */
    prospective_row(display_row: number): number | undefined;
    display_row_for_prospective_row(prospective_row: number): number | undefined;
    display_row_for_identity(identity: RowIdentity): number | undefined;
    /** Compress one host/source-display coordinate into the current source band. */
    display_row_for_source_display(source_display_row: number): number | undefined;
    display_row_for_tail_removal_id(append_history_id: string): number | undefined;
    /**
     * Display rows of the live Pending Inserted Rows in `[start, end]`,
     * ascending. In layout mode these sit inline, before `deletedBandStart`,
     * where a scan of the bands does not reach; the band mode has none.
     */
    inline_pending_display_rows(start: number, end: number): readonly number[];
    /**
     * The rows of `[start, end]` before the deleted band, as runs, so a
     * selection resolves in proportion to its runs rather than its rows: a
     * `source` run is consecutive source rows (layout mode), a
     * `sourceDisplay` run is consecutive host source-display rows (band
     * mode), and a `row` is one row to resolve with `row_at`.
     */
    source_row_runs(start: number, end: number): readonly SourceRowRun[];
    /**
     * The first display row at or after `from` (then the last before it) that
     * is not a Pending Row Removal or tail removal, skipping removed runs
     * whole in layout mode; undefined when none is found within `limit` rows
     * of `from` in band mode.
     */
    nearest_live_display_row(from: number, limit?: number): number | undefined;
    /** Expand compressed source-band intervals back into host display space. */
    source_display_intervals(
        intervals: readonly { readonly start: number; readonly end: number }[],
    ): { start: number; end: number }[];
}

/** See `PendingRowProjection.source_row_runs`. */
export type SourceRowRun =
    | { readonly kind: 'source'; readonly displayStart: number; readonly count: number; readonly sourceRow: number }
    | { readonly kind: 'sourceDisplay'; readonly displayStart: number; readonly count: number; readonly sourceDisplayStart: number }
    | { readonly kind: 'row'; readonly displayRow: number };

/** Band mode's live-row search: row by row, at most `limit` rows each way. */
function nearest_live_by_state(
    projection: Pick<PendingRowProjection, 'row_state' | 'rowCount'>,
    from: number,
    limit: number,
): number | undefined {
    const is_live = (row: number) => {
        const state = projection.row_state(row);
        return state !== 'removed' && state !== 'tail-removal';
    };
    const start = Math.max(0, Math.min(from, projection.rowCount - 1));
    for (let row = start; row < projection.rowCount && row - start <= limit; row += 1) {
        if (is_live(row)) return row;
    }
    for (let row = start - 1; row >= 0 && start - row <= limit; row -= 1) {
        if (is_live(row)) return row;
    }
    return undefined;
}

/** Rows band mode examines each way for a live row after a delete. */
export const NEAREST_LIVE_ROW_SCAN_LIMIT = 10_000;

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
    /**
     * Latest payload of a Pending Inserted Row, by ID. A rows-only change
     * (a height, a highlight, a cell) keeps the topology and so this
     * projection; without it inline rows would report the payload captured
     * when the projection was built.
     */
    readonly pendingRowById?: (id: string) => PendingAppendedRow | undefined;
    /** Display positions occupied by visible tail removals in the source view. */
    readonly removedSourceDisplayRows?: readonly number[];
    /** Removal identities whose transformed inverse lookup has completed. */
    readonly projectedTailRemovalIds?: ReadonlySet<string>;
    /** First body source row: the Header Row's 1-based number, or 0 without one. Default 0. */
    readonly bodyStart?: number;
    /**
     * Whether the body view is sorted, filtered, or hides rows. The layout mode
     * needs an explicit `false`; absent keeps the band mode.
     */
    readonly bodyViewTransformed?: boolean;
}

/** Live rows the layout adds to the body: live inserted rows minus removals. */
function layout_size_change(index: RowLayoutIndex): number {
    let change = 0;
    for (const segment of index.segments) {
        if (segment.kind === 'pending' && segment.status === 'live') change += 1;
        else if (segment.kind === 'source' && segment.status === 'removed') change -= segment.count;
    }
    return change;
}

export function create_pending_row_projection(
    input: PendingRowProjectionInput,
): PendingRowProjection {
    const layout = input.changes.rowLayout;
    if (layout !== undefined && input.bodyViewTransformed === false
        && input.changes.tailRemovals.length === 0) {
        return create_layout_row_projection(input, index_row_layout(layout));
    }
    return create_band_row_projection(input);
}

function create_band_row_projection(
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
    const layout_index = input.changes.rowLayout === undefined
        ? undefined
        : index_row_layout(input.changes.rowLayout);
    const body_start = input.bodyStart ?? 0;
    // Pending Row Removals and live inserted rows move the append band; with
    // neither this is today's start.
    const prospective_start = input.sourceRowCount - input.changes.tailRemovals.length
        + (layout_index === undefined ? 0 : layout_size_change(layout_index));
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
    > & { readonly rowIndex: number }> = appended_rows(input.changes).map((row, index) => {
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
    const source_prospective_row = (source_row: number): number | undefined => {
        if (layout_index === undefined || source_row < body_start) return source_row;
        const body_index = layout_index.body_index_of({ kind: 'source', sourceRow: source_row });
        return body_index === undefined ? undefined : body_start + body_index - 1;
    };
    const projection: PendingRowProjection = {
        sourceRowCount: filtered_source_count,
        deletedBandStart,
        pendingBandStart,
        rowCount,
        layoutMode: false,
        row_state: (display_row) => {
            const projected = projection.row_at(display_row);
            if (projected === undefined) return undefined;
            if (projected.kind === 'removal') return 'tail-removal';
            if (projected.kind !== 'source') return 'appended';
            if (projected.identity === undefined) return undefined;
            return layout_index?.status_of(projected.identity) === 'removed' ? 'removed' : 'source';
        },
        prospective_row: (display_row) => {
            const projected = projection.row_at(display_row);
            if (projected === undefined || projected.kind === 'removal') return undefined;
            if (projected.kind !== 'source') return projected.intendedPhysicalRow;
            return projected.identity === undefined
                ? undefined
                : source_prospective_row(projected.identity.sourceRow);
        },
        display_row_for_prospective_row: (row) => {
            if (!Number.isSafeInteger(row) || row < 0) return undefined;
            if (row >= prospective_start) {
                const index = row - prospective_start;
                return index < pending_rows.length ? pendingBandStart + index : undefined;
            }
            const identity = layout_index === undefined || row < body_start
                ? { kind: 'source' as const, sourceRow: row }
                : layout_index.identity_at_body_index(row - body_start + 1);
            return identity === undefined ? undefined : projection.display_row_for_identity(identity);
        },
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
        inline_pending_display_rows: () => [],
        source_row_runs: (start, end) => {
            const last = Math.min(end, filtered_source_count - 1);
            if (last < Math.max(0, start)) return [];
            return projection.source_display_intervals([{ start, end: last }]).map((raw) => ({
                kind: 'sourceDisplay' as const,
                displayStart: filtered_source_display_row(raw.start)!,
                count: raw.end - raw.start + 1,
                sourceDisplayStart: raw.start,
            }));
        },
        nearest_live_display_row: (from, limit = NEAREST_LIVE_ROW_SCAN_LIMIT) =>
            nearest_live_by_state(projection, from, limit),
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

function create_layout_row_projection(
    input: PendingRowProjectionInput,
    index: RowLayoutIndex,
): PendingRowProjection {
    const layout = input.changes.rowLayout!;
    const body_start = input.bodyStart ?? 0;
    const body_row_count = Math.max(0, input.sourceRowCount - body_start);
    // Untransformed, so the host shows every source row in source order:
    // fixed rows first, then the body, one source-display row per source row.
    const fixed_count = Math.max(0, input.sourceDisplayRowCount - body_row_count);
    const layout_end = fixed_count + index.displayCount;
    const band = appended_rows(input.changes);
    const band_start_row = body_start + index.liveCount;
    const rowCount = layout_end + band.length;
    const moved: readonly SourceInterval[] = moved_source_rows(layout);
    const pending_by_id = new Map(pending_rows(input.changes).map((row) => [row.id, row]));
    const band_index_by_id = new Map(band.map((row, band_index) => [row.id, band_index]));
    const displayed = index.segments.filter((segment) => segment.status !== 'discarded');
    // At most 10,000 inserted rows: their display rows, ascending.
    const inline_pending: number[] = displayed.flatMap((segment) =>
        segment.kind === 'pending' ? [fixed_count + segment.displayBefore] : []);

    /** Index of the displayed segment holding layout display index `index` (the last one starting at or before it). */
    const segment_at_display_index = (index: number): number => {
        let low = 0;
        let high = displayed.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (displayed[middle]!.displayBefore <= index) low = middle + 1;
            else high = middle;
        }
        return Math.max(0, low - 1);
    };
    const is_moved = (source_row: number): boolean => {
        let low = 0;
        let high = moved.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            const entry = moved[middle]!;
            if (entry.start + entry.count <= source_row) low = middle + 1;
            else high = middle;
        }
        const entry = moved[low];
        return entry !== undefined && entry.start <= source_row;
    };
    const source_display_row_of = (source_row: number): number | undefined =>
        source_row < body_start
            ? input.displayRowForSource(source_row)
            : fixed_count + source_row - body_start;
    const band_row = (band_index: number): Extract<PendingProjectedRow, { kind: 'pending' }> => {
        const row = input.appendedRowAt?.(band_index) ?? band[band_index]!;
        return {
            kind: 'pending',
            identity: { kind: 'pending', pendingRowId: band[band_index]!.id },
            row,
            intendedPhysicalRow: band_start_row + band_index,
        };
    };
    const layout_identity_at = (display_row: number): RowIdentity | undefined =>
        display_row >= fixed_count && display_row < layout_end
            ? index.identity_at_display_index(display_row - fixed_count)
            : undefined;

    const projection: PendingRowProjection = {
        sourceRowCount: layout_end,
        deletedBandStart: layout_end,
        pendingBandStart: layout_end,
        rowCount,
        layoutMode: true,
        row_at: (display_row) => {
            if (!Number.isSafeInteger(display_row) || display_row < 0 || display_row >= rowCount) {
                return undefined;
            }
            if (display_row < fixed_count) {
                const sourceRow = input.sourceRowAt(display_row);
                return {
                    kind: 'source',
                    ...(sourceRow === undefined ? {} : { identity: { kind: 'source', sourceRow } }),
                    sourceDisplayRow: display_row,
                };
            }
            if (display_row >= layout_end) return band_row(display_row - layout_end);
            const identity = layout_identity_at(display_row)!;
            if (identity.kind === 'source') {
                return {
                    kind: 'source',
                    identity,
                    sourceDisplayRow: source_display_row_of(identity.sourceRow)!,
                };
            }
            return {
                kind: 'pending',
                identity,
                row: input.pendingRowById?.(identity.pendingRowId)
                    ?? pending_by_id.get(identity.pendingRowId)!,
                intendedPhysicalRow: body_start + index.body_index_of(identity)! - 1,
            };
        },
        row_state: (display_row) => {
            if (!Number.isSafeInteger(display_row) || display_row < 0 || display_row >= rowCount) {
                return undefined;
            }
            if (display_row < fixed_count) return 'source';
            if (display_row >= layout_end) return 'appended';
            const identity = layout_identity_at(display_row)!;
            if (identity.kind === 'pending') return 'inserted';
            if (index.status_of(identity) === 'removed') return 'removed';
            return is_moved(identity.sourceRow) ? 'moved' : 'source';
        },
        prospective_row: (display_row) => {
            if (!Number.isSafeInteger(display_row) || display_row < 0 || display_row >= rowCount) {
                return undefined;
            }
            if (display_row < fixed_count) return input.sourceRowAt(display_row);
            if (display_row >= layout_end) return band_start_row + display_row - layout_end;
            const body_index = index.body_index_of(layout_identity_at(display_row)!);
            return body_index === undefined ? undefined : body_start + body_index - 1;
        },
        display_row_for_prospective_row: (row) => {
            if (!Number.isSafeInteger(row) || row < 0) return undefined;
            if (row < body_start) return input.displayRowForSource(row);
            if (row < band_start_row) {
                const identity = index.identity_at_body_index(row - body_start + 1);
                return identity === undefined ? undefined : projection.display_row_for_identity(identity);
            }
            const band_index = row - band_start_row;
            return band_index < band.length ? layout_end + band_index : undefined;
        },
        display_row_for_identity: (identity) => {
            if (identity.kind === 'pending') {
                const band_index = band_index_by_id.get(identity.pendingRowId);
                if (band_index !== undefined) return layout_end + band_index;
            } else if (identity.sourceRow < body_start) {
                return input.displayRowForSource(identity.sourceRow);
            }
            const display_index = index.display_index_of(identity);
            return display_index === undefined ? undefined : fixed_count + display_index;
        },
        display_row_for_source_display: (source_display_row) => {
            if (!Number.isSafeInteger(source_display_row) || source_display_row < 0) return undefined;
            if (source_display_row < fixed_count) return source_display_row;
            const sourceRow = body_start + source_display_row - fixed_count;
            if (sourceRow >= input.sourceRowCount) return undefined;
            const display_index = index.display_index_of({ kind: 'source', sourceRow });
            return display_index === undefined ? undefined : fixed_count + display_index;
        },
        display_row_for_tail_removal_id: () => undefined,
        source_row_runs: (start, end) => {
            const first = Math.max(0, start);
            const last = Math.min(end, layout_end - 1);
            const runs: SourceRowRun[] = [];
            for (let row = first; row <= Math.min(last, fixed_count - 1); row += 1) {
                runs.push({ kind: 'row', displayRow: row });
            }
            const low_index = Math.max(first, fixed_count) - fixed_count;
            const high_index = last - fixed_count;
            if (high_index < low_index) return runs;
            for (let at = segment_at_display_index(low_index); at < displayed.length; at++) {
                const segment = displayed[at]!;
                if (segment.displayBefore > high_index) break;
                if (segment.kind === 'pending') {
                    if (segment.displayBefore >= low_index) {
                        runs.push({ kind: 'row', displayRow: fixed_count + segment.displayBefore });
                    }
                    continue;
                }
                const low = Math.max(low_index, segment.displayBefore);
                const high = Math.min(high_index, segment.displayBefore + segment.count - 1);
                if (high < low) continue;
                runs.push({
                    kind: 'source',
                    displayStart: fixed_count + low,
                    count: high - low + 1,
                    sourceRow: segment.start + low - segment.displayBefore,
                });
            }
            return runs;
        },
        nearest_live_display_row: (from) => {
            if (rowCount === 0) return undefined;
            const start = Math.max(0, Math.min(from, rowCount - 1));
            // Fixed rows and the band are live; in the layout, skip removed segments whole.
            const live_at_or_after = (row: number): number | undefined => {
                if (row < fixed_count || row >= layout_end) return row;
                for (let at = segment_at_display_index(row - fixed_count); at < displayed.length; at++) {
                    const segment = displayed[at]!;
                    if (segment.status !== 'live') continue;
                    return fixed_count + Math.max(segment.displayBefore, row - fixed_count);
                }
                return layout_end < rowCount ? layout_end : undefined;
            };
            const live_at_or_before = (row: number): number | undefined => {
                if (row < fixed_count || row >= layout_end) return row;
                for (let at = segment_at_display_index(row - fixed_count); at >= 0; at--) {
                    const segment = displayed[at]!;
                    if (segment.status !== 'live') continue;
                    const segment_last = segment.displayBefore + segment.count - 1;
                    return fixed_count + Math.min(segment_last, row - fixed_count);
                }
                return fixed_count > 0 ? fixed_count - 1 : undefined;
            };
            return live_at_or_after(start) ?? (start > 0 ? live_at_or_before(start - 1) : undefined);
        },
        inline_pending_display_rows: (start, end) => {
            let low = 0;
            let high = inline_pending.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (inline_pending[middle]! < start) low = middle + 1;
                else high = middle;
            }
            const rows: number[] = [];
            for (let at = low; at < inline_pending.length && inline_pending[at]! <= end; at++) {
                rows.push(inline_pending[at]!);
            }
            return rows;
        },
        source_display_intervals: (intervals) => {
            const out: { start: number; end: number }[] = [];
            for (const interval of intervals) {
                const start = Math.max(0, interval.start);
                const end = Math.min(layout_end - 1, interval.end);
                if (end < start) continue;
                if (start < fixed_count) out.push({ start, end: Math.min(end, fixed_count - 1) });
                const first = Math.max(start, fixed_count) - fixed_count;
                const last = end - fixed_count;
                if (last < first) continue;
                // The last displayed segment starting at or before `first`.
                let low = 0;
                let high = displayed.length;
                while (low < high) {
                    const middle = (low + high) >>> 1;
                    if (displayed[middle]!.displayBefore <= first) low = middle + 1;
                    else high = middle;
                }
                for (let at = Math.max(0, low - 1); at < displayed.length; at++) {
                    const segment = displayed[at]!;
                    if (segment.displayBefore > last) break;
                    if (segment.kind !== 'source') continue;
                    const low_index = Math.max(first, segment.displayBefore);
                    const high_index = Math.min(last, segment.displayBefore + segment.count - 1);
                    if (high_index < low_index) continue;
                    const offset = fixed_count + segment.start - body_start - segment.displayBefore;
                    out.push({ start: low_index + offset, end: high_index + offset });
                }
            }
            // A range across run boundaries covers the union of its runs' rows.
            out.sort((left, right) => left.start - right.start);
            const merged: { start: number; end: number }[] = [];
            for (const interval of out) {
                const previous = merged[merged.length - 1];
                if (previous !== undefined && interval.start <= previous.end + 1) {
                    previous.end = Math.max(previous.end, interval.end);
                } else {
                    merged.push({ ...interval });
                }
            }
            return merged;
        },
    };
    return Object.freeze(projection);
}
