// The webview's half of a structural save (row and column structure design,
// delivery step 5): the workbook-wide `structural-save` history barrier and
// its Undo message, layout history arms through an append-only save, the
// store clearing what a structural save wrote, and Review Changes' discard of
// row and column changes after the file changed under them.
import { describe, expect, it } from 'vitest';
import {
    own_pending_structural_changes,
    type PendingStructuralChanges,
    type StructuralBasis,
} from '../pending-changes';
import {
    create_pending_row_store,
    delete_rows,
    discard_layout_changes,
    type StructureResult,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    empty_history_stack,
    install_structural_save_barrier,
    peek_history,
    record_history_action,
    rekey_saved_appended_row_history,
    STRUCTURAL_SAVE_BARRIER_MESSAGE,
    type HistoryAction,
    type LayoutHistoryChange,
} from '../webview/history-stack-model';
import { history_refusal_warning } from '../webview/history-command-model';
import { create_history_store } from '../webview/history-store';

const worksheet = { sheetIndex: 0, sheetName: 'Sheet1' };
const BASIS: StructuralBasis = {
    kind: 'delimited',
    byteLength: 8,
    digest: 'sha256:x',
    sourceRowCount: 4,
    sourceColumnCount: 1,
};
const context = (overrides: Partial<WorksheetStructureContext> = {}): WorksheetStructureContext => ({
    worksheet,
    bodyStart: 0,
    sourceRowCount: 4,
    sourceColumnCount: 1,
    bodyViewTransformed: false,
    structuralBasis: BASIS,
    ...overrides,
});
const EMPTY: PendingStructuralChanges = own_pending_structural_changes({});
const planned = (result: StructureResult) => {
    if (!result.ok) throw new Error(result.refusal.message);
    return result.outcome;
};

describe('the structural-save history barrier', () => {
    it('discards history, blocks Undo, and says why', () => {
        const recorded = record_history_action(empty_history_stack(), {
            label: 'Delete row',
            changes: [planned(delete_rows(EMPTY, context(), [{ kind: 'source', sourceRow: 1 }])).change],
        });
        if (recorded.kind !== 'recorded') throw new Error('not recorded');
        const barred = install_structural_save_barrier(recorded.state);
        expect(barred.undoStack).toEqual([]);
        expect(barred.redoStack).toEqual([]);
        expect(barred.epoch).toBe(recorded.state.epoch + 1);
        expect(peek_history(barred, 'undo')).toMatchObject({ kind: 'blocked', barrier: { reason: 'structural-save' } });
        expect(history_refusal_warning('blocked', 'undo', barred.barrier?.label, barred.barrier?.reason))
            .toBe("Can't undo past a save that inserted, deleted, or moved rows or columns.");
        expect(STRUCTURAL_SAVE_BARRIER_MESSAGE)
            .toBe("Can't undo past a save that inserted, deleted, or moved rows or columns.");
        // The action-too-large wording is unchanged.
        expect(history_refusal_warning('blocked', 'undo', 'Paste', 'action-too-large'))
            .toBe('Cannot undo past “Paste”: it was too large to keep in history.');
    });

    it('is installed through the history store', () => {
        const store = create_history_store();
        let notified = 0;
        store.subscribe(() => { notified += 1; });
        store.install_structural_save_barrier();
        expect(store.snapshot().barrier).toEqual({ reason: 'structural-save', label: 'Save' });
        expect(notified).toBe(1);
    });
});

describe('layout history arms through an append-only save', () => {
    it('join the saved appended rows to each recorded row layout', () => {
        const deleted = planned(delete_rows(EMPTY, context(), [{ kind: 'source', sourceRow: 1 }]));
        const action: HistoryAction = { label: 'Delete row', changes: [deleted.change] };
        const recorded = record_history_action(empty_history_stack(), action);
        if (recorded.kind !== 'recorded') throw new Error('not recorded');
        const rekeyed = rekey_saved_appended_row_history(recorded.state, [{
            worksheet,
            pendingRowId: 'p',
            sourceRow: 4,
            savedFingerprint: 'f',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }]);
        const change = rekeyed.undoStack[0]!.action.changes[0] as LayoutHistoryChange;
        expect(change.kind).toBe('rowLayout');
        expect(change.delta.before).toBeNull();
        expect(change.delta.after).toMatchObject({
            runs: [{ kind: 'source', start: 0, count: 5 }],
            removedSourceRows: [{ start: 1, count: 1 }],
        });
        // The recorded Structural Basis is kept: a replay meets the host's check.
        expect(change.delta.structuralBasis).toEqual({ before: null, after: BASIS });
    });

    it('leave another worksheet\'s arms alone', () => {
        const deleted = planned(delete_rows(EMPTY, context(), [{ kind: 'source', sourceRow: 1 }]));
        const recorded = record_history_action(empty_history_stack(), { label: 'Delete row', changes: [deleted.change] });
        if (recorded.kind !== 'recorded') throw new Error('not recorded');
        const rekeyed = rekey_saved_appended_row_history(recorded.state, [{
            worksheet: { sheetIndex: 1, sheetName: 'Other' },
            pendingRowId: 'p',
            sourceRow: 9,
            savedFingerprint: 'f',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }]);
        expect((rekeyed.undoStack[0]!.action.changes[0] as LayoutHistoryChange).delta.after)
            .toEqual(deleted.change.delta.after);
    });
});

describe('the structural store after a structural save', () => {
    it('clears the layout, Pending Columns, and basis with the saved rows', () => {
        const store = create_pending_row_store();
        const deleted = planned(delete_rows(EMPTY, context(), [{ kind: 'source', sourceRow: 1 }]));
        store.install({ session_id: 's' }, deleted.next);
        expect(store.snapshot().rowLayout).toBeDefined();
        store.clear_saved('s', new Set(), new Set(), false);
        expect(store.snapshot().rowLayout).toBeDefined();
        store.clear_saved('s', new Set(), new Set(), true);
        expect(store.snapshot()).toEqual(EMPTY);
    });
});

describe('discarding row and column changes after the file changed', () => {
    it('restores the source layout of the current file as one history action', () => {
        const deleted = planned(delete_rows(EMPTY, context(), [{ kind: 'source', sourceRow: 1 }]));
        const conflicted = own_pending_structural_changes({
            ...deleted.next,
            appendBasis: { sourceRowCount: 4, columnCount: 1, schemaFingerprint: 'sha256:s' },
            formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
            appendedRows: [{ id: 'kept', cells: { 0: { value: 'typed' } }, formatTemplateId: 'plain', createdOrder: 1 }],
            conflicts: [{ reason: 'structuralBasisChanged', pendingRowIds: [], tailRemovalIds: [] }],
        });
        // The file now has five body rows.
        const outcome = planned(discard_layout_changes(conflicted, context({ sourceRowCount: 5 })));
        expect(outcome.next.rowLayout).toBeUndefined();
        expect(outcome.next.structuralBasis).toBeUndefined();
        expect(outcome.next.conflicts).toEqual([]);
        expect(outcome.next.appendedRows.map((row) => row.id)).toEqual(['kept']);
        expect(outcome.change).toMatchObject({
            kind: 'rowLayout',
            delta: { before: deleted.next.rowLayout, after: null, structuralBasis: { before: BASIS, after: null } },
        });
    });
});
