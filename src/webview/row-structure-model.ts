/**
 * Row Delete and Restore in Edit mode, as pure planning the grid commits.
 *
 * Three steps, each testable apart from the grid: resolve a row-gutter
 * selection into row identities (`resolve_row_structure_selection`), decide
 * which structure items the menu offers and why one is disabled
 * (`row_structure_menu_model`), and plan the one history action a gesture
 * records (`plan_row_delete`, `plan_row_restore`). A delete's action holds the
 * `rowLayout` arm the structural store planned and, beside it, a `cell` delta
 * for every source cell edit in a removed row, so Undo restores both together.
 */

import {
    is_inserted_row,
    pending_rows,
    type PendingStructuralChanges,
    type RowIdentity,
} from '../pending-changes';
import type { StructuralAxisSupport } from '../viewer-snapshot';
import type { SourceInterval } from '../worksheet-layout';
import type { HistoryDirtyEntry } from './history-cell-state-model';
import { discard_history_source } from './history-discard-model';
import type { HistoryChange } from './history-stack-model';
import {
    delete_rows,
    restore_rows,
    source_cells_removed_by,
    STRUCTURE_TAIL_REMOVAL_MESSAGE,
    type StructureOutcome,
    type WorksheetStructureContext,
} from './pending-row-store';
import type { PendingRowProjection } from './pending-row-projection';

export const ROWS_NOT_LOADED_MESSAGE =
    "Some selected rows haven't loaded yet. Scroll to them, then try again.";
export const FIXED_ROWS_MESSAGE = "The header row and the rows above it can't be deleted.";
export const RESTORE_ONLY_REMOVALS_MESSAGE = 'Select only deleted rows to restore them.';
export const STRUCTURE_BUSY_MESSAGE = 'Wait for the current change to finish.';

/** "Delete row", "Delete 3 rows", "Restore row", ...: menu items and undo labels alike. */
export function row_structure_label(verb: 'Delete' | 'Restore', count: number): string {
    return count === 1 ? `${verb} row` : `${verb} ${count} rows`;
}

/** Membership in a worksheet's Pending Row Removals, `O(log R)` per row. */
export function removed_source_row_test(
    changes: PendingStructuralChanges,
): (source_row: number) => boolean {
    const removed = changes.rowLayout?.removedSourceRows ?? [];
    if (removed.length === 0) return () => false;
    return (source_row) => {
        let low = 0;
        let high = removed.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            const interval = removed[middle]!;
            if (interval.start + interval.count <= source_row) low = middle + 1;
            else high = middle;
        }
        const interval = removed[low];
        return interval !== undefined && interval.start <= source_row;
    };
}

/** A row-gutter selection, resolved against the projection when the menu opened. */
export interface RowStructureSelection {
    /** Selected display rows. */
    readonly count: number;
    /**
     * Every selected source body row and Pending Row, by identity, in display
     * order; undefined when a selected row could not be resolved, which only
     * happens for a transformed view's row whose page has not loaded.
     */
    readonly identities: readonly RowIdentity[] | undefined;
    /** Selected Pending Row Removals, by source row, in display order. */
    readonly removedSourceRows: readonly number[];
    /** The Header Row or a row above it is selected. */
    readonly fixedRows: boolean;
    /** A Pending Tail Removal is selected. */
    readonly tailRemovals: boolean;
}

export interface RowStructureSelectionOptions {
    /** First body source row: the Header Row's 1-based number, or 0 without one. */
    readonly bodyStart: number;
    readonly isRemoved: (source_row: number) => boolean;
    /**
     * A source row for a source-display row whose identity is not resident.
     * The grid answers only in an untransformed view, where the mapping is
     * arithmetic; a transformed view leaves the row unresolved.
     */
    readonly sourceRowFor?: (source_display_row: number) => number | undefined;
}

export function resolve_row_structure_selection(
    projection: Pick<PendingRowProjection, 'row_at' | 'rowCount'>,
    display_rows: readonly { readonly start: number; readonly end: number }[],
    options: RowStructureSelectionOptions,
): RowStructureSelection {
    const identities: RowIdentity[] = [];
    const removedSourceRows: number[] = [];
    let count = 0;
    let resolved = true;
    let fixedRows = false;
    let tailRemovals = false;
    for (const interval of display_rows) {
        const end = Math.min(interval.end, projection.rowCount - 1);
        for (let row = Math.max(0, interval.start); row <= end; row += 1) {
            count += 1;
            const projected = projection.row_at(row);
            if (projected === undefined) {
                resolved = false;
                continue;
            }
            if (projected.kind === 'removal') {
                tailRemovals = true;
                continue;
            }
            if (projected.kind !== 'source') {
                identities.push(projected.identity);
                continue;
            }
            const source_row = projected.identity?.sourceRow
                ?? options.sourceRowFor?.(projected.sourceDisplayRow);
            if (source_row === undefined) {
                resolved = false;
                continue;
            }
            if (source_row < options.bodyStart) {
                fixedRows = true;
                continue;
            }
            if (options.isRemoved(source_row)) removedSourceRows.push(source_row);
            identities.push({ kind: 'source', sourceRow: source_row });
        }
    }
    return Object.freeze({
        count,
        identities: resolved ? Object.freeze(identities) : undefined,
        removedSourceRows: Object.freeze(removedSourceRows),
        fixedRows,
        tailRemovals,
    });
}

/** Whether every identity is a Pending Appended Row: Delete then leaves the layout alone. */
export function only_appended_rows(
    changes: PendingStructuralChanges,
    identities: readonly RowIdentity[],
): boolean {
    if (identities.length === 0) return false;
    const appended = new Set(pending_rows(changes).flatMap((row) =>
        is_inserted_row(row) ? [] : [row.id]));
    return identities.every((identity) =>
        identity.kind === 'pending' && appended.has(identity.pendingRowId));
}

export interface StructureItemModel {
    readonly count: number;
    readonly enabled: boolean;
    readonly reason?: string;
}

export interface RowStructureMenuModel {
    readonly delete: StructureItemModel;
    /** Offered only when the selection includes a Pending Row Removal. */
    readonly restore?: StructureItemModel;
}

export interface RowStructureMenuInput {
    readonly support: StructuralAxisSupport;
    /** Whether an edit gesture may start now (no save, highlight, or append in flight). */
    readonly ready: boolean;
    readonly selection: RowStructureSelection;
    readonly changes: PendingStructuralChanges;
    readonly context: WorksheetStructureContext;
}

function item(count: number, reason: string | undefined): StructureItemModel {
    return Object.freeze(reason === undefined
        ? { count, enabled: true }
        : { count, enabled: false, reason });
}

/**
 * The Delete and Restore items for a selection. Each is enabled only when its
 * gesture would succeed right now; otherwise its reason is the refusal the
 * gesture itself would give, so the menu and the action cannot disagree.
 */
export function row_structure_menu_model(input: RowStructureMenuInput): RowStructureMenuModel {
    const { selection, changes, context } = input;
    const count = selection.count;
    const shared_reason = !input.support.supported
        ? input.support.reason
        : !input.ready
            ? STRUCTURE_BUSY_MESSAGE
            : undefined;
    const delete_reason = shared_reason
        ?? (selection.fixedRows ? FIXED_ROWS_MESSAGE : undefined)
        ?? (selection.tailRemovals ? STRUCTURE_TAIL_REMOVAL_MESSAGE : undefined)
        ?? (selection.identities === undefined ? ROWS_NOT_LOADED_MESSAGE : undefined)
        ?? (only_appended_rows(changes, selection.identities!)
            ? undefined
            : refusal_message(plan_row_delete(changes, context, selection.identities!, new Map())));
    if (selection.removedSourceRows.length === 0) return Object.freeze({ delete: item(count, delete_reason) });
    const restore_reason = shared_reason
        ?? (selection.removedSourceRows.length !== count ? RESTORE_ONLY_REMOVALS_MESSAGE : undefined)
        ?? refusal_message(plan_row_restore(changes, context, selection.removedSourceRows));
    return Object.freeze({
        delete: item(count, delete_reason),
        restore: item(selection.removedSourceRows.length, restore_reason),
    });
}

/** One gesture, planned: what the stores commit and the history records. */
export interface RowStructurePlan {
    readonly ok: true;
    readonly label: string;
    readonly outcome: StructureOutcome;
    /** Source cell edits (`row:column` keys) the gesture discards. */
    readonly discardedCellKeys: readonly string[];
    /** The one history action's changes: the layout arm, then any `cell` deltas. */
    readonly changes: readonly HistoryChange[];
}

export type RowStructurePlanResult =
    | RowStructurePlan
    | { readonly ok: false; readonly message: string };

function refusal_message(result: RowStructurePlanResult): string | undefined {
    return result.ok ? undefined : result.message;
}

function interval_rows(intervals: readonly SourceInterval[]): number {
    return intervals.reduce((total, interval) => total + interval.count, 0);
}

/**
 * Delete rows: the store turns live source rows into Pending Row Removals and
 * discards Pending Rows; this adds the discard of every source cell edit in a
 * removed row, from `cells` (the worksheet's cell edits), as `cell` deltas.
 */
export function plan_row_delete(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    identities: readonly RowIdentity[],
    cells: ReadonlyMap<string, HistoryDirtyEntry>,
): RowStructurePlanResult {
    const result = delete_rows(changes, context, identities);
    if (!result.ok) return { ok: false, message: result.refusal.message };
    const { outcome } = result;
    const removed = source_cells_removed_by(outcome, cells.keys());
    const entries = new Map(removed.map(({ key }) => [key, cells.get(key)!]));
    const cell_changes = [...discard_history_source([{ target: context.worksheet, entries }])];
    return Object.freeze({
        ok: true,
        label: row_structure_label(
            'Delete',
            interval_rows(outcome.removedSourceRows) + outcome.discardedRows.length,
        ),
        outcome,
        discardedCellKeys: Object.freeze(removed.map(({ key }) => key)),
        changes: Object.freeze([outcome.change, ...cell_changes]),
    });
}

/** Restore Pending Row Removals; every listed source row must be one. */
export function plan_row_restore(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    source_rows: readonly number[],
): RowStructurePlanResult {
    const result = restore_rows(changes, context, source_rows);
    if (!result.ok) return { ok: false, message: result.refusal.message };
    return Object.freeze({
        ok: true,
        label: row_structure_label('Restore', new Set(source_rows).size),
        outcome: result.outcome,
        discardedCellKeys: Object.freeze([]),
        changes: Object.freeze([result.outcome.change]),
    });
}

/**
 * Where focus goes after a Delete: the first displayed row at or after `from`
 * that is not removed, so the caret lands on the row that followed the
 * deleted block; failing that, the nearest one above. At most `limit` rows
 * are examined each way. `is_live` answers for one display row.
 */
export function nearest_live_row(
    from: number,
    row_count: number,
    is_live: (display_row: number) => boolean,
    limit = row_count,
): number | undefined {
    const start = Math.max(0, Math.min(from, row_count - 1));
    for (let row = start; row < row_count && row - start <= limit; row += 1) {
        if (is_live(row)) return row;
    }
    for (let row = start - 1; row >= 0 && start - row <= limit; row -= 1) {
        if (is_live(row)) return row;
    }
    return undefined;
}
