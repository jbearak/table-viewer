// Columns in the webview model (row and column structure design, delivery
// step 8): resolving a header selection, the structure items of the column
// menus and every reason they are disabled, Move past one displayed column
// (skipping hidden ones), planning one history action per gesture with undo
// and redo through the `columnLayout` arm, Pending Column cells, rename, and
// width, the drop target of a drag, default names, the column projection the
// grid shows, and "Discard row and column changes" with column changes.
import { describe, expect, it } from 'vitest';
import {
    own_pending_structural_changes,
    type PendingColumn,
    type PendingStructuralChanges,
} from '../pending-changes';
import type { WorksheetTarget } from '../types';
import { create_history_store } from '../webview/history-store';
import { peek_history, type HistoryChange } from '../webview/history-stack-model';
import { history_menu_projection } from '../webview/history-menu-projection';
import { plan_pending_row_history_replay } from '../webview/pending-row-history';
import {
    discard_layout_changes,
    keep_inserted_rows_at_end,
    LAST_LIVE_COLUMN_MESSAGE,
    STRUCTURE_TAIL_REMOVAL_MESSAGE,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import { STRUCTURE_BUSY_MESSAGE } from '../webview/row-structure-model';
import {
    column_insert_anchor_is_live,
    column_insert_created_order,
    column_insert_label,
    column_move_announcement,
    column_move_block_refusal,
    column_step_target,
    column_structure_label,
    column_structure_menu_model,
    default_pending_column_names,
    INSERT_ONLY_REMOVED_COLUMNS_MESSAGE,
    MOVE_AT_LEFT_MESSAGE,
    MOVE_AT_RIGHT_MESSAGE,
    MOVE_ONLY_REMOVED_COLUMNS_MESSAGE,
    moved_block_display_columns,
    nearest_live_column,
    pending_column_format,
    pending_column_rename_names,
    plan_column_delete,
    plan_column_insert,
    plan_column_move,
    plan_column_restore,
    plan_pending_column_cells,
    plan_pending_column_update,
    removed_column_name_refusal,
    resolve_column_move_drop,
    resolve_column_structure_selection,
    RESTORE_ONLY_REMOVED_COLUMNS_MESSAGE,
    SELECT_ADJACENT_COLUMNS_MESSAGE,
    type ColumnMovePlanResult,
    type ColumnStructurePlanResult,
} from '../webview/column-structure-model';
import {
    create_column_projection,
    create_layout_column_projection,
    with_column_layout,
    type ProjectedColumn,
} from '../webview/column-projection';
import { build_layout_grid_columns } from '../webview/grid-model';
import { column_context_menu_items, multi_column_context_menu_items } from '../webview/column-context-menu';
import { column_rename_error } from '../webview/rename-column-dialog';
import type { ActionMenuItem } from '../webview/context-menu';
import {
    index_column_layout,
    source_column_layout,
    TOO_WIDE_TO_RESTRUCTURE_MESSAGE,
    type ColumnIdentity,
    type ColumnLayout,
} from '../worksheet-layout';

const worksheet: WorksheetTarget = { sheetIndex: 0, sheetName: 'data' };
const EMPTY: PendingStructuralChanges = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };
const BASIS = { kind: 'delimited' as const, byteLength: 40, digest: 'abc', sourceRowCount: 4, sourceColumnCount: 4 };
const supported = { supported: true as const };

function context(overrides: Partial<WorksheetStructureContext> = {}): WorksheetStructureContext {
    return {
        worksheet,
        bodyStart: 0,
        sourceRowCount: 4,
        sourceColumnCount: 4,
        bodyViewTransformed: false,
        structuralBasis: BASIS,
        ...overrides,
    };
}

const src = (sourceColumn: number): ColumnIdentity => ({ kind: 'source', sourceColumn });
const pend = (pendingColumnId: string): ColumnIdentity => ({ kind: 'pending', pendingColumnId });

function new_column(id: string, order: number, header = ''): PendingColumn {
    return { id, header, cells: {}, format: { kind: 'none' }, createdOrder: order };
}

function planned<T extends ColumnStructurePlanResult | ColumnMovePlanResult>(result: T): Extract<T, { ok: true }> {
    if (!result.ok) throw new Error(result.message);
    return result as Extract<T, { ok: true }>;
}

function columns_of(changes: PendingStructuralChanges, hidden: readonly number[] = []): readonly ProjectedColumn[] {
    return create_layout_column_projection(
        4,
        changes.columnLayout,
        hidden.length === 0 ? undefined : { hiddenColumns: hidden },
    ).columns;
}

function round_trip(before: PendingStructuralChanges, after: PendingStructuralChanges, label: string, changes: readonly HistoryChange[]) {
    const history = create_history_store();
    const record = history.stage_record({ label, changes });
    record.commit();
    record.notify();
    expect(history_menu_projection(history.snapshot(), false).undoLabel).toBe(label);
    const peek = peek_history(history.snapshot(), 'undo');
    if (peek.kind !== 'available') throw new Error(peek.kind);
    const undo = plan_pending_row_history_replay(peek.entry.action, 'undo', () => after);
    if (undo.kind !== 'plan') throw new Error(undo.kind);
    expect(undo.plans[0]!.next).toEqual(own_pending_structural_changes(before));
    const redo = plan_pending_row_history_replay(peek.entry.action, 'redo', () => undo.plans[0]!.next);
    if (redo.kind !== 'plan') throw new Error(redo.kind);
    expect(redo.plans[0]!.next).toEqual(own_pending_structural_changes(after));
}

function inserted(): PendingStructuralChanges {
    return planned(plan_column_insert(EMPTY, context(), src(1), 'after', [new_column('p1', 10, 'New column')])).outcome.next;
}

describe('labels and announcements', () => {
    it('names counts as the history and menus do', () => {
        expect(column_structure_label('Insert', 1)).toBe('Insert column');
        expect(column_structure_label('Delete', 3)).toBe('Delete 3 columns');
        expect(column_insert_label('left', 1)).toBe('Insert column left');
        expect(column_insert_label('right', 2)).toBe('Insert 2 columns right');
        expect(column_move_announcement(1, 'left')).toBe('Moved 1 column left');
        expect(column_move_announcement(3, 'right')).toBe('Moved 3 columns right');
    });
});

describe('header selections', () => {
    it('resolves identities, removals, and contiguity in display order', () => {
        const removed = planned(plan_column_delete(EMPTY, context(), [src(2)], new Map())).outcome.next;
        const columns = columns_of(removed);
        const selection = resolve_column_structure_selection(columns, [3, 1, 2, 99]);
        expect(selection.count).toBe(3);
        expect(selection.identities).toEqual([src(1), src(2), src(3)]);
        expect(selection.removedSourceColumns).toEqual([2]);
        expect(selection.contiguous).toBe(true);
        expect(resolve_column_structure_selection(columns, [0, 2]).contiguous).toBe(false);
    });
});

describe('the column menus', () => {
    const menu = (changes: PendingStructuralChanges, display: readonly number[], overrides: {
        ready?: boolean;
        support?: { supported: false; reason: string };
        ctx?: WorksheetStructureContext;
        hidden?: readonly number[];
    } = {}) => {
        const columns = columns_of(changes, overrides.hidden);
        return column_structure_menu_model({
            support: overrides.support ?? supported,
            ready: overrides.ready ?? true,
            selection: resolve_column_structure_selection(columns, display),
            changes,
            context: overrides.ctx ?? context(),
            columns,
        });
    };

    it('offers Insert on both sides, Delete, and Move for a live column', () => {
        const model = menu(EMPTY, [1]);
        expect(model.insertLeft).toMatchObject({ enabled: true, anchor: src(1) });
        expect(model.insertRight).toMatchObject({ enabled: true, anchor: src(1) });
        expect(model.delete.enabled).toBe(true);
        expect(model.restore).toBeUndefined();
        expect(model.moveLeft).toMatchObject({ enabled: true, before: src(0) });
        expect(model.moveRight).toMatchObject({ enabled: true, before: src(3) });
    });

    it('disables every item with the shared reasons', () => {
        const busy = menu(EMPTY, [1], { ready: false });
        for (const item of [busy.insertLeft, busy.insertRight, busy.delete, busy.moveLeft, busy.moveRight]) {
            expect(item.reason).toBe(STRUCTURE_BUSY_MESSAGE);
        }
        const wide = menu(EMPTY, [1], { support: { supported: false, reason: TOO_WIDE_TO_RESTRUCTURE_MESSAGE } });
        expect(wide.delete.reason).toBe(TOO_WIDE_TO_RESTRUCTURE_MESSAGE);
        expect(wide.insertLeft.reason).toBe(TOO_WIDE_TO_RESTRUCTURE_MESSAGE);
        const tail = own_pending_structural_changes({
            ...EMPTY,
            tailRemovals: [{ appendHistoryId: 'h', sourceRow: 3, savedFingerprint: 'f', savedRow: {
                cells: {}, format: { kind: 'none' },
            } }],
        });
        expect(menu(tail, [1]).insertLeft.reason).toBe(STRUCTURE_TAIL_REMOVAL_MESSAGE);
        expect(menu(tail, [1]).moveRight.reason).toBe(STRUCTURE_TAIL_REMOVAL_MESSAGE);
    });

    it('needs adjacent columns for Insert and Move, but deletes any selection', () => {
        const model = menu(EMPTY, [0, 2]);
        expect(model.insertLeft.reason).toBe(SELECT_ADJACENT_COLUMNS_MESSAGE);
        expect(model.moveRight.reason).toBe(SELECT_ADJACENT_COLUMNS_MESSAGE);
        expect(model.delete.enabled).toBe(true);
    });

    it('keeps one live column', () => {
        expect(menu(EMPTY, [0, 1, 2, 3]).delete.reason).toBe(LAST_LIVE_COLUMN_MESSAGE);
    });

    it('offers Restore for removals only, and anchors nothing on a removal alone', () => {
        const removed = planned(plan_column_delete(EMPTY, context(), [src(2)], new Map())).outcome.next;
        const only = menu(removed, [2]);
        expect(only.restore).toMatchObject({ enabled: true, count: 1 });
        expect(only.insertLeft.reason).toBe(INSERT_ONLY_REMOVED_COLUMNS_MESSAGE);
        expect(only.moveLeft.reason).toBe(MOVE_ONLY_REMOVED_COLUMNS_MESSAGE);
        const mixed = menu(removed, [1, 2]);
        expect(mixed.restore?.reason).toBe(RESTORE_ONLY_REMOVED_COLUMNS_MESSAGE);
    });

    it('stops Move at the edges', () => {
        expect(menu(EMPTY, [0]).moveLeft.reason).toBe(MOVE_AT_LEFT_MESSAGE);
        expect(menu(EMPTY, [3]).moveRight.reason).toBe(MOVE_AT_RIGHT_MESSAGE);
        expect(menu(EMPTY, [2]).moveRight).toMatchObject({ enabled: true, before: 'end' });
    });

    it('steps past one displayed column, leaving hidden columns where they are', () => {
        // Column 1 is hidden: moving 2 left passes 0, not the hidden column.
        const model = menu(EMPTY, [1], { hidden: [1] });
        expect(model.moveLeft).toMatchObject({ enabled: true, before: src(0) });
        const plan = planned(plan_column_move(EMPTY, context(), [src(2)], src(0)));
        expect(plan.outcome.next.columnLayout?.columns).toEqual([src(2), src(0), src(1), src(3)]);
        // Moving 0 right past displayed column 2 (hidden 1 between) lands before 3.
        expect(column_step_target(columns_of(EMPTY, [1]), index_column_layout(source_column_layout(4)), [src(0)], 'forward'))
            .toEqual(src(3));
    });

    it('builds menu items that show disabled reasons', () => {
        const items = column_context_menu_items({
            column_name: 'Price',
            transform_sections: false,
            transform_disabled: false,
            active_direction: null,
            any_sorted: false,
            other_columns_sorted: false,
            has_filter: false,
            any_filtered: false,
            on_copy: () => {},
            on_hide: () => {},
            hide_disabled_reason: 'Save the new column to hide it.',
            structure: {
                insert_left: { count: 1, on_click: () => {} },
                insert_right: { count: 2, on_click: () => {} },
                delete: { count: 1, disabled_reason: LAST_LIVE_COLUMN_MESSAGE },
                restore: { count: 1, on_click: () => {} },
                move_left: { count: 1, disabled_reason: MOVE_AT_LEFT_MESSAGE },
                move_right: { count: 1, on_click: () => {} },
            },
            on_sort: () => {},
            on_clear_column_sort: () => {},
            on_clear_all_sorts: () => {},
            on_edit_filter: () => {},
            on_clear_column_filter: () => {},
            on_clear_all_filters: () => {},
        }).filter((item): item is ActionMenuItem => !('kind' in item));
        expect(items.map((item) => item.label)).toEqual([
            'Copy column',
            'Hide column',
            'Insert column left',
            'Insert 2 columns right',
            'Delete column',
            'Restore column',
            'Move columns left',
            'Move columns right',
        ]);
        expect(items[1]).toMatchObject({ disabled: true, disabled_reason: 'Save the new column to hide it.' });
        expect(items[4]).toMatchObject({ disabled: true, disabled_reason: LAST_LIVE_COLUMN_MESSAGE });
        const multi = multi_column_context_menu_items({
            column_count: 3,
            transform_sections: false,
            transform_disabled: false,
            on_copy: () => {},
            on_hide: () => {},
            structure: {
                insert_left: { count: 3, on_click: () => {} },
                insert_right: { count: 3, on_click: () => {} },
                delete: { count: 3, on_click: () => {} },
                move_left: { count: 3, on_click: () => {} },
                move_right: { count: 3, on_click: () => {} },
            },
            on_sort: () => {},
        }).filter((item): item is ActionMenuItem => !('kind' in item));
        expect(multi.map((item) => item.label)).toContain('Insert 3 columns left');
        expect(multi.map((item) => item.label)).toContain('Delete 3 columns');
    });
});

describe('planning column gestures', () => {
    it('inserts Pending Columns beside the anchor: one undoable action', () => {
        const plan = planned(plan_column_insert(EMPTY, context(), src(1), 'after', [
            new_column('p1', 10, 'New column'),
            new_column('p2', 11, 'New column 2'),
        ]));
        expect(plan.label).toBe('Insert 2 columns');
        expect(plan.changes[0]!.kind).toBe('columnLayout');
        expect(plan.outcome.next.columnLayout?.columns).toEqual([src(0), src(1), pend('p1'), pend('p2'), src(2), src(3)]);
        expect(plan.outcome.next.structuralBasis).toEqual(BASIS);
        round_trip(EMPTY, plan.outcome.next, plan.label, plan.changes);
    });

    it('deletes a column with its cell edits and Pending Row cells, and undo restores both', () => {
        const with_row = planned(plan_column_insert(EMPTY, context(), src(0), 'before', [new_column('p1', 3)]));
        const before = with_row.outcome.next;
        const cells = new Map([
            ['1:2', { value: 'x', base: 'old' }],
            ['1:1', { value: 'kept', base: 'old' }],
        ]);
        const plan = planned(plan_column_delete(before, context(), [src(2), pend('p1')], cells as never));
        expect(plan.label).toBe('Delete 2 columns');
        expect(plan.discardedCellKeys).toEqual(['1:2']);
        expect(plan.changes.map((change) => change.kind)).toEqual(['columnLayout', 'cell']);
        expect(plan.outcome.next.columnLayout?.removedSourceColumns).toEqual([2]);
        expect(plan.outcome.next.pendingColumns ?? []).toEqual([]);
        expect(plan.outcome.discardedColumns.map((column) => column.id)).toEqual(['p1']);
    });

    it('restores a removal in place', () => {
        const removed = planned(plan_column_delete(EMPTY, context(), [src(2)], new Map())).outcome.next;
        const plan = planned(plan_column_restore(removed, context(), [2]));
        expect(plan.label).toBe('Restore column');
        expect(plan.outcome.next.columnLayout).toBeUndefined();
        round_trip(removed, plan.outcome.next, plan.label, plan.changes);
    });

    it('moves a block, reports its direction, and refuses a move that changes nothing', () => {
        const plan = planned(plan_column_move(EMPTY, context(), [src(0), src(1)], 'end'));
        expect(plan).toMatchObject({ label: 'Move 2 columns', direction: 'right', movedColumns: 2 });
        expect(plan.movedIdentities).toEqual([src(0), src(1)]);
        expect(plan.outcome.next.columnLayout?.columns).toEqual([src(2), src(3), src(0), src(1)]);
        round_trip(EMPTY, plan.outcome.next, plan.label, plan.changes);
        expect(planned(plan_column_move(EMPTY, context(), [src(3)], src(0))).direction).toBe('left');
        expect(plan_column_move(EMPTY, context(), [src(1)], src(2))).toMatchObject({ ok: false, unchanged: true });
    });

    it('checks the anchor and orders new columns past every existing one', () => {
        const next = inserted();
        expect(column_insert_anchor_is_live(next, context(), pend('p1'))).toBe(true);
        const removed = planned(plan_column_delete(next, context(), [pend('p1')], new Map())).outcome.next;
        expect(column_insert_anchor_is_live(removed, context(), pend('p1'))).toBe(false);
        expect(column_insert_created_order(next, 0)).toBe(11);
        expect(column_insert_created_order(next, 50)).toBe(50);
    });
});

describe('Pending Column content', () => {
    it('writes cells by row identity as a column arm Undo reverses', () => {
        const before = inserted();
        const plan = plan_pending_column_cells(before, worksheet, [
            { pendingColumnId: 'p1', rowKey: 's:0', cell: { value: 'Spain' } },
            { pendingColumnId: 'p1', rowKey: 's:1', cell: { value: 'second' } },
            { pendingColumnId: 'missing', rowKey: 's:0', cell: { value: 'ignored' } },
        ])!;
        expect(plan.next.pendingColumns?.[0]?.cells).toEqual({ 's:0': { value: 'Spain' }, 's:1': { value: 'second' } });
        expect(plan.change.kind).toBe('columnLayout');
        round_trip(before, own_pending_structural_changes(plan.next), 'Edit cell', [plan.change]);
        const cleared = plan_pending_column_cells(plan.next, worksheet, [
            { pendingColumnId: 'p1', rowKey: 's:0', cell: undefined },
        ])!;
        expect(cleared.next.pendingColumns?.[0]?.cells).toEqual({ 's:1': { value: 'second' } });
        expect(plan_pending_column_cells(before, worksheet, [
            { pendingColumnId: 'p1', rowKey: 's:0', cell: undefined },
        ])).toBeUndefined();
    });

    it('renames a Pending Column as one action', () => {
        const before = inserted();
        const plan = plan_pending_column_update(before, worksheet, 'p1', (column) => ({ ...column, header: 'origin' }))!;
        expect(plan.next.pendingColumns?.[0]?.header).toBe('origin');
        round_trip(before, own_pending_structural_changes(plan.next), 'Rename column', [plan.change]);
        expect(plan_pending_column_update(before, worksheet, 'p1', (column) => column)).toBeUndefined();
    });

    it('names new columns uniquely among the prospective names', () => {
        expect(default_pending_column_names(['name', 'qty'], 2)).toEqual(['New column', 'New column 2']);
        expect(default_pending_column_names(['new column', 'New column 3'], 3))
            .toEqual(['New column 2', 'New column 4', 'New column 5']);
    });

    it('refuses a deleted column\'s name in the rename dialog', () => {
        const removed = planned(plan_column_delete(inserted(), context(), [src(2)], new Map())).outcome.next;
        const columns = columns_of(removed);
        const names = pending_column_rename_names(columns, (column) =>
            column.identity.kind === 'source' ? ['name', 'unit', 'Price', 'qty'][column.identity.sourceColumn]! : 'New column');
        expect(names.removed).toEqual(['Price']);
        expect(names.live.map((entry) => entry.name)).toEqual(['name', 'unit', 'New column', 'qty']);
        const message = 'A deleted column on this sheet is named Price. Restore it or choose another name.';
        expect(removed_column_name_refusal('Prices', names.removed)).toBeUndefined();
        expect(removed_column_name_refusal(' Price ', names.removed)).toBe(message);
        const self = names.live.findIndex((entry) => entry.key === 'p:p1');
        expect(column_rename_error('Price', names.live.map((entry) => entry.name), self, names.removed)).toBe(message);
        expect(column_rename_error('qty', names.live.map((entry) => entry.name), self, names.removed))
            .toBe('Another column already has that name.');
        expect(column_rename_error('origin', names.live.map((entry) => entry.name), self, names.removed)).toBeUndefined();
    });

    it('inherits formatting from the live column beside it in .xlsx only', () => {
        expect(pending_column_format(EMPTY, context(), src(1), 'after', true)).toEqual({ kind: 'none' });
        expect(pending_column_format(EMPTY, context(), src(1), 'after', false)).toEqual({ kind: 'source', sourceColumn: 1 });
        expect(pending_column_format(EMPTY, context(), src(1), 'before', false)).toEqual({ kind: 'source', sourceColumn: 0 });
        expect(pending_column_format(EMPTY, context(), src(0), 'before', false)).toEqual({ kind: 'source', sourceColumn: 0 });
        const with_pending = planned(plan_column_insert(EMPTY, context(), src(1), 'after', [
            { ...new_column('p1', 1), format: { kind: 'source', sourceColumn: 1 } },
        ])).outcome.next;
        expect(pending_column_format(with_pending, context(), pend('p1'), 'after', false))
            .toEqual({ kind: 'source', sourceColumn: 1 });
    });
});

describe('dragging columns', () => {
    it('resolves a drop to the column displayed there, or the end', () => {
        const columns = columns_of(EMPTY);
        expect(resolve_column_move_drop(columns, 0)).toEqual(src(0));
        expect(resolve_column_move_drop(columns, 4)).toBe('end');
        expect(resolve_column_move_drop(columns, -1)).toBeUndefined();
    });

    it('arms only for a contiguous selection with a live column', () => {
        const removed = planned(plan_column_delete(EMPTY, context(), [src(2)], new Map())).outcome.next;
        const block = (display: readonly number[], changes = EMPTY) => column_move_block_refusal({
            support: supported,
            ready: true,
            selection: resolve_column_structure_selection(columns_of(changes), display),
            changes,
            context: context(),
        });
        expect(block([1, 2])).toBeUndefined();
        expect(block([0, 2])).toBe(SELECT_ADJACENT_COLUMNS_MESSAGE);
        expect(block([2], removed)).toBe(MOVE_ONLY_REMOVED_COLUMNS_MESSAGE);
    });

    it('finds the moved block and the nearest live column after a delete', () => {
        const removed = planned(plan_column_delete(EMPTY, context(), [src(1)], new Map())).outcome.next;
        const moved = planned(plan_column_move(removed, context(), [src(0)], 'end')).outcome.next;
        // The removal of column 1 is glued to column 0 and travels with it.
        expect(columns_of(moved).map((column) => column.key)).toEqual(['s:2', 's:3', 's:0', 's:1']);
        expect(moved_block_display_columns(columns_of(moved), [src(0)])).toEqual({ start: 2, end: 3 });
        expect(moved_block_display_columns(columns_of(EMPTY), [src(1), src(2)])).toEqual({ start: 1, end: 2 });
        expect(moved_block_display_columns(columns_of(removed), [src(0)])).toEqual({ start: 0, end: 1 });
        expect(nearest_live_column(columns_of(removed), 1)).toBe(2);
        const last = planned(plan_column_delete(EMPTY, context(), [src(3)], new Map())).outcome.next;
        expect(nearest_live_column(columns_of(last), 3)).toBe(2);
    });
});

describe('the column projection', () => {
    it('keys display columns by identity, with states, hidden columns skipped', () => {
        const with_pending = inserted();
        const removed = planned(plan_column_delete(with_pending, context(), [src(3)], new Map())).outcome.next;
        const moved = planned(plan_column_move(removed, context(), [src(0)], 'end')).outcome.next;
        const projection = with_column_layout(create_column_projection(4, { hiddenColumns: [2] }), 4, moved.columnLayout);
        expect(projection.columns.map((column) => `${column.key}:${column.state}`)).toEqual([
            's:1:source', 'p:p1:inserted', 's:3:removed', 's:0:moved',
        ]);
        expect(projection.visible_to_source).toEqual([1, undefined, 3, 0]);
        expect(projection.source_to_visible[0]).toBe(3);
        expect(projection.source_to_visible[2]).toBeUndefined();
        expect(projection.hidden_count).toBe(1);
        expect(projection.display_column_for_key('p:p1')).toBe(1);
    });

    it('keeps the base projection\'s order without a layout', () => {
        const base = { visible_to_source: [2, 0], source_to_visible: [1, undefined, 0], hidden_count: 1 };
        const projection = with_column_layout(base, 3, undefined);
        expect(projection.columns.map((column) => column.key)).toEqual(['s:2', 's:0']);
        expect(projection.visible_to_source).toEqual([2, 0]);
    });

    it('builds Glide columns keyed by identity with prospective titles', () => {
        const removed = planned(plan_column_delete(inserted(), context(), [src(0)], new Map())).outcome.next;
        const layout = removed.columnLayout as ColumnLayout;
        const projection = create_layout_column_projection(4, layout);
        const index = index_column_layout(layout);
        const built = build_layout_grid_columns(
            projection.columns,
            { 1: 200 },
            ['', 'unit', '', ''],
            new Map([['p1', { header: '', viewerWidth: 90 }]]),
            (column) => {
                const body = index.body_index_of(column.identity);
                return body === undefined ? undefined : body - 1;
            },
        );
        expect(built.map((column) => [column.id, column.title, column.width])).toEqual([
            ['s:0', 'A', 120],
            ['s:1', 'unit', 200],
            ['p:p1', 'B', 90],
            ['s:2', 'C', 120],
            ['s:3', 'D', 120],
        ]);
    });
});

describe('Discard row and column changes, and Keep new rows at the end, with column changes', () => {
    it('discards only column changes as one column arm', () => {
        const before = own_pending_structural_changes({
            ...inserted(),
            conflicts: [{ reason: 'structuralBasisChanged', pendingRowIds: [], tailRemovalIds: [] }],
        });
        const result = discard_layout_changes(before, context());
        if (!result.ok) throw new Error(result.refusal.message);
        const { next, change, additionalChanges } = result.outcome;
        expect(change.kind).toBe('columnLayout');
        expect(additionalChanges).toBeUndefined();
        expect(next.columnLayout).toBeUndefined();
        expect(next.pendingColumns).toBeUndefined();
        expect(next.structuralBasis).toBeUndefined();
        expect(next.conflicts).toEqual([]);
    });

    it('discards row and column changes as two arms Undo reverses together', () => {
        const columns = inserted();
        const rows = own_pending_structural_changes({
            ...columns,
            rowLayout: { runs: [{ kind: 'source', start: 2, count: 2 }, { kind: 'source', start: 0, count: 2 }], removedSourceRows: [], discardedPendingRows: [] },
        });
        const result = discard_layout_changes(rows, context());
        if (!result.ok) throw new Error(result.refusal.message);
        const changes = [result.outcome.change, ...(result.outcome.additionalChanges ?? [])];
        expect(changes.map((change) => change.kind)).toEqual(['rowLayout', 'columnLayout']);
        expect(result.outcome.next.rowLayout).toBeUndefined();
        expect(result.outcome.next.columnLayout).toBeUndefined();
        expect(result.outcome.next.structuralBasis).toBeUndefined();
        round_trip(rows, result.outcome.next, 'Discard row and column changes on data', changes);
    });

    it('keeps new rows at the end while dropping Pending Columns', () => {
        const columns = inserted();
        const result = keep_inserted_rows_at_end(columns, context());
        if (!result.ok) throw new Error(result.refusal.message);
        expect(result.outcome.next.pendingColumns).toBeUndefined();
        expect(result.outcome.discardedColumns.map((column) => column.id)).toEqual(['p1']);
    });
});
