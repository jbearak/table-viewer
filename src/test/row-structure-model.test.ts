import { describe, expect, it } from 'vitest';
import {
    own_pending_structural_changes,
    type PendingAppendedRow,
    type PendingStructuralChanges,
    type RowIdentity,
} from '../pending-changes';
import type { WorksheetTarget } from '../types';
import type { HistoryDirtyEntry } from '../webview/history-cell-state-model';
import {
    absent_overlay,
    history_value,
    overlay_state_from_dirty_entry,
} from '../webview/history-cell-state-model';
import { plan_history_replay } from '../webview/history-replay-model';
import { create_history_store } from '../webview/history-store';
import { peek_history } from '../webview/history-stack-model';
import { history_menu_projection } from '../webview/history-menu-projection';
import { plan_pending_row_history_replay } from '../webview/pending-row-history';
import { create_pending_row_projection } from '../webview/pending-row-projection';
import {
    STRUCTURE_CELL_MOVE_MESSAGE,
    STRUCTURE_TAIL_REMOVAL_MESSAGE,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    FIXED_ROWS_MESSAGE,
    nearest_live_row,
    plan_row_delete,
    plan_row_restore,
    removed_source_row_test,
    resolve_row_structure_selection,
    RESTORE_ONLY_REMOVALS_MESSAGE,
    ROWS_NOT_LOADED_MESSAGE,
    row_structure_menu_model,
    STRUCTURE_BUSY_MESSAGE,
    type RowStructurePlan,
    type RowStructureSelection,
    row_structure_selection,
    plan_row_delete_runs,
    plan_row_restore_runs,
} from '../webview/row-structure-model';

const worksheet: WorksheetTarget = { sheetIndex: 0, sheetName: 'data' };
const template = { id: 'plain', format: { kind: 'none' as const } };
const EMPTY: PendingStructuralChanges = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };

function context(overrides: Partial<WorksheetStructureContext> = {}): WorksheetStructureContext {
    return {
        worksheet,
        bodyStart: 0,
        sourceRowCount: 10,
        sourceColumnCount: 2,
        bodyViewTransformed: false,
        structuralBasis: {
            kind: 'delimited', byteLength: 40, digest: 'abc', sourceRowCount: 10, sourceColumnCount: 2,
        },
        ...overrides,
    };
}

function appended(id: string, createdOrder: number): PendingAppendedRow {
    return { id, cells: { 0: { value: id, valueEditOrder: createdOrder } }, formatTemplateId: 'plain', createdOrder };
}

function with_rows(rows: readonly PendingAppendedRow[]): PendingStructuralChanges {
    return { ...EMPTY, formatTemplates: [template], appendedRows: rows };
}

function planned(result: ReturnType<typeof plan_row_delete>): RowStructurePlan {
    if (!result.ok) throw new Error(result.message);
    return result;
}

function source(sourceRow: number): RowIdentity {
    return { kind: 'source', sourceRow };
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

describe('row Delete and Restore planning', () => {
    it('deletes source rows and discards their cell edits in one action', () => {
        const cells = new Map<string, HistoryDirtyEntry>([
            ['2:0', { value: 'edited', base: 'base' }],
            ['3:1', { value: 'kept', base: 'k' }],
        ]);
        const plan = planned(plan_row_delete(EMPTY, context(), [source(2), source(4)], cells));
        expect(plan.label).toBe('Delete 2 rows');
        expect(plan.discardedCellKeys).toEqual(['2:0']);
        expect(plan.changes.map((change) => change.kind)).toEqual(['rowLayout', 'cell']);
        expect(plan.outcome.next.rowLayout?.removedSourceRows).toEqual([
            { start: 2, count: 1 }, { start: 4, count: 1 },
        ]);
        // The first live change records the file's basis.
        expect(plan.outcome.next.structuralBasis).toEqual(context().structuralBasis);
    });

    it('undoes and redoes the delete with its discarded edits together', () => {
        const cells = new Map<string, HistoryDirtyEntry>([['2:0', { value: 'edited', base: 'base' }]]);
        const plan = planned(plan_row_delete(EMPTY, context(), [source(2)], cells));
        const history = create_history_store();
        const record = history.stage_record({ label: plan.label, changes: plan.changes });
        record.commit();
        record.notify();
        expect(history_menu_projection(history.snapshot(), false).undoLabel).toBe('Delete row');
        const peek = peek_history(history.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error('nothing recorded');
        const action = peek.entry.action;

        // Undo: the layout returns to the source layout and the edit comes back.
        const structure = plan_pending_row_history_replay(action, 'undo', () => plan.outcome.next);
        if (structure.kind !== 'plan') throw new Error(structure.kind);
        expect(structure.plans[0].next).toEqual(own_pending_structural_changes(EMPTY));
        const cell_undo = plan_history_replay(action, 'undo', () => ({
            overlay: absent_overlay(),
            persisted: history_value('base'),
        }));
        if (cell_undo.kind !== 'plan') throw new Error(cell_undo.reason);
        expect(cell_undo.writes.map((write) => [write.key, write.entry?.value])).toEqual([['2:0', 'edited']]);

        // Redo: both go again.
        const redo = plan_pending_row_history_replay(action, 'redo', () => structure.plans[0].next);
        if (redo.kind !== 'plan') throw new Error(redo.kind);
        expect(redo.plans[0].next).toEqual(plan.outcome.next);
        const cell_redo = plan_history_replay(action, 'redo', () => ({
            overlay: overlay_state_from_dirty_entry({ value: 'edited', base: 'base' }),
            persisted: history_value('base'),
        }));
        if (cell_redo.kind !== 'plan') throw new Error(cell_redo.reason);
        expect(cell_redo.writes.map((write) => [write.key, write.entry])).toEqual([['2:0', undefined]]);
    });

    it('deletes a mixed selection: source rows become removals, Pending Rows are discarded', () => {
        const start = with_rows([appended('a', 1), appended('b', 2)]);
        const plan = planned(plan_row_delete(start, context(), [
            source(1),
            { kind: 'pending', pendingRowId: 'a' },
        ], new Map()));
        expect(plan.label).toBe('Delete 2 rows');
        expect(plan.outcome.next.appendedRows.map((row) => row.id)).toEqual(['b']);
        expect(plan.outcome.discardedRows.map((row) => row.id)).toEqual(['a']);
    });

    it('restores removals with one action labeled by count', () => {
        const deleted = planned(plan_row_delete(EMPTY, context(), [source(2), source(3)], new Map()));
        const one = plan_row_restore(deleted.outcome.next, context(), [3]);
        if (!one.ok) throw new Error(one.message);
        expect(one.label).toBe('Restore row');
        expect(one.outcome.next.rowLayout?.removedSourceRows).toEqual([{ start: 2, count: 1 }]);
        const both = plan_row_restore(deleted.outcome.next, context(), [2, 3]);
        if (!both.ok) throw new Error(both.message);
        expect(both.label).toBe('Restore 2 rows');
        // Restoring every removal leaves the source layout, which is stored as absence.
        expect(both.outcome.next.rowLayout).toBeUndefined();
        expect(both.outcome.next.structuralBasis).toBeUndefined();
    });
});

describe('row structure menu model', () => {
    const supported = { supported: true as const };

    it('enables Delete for live rows and offers no Restore without removals', () => {
        const model = row_structure_menu_model({
            support: supported, ready: true, selection: selection({ count: 1 }), changes: EMPTY, context: context(),
        });
        expect(model.delete).toEqual({ count: 1, enabled: true });
        expect(model.restore).toBeUndefined();
    });

    it('reports an unsupported worksheet with the host reason', () => {
        const model = row_structure_menu_model({
            support: { supported: false, reason: 'Not available yet' },
            ready: true,
            selection: selection({}),
            changes: EMPTY,
            context: context(),
        });
        expect(model.delete).toEqual({ count: 1, enabled: false, reason: 'Not available yet' });
    });

    it('disables Delete for header rows, tail removals, unloaded rows, and a busy grid', () => {
        const menu = (overrides: Partial<RowStructureSelection>, ready = true) => row_structure_menu_model({
            support: supported, ready, selection: selection(overrides), changes: EMPTY, context: context(),
        }).delete.reason;
        expect(menu({ fixedRows: true })).toBe(FIXED_ROWS_MESSAGE);
        expect(menu({ tailRemovals: true })).toBe(STRUCTURE_TAIL_REMOVAL_MESSAGE);
        expect(menu({ identities: undefined })).toBe(ROWS_NOT_LOADED_MESSAGE);
        expect(menu({}, false)).toBe(STRUCTURE_BUSY_MESSAGE);
    });

    it('takes the store refusal as the reason: pending cell moves, tail removals', () => {
        const moved = row_structure_menu_model({
            support: supported,
            ready: true,
            selection: selection({}),
            changes: EMPTY,
            context: context({ hasPendingCellMove: () => true }),
        });
        expect(moved.delete).toEqual({ count: 1, enabled: false, reason: STRUCTURE_CELL_MOVE_MESSAGE });
    });

    it('enables Restore only for a selection made only of removals', () => {
        const deleted = planned(plan_row_delete(EMPTY, context(), [source(2), source(3)], new Map()));
        const only = row_structure_menu_model({
            support: supported,
            ready: true,
            selection: selection({ count: 2, identities: [source(2), source(3)], removedSourceRows: [2, 3] }),
            changes: deleted.outcome.next,
            context: context(),
        });
        expect(only.restore).toEqual({ count: 2, enabled: true });
        // Every selected row is already deleted, so Delete has nothing to do.
        expect(only.delete.enabled).toBe(false);
        const mixed = row_structure_menu_model({
            support: supported,
            ready: true,
            selection: selection({ count: 2, identities: [source(2), source(5)], removedSourceRows: [2] }),
            changes: deleted.outcome.next,
            context: context(),
        });
        expect(mixed.delete.enabled).toBe(true);
        expect(mixed.restore).toEqual({ count: 1, enabled: false, reason: RESTORE_ONLY_REMOVALS_MESSAGE });
    });

    it('lets Delete remove Pending Appended Rows even beside a tail removal', () => {
        const start: PendingStructuralChanges = {
            ...with_rows([appended('a', 1)]),
            tailRemovals: [{
                appendHistoryId: 'h', sourceRow: 9, savedFingerprint: 'f',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }],
        };
        const model = row_structure_menu_model({
            support: supported,
            ready: true,
            selection: selection({ identities: [{ kind: 'pending', pendingRowId: 'a' }] }),
            changes: start,
            context: context(),
        });
        expect(model.delete.enabled).toBe(true);
    });
});

describe('resolving a row selection', () => {
    it('resolves source, pending, removed, and header rows from the projection', () => {
        const deleted = planned(plan_row_delete(with_rows([appended('a', 1)]), context({
            bodyStart: 1,
            structuralBasis: { kind: 'delimited', byteLength: 4, digest: 'd', sourceRowCount: 10, sourceColumnCount: 2 },
        }), [source(3)], new Map())).outcome.next;
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 10,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: 10,
            changes: deleted,
            bodyStart: 1,
            bodyViewTransformed: false,
        });
        expect(projection.layoutMode).toBe(true);
        const resolved = resolve_row_structure_selection(projection, [{ start: 0, end: 0 }, { start: 3, end: 4 }, { start: 10, end: 10 }], {
            bodyStart: 1,
            isRemoved: removed_source_row_test(deleted),
        });
        expect(resolved).toEqual({
            count: 4,
            runs: [{ kind: 'source', start: 3, count: 2 }, { kind: 'pending', identity: { kind: 'pending', pendingRowId: 'a' } }],
            identities: [source(3), source(4), { kind: 'pending', pendingRowId: 'a' }],
            removedSourceRuns: [{ start: 3, count: 1 }],
            removedCount: 1,
            removedSourceRows: [3],
            fixedRows: true,
            tailRemovals: false,
            contiguous: false,
            bandRows: 1,
            endsAtBandEnd: true,
        });
    });

    it('leaves a transformed view’s unloaded row unresolved', () => {
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 5,
            sourceRowAt: (row) => row === 1 ? undefined : 4 - row,
            displayRowForSource: (row) => 4 - row,
            sourceRowCount: 5,
            changes: EMPTY,
            bodyViewTransformed: true,
        });
        const resolve = (rows: { start: number; end: number }[]) =>
            resolve_row_structure_selection(projection, rows, { bodyStart: 0, isRemoved: () => false });
        expect(resolve([{ start: 0, end: 0 }]).identities).toEqual([source(4)]);
        expect(resolve([{ start: 0, end: 1 }]).identities).toBeUndefined();
    });
});

describe('selections proportional to their runs', () => {
    const rows = 1_000_000;
    const big_context = () => context({
        bodyStart: 1,
        sourceRowCount: rows,
        structuralBasis: { kind: 'delimited', byteLength: 4, digest: 'd', sourceRowCount: rows, sourceColumnCount: 2 },
    });

    it('resolves, plans, and focuses a select-all of a million-row layout without visiting each row', () => {
        // One deleted row makes a layout; the selection is every display row.
        const deleted = planned(plan_row_delete(EMPTY, big_context(), [source(10)], new Map())).outcome.next;
        const base = create_pending_row_projection({
            sourceDisplayRowCount: rows,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: rows,
            changes: deleted,
            bodyStart: 1,
            bodyViewTransformed: false,
        });
        let row_reads = 0;
        const projection = { ...base, row_at: (row: number) => { row_reads += 1; return base.row_at(row); } };
        const selection = resolve_row_structure_selection(projection, [{ start: 0, end: rows - 1 }], {
            bodyStart: 1,
            isRemoved: removed_source_row_test(deleted),
            removedSourceRows: deleted.rowLayout!.removedSourceRows,
        });
        // The Header Row is the only row read on its own.
        expect(row_reads).toBe(1);
        expect(selection.count).toBe(rows);
        expect(selection.fixedRows).toBe(true);
        expect(selection.runs).toEqual([{ kind: 'source', start: 1, count: rows - 1 }]);
        expect(selection.removedCount).toBe(1);
        const model = row_structure_menu_model({
            selection: { ...selection, fixedRows: false },
            changes: deleted,
            context: big_context(),
            support: { supported: true },
            ready: true,
        });
        expect(model.delete).toMatchObject({ enabled: true, count: rows });
        const plan = planned(plan_row_delete_runs(deleted, big_context(), selection.runs!, new Map()));
        // The Header Row and the row already deleted are not deleted again.
        expect(plan.label).toBe(`Delete ${rows - 2} rows`);
        expect(plan.outcome.next.rowLayout?.removedSourceRows).toEqual([{ start: 1, count: rows - 1 }]);
        // After the delete, the nearest live row is found by skipping the removed run.
        const after = create_pending_row_projection({
            sourceDisplayRowCount: rows,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: rows,
            changes: plan.outcome.next,
            bodyStart: 1,
            bodyViewTransformed: false,
        });
        expect(after.nearest_live_display_row(500)).toBe(0);
    });

    it('maps an untransformed band-mode run through sourceRowsFor, and restores by intervals', () => {
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 10,
            sourceRowAt: () => undefined,
            displayRowForSource: (row) => row,
            sourceRowCount: 10,
            changes: EMPTY,
        });
        const selection = resolve_row_structure_selection(projection, [{ start: 2, end: 7 }], {
            bodyStart: 0,
            isRemoved: () => false,
            sourceRowsFor: (start, count) => [{ start, count }],
        });
        expect(selection.runs).toEqual([{ kind: 'source', start: 2, count: 6 }]);
        const deleted = planned(plan_row_delete_runs(EMPTY, context(), selection.runs!, new Map())).outcome.next;
        const restored = planned(plan_row_restore_runs(deleted, context(), [{ start: 3, count: 2 }]));
        expect(restored.label).toBe('Restore 2 rows');
        expect(restored.outcome.next.rowLayout?.removedSourceRows).toEqual([
            { start: 2, count: 1 },
            { start: 5, count: 3 },
        ]);
        expect(plan_row_restore_runs(deleted, context(), [{ start: 8, count: 1 }]).ok).toBe(false);
    });
});

describe('removed rows in the projection', () => {
    const deleted = planned(plan_row_delete(EMPTY, context(), [source(2), source(3)], new Map())).outcome.next;

    it('keeps removed rows in place, unnumbered, in the untransformed layout mode', () => {
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 10,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: 10,
            changes: deleted,
            bodyViewTransformed: false,
        });
        expect(projection.layoutMode).toBe(true);
        expect(projection.rowCount).toBe(10);
        expect([1, 2, 3, 4].map((row) => projection.row_state(row))).toEqual(['source', 'removed', 'removed', 'source']);
        // Prospective numbering skips the removed rows.
        expect([1, 2, 3, 4].map((row) => projection.prospective_row(row))).toEqual([1, undefined, undefined, 2]);
    });

    it('keeps removed rows at their display positions in a transformed view', () => {
        // Sorted descending: display row d shows source row 9 - d.
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 10,
            sourceRowAt: (row) => 9 - row,
            displayRowForSource: (row) => 9 - row,
            sourceRowCount: 10,
            changes: deleted,
            bodyViewTransformed: true,
        });
        expect(projection.layoutMode).toBe(false);
        expect([5, 6, 7, 8].map((row) => projection.row_state(row))).toEqual(['source', 'removed', 'removed', 'source']);
        expect(projection.prospective_row(5)).toBe(2);
        expect(projection.prospective_row(6)).toBeUndefined();
    });

    it('focuses the row after a deleted block, or the nearest above at the end', () => {
        const live = (row: number) => row !== 2 && row !== 3;
        expect(nearest_live_row(2, 10, live)).toBe(4);
        expect(nearest_live_row(8, 10, (row) => row < 8)).toBe(7);
        expect(nearest_live_row(0, 2, () => false)).toBeUndefined();
    });
});
