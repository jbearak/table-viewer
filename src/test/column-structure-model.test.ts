// Columns in the webview model (row and column structure design, delivery
// step 8): resolving a header selection (the menus' structure items and their
// reasons are in structure-menu.test.ts), Move past one displayed column
// (skipping hidden ones), planning one history action per gesture with undo
// and redo through the `columnLayout` arm, Pending Column cells, rename, and
// width, the drop target of a drag, default names, the column projection the
// grid shows, and "Discard row and column changes" with column changes.
import { describe, expect, it } from 'vitest';
import {
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    own_pending_structural_changes,
    pending_structure_error,
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
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    column_insert_anchor_is_live,
    column_insert_created_order,
    column_move_announcement,
    column_move_block_refusal,
    column_step_target,
    column_structure_label,
    default_pending_column_names,
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
    SELECT_ADJACENT_COLUMNS_MESSAGE,
    type ColumnMovePlanResult,
    type ColumnStructurePlanResult,
    with_pending_column_widths,
} from '../webview/column-structure-model';
import {
    create_column_projection,
    create_layout_column_projection,
    with_column_layout,
    type ProjectedColumn,
} from '../webview/column-projection';
import { build_layout_grid_columns } from '../webview/grid-model';
import { column_rename_error } from '../webview/rename-column-dialog';
import {
    index_column_layout,
    source_column_layout,
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

describe('a column Move step', () => {
    it('passes one displayed column, leaving hidden columns where they are', () => {
        const plan = planned(plan_column_move(EMPTY, context(), [src(2)], src(0)));
        expect(plan.outcome.next.columnLayout?.columns).toEqual([src(2), src(0), src(1), src(3)]);
        // Moving 0 right past displayed column 2 (hidden 1 between) lands before 3.
        expect(column_step_target(columns_of(EMPTY, [1]), index_column_layout(source_column_layout(4)), [src(0)], 'forward'))
            .toEqual(src(3));
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

describe('Pending Columns beside a tail removal', () => {
    it('cannot coexist with one, so no Pending Column cell sits on a replacement row', () => {
        expect(pending_structure_error({
            ...inserted(),
            tailRemovals: [{
                appendHistoryId: 'saved',
                sourceRow: 3,
                savedFingerprint: 'f',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }],
        }, undefined, { bodyStart: 0, sourceRowCount: 4, sourceColumnCount: 4 }))
            .toBe('A worksheet with row or column changes cannot also undo a saved append.');
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
        // One copy per column per batch, and never the input's own map.
        expect(before.pendingColumns?.[0]?.cells).toEqual({});
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

    it('treats a Pending Column\'s width as view state: content Undo and Redo keep the current width', () => {
        const before = inserted();
        const plan = plan_pending_column_cells(before, worksheet, [
            { pendingColumnId: 'p1', rowKey: 's:0', cell: { value: 'Spain' } },
        ])!;
        const history = create_history_store();
        const record = history.stage_record({ label: 'Edit cell', changes: [plan.change] });
        record.commit();
        record.notify();
        const peek = peek_history(history.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error(peek.kind);
        // The column was resized after the edit, without a history entry.
        const resized = own_pending_structural_changes({
            ...plan.next,
            pendingColumns: [{ ...plan.next.pendingColumns![0]!, viewerWidth: 240 }],
        });
        const undo = plan_pending_row_history_replay(peek.entry.action, 'undo', () => resized);
        if (undo.kind !== 'plan') throw new Error(undo.kind);
        expect(undo.plans[0]!.next.pendingColumns?.[0]).toMatchObject({ cells: {}, viewerWidth: 240 });
        const redo = plan_pending_row_history_replay(peek.entry.action, 'redo', () => undo.plans[0]!.next);
        if (redo.kind !== 'plan') throw new Error(redo.kind);
        expect(redo.plans[0]!.next.pendingColumns?.[0]).toMatchObject({ cells: { 's:0': { value: 'Spain' } }, viewerWidth: 240 });
    });

    it('ignores a Pending Column\'s width in a metadata arm\'s snapshots', () => {
        const before = own_pending_structural_changes({
            ...inserted(),
            conflicts: [{ reason: 'savedSuffixChanged', pendingRowIds: [], tailRemovalIds: [] }],
        });
        const after = own_pending_structural_changes({ ...before, conflicts: [] });
        const change: HistoryChange = { kind: 'pendingRows', delta: { worksheet, before, after } };
        const resized = (changes: PendingStructuralChanges) => own_pending_structural_changes({
            ...changes,
            pendingColumns: [{ ...changes.pendingColumns![0]!, viewerWidth: 240 }],
        });
        const action = { label: 'Edit cell', changes: [change] } as const;
        const undo = plan_pending_row_history_replay(action as never, 'undo', () => resized(after));
        if (undo.kind !== 'plan') throw new Error(undo.kind);
        expect(undo.plans[0]!.next.conflicts).toHaveLength(1);
        expect(undo.plans[0]!.next.pendingColumns?.[0]?.viewerWidth).toBe(240);
    });

    it('brings a Pending Column back at the width it had, when Undo restores it', () => {
        const before = own_pending_structural_changes({
            ...inserted(),
            pendingColumns: [{ ...inserted().pendingColumns![0]!, viewerWidth: 240 }],
        });
        const after = own_pending_structural_changes({ ...EMPTY });
        const change: HistoryChange = { kind: 'pendingRows', delta: { worksheet, before, after } };
        const undo = plan_pending_row_history_replay({ label: 'Discard', changes: [change] } as never, 'undo', () => after);
        if (undo.kind !== 'plan') throw new Error(undo.kind);
        expect(undo.plans[0]!.next.pendingColumns?.[0]?.viewerWidth).toBe(240);
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

    it('discards inserted rows that hold Pending Column cells, and Undo brings the cells back', () => {
        const columns = inserted();
        const rows = own_pending_structural_changes({
            ...columns,
            formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
            appendedRows: [{ id: 'ins', origin: 'insert', cells: { 0: { value: 'row' } }, formatTemplateId: 'plain', createdOrder: 1 }],
            rowLayout: {
                runs: [{ kind: 'source', start: 0, count: 1 }, { kind: 'pending', ids: ['ins'] }, { kind: 'source', start: 1, count: 3 }],
                removedSourceRows: [],
                discardedPendingRows: [],
            },
            pendingColumns: [{ ...columns.pendingColumns![0]!, cells: { 'p:ins': { value: 'typed' }, 's:0': { value: 'kept' } } }],
        });
        const result = discard_layout_changes(rows, context());
        if (!result.ok) throw new Error(result.refusal.message);
        const changes = [result.outcome.change, ...(result.outcome.additionalChanges ?? [])];
        expect(changes.map((change) => change.kind)).toEqual(['rowLayout', 'columnLayout']);
        expect(result.outcome.next.appendedRows).toEqual([]);
        expect(result.outcome.next.pendingColumns).toBeUndefined();
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

describe('with_pending_column_widths', () => {
    const column = (id: string, viewerWidth?: number) => ({
        id,
        header: id,
        cells: {},
        format: { kind: 'none' as const },
        createdOrder: 1,
        ...(viewerWidth === undefined ? {} : { viewerWidth }),
    });
    const changes = {
        ...EMPTY_PENDING_STRUCTURAL_CHANGES,
        pendingColumns: [column('a', 90), column('b')],
    };

    it('sets and clears widths by ID, skipping columns no longer pending', () => {
        const next = with_pending_column_widths(changes, { a: undefined, b: 140, gone: 10 });
        expect(next?.pendingColumns).toEqual([column('a'), column('b', 140)]);
    });

    it('is undefined when nothing changes', () => {
        expect(with_pending_column_widths(changes, { a: 90, b: undefined })).toBeUndefined();
    });
});
