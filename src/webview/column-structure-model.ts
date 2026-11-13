/**
 * Column Insert, Delete, Restore, Move, and Pending Column rename in Edit
 * mode, as pure planning the grid commits: the column twin of
 * `row-structure-model.ts`.
 *
 * Resolve a header selection into column identities
 * (`resolve_column_structure_selection`), decide which structure items the
 * column menus offer and why one is disabled (`column_structure_menu_model`),
 * and plan the one history action a gesture records (`plan_column_insert`,
 * `plan_column_delete`, `plan_column_restore`, `plan_column_move`, and
 * `plan_pending_column_update` for a Pending Column's header, cells, or
 * width). A drag's drop column resolves to a layout target through
 * `resolve_column_move_drop`. Column operations work under any row
 * transform. Hidden columns stay hidden: a Move passes one neighboring
 * *displayed* column and leaves hidden columns where they are relative to
 * the columns around them.
 */

import {
    MAX_PENDING_COLUMNS,
    type PendingColumn,
    type PendingColumnFormat,
    type PendingRowCell,
    type PendingStructuralChanges,
} from '../pending-changes';
import { normalized_column_name } from '../column-name';
import type { CellHighlightColor } from '../cell-highlight-colors';
import type { StructuralAxisSupport } from '../viewer-snapshot';
import {
    column_identities_equal,
    index_column_layout,
    type ColumnIdentity,
    insert_anchor_for_selection,
    source_column_layout,
    type ColumnLayout,
    type ColumnLayoutIndex,
} from '../worksheet-layout';
import type { ProjectedColumn } from './column-projection';
import type { HistoryDirtyEntry } from './history-cell-state-model';
import { discard_history_source } from './history-discard-model';
import type { HistoryChange, LayoutHistoryChange } from './history-stack-model';
import {
    delete_columns,
    insert_columns,
    move_columns,
    restore_columns,
    source_cells_removed_by,
    structure_exclusivity_message,
    TOO_MANY_PENDING_COLUMNS_MESSAGE,
    type StructureOutcome,
    type WorksheetStructureContext,
} from './pending-row-store';
import { STRUCTURE_BUSY_MESSAGE } from './row-structure-model';

export const SELECT_ADJACENT_COLUMNS_MESSAGE = 'Select adjacent columns to insert or move them.';
export const INSERT_ONLY_REMOVED_COLUMNS_MESSAGE =
    "Select a column that isn't deleted to insert columns beside it.";
export const MOVE_ONLY_REMOVED_COLUMNS_MESSAGE = "Select a column that isn't deleted to move it.";
export const RESTORE_ONLY_REMOVED_COLUMNS_MESSAGE = 'Select only deleted columns to restore them.';
export const MOVE_AT_LEFT_MESSAGE = 'The selected columns are already at the left edge.';
export const MOVE_AT_RIGHT_MESSAGE = 'The selected columns are already at the right edge.';
export const INSERT_COLUMN_CANCELED_MESSAGE = 'Insert canceled because its column was removed.';
/** Sort and filter read source data only, so a Pending Column offers neither. */
export const PENDING_COLUMN_TRANSFORM_MESSAGE = 'Save the new column to sort or filter by it.';
export const RENAME_ONLY_NEW_COLUMNS_MESSAGE = 'Only new columns can be renamed on this sheet.';
/** Column visibility is keyed by source column, so a Pending Column stays shown. */
export const PENDING_COLUMN_HIDE_MESSAGE = 'Save the new column to hide it.';
/** The first default name; later ones are "New column 2", "New column 3", and so on. */
export const DEFAULT_PENDING_COLUMN_NAME = 'New column';

/**
 * Why a Pending Column may not take a deleted column's name: structured
 * references such as `[Price]` follow the name and would silently rebind.
 */
export function removed_column_name_message(name: string): string {
    return `A deleted column on this sheet is named ${name}. Restore it or choose another name.`;
}

/** "Delete column", "Delete 3 columns", "Move column", ...: undo labels and menu items. */
export function column_structure_label(
    verb: 'Delete' | 'Restore' | 'Insert' | 'Move',
    count: number,
): string {
    return count === 1 ? `${verb} column` : `${verb} ${count} columns`;
}

/** "Insert column left", "Insert 3 columns right": the Insert menu items. */
export function column_insert_label(side: 'left' | 'right', count: number): string {
    return `${column_structure_label('Insert', Math.max(1, count))} ${side}`;
}

/** The live region's report of a move: "Moved 3 columns right", "Moved 1 column left". */
export function column_move_announcement(count: number, direction: 'left' | 'right'): string {
    return `Moved ${count} ${count === 1 ? 'column' : 'columns'} ${direction}`;
}

/** A header selection, resolved against the column projection when the menu opened. */
export interface ColumnStructureSelection {
    /** Selected display columns. */
    readonly count: number;
    /** Every selected column by identity, in display order. */
    readonly identities: readonly ColumnIdentity[];
    /** Selected Pending Column Removals, by source column, in display order. */
    readonly removedSourceColumns: readonly number[];
    /** The selected display columns form one interval: Insert and Move need that. */
    readonly contiguous: boolean;
}

/**
 * Resolve selected display columns (any order) against the projection's
 * display columns. Out-of-range display columns are ignored.
 */
export function resolve_column_structure_selection(
    columns: readonly ProjectedColumn[],
    display_columns: Iterable<number>,
): ColumnStructureSelection {
    const sorted = [...new Set(display_columns)]
        .filter((column) => Number.isInteger(column) && column >= 0 && column < columns.length)
        .sort((left, right) => left - right);
    const identities: ColumnIdentity[] = [];
    const removed: number[] = [];
    for (const display of sorted) {
        const column = columns[display]!;
        identities.push(column.identity);
        if (column.state === 'removed' && column.identity.kind === 'source') {
            removed.push(column.identity.sourceColumn);
        }
    }
    return Object.freeze({
        count: sorted.length,
        identities: Object.freeze(identities),
        removedSourceColumns: Object.freeze(removed),
        contiguous: sorted.length > 0 && sorted[sorted.length - 1]! - sorted[0]! + 1 === sorted.length,
    });
}

export interface ColumnStructureItemModel {
    readonly count: number;
    readonly enabled: boolean;
    readonly reason?: string;
}

export interface ColumnInsertItemModel extends ColumnStructureItemModel {
    /** The live column the new columns go beside; absent when disabled. */
    readonly anchor?: ColumnIdentity;
}

export interface ColumnMoveItemModel extends ColumnStructureItemModel {
    /** The `before` target of the step; absent when disabled. */
    readonly before?: ColumnIdentity | 'end';
}

export interface ColumnStructureMenuModel {
    readonly insertLeft: ColumnInsertItemModel;
    readonly insertRight: ColumnInsertItemModel;
    readonly delete: ColumnStructureItemModel;
    /** Offered only when the selection includes a Pending Column Removal. */
    readonly restore?: ColumnStructureItemModel;
    readonly moveLeft: ColumnMoveItemModel;
    readonly moveRight: ColumnMoveItemModel;
}

export interface ColumnStructureMenuInput {
    readonly support: StructuralAxisSupport;
    /** Whether an edit gesture may start now (no save, admission, or replay in flight). */
    readonly ready: boolean;
    readonly selection: ColumnStructureSelection;
    readonly changes: PendingStructuralChanges;
    readonly context: WorksheetStructureContext;
    /** The display columns the grid shows now, for Move's displayed neighbor. */
    readonly columns: readonly ProjectedColumn[];
}

function item(count: number, reason: string | undefined): ColumnStructureItemModel {
    return Object.freeze(reason === undefined
        ? { count, enabled: true }
        : { count, enabled: false, reason });
}

function shared_reason(input: Pick<ColumnStructureMenuInput, 'support' | 'ready'>): string | undefined {
    return !input.support.supported
        ? input.support.reason
        : !input.ready ? STRUCTURE_BUSY_MESSAGE : undefined;
}

export function column_layout_for(
    changes: PendingStructuralChanges,
    context: Pick<WorksheetStructureContext, 'sourceColumnCount'>,
): ColumnLayout {
    return changes.columnLayout ?? source_column_layout(context.sourceColumnCount);
}

/**
 * The structure items for a header selection. Each is enabled only when its
 * gesture would succeed now; otherwise its reason is the refusal the gesture
 * would give, so the menu and the action cannot disagree.
 */
export function column_structure_menu_model(input: ColumnStructureMenuInput): ColumnStructureMenuModel {
    const { selection, changes, context } = input;
    const count = selection.count;
    const shared = shared_reason(input);
    const delete_reason = shared
        ?? refusal_message(plan_column_delete(changes, context, selection.identities, new Map()));
    const insertLeft = insert_item(input, shared, 'before');
    const insertRight = insert_item(input, shared, 'after');
    const moveLeft = column_move_item_model(input, 'backward');
    const moveRight = column_move_item_model(input, 'forward');
    if (selection.removedSourceColumns.length === 0) {
        return Object.freeze({ insertLeft, insertRight, delete: item(count, delete_reason), moveLeft, moveRight });
    }
    const restore_reason = shared
        ?? (selection.removedSourceColumns.length !== count ? RESTORE_ONLY_REMOVED_COLUMNS_MESSAGE : undefined)
        ?? refusal_message(plan_column_restore(changes, context, selection.removedSourceColumns));
    return Object.freeze({
        insertLeft,
        insertRight,
        delete: item(count, delete_reason),
        restore: item(selection.removedSourceColumns.length, restore_reason),
        moveLeft,
        moveRight,
    });
}

function insert_item(
    input: ColumnStructureMenuInput,
    shared: string | undefined,
    side: 'before' | 'after',
): ColumnInsertItemModel {
    const { selection, changes, context } = input;
    const count = selection.count;
    const disabled = (reason: string): ColumnInsertItemModel => Object.freeze({ count, enabled: false, reason });
    const reason = shared
        ?? (!selection.contiguous ? SELECT_ADJACENT_COLUMNS_MESSAGE : undefined)
        ?? structure_exclusivity_message(changes, context);
    if (reason !== undefined) return disabled(reason);
    const layout = column_layout_for(changes, context);
    const anchor = insert_anchor_for_selection(index_column_layout(layout), selection.identities, side);
    if (anchor === undefined) return disabled(INSERT_ONLY_REMOVED_COLUMNS_MESSAGE);
    if ((changes.pendingColumns?.length ?? 0) + layout.discardedPendingColumns.length + Math.max(1, count)
        > MAX_PENDING_COLUMNS) {
        return disabled(TOO_MANY_PENDING_COLUMNS_MESSAGE);
    }
    // A dry run with placeholder columns gives the refusal the gesture would
    // get with the host's IDs (width and entry limits), so menu and gesture agree.
    const probe = plan_column_insert(
        changes,
        context,
        anchor,
        side,
        Array.from({ length: Math.max(1, count) }, (_, index): PendingColumn => ({
            id: `menu-probe:${index}`,
            header: '',
            cells: {},
            format: { kind: 'none' },
            createdOrder: Number.MAX_SAFE_INTEGER - count + index,
        })),
    );
    if (!probe.ok) return disabled(probe.message);
    return Object.freeze({ count, enabled: true, anchor });
}

/** Why the selected columns cannot move at all, by menu, shortcut, or drag, or undefined. */
export function column_move_block_refusal(
    input: Pick<ColumnStructureMenuInput, 'support' | 'ready' | 'selection' | 'changes' | 'context'>,
): string | undefined {
    const { selection, changes, context } = input;
    const reason = shared_reason(input)
        ?? (!selection.contiguous ? SELECT_ADJACENT_COLUMNS_MESSAGE : undefined)
        ?? structure_exclusivity_message(changes, context);
    if (reason !== undefined) return reason;
    const index = index_column_layout(column_layout_for(changes, context));
    return selection.identities.some((identity) => index.is_live(identity))
        ? undefined
        : MOVE_ONLY_REMOVED_COLUMNS_MESSAGE;
}

/**
 * The `before` target of one Move step: the block passes one neighboring
 * displayed live column, with its glued tombstones. Hidden columns are not
 * displayed, so a step skips them and they keep their place relative to the
 * columns around them. Undefined at the edge.
 */
export function column_step_target(
    columns: readonly ProjectedColumn[],
    index: ColumnLayoutIndex,
    identities: readonly ColumnIdentity[],
    direction: 'backward' | 'forward',
): ColumnIdentity | 'end' | undefined {
    const selected = new Set(identities.map(key_of));
    let first = Infinity;
    let last = -Infinity;
    for (let display = 0; display < columns.length; display++) {
        const column = columns[display]!;
        if (!selected.has(column.key) || !index.is_live(column.identity)) continue;
        first = Math.min(first, display);
        last = Math.max(last, display);
    }
    if (first === Infinity) return undefined;
    if (direction === 'backward') {
        for (let display = first - 1; display >= 0; display--) {
            const column = columns[display]!;
            if (index.is_live(column.identity)) return column.identity;
        }
        return undefined;
    }
    for (let display = last + 1; display < columns.length; display++) {
        const neighbor = columns[display]!;
        if (!index.is_live(neighbor.identity)) continue;
        const body = index.body_index_of(neighbor.identity)!;
        return body >= index.liveCount ? 'end' : index.identity_at_body_index(body + 1);
    }
    return undefined;
}

function key_of(identity: ColumnIdentity): string {
    return identity.kind === 'source' ? `s:${identity.sourceColumn}` : `p:${identity.pendingColumnId}`;
}

/**
 * One Move item ('backward' is left): enabled with the step's `before` target
 * when the gesture would succeed now, else disabled with the reason it would
 * give. The `Alt+Shift+←`/`→` shortcuts ask the same question.
 */
export function column_move_item_model(
    input: Pick<ColumnStructureMenuInput, 'support' | 'ready' | 'selection' | 'changes' | 'context' | 'columns'>,
    direction: 'backward' | 'forward',
): ColumnMoveItemModel {
    const { selection, changes, context } = input;
    const count = selection.count;
    const disabled = (reason: string): ColumnMoveItemModel => Object.freeze({ count, enabled: false, reason });
    const reason = column_move_block_refusal(input);
    if (reason !== undefined) return disabled(reason);
    const index = index_column_layout(column_layout_for(changes, context));
    const before = column_step_target(input.columns, index, selection.identities, direction);
    if (before === undefined) return disabled(direction === 'backward' ? MOVE_AT_LEFT_MESSAGE : MOVE_AT_RIGHT_MESSAGE);
    const probe = plan_column_move(changes, context, selection.identities, before);
    if (!probe.ok) return disabled(probe.message);
    return Object.freeze({ count, enabled: true, before });
}

/** Whether an insert's anchor is still a live column: checked when the host's reply arrives. */
export function column_insert_anchor_is_live(
    changes: PendingStructuralChanges,
    context: Pick<WorksheetStructureContext, 'sourceColumnCount'>,
    anchor: ColumnIdentity,
): boolean {
    return index_column_layout(column_layout_for(changes, context)).is_live(anchor);
}

/** The creation order for an insert's first column, past every Pending Column's. */
export function column_insert_created_order(changes: PendingStructuralChanges, clock: number): number {
    let highest = -1;
    for (const column of changes.pendingColumns ?? []) highest = Math.max(highest, column.createdOrder);
    for (const column of changes.columnLayout?.discardedPendingColumns ?? []) {
        highest = Math.max(highest, column.createdOrder);
    }
    return Math.max(clock, highest + 1);
}

/**
 * Default names for `count` new columns: "New column", "New column 2", and so
 * on, skipping any name already among `taken` (the prospective column names),
 * compared as the rename dialog compares them.
 */
export function default_pending_column_names(taken: Iterable<string>, count: number): string[] {
    const used = new Set<string>();
    for (const name of taken) used.add(normalized_column_name(name).toLowerCase());
    const names: string[] = [];
    for (let ordinal = 1; names.length < count; ordinal++) {
        const name = ordinal === 1 ? DEFAULT_PENDING_COLUMN_NAME : `${DEFAULT_PENDING_COLUMN_NAME} ${ordinal}`;
        const normalized = name.toLowerCase();
        if (used.has(normalized)) continue;
        used.add(normalized);
        names.push(name);
    }
    return names;
}

/**
 * The format a new column copies, resolved once at insertion ("Formatting
 * inheritance"): CSV and TSV have none. In `.xlsx` it is the live column to
 * the left in the prospective layout, or to the right when the new column is
 * first: a source column's own formatting, or a Pending Column's format, so
 * inheritance ends at a source column or the default.
 */
export function pending_column_format(
    changes: PendingStructuralChanges,
    context: Pick<WorksheetStructureContext, 'sourceColumnCount'>,
    anchor: ColumnIdentity,
    side: 'before' | 'after',
    delimited: boolean,
): PendingColumnFormat {
    if (delimited) return { kind: 'none' };
    const index = index_column_layout(column_layout_for(changes, context));
    const body = index.body_index_of(anchor);
    if (body === undefined) return { kind: 'default' };
    const neighbor = side === 'after'
        ? anchor
        : body > 1 ? index.identity_at_body_index(body - 1)! : anchor;
    if (neighbor.kind === 'source') return { kind: 'source', sourceColumn: neighbor.sourceColumn };
    const pending = changes.pendingColumns?.find((column) => column.id === neighbor.pendingColumnId);
    return pending?.format.kind === 'source' || pending?.format.kind === 'default'
        ? pending.format
        : { kind: 'default' };
}

/** One gesture, planned: what the stores commit and the history records. */
export interface ColumnStructurePlan {
    readonly ok: true;
    readonly label: string;
    readonly outcome: StructureOutcome;
    /** Source cell edits (`row:column` keys) the gesture discards. */
    readonly discardedCellKeys: readonly string[];
    /** The one history action's changes: the layout arm, then any `cell` deltas. */
    readonly changes: readonly HistoryChange[];
}

export type ColumnStructurePlanResult =
    | ColumnStructurePlan
    | { readonly ok: false; readonly message: string; readonly unchanged?: true };

function refusal_message(result: { readonly ok: boolean; readonly message?: string }): string | undefined {
    return result.ok ? undefined : result.message;
}

/** Insert host-admitted Pending Columns beside `anchor`: "Insert column" or "Insert N columns". */
export function plan_column_insert(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    anchor: ColumnIdentity,
    side: 'before' | 'after',
    columns: readonly PendingColumn[],
): ColumnStructurePlanResult {
    const result = insert_columns(changes, context, anchor, side, columns);
    if (!result.ok) return { ok: false, message: result.refusal.message };
    return Object.freeze({
        ok: true,
        label: column_structure_label('Insert', columns.length),
        outcome: result.outcome,
        discardedCellKeys: Object.freeze([]),
        changes: Object.freeze([result.outcome.change]),
    });
}

/**
 * Delete columns: the store turns live source columns into Pending Column
 * Removals and discards Pending Columns; this adds the discard of every source
 * cell edit in a removed column, from `cells`, as `cell` deltas.
 */
export function plan_column_delete(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    identities: readonly ColumnIdentity[],
    cells: ReadonlyMap<string, HistoryDirtyEntry>,
): ColumnStructurePlanResult {
    const result = delete_columns(changes, context, identities);
    if (!result.ok) return { ok: false, message: result.refusal.message };
    const { outcome } = result;
    const removed = source_cells_removed_by(outcome, cells.keys());
    const entries = new Map(removed.map(({ key }) => [key, cells.get(key)!]));
    const cell_changes = [...discard_history_source([{ target: context.worksheet, entries }])];
    return Object.freeze({
        ok: true,
        label: column_structure_label(
            'Delete',
            outcome.removedSourceColumns.length + outcome.discardedColumns.length,
        ),
        outcome,
        discardedCellKeys: Object.freeze(removed.map(({ key }) => key)),
        changes: Object.freeze([outcome.change, ...cell_changes]),
    });
}

/** Restore Pending Column Removals; every listed source column must be one. */
export function plan_column_restore(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    source_columns: readonly number[],
): ColumnStructurePlanResult {
    const result = restore_columns(changes, context, source_columns);
    if (!result.ok) return { ok: false, message: result.refusal.message };
    return Object.freeze({
        ok: true,
        label: column_structure_label('Restore', new Set(source_columns).size),
        outcome: result.outcome,
        discardedCellKeys: Object.freeze([]),
        changes: Object.freeze([result.outcome.change]),
    });
}

/** A planned move, with what the live region announces. */
export interface ColumnMovePlan extends ColumnStructurePlan {
    readonly movedColumns: number;
    readonly direction: 'left' | 'right';
    /** The live identities the gesture moves, in layout order: focus follows them. */
    readonly movedIdentities: readonly ColumnIdentity[];
}

export type ColumnMovePlanResult =
    | ColumnMovePlan
    | { readonly ok: false; readonly message: string; readonly unchanged?: true };

/**
 * Move the live columns of `identities`, each with its glued tombstones, to
 * just before `before` ('end' is the end of the layout): one history action,
 * "Move column" or "Move N columns". A move that would change nothing is
 * refused with `unchanged`.
 */
export function plan_column_move(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    identities: readonly ColumnIdentity[],
    before: ColumnIdentity | 'end',
): ColumnMovePlanResult {
    const result = move_columns(changes, context, identities, before);
    if (!result.ok) {
        return result.refusal.reason === 'unchanged'
            ? { ok: false, message: result.refusal.message, unchanged: true }
            : { ok: false, message: result.refusal.message };
    }
    const index = index_column_layout(column_layout_for(changes, context));
    const live = identities
        .filter((identity) => index.is_live(identity))
        .sort((left, right) => index.position_of(left)! - index.position_of(right)!);
    const first = live.length === 0 ? Infinity : index.position_of(live[0]!)!;
    const direction = before === 'end' || (index.position_of(before) ?? Infinity) > first ? 'right' : 'left';
    return Object.freeze({
        ok: true,
        label: column_structure_label('Move', live.length),
        outcome: result.outcome,
        discardedCellKeys: Object.freeze([]),
        changes: Object.freeze([result.outcome.change]),
        movedColumns: live.length,
        direction,
        movedIdentities: Object.freeze(live),
    });
}

/**
 * The layout target for a drag that drops before display column `before`
 * (`columns.length` for the end): the identity displayed there, which may be
 * a tombstone (`move_columns` then lands after its live neighbor's glued
 * tombstones), or 'end'.
 */
export function resolve_column_move_drop(
    columns: readonly ProjectedColumn[],
    before: number,
): ColumnIdentity | 'end' | undefined {
    if (!Number.isInteger(before) || before < 0) return undefined;
    if (before >= columns.length) return 'end';
    return columns[before]!.identity;
}

/** The display columns a moved block occupies once shown, or undefined until every one is. */
export function moved_block_display_columns(
    columns: readonly ProjectedColumn[],
    moved: readonly ColumnIdentity[],
): { readonly start: number; readonly end: number } | undefined {
    let start = Infinity;
    let end = -Infinity;
    for (const identity of moved) {
        const display = columns.findIndex((column) => column_identities_equal(column.identity, identity));
        if (display < 0) return undefined;
        start = Math.min(start, display);
        end = Math.max(end, display);
    }
    if (end < 0) return undefined;
    while (end + 1 < columns.length && columns[end + 1]!.state === 'removed') end += 1;
    return { start, end };
}

/**
 * Where focus goes after a column Delete: the first displayed column at or
 * after `from` that is not removed, else the nearest one before it.
 */
export function nearest_live_column(
    columns: readonly ProjectedColumn[],
    from: number,
): number | undefined {
    const start = Math.max(0, Math.min(from, columns.length - 1));
    for (let display = start; display < columns.length; display++) {
        if (columns[display]!.state !== 'removed') return display;
    }
    for (let display = start - 1; display >= 0; display--) {
        if (columns[display]!.state !== 'removed') return display;
    }
    return undefined;
}

/** One Pending Column cell a gesture writes; `cell` undefined clears it. */
export interface PendingColumnCellEdit {
    readonly pendingColumnId: string;
    /** `s:<sourceRow>`, `p:<pendingRowId>`, or `f:<row>`. */
    readonly rowKey: string;
    readonly cell: PendingRowCell | undefined;
}

/**
 * Write Pending Column cells as one `columnLayout` arm with an unchanged
 * layout: one transition per column the gesture changed. Undefined when no
 * edit names a live Pending Column or nothing changes.
 */
export function plan_pending_column_cells(
    changes: PendingStructuralChanges,
    worksheet: WorksheetStructureContext['worksheet'],
    edits: readonly PendingColumnCellEdit[],
): { readonly next: PendingStructuralChanges; readonly change: LayoutHistoryChange } | undefined {
    const columns = [...(changes.pendingColumns ?? [])];
    const index_of = new Map(columns.map((column, index) => [column.id, index]));
    const before_by_id = new Map<string, PendingColumn>();
    // Each column's cell map is copied once per batch, not once per edit: a
    // large paste into one column stays linear.
    const cells_by_index = new Map<number, Record<string, PendingRowCell>>();
    for (const edit of edits) {
        const index = index_of.get(edit.pendingColumnId);
        if (index === undefined) continue;
        const column = columns[index]!;
        if (!before_by_id.has(column.id)) before_by_id.set(column.id, column);
        let cells = cells_by_index.get(index);
        if (cells === undefined) {
            cells = { ...column.cells };
            cells_by_index.set(index, cells);
        }
        if (edit.cell === undefined) delete cells[edit.rowKey];
        else cells[edit.rowKey] = edit.cell;
    }
    for (const [index, cells] of cells_by_index) {
        columns[index] = { ...columns[index]!, cells };
    }
    const transitions = [...before_by_id].flatMap(([id, before]) => {
        const after = columns[index_of.get(id)!]!;
        return JSON.stringify(after) === JSON.stringify(before) ? [] : [{ id, before, after }];
    });
    if (transitions.length === 0) return undefined;
    const layout = changes.columnLayout ?? null;
    return {
        next: { ...changes, pendingColumns: columns },
        change: {
            kind: 'columnLayout',
            delta: {
                worksheet,
                before: layout,
                after: layout,
                pendingRows: [],
                pendingColumns: transitions,
                formatTemplates: [],
            },
        },
    };
}

/**
 * Set Pending Column widths, view state stored without a history entry (as a
 * resize stores them): a number sets `viewerWidth`, `undefined` clears it.
 * Columns no longer pending are skipped. Undefined when nothing changes.
 */
export function with_pending_column_widths(
    changes: PendingStructuralChanges,
    widths: Readonly<Record<string, number | undefined>>,
): PendingStructuralChanges | undefined {
    let changed = false;
    const columns = (changes.pendingColumns ?? []).map((column) => {
        if (!Object.prototype.hasOwnProperty.call(widths, column.id)) return column;
        const width = widths[column.id];
        if (column.viewerWidth === width) return column;
        changed = true;
        const { viewerWidth: _previous, ...rest } = column;
        return width === undefined ? rest : { ...rest, viewerWidth: width };
    });
    return changed ? { ...changes, pendingColumns: columns } : undefined;
}

/**
 * The `columnLayout` arm for Pending Columns whose content changed between two
 * snapshots with the same column layout, such as cells an admission seeded.
 * Undefined when no Pending Column changed.
 */
export function pending_column_cells_change(
    worksheet: WorksheetStructureContext['worksheet'],
    before: PendingStructuralChanges,
    after: PendingStructuralChanges,
): LayoutHistoryChange | undefined {
    const prior = new Map((before.pendingColumns ?? []).map((column) => [column.id, column]));
    const transitions = (after.pendingColumns ?? []).flatMap((column) => {
        const was = prior.get(column.id);
        return was === undefined || JSON.stringify(was) === JSON.stringify(column)
            ? []
            : [{ id: column.id, before: was, after: column }];
    });
    if (transitions.length === 0) return undefined;
    const layout = after.columnLayout ?? null;
    return {
        kind: 'columnLayout',
        delta: {
            worksheet,
            before: layout,
            after: layout,
            pendingRows: [],
            pendingColumns: transitions,
            formatTemplates: [],
        },
    };
}

/** A Pending Column cell's highlight a gesture sets; `color` undefined clears it. */
export interface PendingColumnHighlightEdit {
    readonly pendingColumnId: string;
    /** `s:<sourceRow>`, `p:<pendingRowId>`, or `f:<row>`. */
    readonly rowKey: string;
    readonly color: CellHighlightColor | undefined;
}

/**
 * Set or clear highlights on Pending Column cells as one `columnLayout` arm
 * with an unchanged layout, like `plan_pending_column_cells`. Undefined when
 * no edit names a live Pending Column or nothing changes.
 */
export function plan_pending_column_highlights(
    changes: PendingStructuralChanges,
    worksheet: WorksheetStructureContext['worksheet'],
    edits: readonly PendingColumnHighlightEdit[],
): { readonly next: PendingStructuralChanges; readonly change: LayoutHistoryChange } | undefined {
    const columns = [...(changes.pendingColumns ?? [])];
    const index_of = new Map(columns.map((column, index) => [column.id, index]));
    const highlights_by_index = new Map<number, Record<string, CellHighlightColor>>();
    for (const edit of edits) {
        const index = index_of.get(edit.pendingColumnId);
        if (index === undefined) continue;
        let highlights = highlights_by_index.get(index);
        if (highlights === undefined) {
            highlights = { ...(columns[index]!.highlights ?? {}) };
            highlights_by_index.set(index, highlights);
        }
        if (edit.color === undefined) delete highlights[edit.rowKey];
        else highlights[edit.rowKey] = edit.color;
    }
    const transitions: { id: string; before: PendingColumn; after: PendingColumn }[] = [];
    for (const [index, highlights] of highlights_by_index) {
        const before = columns[index]!;
        const { highlights: _previous, ...rest } = before;
        const after: PendingColumn = Object.keys(highlights).length === 0 ? rest : { ...rest, highlights };
        if (JSON.stringify(after.highlights ?? {}) === JSON.stringify(before.highlights ?? {})) continue;
        columns[index] = after;
        transitions.push({ id: before.id, before, after });
    }
    if (transitions.length === 0) return undefined;
    const layout = changes.columnLayout ?? null;
    return {
        next: { ...changes, pendingColumns: columns },
        change: {
            kind: 'columnLayout',
            delta: {
                worksheet,
                before: layout,
                after: layout,
                pendingRows: [],
                pendingColumns: transitions,
                formatTemplates: [],
            },
        },
    };
}

/**
 * Change one live Pending Column (its header, cells, or width) as a
 * `columnLayout` arm whose layout is unchanged: Undo puts the column back as
 * it was. Undefined when the column is not live.
 */
export function plan_pending_column_update(
    changes: PendingStructuralChanges,
    worksheet: WorksheetStructureContext['worksheet'],
    id: string,
    update: (column: PendingColumn) => PendingColumn,
): { readonly next: PendingStructuralChanges; readonly change: LayoutHistoryChange } | undefined {
    const columns = changes.pendingColumns ?? [];
    const index = columns.findIndex((column) => column.id === id);
    if (index < 0) return undefined;
    const before = columns[index]!;
    const after = update(before);
    if (JSON.stringify(after) === JSON.stringify(before)) return undefined;
    const next_columns = [...columns];
    next_columns[index] = after;
    const layout = changes.columnLayout ?? null;
    return {
        next: { ...changes, pendingColumns: next_columns },
        change: {
            kind: 'columnLayout',
            delta: {
                worksheet,
                before: layout,
                after: layout,
                pendingRows: [],
                pendingColumns: [{ id, before, after }],
                formatTemplates: [],
            },
        },
    };
}

/**
 * The names a Pending Column's rename is checked against: every displayed
 * live column's name, in display order, and the names of source columns
 * removed this session, which it may not take.
 */
export function pending_column_rename_names(
    columns: readonly ProjectedColumn[],
    name_of: (column: ProjectedColumn) => string,
): { readonly live: readonly { readonly key: string; readonly name: string }[]; readonly removed: readonly string[] } {
    const live: { key: string; name: string }[] = [];
    const removed: string[] = [];
    for (const column of columns) {
        const name = name_of(column);
        if (column.state === 'removed') {
            if (name !== '') removed.push(name);
        } else {
            live.push({ key: column.key, name });
        }
    }
    return { live, removed };
}

/** The rename dialog's extra rule for a Pending Column: no deleted column's name. */
export function removed_column_name_refusal(
    value: string,
    removed_names: readonly string[],
): string | undefined {
    const normalized = normalized_column_name(value);
    const match = removed_names.find((name) => normalized_column_name(name) === normalized);
    return match === undefined ? undefined : removed_column_name_message(match);
}
