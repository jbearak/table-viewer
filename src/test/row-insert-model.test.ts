// Row insert in the webview model (row and column structure design, delivery
// step 6): the Insert items of the row-gutter menu and their gating, planning
// one history action per gesture with undo and redo, the anchor check a host
// reply meets, the projection of inserted rows, and "Keep new rows at the end"
// with its undo.
import { describe, expect, it } from 'vitest';
import {
    is_inserted_row,
    own_pending_structural_changes,
    pending_rows,
    type PendingAppendedRow,
    type PendingStructuralChanges,
    type RowIdentity,
} from '../pending-changes';
import type { WorksheetTarget } from '../types';
import { create_history_store } from '../webview/history-store';
import { peek_history } from '../webview/history-stack-model';
import { history_menu_projection } from '../webview/history-menu-projection';
import { plan_pending_row_history_replay } from '../webview/pending-row-history';
import { create_pending_row_projection } from '../webview/pending-row-projection';
import {
    APPENDED_BAND_MESSAGE,
    keep_inserted_rows_at_end,
    STRUCTURE_CELL_MOVE_MESSAGE,
    STRUCTURE_TAIL_REMOVAL_MESSAGE,
    STRUCTURE_TRANSFORMED_MESSAGE,
    TOO_MANY_PENDING_ROWS_MESSAGE,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    has_inserted_rows,
    INSERT_ABOVE_HEADER_MESSAGE,
    INSERT_ONLY_REMOVED_ROWS_MESSAGE,
    insert_anchor_is_live,
    insert_created_order,
    plan_row_delete,
    plan_row_insert,
    resolve_row_structure_selection,
    row_insert_label,
    row_structure_menu_model,
    ROWS_NOT_LOADED_MESSAGE,
    SELECT_ADJACENT_ROWS_MESSAGE,
    STRUCTURE_BUSY_MESSAGE,
    type RowStructurePlanResult,
    type RowStructureSelection,
} from '../webview/row-structure-model';
import { row_context_menu_items } from '../webview/row-context-menu';
import type { ActionMenuItem } from '../webview/context-menu';

const worksheet: WorksheetTarget = { sheetIndex: 0, sheetName: 'data' };
const template = { id: 'plain', format: { kind: 'none' as const } };
const EMPTY: PendingStructuralChanges = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };
const BASIS = { kind: 'delimited' as const, byteLength: 40, digest: 'abc', sourceRowCount: 10, sourceColumnCount: 2 };
const APPEND_BASIS = { sourceRowCount: 10, columnCount: 2, schemaFingerprint: 'sha256:x' };
const supported = { supported: true as const };

function context(overrides: Partial<WorksheetStructureContext> = {}): WorksheetStructureContext {
    return {
        worksheet,
        bodyStart: 0,
        sourceRowCount: 10,
        sourceColumnCount: 2,
        bodyViewTransformed: false,
        structuralBasis: BASIS,
        ...overrides,
    };
}

function source(sourceRow: number): RowIdentity {
    return { kind: 'source', sourceRow };
}

function pending(pendingRowId: string): RowIdentity {
    return { kind: 'pending', pendingRowId };
}

function planned(result: RowStructurePlanResult) {
    if (!result.ok) throw new Error(result.message);
    return result;
}

function insert(
    changes: PendingStructuralChanges,
    anchor: RowIdentity,
    side: 'before' | 'after',
    ids: readonly string[],
    first_order = 100,
    ctx = context(),
) {
    return planned(plan_row_insert(changes, ctx, anchor, side, ids, template, first_order, APPEND_BASIS));
}

function appended(id: string, createdOrder: number): PendingAppendedRow {
    return { id, cells: {}, formatTemplateId: 'plain', createdOrder };
}

function selection(overrides: Partial<RowStructureSelection>): RowStructureSelection {
    return {
        count: 1,
        identities: [source(2)],
        removedSourceRows: [],
        fixedRows: false,
        tailRemovals: false,
        contiguous: true,
        bandRows: 0,
        endsAtBandEnd: false,
        ...overrides,
    };
}

function menu(
    changes: PendingStructuralChanges,
    overrides: Partial<RowStructureSelection>,
    options: { ready?: boolean; ctx?: WorksheetStructureContext; appendRefusal?: string } = {},
) {
    return row_structure_menu_model({
        support: supported,
        ready: options.ready ?? true,
        selection: selection(overrides),
        changes,
        context: options.ctx ?? context(),
        ...(options.appendRefusal === undefined ? {} : { appendRefusal: options.appendRefusal }),
    });
}

describe('planning an insert', () => {
    it('inserts blank Pending Inserted Rows before or after the anchor as one action', () => {
        const above = insert(EMPTY, source(2), 'before', ['a', 'b']);
        expect(above.label).toBe('Insert 2 rows');
        expect(above.changes.map((change) => change.kind)).toEqual(['rowLayout']);
        expect(above.outcome.next.rowLayout?.runs).toEqual([
            { kind: 'source', start: 0, count: 2 },
            { kind: 'pending', ids: ['a', 'b'] },
            { kind: 'source', start: 2, count: 8 },
        ]);
        expect(pending_rows(above.outcome.next).map((row) => [row.id, row.origin, row.createdOrder, row.cells]))
            .toEqual([['a', 'insert', 100, {}], ['b', 'insert', 101, {}]]);
        // The first live change records the basis; the first insert, the append basis.
        expect(above.outcome.next.structuralBasis).toEqual(BASIS);
        expect(above.outcome.next.appendBasis).toEqual(APPEND_BASIS);

        const below = insert(EMPTY, source(9), 'after', ['z']);
        expect(below.label).toBe('Insert row');
        expect(below.outcome.next.rowLayout?.runs).toEqual([
            { kind: 'source', start: 0, count: 10 },
            { kind: 'pending', ids: ['z'] },
        ]);
    });

    it('anchors on an inserted row too, and lands after a deleted row’s glued tombstone', () => {
        const first = insert(EMPTY, source(2), 'after', ['a']).outcome.next;
        const second = insert(first, pending('a'), 'after', ['b'], 200).outcome.next;
        expect(second.rowLayout?.runs).toEqual([
            { kind: 'source', start: 0, count: 3 },
            { kind: 'pending', ids: ['a', 'b'] },
            { kind: 'source', start: 3, count: 7 },
        ]);
        // Row 3 deleted: it glues to row 2, so Insert below row 2 lands after it.
        const deleted = planned(plan_row_delete(EMPTY, context(), [source(3)], new Map())).outcome.next;
        const after = insert(deleted, source(2), 'after', ['c']).outcome.next;
        expect(after.rowLayout?.runs).toEqual([
            { kind: 'source', start: 0, count: 4 },
            { kind: 'pending', ids: ['c'] },
            { kind: 'source', start: 4, count: 6 },
        ]);
    });

    it('undoes and redoes the insert, and its label reaches the Edit menu', () => {
        const plan = insert(EMPTY, source(4), 'before', ['a', 'b', 'c']);
        const history = create_history_store();
        const record = history.stage_record({ label: plan.label, changes: plan.changes });
        record.commit();
        record.notify();
        expect(history_menu_projection(history.snapshot(), false).undoLabel).toBe('Insert 3 rows');
        const peek = peek_history(history.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error('nothing recorded');
        const undo = plan_pending_row_history_replay(peek.entry.action, 'undo', () => plan.outcome.next);
        if (undo.kind !== 'plan') throw new Error(undo.kind);
        expect(undo.plans[0].next).toEqual(own_pending_structural_changes(EMPTY));
        const redo = plan_pending_row_history_replay(peek.entry.action, 'redo', () => undo.plans[0].next);
        if (redo.kind !== 'plan') throw new Error(redo.kind);
        expect(redo.plans[0].next).toEqual(plan.outcome.next);
    });

    it('refuses with the store’s exclusivity and transform reasons', () => {
        const moved = plan_row_insert(EMPTY, context({ hasPendingCellMove: () => true }), source(1), 'after', ['a'], template, 1);
        expect(moved).toEqual({ ok: false, message: STRUCTURE_CELL_MOVE_MESSAGE });
        const transformed = plan_row_insert(EMPTY, context({ bodyViewTransformed: true }), source(1), 'after', ['a'], template, 1);
        expect(transformed).toEqual({ ok: false, message: STRUCTURE_TRANSFORMED_MESSAGE });
    });

    it('picks a creation order past every Pending Row and tombstone', () => {
        const start = insert(EMPTY, source(1), 'after', ['a', 'b'], 500).outcome.next;
        expect(insert_created_order(start, 10)).toBe(502);
        expect(insert_created_order(start, 9_000)).toBe(9_000);
        const deleted = planned(plan_row_delete(start, context({ isRowReferenced: () => true }), [pending('b')], new Map()))
            .outcome.next;
        expect(insert_created_order(deleted, 10)).toBe(502);
    });
});

describe('the anchor check a host reply meets', () => {
    it('installs only while the anchor is a live row', () => {
        expect(insert_anchor_is_live(EMPTY, context(), source(3))).toBe(true);
        expect(insert_anchor_is_live(EMPTY, context(), source(10))).toBe(false);
        const deleted = planned(plan_row_delete(EMPTY, context(), [source(3)], new Map())).outcome.next;
        expect(insert_anchor_is_live(deleted, context(), source(3))).toBe(false);
        const inserted = insert(EMPTY, source(1), 'after', ['a']).outcome.next;
        expect(insert_anchor_is_live(inserted, context(), pending('a'))).toBe(true);
        const gone = planned(plan_row_delete(inserted, context(), [pending('a')], new Map())).outcome.next;
        expect(insert_anchor_is_live(gone, context(), pending('a'))).toBe(false);
    });
});

describe('the Insert items', () => {
    it('offers Insert above and below for contiguous body rows, anchored on the selection’s ends', () => {
        const model = menu(EMPTY, { count: 3, identities: [source(2), source(3), source(4)] });
        expect(model.insertAbove).toEqual({ count: 3, enabled: true, action: 'insert', anchor: source(2) });
        expect(model.insertBelow).toEqual({ count: 3, enabled: true, action: 'insert', anchor: source(4) });
    });

    it('disables both with the spec’s reasons', () => {
        const reason = (overrides: Partial<RowStructureSelection>, options = {}) =>
            menu(EMPTY, overrides, options).insertAbove.reason;
        expect(reason({ contiguous: false, count: 2, identities: [source(1), source(5)] }))
            .toBe(SELECT_ADJACENT_ROWS_MESSAGE);
        expect(reason({}, { ctx: context({ bodyViewTransformed: true }) })).toBe(STRUCTURE_TRANSFORMED_MESSAGE);
        expect(reason({ fixedRows: true })).toBe(INSERT_ABOVE_HEADER_MESSAGE);
        expect(reason({ tailRemovals: true })).toBe(STRUCTURE_TAIL_REMOVAL_MESSAGE);
        expect(reason({ identities: undefined })).toBe(ROWS_NOT_LOADED_MESSAGE);
        expect(reason({}, { ready: false })).toBe(STRUCTURE_BUSY_MESSAGE);
        expect(reason({}, { ctx: context({ hasPendingCellMove: () => true }) })).toBe(STRUCTURE_CELL_MOVE_MESSAGE);
        expect(row_structure_menu_model({
            support: { supported: false, reason: 'Not available yet' },
            ready: true,
            selection: selection({}),
            changes: EMPTY,
            context: context(),
        }).insertBelow.reason).toBe('Not available yet');
        // A selection of only deleted rows has nothing live to anchor on.
        const deleted = planned(plan_row_delete(EMPTY, context(), [source(2)], new Map())).outcome.next;
        expect(menu(deleted, { removedSourceRows: [2] }).insertBelow.reason).toBe(INSERT_ONLY_REMOVED_ROWS_MESSAGE);
    });

    it('keeps the append band at the end: Insert below its last row appends', () => {
        const band = { ...EMPTY, formatTemplates: [template], appendedRows: [appended('x', 1), appended('y', 2)] };
        const last = { identities: [pending('y')], bandRows: 1, endsAtBandEnd: true };
        expect(menu(band, last).insertBelow).toEqual({ count: 1, enabled: true, action: 'append' });
        expect(menu(band, last).insertAbove.reason).toBe(APPENDED_BAND_MESSAGE);
        expect(menu(band, last, { appendRefusal: 'full' }).insertBelow)
            .toEqual({ count: 1, enabled: false, reason: 'full', action: 'append' });
        // Not the band's last row, or a selection spanning body and band.
        expect(menu(band, { identities: [pending('x')], bandRows: 1 }).insertBelow.reason)
            .toBe(APPENDED_BAND_MESSAGE);
        expect(menu(band, {
            count: 2,
            identities: [source(9), pending('x')],
            bandRows: 1,
        }).insertBelow.reason).toBe(APPENDED_BAND_MESSAGE);
    });

    it('refuses an over-limit selection before building any probe IDs', () => {
        // Larger than any array can be: allocating one probe ID per row would throw.
        const huge = 2 ** 32;
        const model = menu(EMPTY, { count: huge, identities: [source(2), source(3)] });
        expect(model.insertAbove).toEqual({
            count: huge,
            enabled: false,
            reason: TOO_MANY_PENDING_ROWS_MESSAGE,
            action: 'insert',
        });
        expect(model.insertBelow.reason).toBe(TOO_MANY_PENDING_ROWS_MESSAGE);
    });

    it('labels the items "Insert row above" and "Insert N rows below", with their reasons', () => {
        expect(row_insert_label('above', 1)).toBe('Insert row above');
        expect(row_insert_label('below', 3)).toBe('Insert 3 rows below');
        const items = row_context_menu_items({
            selected_row_count: 2,
            can_hide_rows: false,
            can_promote_row_to_header: false,
            on_hide_rows: () => {},
            on_promote_row_to_header: () => {},
            on_copy_rows: () => {},
            insert_rows_above: { count: 2, on_click: () => {} },
            insert_rows_below: { count: 2, disabled_reason: SELECT_ADJACENT_ROWS_MESSAGE },
            delete_rows: { count: 2, on_click: () => {} },
        }) as ActionMenuItem[];
        expect(items.map((item) => item.label)).toEqual([
            'Insert 2 rows above', 'Insert 2 rows below', 'Delete 2 rows', 'Copy 2 rows',
        ]);
        expect(items[1]).toMatchObject({ disabled: true, disabled_reason: SELECT_ADJACENT_ROWS_MESSAGE });
        expect(items[0]?.disabled).toBeUndefined();
    });
});

describe('resolving a selection for Insert', () => {
    it('reports contiguity and band membership in display order', () => {
        const changes = insert(
            { ...EMPTY, formatTemplates: [template], appendedRows: [appended('x', 1)] },
            source(1),
            'after',
            ['a'],
        ).outcome.next;
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 10,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: 10,
            changes,
            bodyViewTransformed: false,
        });
        const resolve = (rows: { start: number; end: number }[]) =>
            resolve_row_structure_selection(projection, rows, { bodyStart: 0, isRemoved: () => false });
        // Display: rows 0-1, inserted a, rows 2-9, then band row x at 11.
        expect(resolve([{ start: 1, end: 2 }])).toMatchObject({
            identities: [source(1), pending('a')],
            contiguous: true,
            bandRows: 0,
        });
        expect(resolve([{ start: 1, end: 1 }, { start: 3, end: 3 }]).contiguous).toBe(false);
        expect(resolve([{ start: 0, end: 0 }, { start: 1, end: 1 }]).contiguous).toBe(true);
        expect(resolve([{ start: 11, end: 11 }])).toMatchObject({ bandRows: 1, endsAtBandEnd: true });
        expect(resolve([{ start: 10, end: 11 }])).toMatchObject({ count: 2, bandRows: 1, endsAtBandEnd: true });
    });
});

describe('projecting inserted rows', () => {
    it('shows them inline in layout mode, tinted inserted, with prospective row numbers', () => {
        const changes = insert(EMPTY, source(3), 'before', ['a', 'b']).outcome.next;
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 10,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: 10,
            changes,
            bodyViewTransformed: false,
        });
        expect(projection.layoutMode).toBe(true);
        expect(projection.rowCount).toBe(12);
        expect([2, 3, 4, 5].map((row) => projection.row_state(row)))
            .toEqual(['source', 'inserted', 'inserted', 'source']);
        const row = projection.row_at(4);
        expect(row?.kind === 'pending' && is_inserted_row(row.row)).toBe(true);
        // What the gutter shows and the accessibility label names: "Row 5, inserted".
        expect(row?.kind === 'pending' ? row.intendedPhysicalRow + 1 : undefined).toBe(5);
        expect(projection.prospective_row(5)).toBe(5);
        expect(projection.display_row_for_identity(pending('a'))).toBe(3);
        expect(has_inserted_rows(changes)).toBe(true);
        expect(has_inserted_rows(EMPTY)).toBe(false);
    });

    it('lists the inline inserted rows in a display range, which the band scans miss', () => {
        let changes = insert(EMPTY, source(3), 'before', ['a', 'b']).outcome.next;
        changes = insert(changes, source(7), 'after', ['c'], 200).outcome.next;
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 10,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: 10,
            changes,
            bodyViewTransformed: false,
        });
        // Display: rows 0-2, a (3), b (4), rows 3-7 (5-9), c (10), rows 8-9.
        expect(projection.deletedBandStart).toBe(13);
        expect(projection.inline_pending_display_rows(0, 12)).toEqual([3, 4, 10]);
        expect(projection.inline_pending_display_rows(4, 9)).toEqual([4]);
        expect(projection.inline_pending_display_rows(11, 12)).toEqual([]);
        // The band mode (a transformed view) has none.
        const band = create_pending_row_projection({
            sourceDisplayRowCount: 10,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: 10,
            changes: EMPTY,
            bodyViewTransformed: true,
        });
        expect(band.inline_pending_display_rows(0, 9)).toEqual([]);
    });
});

describe('Keep new rows at the end', () => {
    function conflicted(changes: PendingStructuralChanges): PendingStructuralChanges {
        return own_pending_structural_changes({
            ...changes,
            conflicts: [{ reason: 'structuralBasisChanged', pendingRowIds: [], tailRemovalIds: [] }],
        });
    }

    it('turns inserted rows into appends in layout order after the band, dropping the rest of the layout', () => {
        const band = { ...EMPTY, formatTemplates: [template], appendedRows: [appended('x', 50)], appendBasis: APPEND_BASIS };
        let changes = insert(band, source(6), 'after', ['late'], 100).outcome.next;
        changes = insert(changes, source(1), 'before', ['early'], 200).outcome.next;
        changes = own_pending_structural_changes({
            ...changes,
            appendedRows: pending_rows(changes).map((row) => row.id === 'late'
                ? { ...row, cells: { 0: { value: 'typed', valueEditOrder: 300 } } }
                : row),
        });
        changes = planned(plan_row_delete(changes, context(), [source(4)], new Map())).outcome.next;
        const result = keep_inserted_rows_at_end(conflicted(changes), context());
        if (!result.ok) throw new Error(result.refusal.message);
        const next = result.outcome.next;
        expect(next.rowLayout).toBeUndefined();
        expect(next.structuralBasis).toBeUndefined();
        expect(next.appendBasis).toEqual(APPEND_BASIS);
        expect(next.conflicts).toEqual([]);
        // `early` sits above `late` in the layout, so it comes first.
        expect(pending_rows(next).map((row) => [row.id, row.origin ?? 'append', row.createdOrder])).toEqual([
            ['x', 'append', 50],
            ['early', 'append', 201],
            ['late', 'append', 202],
        ]);
        expect(pending_rows(next).find((row) => row.id === 'late')?.cells)
            .toEqual({ 0: { value: 'typed', valueEditOrder: 300 } });
        expect(next.appendedRows.every((row) => !is_inserted_row(row))).toBe(true);
    });

    it('takes a clock floor for the fresh orders', () => {
        const changes = insert(EMPTY, source(1), 'after', ['a'], 5).outcome.next;
        const result = keep_inserted_rows_at_end(changes, context(), 1_000);
        if (!result.ok) throw new Error(result.refusal.message);
        expect(pending_rows(result.outcome.next)[0]?.createdOrder).toBe(1_000);
    });

    it('is one history action whose undo restores origins, orders, and positions', () => {
        const before = conflicted(insert(EMPTY, source(2), 'after', ['a', 'b'], 10).outcome.next);
        const result = keep_inserted_rows_at_end(before, context(), 99);
        if (!result.ok) throw new Error(result.refusal.message);
        expect(result.outcome.change.kind).toBe('rowLayout');
        const action = { label: 'Keep new rows at the end', changes: [result.outcome.change] };
        const undo = plan_pending_row_history_replay(action as never, 'undo', () => result.outcome.next);
        if (undo.kind !== 'plan') throw new Error(undo.kind);
        const restored = undo.plans[0].next;
        expect(restored.rowLayout).toEqual(before.rowLayout);
        expect(restored.structuralBasis).toEqual(BASIS);
        expect(pending_rows(restored).map((row) => [row.id, row.origin, row.createdOrder]))
            .toEqual([['a', 'insert', 10], ['b', 'insert', 11]]);
        const redo = plan_pending_row_history_replay(action as never, 'redo', () => restored);
        if (redo.kind !== 'plan') throw new Error(redo.kind);
        expect(pending_rows(redo.plans[0].next).map((row) => [row.id, row.origin ?? 'append', row.createdOrder]))
            .toEqual([['a', 'append', 99], ['b', 'append', 100]]);
    });
});
