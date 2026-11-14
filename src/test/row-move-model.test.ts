// Row move in the webview model (row and column structure design, delivery
// step 7): one step past a live row and its glued tombstones (the Move items
// and their reasons are in structure-menu.test.ts), planning one
// history action per gesture with undo and redo, resolving a drag's drop row,
// the block focus follows, the announcement, and the moved tint and labels.
import { describe, expect, it } from 'vitest';
import {
    has_inserted_or_moved_rows,
    own_pending_structural_changes,
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
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    moved_block_display_rows,
    MOVE_ABOVE_HEADER_MESSAGE,
    MOVE_FIXED_ROWS_MESSAGE,
    plan_row_delete,
    plan_row_insert,
    plan_row_move,
    resolve_row_move_drop,
    row_move_announcement,
    row_move_block_refusal,
    row_move_item_model,
    ROWS_NOT_LOADED_MESSAGE,
    type RowMovePlanResult,
    type RowStructurePlanResult,
    type RowStructureSelection,
    row_structure_selection,
} from '../webview/row-structure-model';

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

function planned<T extends RowStructurePlanResult | RowMovePlanResult>(result: T): Extract<T, { ok: true }> {
    if (!result.ok) throw new Error(result.message);
    return result as Extract<T, { ok: true }>;
}

function deleted(changes: PendingStructuralChanges, rows: number[], ctx = context()): PendingStructuralChanges {
    return planned(plan_row_delete(changes, ctx, rows.map(source), new Map())).outcome.next;
}

function appended(id: string, createdOrder: number): PendingAppendedRow {
    return { id, cells: {}, formatTemplateId: 'plain', createdOrder };
}

function selection(overrides: Partial<RowStructureSelection>): RowStructureSelection {
    return row_structure_selection({
        count: 1,
        identities: [source(2)],
        removedSourceRows: [],
        fixedRows: false,
        tailRemovals: false,
        contiguous: true,
        bandRows: 0,
        endsAtBandEnd: false,
        ...overrides,
    } as Parameters<typeof row_structure_selection>[0]);
}

/** The step each Move item, and the `Alt+Shift+↑`/`↓` shortcuts, would take. */
function steps(changes: PendingStructuralChanges, overrides: Partial<RowStructureSelection>) {
    const input = { support: supported, ready: true, selection: selection(overrides), changes, context: context() };
    return { moveUp: row_move_item_model(input, 'backward'), moveDown: row_move_item_model(input, 'forward') };
}

function rows(count: number, start = 0): RowIdentity[] {
    return Array.from({ length: count }, (_, index) => source(start + index));
}

describe('planning a move', () => {
    it('moves the block past one neighbor as one action labelled "Move N rows"', () => {
        const model = steps(EMPTY, { count: 3, identities: rows(3, 2) });
        expect(model.moveDown).toEqual({ count: 3, enabled: true, before: source(6) });
        expect(model.moveUp).toEqual({ count: 3, enabled: true, before: source(1) });
        const down = planned(plan_row_move(EMPTY, context(), rows(3, 2), model.moveDown.before!));
        expect(down.label).toBe('Move 3 rows');
        expect(down.direction).toBe('down');
        expect(down.movedRows).toBe(3);
        expect(down.movedIdentities).toEqual(rows(3, 2));
        expect(down.changes.map((change) => change.kind)).toEqual(['rowLayout']);
        expect(down.outcome.next.rowLayout?.runs).toEqual([
            { kind: 'source', start: 0, count: 2 },
            { kind: 'source', start: 5, count: 1 },
            { kind: 'source', start: 2, count: 3 },
            { kind: 'source', start: 6, count: 4 },
        ]);
        // A move is a live layout change: it records the Structural Basis.
        expect(down.outcome.next.structuralBasis).toEqual(BASIS);
        const up = planned(plan_row_move(EMPTY, context(), [source(4)], model.moveUp.before!));
        expect(up.label).toBe('Move row');
        expect(up.direction).toBe('up');
    });

    it('passes a live row together with its glued tombstones in one step', () => {
        // Row 6 deleted: it glues to row 5.
        const changes = deleted(EMPTY, [6]);
        const down = steps(changes, { count: 2, identities: rows(2, 3) }).moveDown;
        expect(down.before).toEqual(source(7));
        expect(planned(plan_row_move(changes, context(), rows(2, 3), down.before!)).outcome.next.rowLayout?.runs)
            .toEqual([
                { kind: 'source', start: 0, count: 3 },
                { kind: 'source', start: 5, count: 2 },
                { kind: 'source', start: 3, count: 2 },
                { kind: 'source', start: 7, count: 3 },
            ]);
        const up = steps(changes, { identities: [source(7)] }).moveUp;
        expect(up.before).toEqual(source(5));
        expect(planned(plan_row_move(changes, context(), [source(7)], up.before!)).outcome.next.rowLayout?.runs)
            .toEqual([
                { kind: 'source', start: 0, count: 5 },
                { kind: 'source', start: 7, count: 1 },
                { kind: 'source', start: 5, count: 2 },
                { kind: 'source', start: 8, count: 2 },
            ]);
    });

    it('carries selected tombstones with the live rows they glue to, and counts only live rows', () => {
        const changes = deleted(EMPTY, [4]);
        const plan = planned(plan_row_move(changes, context(), [source(3), source(4)], source(8)));
        expect(plan.label).toBe('Move row');
        expect(plan.movedIdentities).toEqual([source(3)]);
        expect(plan.outcome.next.rowLayout?.runs).toEqual([
            { kind: 'source', start: 0, count: 3 },
            { kind: 'source', start: 5, count: 3 },
            { kind: 'source', start: 3, count: 2 },
            { kind: 'source', start: 8, count: 2 },
        ]);
    });

    it('moves Pending Inserted Rows like source rows', () => {
        const inserted = planned(plan_row_insert(EMPTY, context(), source(1), 'after', ['a'], template, 1, APPEND_BASIS))
            .outcome.next;
        const plan = planned(plan_row_move(inserted, context(), [pending('a')], source(5)));
        expect(plan.outcome.next.rowLayout?.runs).toEqual([
            { kind: 'source', start: 0, count: 5 },
            { kind: 'pending', ids: ['a'] },
            { kind: 'source', start: 5, count: 5 },
        ]);
    });

    it('plans a move of more rows than a call can take as arguments', () => {
        const count = 150_000;
        const ctx = context({ sourceRowCount: count + 1, structuralBasis: { ...BASIS, sourceRowCount: count + 1 } });
        const plan = planned(plan_row_move(EMPTY, ctx, rows(count), 'end'));
        expect(plan.label).toBe(`Move ${count} rows`);
        expect(plan.direction).toBe('down');
    });

    it('refuses a move that changes nothing, marked unchanged', () => {
        expect(plan_row_move(EMPTY, context(), [source(3)], source(4))).toMatchObject({ ok: false, unchanged: true });
    });

    it('undoes and redoes the move, and its label reaches the Edit menu', () => {
        const plan = planned(plan_row_move(EMPTY, context(), rows(3, 2), source(6)));
        const history = create_history_store();
        const record = history.stage_record({ label: plan.label, changes: plan.changes });
        record.commit();
        record.notify();
        expect(history_menu_projection(history.snapshot(), false).undoLabel).toBe('Move 3 rows');
        const peek = peek_history(history.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error('nothing recorded');
        const undo = plan_pending_row_history_replay(peek.entry.action, 'undo', () => plan.outcome.next);
        if (undo.kind !== 'plan') throw new Error(undo.kind);
        expect(undo.plans[0].next).toEqual(own_pending_structural_changes(EMPTY));
        const redo = plan_pending_row_history_replay(peek.entry.action, 'redo', () => undo.plans[0].next);
        if (redo.kind !== 'plan') throw new Error(redo.kind);
        expect(redo.plans[0].next).toEqual(plan.outcome.next);
    });

    it('announces the gesture', () => {
        expect(row_move_announcement(3, 'down')).toBe('Moved 3 rows down');
        expect(row_move_announcement(1, 'up')).toBe('Moved 1 row up');
    });
});

describe('the block a drag moves', () => {
    it('arms a drag only when the block could move at all', () => {
        const input = (overrides: Partial<RowStructureSelection>) => ({
            support: supported,
            ready: true,
            selection: selection(overrides),
            changes: EMPTY,
            context: context(),
        });
        expect(row_move_block_refusal(input({ identities: [source(0)] }))).toBeUndefined();
        expect(row_move_block_refusal(input({ bandRows: 1 }))).toBe(APPENDED_BAND_MESSAGE);
        expect(row_move_block_refusal(input({ fixedRows: true }))).toBe(MOVE_FIXED_ROWS_MESSAGE);
    });
});

describe('resolving a drop row', () => {
    // Source row 1 is the promoted Header Row: display row 0 is the row above
    // it, display rows 1-8 the body (source rows 2-9).
    const projection_for = (changes: PendingStructuralChanges) => create_pending_row_projection({
        sourceDisplayRowCount: 9,
        sourceRowAt: (row) => row < 1 ? row : row + 1,
        displayRowForSource: (row) => row < 1 ? row : row === 1 ? undefined : row - 1,
        sourceRowCount: 10,
        changes,
        bodyStart: 2,
        bodyViewTransformed: false,
    });
    const options = { bodyStart: 2 };

    it('refuses a drop at or above the Header Row', () => {
        const projection = projection_for(EMPTY);
        expect(resolve_row_move_drop(projection, -1, options)).toEqual({ ok: false, message: MOVE_ABOVE_HEADER_MESSAGE });
        expect(resolve_row_move_drop(projection, 0, options)).toEqual({ ok: false, message: MOVE_ABOVE_HEADER_MESSAGE });
        expect(resolve_row_move_drop(projection, 1, options)).toEqual({ ok: true, before: source(2) });
    });

    it('resolves a drop inside or after the append band to just before it', () => {
        const band = { ...EMPTY, formatTemplates: [template], appendedRows: [appended('x', 1), appended('y', 2)] };
        const projection = projection_for(band);
        expect(projection.pendingBandStart).toBe(9);
        expect(resolve_row_move_drop(projection, 8, options)).toEqual({ ok: true, before: source(9) });
        for (const before of [9, 10, 11]) {
            expect(resolve_row_move_drop(projection, before, options)).toEqual({ ok: true, before: 'end' });
        }
    });

    it('names an inserted row, and a glued tombstone that the move then resolves after', () => {
        const ctx = context({ bodyStart: 2 });
        let changes = planned(plan_row_insert(EMPTY, ctx, source(3), 'after', ['a'], template, 1, APPEND_BASIS))
            .outcome.next;
        changes = deleted(changes, [5], ctx);
        const projection = projection_for(changes);
        // Display: 0 pre-header, 1-2 rows 2-3, 3 inserted a, 4 row 4, 5 row 5 (removed), 6 row 6.
        expect(resolve_row_move_drop(projection, 3, options)).toEqual({ ok: true, before: pending('a') });
        const between = resolve_row_move_drop(projection, 5, options);
        expect(between).toEqual({ ok: true, before: source(5) });
        if (!between.ok) throw new Error('refused');
        const plan = planned(plan_row_move(changes, ctx, [source(2)], between.before));
        // Row 2 lands after row 4 and its glued tombstone, row 5.
        expect(plan.outcome.next.rowLayout?.runs).toEqual([
            { kind: 'source', start: 3, count: 1 },
            { kind: 'pending', ids: ['a'] },
            { kind: 'source', start: 4, count: 2 },
            { kind: 'source', start: 2, count: 1 },
            { kind: 'source', start: 6, count: 4 },
        ]);
    });

    it('resolves an unloaded row arithmetically when the grid can, and refuses otherwise', () => {
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 10,
            sourceRowAt: () => undefined,
            displayRowForSource: () => undefined,
            sourceRowCount: 10,
            changes: EMPTY,
            bodyViewTransformed: false,
        });
        expect(resolve_row_move_drop(projection, 4, { bodyStart: 0 })).toEqual({ ok: false, message: ROWS_NOT_LOADED_MESSAGE });
        expect(resolve_row_move_drop(projection, 4, { bodyStart: 0, sourceRowFor: (row) => row }))
            .toEqual({ ok: true, before: source(4) });
    });
});

describe('after a move', () => {
    const projection_for = (changes: PendingStructuralChanges) => create_pending_row_projection({
        sourceDisplayRowCount: 10,
        sourceRowAt: (row) => row,
        displayRowForSource: (row) => row,
        sourceRowCount: 10,
        changes,
        bodyViewTransformed: false,
    });

    it('finds the moved block, with the tombstones glued after it', () => {
        const changes = deleted(EMPTY, [4]);
        const plan = planned(plan_row_move(changes, context(), rows(2, 2), source(8)));
        const projection = projection_for(plan.outcome.next);
        // Display: 0 1 5 6 7 2 3 4(removed) 8 9.
        expect(moved_block_display_rows(projection, plan.movedIdentities)).toEqual({ start: 5, end: 7 });
        expect(moved_block_display_rows(projection, [])).toBeUndefined();
    });

    it('tints the fewest rows that explain the new order, and labels follow the tint', () => {
        // Moving rows 3-5 below row 6 (1-based) tints the old row 6.
        const plan = planned(plan_row_move(EMPTY, context(), rows(3, 2), source(6)));
        const projection = projection_for(plan.outcome.next);
        expect(projection.layoutMode).toBe(true);
        expect([0, 1, 2, 3, 4, 5, 6].map((row) => projection.row_state(row)))
            .toEqual(['source', 'source', 'moved', 'source', 'source', 'source', 'source']);
        const row = projection.row_at(2);
        expect(row?.kind === 'source' ? row.identity?.sourceRow : undefined).toBe(5);
        // "Row 3, moved from row 6".
        expect(projection.prospective_row(2)).toBe(2);
        // Moving row 3 below row 4 tints row 3, not row 4.
        const single = planned(plan_row_move(EMPTY, context(), [source(2)], source(4)));
        const single_projection = projection_for(single.outcome.next);
        expect([2, 3].map((row) => single_projection.row_state(row))).toEqual(['source', 'moved']);
    });

    it('locks sort, filter, and hide while moved rows exist', () => {
        const moved = planned(plan_row_move(EMPTY, context(), [source(2)], source(4))).outcome.next;
        expect(has_inserted_or_moved_rows(moved)).toBe(true);
        // Moving it back leaves no moved row; deleting the moved row does too.
        const back = planned(plan_row_move(moved, context(), [source(2)], source(3))).outcome.next;
        expect(has_inserted_or_moved_rows(back)).toBe(false);
        expect(has_inserted_or_moved_rows(deleted(moved, [2]))).toBe(false);
        // Deleting rows alone never locks.
        expect(has_inserted_or_moved_rows(deleted(EMPTY, [3]))).toBe(false);
    });
});
