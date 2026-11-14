// Row insert in the webview model (row and column structure design, delivery
// step 6): planning one history action per gesture with undo and redo (the
// Insert items and their gating are in structure-menu.test.ts), the anchor check a host
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
    keep_inserted_rows_at_end,
    STRUCTURE_CELL_MOVE_MESSAGE,
    STRUCTURE_TRANSFORMED_MESSAGE,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    has_inserted_or_moved_rows,
    insert_anchor_is_live,
    insert_created_order,
    plan_row_delete,
    plan_row_insert,
    resolve_row_structure_selection,
    type RowStructurePlanResult,
} from '../webview/row-structure-model';

const worksheet: WorksheetTarget = { sheetIndex: 0, sheetName: 'data' };
const template = { id: 'plain', format: { kind: 'none' as const } };
const EMPTY: PendingStructuralChanges = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };
const BASIS = { kind: 'delimited' as const, byteLength: 40, digest: 'abc', sourceRowCount: 10, sourceColumnCount: 2 };
const APPEND_BASIS = { sourceRowCount: 10, columnCount: 2, schemaFingerprint: 'sha256:x' };

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
        expect(has_inserted_or_moved_rows(changes)).toBe(true);
        expect(has_inserted_or_moved_rows(EMPTY)).toBe(false);
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

    it('reads an inline inserted row’s payload from the live store', () => {
        const changes = insert(EMPTY, source(3), 'before', ['a']).outcome.next;
        let live = pending_rows(changes)[0]!;
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 10,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: 10,
            changes,
            bodyViewTransformed: false,
            pendingRowById: (id) => id === 'a' ? live : undefined,
        });
        live = { ...live, viewerRowHeight: 50, highlights: { 0: 'pink' } };
        const row = projection.row_at(3);
        expect(row?.kind === 'pending' ? row.row : undefined).toBe(live);
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
