/**
 * Row Insert, Delete, Restore, and Move in Edit mode, as pure planning the
 * grid commits.
 *
 * Three steps, each testable apart from the grid: resolve a row-gutter
 * selection into row identities (`resolve_row_structure_selection`), decide
 * which structure items the menu offers and why one is disabled
 * (`row_structure_menu_model`), and plan the one history action a gesture
 * records (`plan_row_insert`, `plan_row_delete`, `plan_row_restore`,
 * `plan_row_move`). A drag's drop row resolves to a layout target through
 * `resolve_row_move_drop`. A
 * delete's action holds the `rowLayout` arm the structural store planned and,
 * beside it, a `cell` delta for every source cell edit in a removed row, so
 * Undo restores both together. An insert's IDs come from host admission, so
 * the grid asks the host first and plans the insert with its reply, after
 * checking that the anchor is still live (`insert_anchor_is_live`).
 */

import {
    appended_rows,
    has_inserted_or_moved_rows,
    has_live_layout_change,
    is_inserted_row,
    MAX_PENDING_APPENDED_ROWS,
    pending_rows,
    type PendingAppendBasis,
    type PendingRowFormatTemplate,
    type PendingStructuralChanges,
    type RowIdentity,
} from '../pending-changes';
import type { StructuralAxisSupport, WorksheetRelativeRule } from '../viewer-snapshot';
import type { AnchorWorksheetInput } from '../formula-anchor-layout';
import {
    MAX_RULE_SPLIT,
    parse_rule_sqref,
    relative_rule_split_count,
    rule_split_workbook,
} from '../formula-rule-split';
import type { MergeRange } from '../types';
import {
    has_live_column_layout_change,
    index_row_layout,
    insert_anchor_for_selection,
    source_row_layout,
    step_move_target,
    subtract_intervals,
    type SourceInterval,
} from '../worksheet-layout';
import type { HistoryDirtyEntry } from './history-cell-state-model';
import { discard_history_source } from './history-discard-model';
import type { HistoryChange } from './history-stack-model';
import {
    APPENDED_BAND_MESSAGE,
    delete_row_runs,
    restore_row_runs,
    row_runs_of_identities,
    insert_rows,
    MERGE_SPLIT_MESSAGE,
    move_rows,
    restore_rows,
    source_cells_removed_by,
    structure_exclusivity_message,
    STRUCTURE_TAIL_REMOVAL_MESSAGE,
    STRUCTURE_TRANSFORMED_MESSAGE,
    TOO_MANY_PENDING_ROWS_MESSAGE,
    type RowSelectionRun,
    type StructureOutcome,
    type WorksheetStructureContext,
} from './pending-row-store';
import type { PendingRowProjection } from './pending-row-projection';

export const ROWS_NOT_LOADED_MESSAGE =
    "Some selected rows haven't loaded yet. Scroll to them, then try again.";
export const FIXED_ROWS_MESSAGE = "The header row and the rows above it can't be deleted.";
export const RESTORE_ONLY_REMOVALS_MESSAGE = 'Select only deleted rows to restore them.';
export const STRUCTURE_BUSY_MESSAGE = 'Wait for the current change to finish.';
export const SELECT_ADJACENT_ROWS_MESSAGE = 'Select adjacent rows to insert or move them.';
export const INSERT_ABOVE_HEADER_MESSAGE = "Rows can't be inserted above the header row.";
export const INSERT_ONLY_REMOVED_ROWS_MESSAGE = 'Select a row that isn\'t deleted to insert rows beside it.';
export const INSERT_CANCELED_MESSAGE = 'Insert canceled because its row was removed.';
/** Sort, filter, and hide rows are disabled while inserted or moved rows exist. */
export const INSERTED_ROWS_TRANSFORM_MESSAGE =
    'Save or discard inserted and moved rows to sort, filter, or hide rows.';
export const MOVE_FIXED_ROWS_MESSAGE = "The header row and the rows above it can't be moved.";
export const MOVE_ONLY_REMOVED_ROWS_MESSAGE = "Select a row that isn't deleted to move it.";
export const MOVE_ABOVE_HEADER_MESSAGE = "Rows can't be moved above the header row.";
export const MOVE_AT_TOP_MESSAGE = 'The selected rows are already at the top.';
export const MOVE_AT_BOTTOM_MESSAGE = 'The selected rows are already at the bottom.';

/**
 * "Delete row", "Delete 3 rows", "Restore row", "Insert 2 rows", "Move 3
 * rows", ...: undo labels, and menu items for Delete and Restore.
 */
export function row_structure_label(verb: 'Delete' | 'Restore' | 'Insert' | 'Move', count: number): string {
    return count === 1 ? `${verb} row` : `${verb} ${count} rows`;
}

/** The live region's report of a move: "Moved 3 rows down", "Moved 1 row up". */
export function row_move_announcement(count: number, direction: 'up' | 'down'): string {
    return `Moved ${count} ${count === 1 ? 'row' : 'rows'} ${direction}`;
}

/** "Insert row above", "Insert 3 rows below": the Insert menu items. */
export function row_insert_label(side: 'above' | 'below', count: number): string {
    return `${row_structure_label('Insert', Math.max(1, count))} ${side}`;
}

/**
 * Whether the worksheet holds a live Pending Inserted Row or a Moved Row.
 * While it does, the display order must stay the layout's, so sorting,
 * filtering, and hiding rows on the worksheet are disabled with
 * `INSERTED_ROWS_TRANSFORM_MESSAGE`.
 */
export { has_inserted_or_moved_rows };

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
     * The selected source body rows and Pending Rows as runs, in display
     * order: proportional to the selection's runs, not its rows. Undefined
     * when a selected row could not be resolved, which only happens for a
     * transformed view's row whose page has not loaded.
     */
    readonly runs: readonly RowSelectionRun[] | undefined;
    /**
     * Every selected source body row and Pending Row, by identity, in display
     * order; `undefined` exactly when `runs` is. Expanded from the runs on
     * first read, for gestures that need each row.
     */
    readonly identities: readonly RowIdentity[] | undefined;
    /** Selected Pending Row Removals, as sorted source intervals. */
    readonly removedSourceRuns: readonly SourceInterval[];
    /** How many selected rows are Pending Row Removals. */
    readonly removedCount: number;
    /** Selected Pending Row Removals, by source row; expanded on first read. */
    readonly removedSourceRows: readonly number[];
    /** The Header Row or a row above it is selected. */
    readonly fixedRows: boolean;
    /** A Pending Tail Removal is selected. */
    readonly tailRemovals: boolean;
    /** The selected display rows form one interval: Insert needs that. */
    readonly contiguous: boolean;
    /** Selected rows in the append band (Pending Appended Rows). */
    readonly bandRows: number;
    /** The last selected display row is the band's last row: Insert below appends there. */
    readonly endsAtBandEnd: boolean;
}

export interface RowStructureSelectionOptions {
    /** First body source row: the Header Row's 1-based number, or 0 without one. */
    readonly bodyStart: number;
    readonly isRemoved: (source_row: number) => boolean;
    /**
     * Pending Row Removals as sorted intervals, so a run of rows is checked
     * at once; without them each row asks `isRemoved`.
     */
    readonly removedSourceRows?: readonly SourceInterval[];
    /**
     * A source row for a source-display row whose identity is not resident.
     * The grid answers only in an untransformed view, where the mapping is
     * arithmetic; a transformed view leaves the row unresolved.
     */
    readonly sourceRowFor?: (source_display_row: number) => number | undefined;
    /**
     * `sourceRowFor` for `count` consecutive source-display rows, as source
     * intervals in display order; undefined where the mapping is not
     * arithmetic (a transformed view).
     */
    readonly sourceRowsFor?: (source_display_start: number, count: number) => readonly SourceInterval[] | undefined;
}

function intersect_intervals(
    left: readonly SourceInterval[],
    right: readonly SourceInterval[],
): SourceInterval[] {
    const out: SourceInterval[] = [];
    let at = 0;
    for (const entry of left) {
        const end = entry.start + entry.count;
        while (at < right.length && right[at]!.start + right[at]!.count <= entry.start) at++;
        for (let cursor = at; cursor < right.length && right[cursor]!.start < end; cursor++) {
            const other = right[cursor]!;
            const start = Math.max(entry.start, other.start);
            const stop = Math.min(end, other.start + other.count);
            if (stop > start) out.push({ start, count: stop - start });
        }
    }
    return out;
}

export function resolve_row_structure_selection(
    projection: Pick<PendingRowProjection, 'row_at' | 'rowCount'>
        & Partial<Pick<PendingRowProjection, 'source_row_runs' | 'deletedBandStart'>>,
    display_rows: readonly { readonly start: number; readonly end: number }[],
    options: RowStructureSelectionOptions,
): RowStructureSelection {
    const runs: RowSelectionRun[] = [];
    const removed: SourceInterval[] = [];
    let count = 0;
    let resolved = true;
    let fixedRows = false;
    let tailRemovals = false;
    let bandRows = 0;
    let last_row: number | undefined;
    const covered: { start: number; end: number }[] = [];
    const add_source = (start: number, length: number): void => {
        let first = start;
        let rows = length;
        if (first < options.bodyStart) {
            fixedRows = true;
            const skip = Math.min(rows, options.bodyStart - first);
            first += skip;
            rows -= skip;
        }
        if (rows <= 0) return;
        const previous = runs[runs.length - 1];
        if (previous?.kind === 'source' && previous.start + previous.count === first) {
            runs[runs.length - 1] = { kind: 'source', start: previous.start, count: previous.count + rows };
        } else {
            runs.push({ kind: 'source', start: first, count: rows });
        }
        if (options.removedSourceRows !== undefined) {
            removed.push(...intersect_intervals([{ start: first, count: rows }], options.removedSourceRows));
        } else {
            for (let row = first; row < first + rows; row += 1) {
                if (options.isRemoved(row)) removed.push({ start: row, count: 1 });
            }
        }
    };
    const add_row = (row: number): void => {
        const projected = projection.row_at(row);
        if (projected === undefined) {
            resolved = false;
            return;
        }
        if (projected.kind === 'removal') {
            tailRemovals = true;
            return;
        }
        if (projected.kind !== 'source') {
            if (projected.kind === 'replacement' || !is_inserted_row(projected.row)) bandRows += 1;
            runs.push({ kind: 'pending', identity: projected.identity as Extract<RowIdentity, { kind: 'pending' }> });
            return;
        }
        const source_row = projected.identity?.sourceRow
            ?? options.sourceRowFor?.(projected.sourceDisplayRow);
        if (source_row === undefined) {
            resolved = false;
            return;
        }
        if (source_row < options.bodyStart) {
            fixedRows = true;
            return;
        }
        add_source(source_row, 1);
    };
    for (const interval of display_rows) {
        const end = Math.min(interval.end, projection.rowCount - 1);
        const start = Math.max(0, interval.start);
        if (end < start) continue;
        covered.push({ start, end });
        count += end - start + 1;
        last_row = Math.max(last_row ?? end, end);
        const band_start = projection.source_row_runs === undefined
            ? start
            : Math.min(Math.max(start, projection.deletedBandStart ?? start), end + 1);
        if (band_start > start) {
            for (const run of projection.source_row_runs!(start, band_start - 1)) {
                if (run.kind === 'row') {
                    add_row(run.displayRow);
                } else if (run.kind === 'source') {
                    add_source(run.sourceRow, run.count);
                } else {
                    const mapped = options.sourceRowsFor?.(run.sourceDisplayStart, run.count);
                    if (mapped !== undefined) {
                        for (const entry of mapped) add_source(entry.start, entry.count);
                        continue;
                    }
                    // Not arithmetic: each row resolves on its own, and one that
                    // has not loaded leaves the selection unresolved.
                    for (let row = run.displayStart; row < run.displayStart + run.count && resolved; row += 1) {
                        add_row(row);
                    }
                }
            }
        }
        // The deleted and append bands: at most the session's Pending Rows and tail removals.
        for (let row = band_start; row <= end; row += 1) add_row(row);
    }
    covered.sort((left, right) => left.start - right.start);
    let contiguous = covered.length > 0;
    for (let index = 1; index < covered.length && contiguous; index += 1) {
        if (covered[index]!.start > covered[index - 1]!.end + 1) contiguous = false;
    }
    const frozen_runs = resolved ? Object.freeze(runs) : undefined;
    const removed_runs = Object.freeze(merge_intervals(removed));
    let identities: readonly RowIdentity[] | undefined;
    let removed_rows: readonly number[] | undefined;
    return Object.freeze({
        count,
        runs: frozen_runs,
        get identities(): readonly RowIdentity[] | undefined {
            if (frozen_runs === undefined) return undefined;
            identities ??= Object.freeze(identities_of_runs(frozen_runs));
            return identities;
        },
        removedSourceRuns: removed_runs,
        removedCount: removed_runs.reduce((total, entry) => total + entry.count, 0),
        get removedSourceRows(): readonly number[] {
            removed_rows ??= Object.freeze(removed_runs.flatMap((entry) =>
                Array.from({ length: entry.count }, (_, offset) => entry.start + offset)));
            return removed_rows;
        },
        fixedRows,
        tailRemovals,
        contiguous,
        bandRows,
        endsAtBandEnd: bandRows > 0 && last_row === projection.rowCount - 1,
    });
}

/**
 * A selection from per-row identities, for callers outside the grid: runs in
 * the identities' order, consecutive source rows merged.
 */
export function row_structure_selection(
    fields: Omit<RowStructureSelection, 'runs' | 'identities' | 'removedSourceRuns' | 'removedCount' | 'removedSourceRows'> & {
        readonly identities: readonly RowIdentity[] | undefined;
        readonly removedSourceRows: readonly number[];
    },
): RowStructureSelection {
    const runs: RowSelectionRun[] | undefined = fields.identities === undefined ? undefined : [];
    for (const identity of fields.identities ?? []) {
        const previous = runs![runs!.length - 1];
        if (identity.kind === 'pending') runs!.push({ kind: 'pending', identity });
        else if (previous?.kind === 'source' && previous.start + previous.count === identity.sourceRow) {
            runs![runs!.length - 1] = { kind: 'source', start: previous.start, count: previous.count + 1 };
        } else runs!.push({ kind: 'source', start: identity.sourceRow, count: 1 });
    }
    const removed = merge_intervals(fields.removedSourceRows.map((row) => ({ start: row, count: 1 })));
    return Object.freeze({
        ...fields,
        runs: runs === undefined ? undefined : Object.freeze(runs),
        removedSourceRuns: Object.freeze(removed),
        removedCount: removed.reduce((total, entry) => total + entry.count, 0),
    });
}

/** Sort and merge overlapping or adjacent intervals. */
function merge_intervals(intervals: readonly SourceInterval[]): SourceInterval[] {
    const sorted = [...intervals].sort((left, right) => left.start - right.start);
    const out: SourceInterval[] = [];
    for (const entry of sorted) {
        const last = out[out.length - 1];
        if (last !== undefined && entry.start <= last.start + last.count) {
            out[out.length - 1] = {
                start: last.start,
                count: Math.max(last.start + last.count, entry.start + entry.count) - last.start,
            };
        } else {
            out.push({ start: entry.start, count: entry.count });
        }
    }
    return out;
}

/** The runs' rows, one identity each, in order. */
export function identities_of_runs(runs: readonly RowSelectionRun[]): RowIdentity[] {
    const out: RowIdentity[] = [];
    for (const run of runs) {
        if (run.kind === 'pending') {
            out.push(run.identity);
            continue;
        }
        for (let row = run.start; row < run.start + run.count; row += 1) out.push({ kind: 'source', sourceRow: row });
    }
    return out;
}

/**
 * At most two identities per run: the first and last live row of each, so a
 * selection's live span, which Insert and Move anchor on, is found in
 * proportion to its runs.
 */
export function live_span_identities(
    changes: PendingStructuralChanges,
    runs: readonly RowSelectionRun[],
): RowIdentity[] {
    const removed = changes.rowLayout?.removedSourceRows ?? [];
    const out: RowIdentity[] = [];
    for (const run of runs) {
        if (run.kind === 'pending') {
            out.push(run.identity);
            continue;
        }
        const live = subtract_intervals([{ start: run.start, count: run.count }], removed);
        const first = live[0];
        const last = live[live.length - 1];
        if (first === undefined || last === undefined) {
            // A run of tombstones still names a known row for the index to place.
            out.push({ kind: 'source', sourceRow: run.start });
            continue;
        }
        out.push({ kind: 'source', sourceRow: first.start });
        if (last.start + last.count - 1 !== first.start) {
            out.push({ kind: 'source', sourceRow: last.start + last.count - 1 });
        }
    }
    return out;
}

/** `only_appended_rows` over runs. */
export function only_appended_runs(
    changes: PendingStructuralChanges,
    runs: readonly RowSelectionRun[],
): boolean {
    if (runs.length === 0 || runs.some((run) => run.kind !== 'pending')) return false;
    return only_appended_rows(changes, runs.map((run) => (run as Extract<RowSelectionRun, { kind: 'pending' }>).identity));
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

/** An Insert item: inserting beside the selection, or, below the band's last row, appending. */
export interface InsertItemModel extends StructureItemModel {
    readonly action: 'insert' | 'append';
    /** The live row the new rows go beside; absent when the item appends or is disabled. */
    readonly anchor?: RowIdentity;
}

/** A Move item: one step past the neighboring live row (with its glued tombstones). */
export interface MoveItemModel extends StructureItemModel {
    /** The `before` target of the step; absent when the item is disabled. */
    readonly before?: RowIdentity | 'end';
}

export interface RowStructureMenuModel {
    readonly insertAbove: InsertItemModel;
    readonly insertBelow: InsertItemModel;
    readonly delete: StructureItemModel;
    /** Offered only when the selection includes a Pending Row Removal. */
    readonly restore?: StructureItemModel;
    readonly moveUp: MoveItemModel;
    readonly moveDown: MoveItemModel;
}

export interface RowStructureMenuInput {
    readonly support: StructuralAxisSupport;
    /** Whether an edit gesture may start now (no save, highlight, or append in flight). */
    readonly ready: boolean;
    readonly selection: RowStructureSelection;
    readonly changes: PendingStructuralChanges;
    readonly context: WorksheetStructureContext;
    /**
     * Why Append Row is unavailable right now, for "Insert below" on the
     * band's last row; absent when appending would be admitted.
     */
    readonly appendRefusal?: string;
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
        ?? (selection.runs === undefined ? ROWS_NOT_LOADED_MESSAGE : undefined)
        ?? (only_appended_runs(changes, selection.runs!)
            ? undefined
            : refusal_message(plan_row_delete_runs(changes, context, selection.runs!, new Map())));
    const insertAbove = insert_item(input, shared_reason, 'before');
    const insertBelow = insert_item(input, shared_reason, 'after');
    const moveUp = row_move_item_model(input, 'backward');
    const moveDown = row_move_item_model(input, 'forward');
    if (selection.removedCount === 0) {
        return Object.freeze({ insertAbove, insertBelow, delete: item(count, delete_reason), moveUp, moveDown });
    }
    const restore_reason = shared_reason
        ?? (selection.removedCount !== count ? RESTORE_ONLY_REMOVALS_MESSAGE : undefined)
        ?? refusal_message(plan_row_restore_runs(changes, context, selection.removedSourceRuns));
    return Object.freeze({
        insertAbove,
        insertBelow,
        delete: item(count, delete_reason),
        restore: item(selection.removedCount, restore_reason),
        moveUp,
        moveDown,
    });
}

function shared_structure_reason(input: Pick<RowStructureMenuInput, 'support' | 'ready'>): string | undefined {
    return !input.support.supported
        ? input.support.reason
        : !input.ready
            ? STRUCTURE_BUSY_MESSAGE
            : undefined;
}

/**
 * Why the selected rows cannot move at all, in either direction or by drag,
 * or undefined. Both Move items ask it before their step's own reasons, and a
 * drag arms only when it is undefined.
 */
export function row_move_block_refusal(
    input: Pick<RowStructureMenuInput, 'support' | 'ready' | 'selection' | 'changes' | 'context'>,
): string | undefined {
    const { selection, changes, context } = input;
    // An `.xlsx` sheet the host can't restructure says so in Move's words.
    const reason = (input.support.supported ? undefined : input.support.moveReason)
        ?? shared_structure_reason(input)
        ?? (selection.fixedRows ? MOVE_FIXED_ROWS_MESSAGE : undefined)
        ?? (selection.tailRemovals ? STRUCTURE_TAIL_REMOVAL_MESSAGE : undefined)
        ?? (selection.runs === undefined ? ROWS_NOT_LOADED_MESSAGE : undefined)
        ?? (!selection.contiguous ? SELECT_ADJACENT_ROWS_MESSAGE : undefined)
        // Appended rows stay where Append put them; a selection reaching
        // into the band moves nothing.
        ?? (selection.bandRows > 0 ? APPENDED_BAND_MESSAGE : undefined)
        ?? (context.bodyViewTransformed ? STRUCTURE_TRANSFORMED_MESSAGE : undefined)
        ?? structure_exclusivity_message(changes, context)
        ?? merge_split_refusal(changes, context, selection.runs!);
    if (reason !== undefined) return reason;
    const index = index_row_layout(row_layout_for(changes, context));
    return insert_anchor_for_selection(index, live_span_identities(changes, selection.runs!), 'before') === undefined
        ? MOVE_ONLY_REMOVED_ROWS_MESSAGE
        : undefined;
}

/**
 * Moving part of a merge is refused whatever the destination, so the Move
 * items and the drag refuse it before a target is chosen, with the store's
 * own message (`move_rows` refuses the same block). A merge's part is the
 * block's live source rows inside its row span, against all its live rows.
 */
function merge_split_refusal(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    runs: readonly RowSelectionRun[],
): string | undefined {
    const merges = context.merges ?? [];
    if (merges.length === 0) return undefined;
    const removed = changes.rowLayout?.removedSourceRows ?? [];
    const moved = subtract_intervals(merge_intervals(runs.flatMap((run) =>
        run.kind === 'source' ? [{ start: run.start, count: run.count }] : [])), removed);
    if (moved.length === 0) return undefined;
    const size = (intervals: readonly SourceInterval[]) =>
        intervals.reduce((total, entry) => total + entry.count, 0);
    for (const merge of merges) {
        if (merge.endRow <= merge.startRow) continue;
        const span = [{ start: merge.startRow, count: merge.endRow - merge.startRow + 1 }];
        const inside = size(intersect_intervals(moved, span));
        if (inside === 0) continue;
        const live = size(subtract_intervals(span, removed));
        if (inside < live) return MERGE_SPLIT_MESSAGE;
    }
    return undefined;
}

/**
 * One Move item ('backward' is up): enabled with the step's `before` target
 * when the gesture would succeed now, else disabled with the reason it would
 * give. The `Alt+Shift+↑`/`↓` shortcuts ask the same question.
 */
export function row_move_item_model(
    input: Pick<RowStructureMenuInput, 'support' | 'ready' | 'selection' | 'changes' | 'context'>,
    direction: 'backward' | 'forward',
): MoveItemModel {
    const { selection, changes, context } = input;
    const count = selection.count;
    const disabled = (reason: string): MoveItemModel => Object.freeze({ count, enabled: false, reason });
    const reason = row_move_block_refusal(input);
    if (reason !== undefined) return disabled(reason);
    const index = index_row_layout(row_layout_for(changes, context));
    const before = step_move_target(index, live_span_identities(changes, selection.runs!), direction);
    if (before === undefined) {
        if (direction === 'backward') {
            return disabled(context.bodyStart > 0 ? MOVE_ABOVE_HEADER_MESSAGE : MOVE_AT_TOP_MESSAGE);
        }
        return disabled(appended_rows(changes).length > 0 ? APPENDED_BAND_MESSAGE : MOVE_AT_BOTTOM_MESSAGE);
    }
    // A dry run gives the refusal the gesture would get (merges, run limit).
    const probe = plan_row_move(changes, context, selection.identities!, before);
    if (!probe.ok) return disabled(probe.message);
    return Object.freeze({ count, enabled: true, before });
}

function insert_item(
    input: RowStructureMenuInput,
    shared_reason: string | undefined,
    side: 'before' | 'after',
): InsertItemModel {
    const { selection, changes, context } = input;
    const count = selection.count;
    const disabled = (reason: string): InsertItemModel =>
        Object.freeze({ count, enabled: false, reason, action: 'insert' });
    const reason = shared_reason
        ?? (selection.fixedRows ? INSERT_ABOVE_HEADER_MESSAGE : undefined)
        ?? (selection.tailRemovals ? STRUCTURE_TAIL_REMOVAL_MESSAGE : undefined)
        ?? (selection.runs === undefined ? ROWS_NOT_LOADED_MESSAGE : undefined)
        ?? (!selection.contiguous ? SELECT_ADJACENT_ROWS_MESSAGE : undefined);
    if (reason !== undefined) return disabled(reason);
    if (selection.bandRows > 0) {
        // The band stays where Append put it: nothing goes into or after it,
        // except that Insert below its last row appends.
        if (side === 'before' || selection.bandRows < count || !selection.endsAtBandEnd) {
            return disabled(APPENDED_BAND_MESSAGE);
        }
        return Object.freeze(input.appendRefusal === undefined
            ? { count, enabled: true, action: 'append' }
            : { count, enabled: false, reason: input.appendRefusal, action: 'append' });
    }
    if (context.bodyViewTransformed) return disabled(STRUCTURE_TRANSFORMED_MESSAGE);
    const anchor = insert_anchor_for_selection(
        index_row_layout(row_layout_for(changes, context)),
        live_span_identities(changes, selection.runs!),
        side,
    );
    if (anchor === undefined) return disabled(INSERT_ONLY_REMOVED_ROWS_MESSAGE);
    // Refused before any placeholder is allocated: a selection of a million
    // rows would otherwise build a million probe IDs to learn this.
    if (pending_rows(changes).length + (changes.rowLayout?.discardedPendingRows.length ?? 0)
        + Math.max(1, count) > MAX_PENDING_APPENDED_ROWS) {
        return disabled(TOO_MANY_PENDING_ROWS_MESSAGE);
    }
    // A dry run with placeholder IDs gives the refusal the gesture would get
    // with the host's (exclusivity, run and row limits), so menu and gesture agree.
    const ids = Array.from({ length: Math.max(1, count) }, (_, index) => `menu-probe:${index}`);
    const probe = plan_row_insert(
        changes,
        context,
        anchor,
        side,
        ids,
        changes.formatTemplates.find((template) => template.format.kind === 'none')
            ?? { id: 'menu-probe-template', format: { kind: 'none' } },
        Number.MAX_SAFE_INTEGER - ids.length,
    );
    if (!probe.ok) return disabled(probe.message);
    return Object.freeze({ count, enabled: true, action: 'insert', anchor });
}

function row_layout_for(changes: PendingStructuralChanges, context: WorksheetStructureContext) {
    return changes.rowLayout
        ?? source_row_layout(context.bodyStart, Math.max(0, context.sourceRowCount - context.bodyStart));
}

/**
 * Whether an insert's anchor is still a live row of the worksheet. The grid
 * checks it when the host's reply arrives: a row deleted (or an insert
 * undone) while the request was out cancels the insert, which then announces
 * `INSERT_CANCELED_MESSAGE` and releases its admission.
 */
export function insert_anchor_is_live(
    changes: PendingStructuralChanges,
    context: Pick<WorksheetStructureContext, 'bodyStart' | 'sourceRowCount'>,
    anchor: RowIdentity,
): boolean {
    const layout = changes.rowLayout
        ?? source_row_layout(context.bodyStart, Math.max(0, context.sourceRowCount - context.bodyStart));
    return index_row_layout(layout).is_live(anchor);
}

/**
 * The creation order for an insert's first row: the caller's clock value, or
 * past every Pending Row's order when that is higher, so a burst of gestures
 * inside one clock tick cannot reuse an order.
 */
export function insert_created_order(changes: PendingStructuralChanges, clock: number): number {
    let highest = -1;
    for (const row of pending_rows(changes)) highest = Math.max(highest, row.createdOrder);
    for (const row of changes.rowLayout?.discardedPendingRows ?? []) highest = Math.max(highest, row.createdOrder);
    return Math.max(clock, highest + 1);
}

/**
 * Insert the host-admitted `ids` beside `anchor`: one history action, the
 * `rowLayout` arm, labelled "Insert row" or "Insert N rows".
 */
export function plan_row_insert(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    anchor: RowIdentity,
    side: 'before' | 'after',
    ids: readonly string[],
    template: PendingRowFormatTemplate,
    first_created_order: number,
    append_basis?: PendingAppendBasis,
): RowStructurePlanResult {
    const result = insert_rows(changes, context, anchor, side, ids, template, first_created_order, append_basis);
    if (!result.ok) return { ok: false, message: result.refusal.message };
    return Object.freeze({
        ok: true,
        label: row_structure_label('Insert', ids.length),
        outcome: result.outcome,
        discardedCellKeys: Object.freeze([]),
        changes: Object.freeze([result.outcome.change]),
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
    return plan_row_delete_runs(changes, context, row_runs_of_identities(identities), cells);
}

/** `plan_row_delete` over a selection's runs, proportional to the runs. */
export function plan_row_delete_runs(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    runs: readonly RowSelectionRun[],
    cells: ReadonlyMap<string, HistoryDirtyEntry>,
): RowStructurePlanResult {
    const result = delete_row_runs(changes, context, runs);
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

/** `plan_row_restore` over intervals of source rows, proportional to the intervals. */
export function plan_row_restore_runs(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    source: readonly SourceInterval[],
): RowStructurePlanResult {
    const result = restore_row_runs(changes, context, source);
    if (!result.ok) return { ok: false, message: result.refusal.message };
    return Object.freeze({
        ok: true,
        label: row_structure_label('Restore', merge_intervals(source).reduce((total, entry) => total + entry.count, 0)),
        outcome: result.outcome,
        discardedCellKeys: Object.freeze([]),
        changes: Object.freeze([result.outcome.change]),
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

/** A planned move, with what the live region announces. */
export interface RowMovePlan extends RowStructurePlan {
    /** Live rows the gesture moves (glued tombstones ride along uncounted). */
    readonly movedRows: number;
    readonly direction: 'up' | 'down';
    /** The live identities the gesture moves, in display order: focus follows them. */
    readonly movedIdentities: readonly RowIdentity[];
}

export type RowMovePlanResult =
    | RowMovePlan
    | { readonly ok: false; readonly message: string; readonly unchanged?: true };

/**
 * Move the live rows of `identities`, each with its glued tombstones, to just
 * before `before` ('end' is the end of the layout, before the append band):
 * one history action, the `rowLayout` arm, labelled "Move row" or "Move N
 * rows". A move that would change nothing is refused with `unchanged`.
 */
export function plan_row_move(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    identities: readonly RowIdentity[],
    before: RowIdentity | 'end',
): RowMovePlanResult {
    const result = move_rows(changes, context, identities, before);
    if (!result.ok) {
        return result.refusal.reason === 'unchanged'
            ? { ok: false, message: result.refusal.message, unchanged: true }
            : { ok: false, message: result.refusal.message };
    }
    const index = index_row_layout(row_layout_for(changes, context));
    const live = identities.filter((identity) => index.is_live(identity));
    // A loop, not `Math.min(...)`: a selection may exceed the argument limit.
    let first = Infinity;
    for (const identity of live) first = Math.min(first, index.position_of(identity)!);
    const direction = before === 'end' || (index.position_of(before) ?? Infinity) > first ? 'down' : 'up';
    return Object.freeze({
        ok: true,
        label: row_structure_label('Move', live.length),
        outcome: result.outcome,
        discardedCellKeys: Object.freeze([]),
        changes: Object.freeze([result.outcome.change]),
        movedRows: live.length,
        direction,
        movedIdentities: Object.freeze(live),
    });
}

/** Options for resolving a drop row; see `RowStructureSelectionOptions`. */
export interface RowMoveDropOptions {
    readonly bodyStart: number;
    readonly sourceRowFor?: (source_display_row: number) => number | undefined;
}

/**
 * The layout target for a drag that drops before display row `before`
 * (`projection.rowCount` for the end, -1 over the column header). A drop at
 * or above the Header Row is refused; a drop inside or after the append band
 * resolves to just before it ('end'); a drop between a live row and its glued
 * tombstones names the tombstone, which `move_rows` resolves to after them.
 */
export function resolve_row_move_drop(
    projection: Pick<PendingRowProjection, 'row_at' | 'rowCount' | 'pendingBandStart'>,
    before: number,
    options: RowMoveDropOptions,
): { readonly ok: true; readonly before: RowIdentity | 'end' } | { readonly ok: false; readonly message: string } {
    const refused_above = {
        ok: false as const,
        message: options.bodyStart > 0 ? MOVE_ABOVE_HEADER_MESSAGE : MOVE_AT_TOP_MESSAGE,
    };
    if (before < 0) return refused_above;
    if (before >= projection.pendingBandStart || before >= projection.rowCount) {
        return { ok: true, before: 'end' };
    }
    const projected = projection.row_at(before);
    if (projected === undefined) return { ok: false, message: ROWS_NOT_LOADED_MESSAGE };
    if (projected.kind === 'pending') return { ok: true, before: projected.identity };
    if (projected.kind !== 'source') return { ok: true, before: 'end' };
    const source_row = projected.identity?.sourceRow ?? options.sourceRowFor?.(projected.sourceDisplayRow);
    if (source_row === undefined) return { ok: false, message: ROWS_NOT_LOADED_MESSAGE };
    if (source_row < options.bodyStart) return refused_above;
    return { ok: true, before: { kind: 'source', sourceRow: source_row } };
}

/**
 * The display rows a move's block occupies once the grid shows it: from its
 * first moved live row through its last, plus the removed rows glued after
 * that one, which moved with it. Undefined until every moved row is shown.
 */
export function moved_block_display_rows(
    projection: Pick<PendingRowProjection, 'display_row_for_identity' | 'row_state' | 'rowCount'>,
    moved: readonly RowIdentity[],
): { readonly start: number; readonly end: number } | undefined {
    let start = Infinity;
    let end = -Infinity;
    for (const identity of moved) {
        const row = projection.display_row_for_identity(identity);
        if (row === undefined) return undefined;
        start = Math.min(start, row);
        end = Math.max(end, row);
    }
    if (end < 0) return undefined;
    while (end + 1 < projection.rowCount && projection.row_state(end + 1) === 'removed') end += 1;
    return { start, end };
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

/**
 * The shipped `.xlsx` merges (A1 ranges) as the store's merge rules read them,
 * in canonical source coordinates. A range the parser cannot read is left
 * out: the host's support scan already refused the worksheet over it.
 */
export function merge_ranges_of(refs: readonly string[]): MergeRange[] {
    return refs.flatMap((ref) => {
        const cells = parse_rule_sqref(ref);
        if (cells === undefined || cells.length !== 1) return [];
        const [range] = cells;
        return [{
            startRow: range!.firstRow,
            startCol: range!.firstColumn,
            endRow: range!.lastRow,
            endCol: range!.lastColumn,
        }];
    });
}

/** One `.xlsx` rule that Save would refuse to split. */
export interface RuleSplitWarning {
    readonly kind: WorksheetRelativeRule['kind'];
    readonly sqref: string;
}

/**
 * The conditional-formatting elements and data-validation rules on
 * `sheet_index` that the current layouts would split into more than
 * `MAX_RULE_SPLIT` rules, which Save refuses. Counted with the writer's own
 * partition (`relative_rule_split_count`), per element, so the warning names
 * exactly what Save would refuse. A rule the layouts cannot render at all is
 * refused at Save with its own reason, so it is not repeated here.
 */
export function rule_split_warnings(
    inputs: readonly AnchorWorksheetInput[],
    sheet_index: number,
    rules: readonly WorksheetRelativeRule[],
): RuleSplitWarning[] {
    if (rules.length === 0 || !inputs.some((input) =>
        input.changes !== undefined && has_live_layout_change(input.changes))) return [];
    const workbook = rule_split_workbook(inputs);
    return rules.flatMap((rule) => {
        if (rule.formulas.length === 0) return [];
        const cells = parse_rule_sqref(rule.sqref);
        if (cells === undefined) return [];
        const split = relative_rule_split_count(workbook, {
            worksheet: sheet_index,
            cells,
            formulas: rule.formulas,
        });
        return split.kind === 'count' && split.count > MAX_RULE_SPLIT
            ? [Object.freeze({ kind: rule.kind, sqref: rule.sqref })]
            : [];
    });
}

/**
 * "Moving these rows would split the conditional formatting on B2:B500 into
 * more than 64 rules. Save will refuse it." The lead names the worksheet's
 * gestures when they are of one kind. The split count stops at the cap, so
 * the message says "more than" rather than a number.
 */
export function rule_split_warning_message(
    warning: RuleSplitWarning,
    changes: Pick<PendingStructuralChanges, 'rowLayout' | 'columnLayout' | 'appendedRows'>,
): string {
    const rows = changes.rowLayout === undefined ? undefined : index_row_layout(changes.rowLayout);
    const columns_changed = changes.columnLayout !== undefined
        && has_live_column_layout_change(changes.columnLayout);
    const moved = rows?.hasOutOfOrderRun === true;
    const inserted = rows?.hasLiveInserted === true;
    const deleted = (changes.rowLayout?.removedSourceRows.length ?? 0) > 0;
    const lead = columns_changed || [moved, inserted, deleted].filter(Boolean).length !== 1
        ? 'These row and column changes'
        : moved ? 'Moving these rows' : inserted ? 'Inserting these rows' : 'Deleting these rows';
    const what = warning.kind === 'conditionalFormatting' ? 'conditional formatting' : 'data validation';
    return `${lead} would split the ${what} on ${warning.sqref} into more than ${MAX_RULE_SPLIT} rules. Save will refuse it.`;
}

/** The shipped AutoFilter as the store's filtered-column move rule reads it, or nothing. */
export function structure_auto_filter(
    auto_filter: { readonly ref: string; readonly filteredColumns: readonly number[] } | undefined,
): { readonly autoFilter?: NonNullable<WorksheetStructureContext['autoFilter']> } {
    if (auto_filter === undefined || auto_filter.filteredColumns.length === 0) return {};
    const cells = parse_rule_sqref(auto_filter.ref);
    if (cells === undefined || cells.length !== 1) return {};
    return {
        autoFilter: Object.freeze({
            firstColumn: cells[0]!.firstColumn,
            lastColumn: cells[0]!.lastColumn,
            filteredColumns: Object.freeze([...auto_filter.filteredColumns]),
        }),
    };
}
