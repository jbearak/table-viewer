// Discarded tombstones and stored Formula Anchors: a structural action keeps a
// discarded Pending Row's tombstone while a stored anchor names it, so a range
// cornered on it shrinks to its live neighbors instead of rendering `#REF!`;
// it drops the tombstone once nothing names it; and undo and redo restore
// both.
import { describe, expect, it } from 'vitest';
import {
    referenced_pending_ids,
    type AnchorReferenceSource,
} from '../formula-anchor-layout';
import {
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    own_pending_structural_changes,
    type PendingRowFormatTemplate,
    type PendingStructuralChanges,
} from '../pending-changes';
import type { CsvDirtyEntry, WorksheetTarget } from '../types';
import {
    delete_rows,
    insert_rows,
    move_rows,
    type StructureOutcome,
    type StructureResult,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import { plan_pending_row_history_replay } from '../webview/pending-row-history';
import {
    empty_history_stack,
    record_history_action,
    type HistoryAction,
} from '../webview/history-stack-model';
import {
    committed_formula_fields,
    formula_display,
    webview_formula_workbook,
    type AnchorSheetMeta,
} from '../webview/formula-anchor-model';

const DATA: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data' };
const OTHER: WorksheetTarget = { sheetIndex: 1, sheetName: 'Other' };

/** `Data`: header on row 1, body rows 2..6 (source rows 1..5). `Other`: three rows. */
const SHEETS: readonly AnchorSheetMeta[] = [
    {
        name: 'Data',
        sourceRowCount: 6,
        columnCount: 3,
        excelFirstRowHeader: { mode: 'on', detected: false, active: true, available: true, sourceRow: 0 },
    },
    { name: 'Other', sourceRowCount: 3, columnCount: 2 },
];

const TEMPLATE: PendingRowFormatTemplate = {
    id: 't',
    format: { kind: 'xlsx', templateSourceRow: 5, styleFingerprint: 's', cellStyleIndexes: [] },
};

function context(sources: () => readonly AnchorReferenceSource[] = () => []): WorksheetStructureContext {
    // One set per action, as GridShell builds it.
    let referenced: ReturnType<typeof referenced_pending_ids> | undefined;
    const ids = () => referenced ??= referenced_pending_ids(DATA, sources());
    return {
        worksheet: DATA,
        bodyStart: 1,
        sourceRowCount: 6,
        sourceColumnCount: 3,
        bodyViewTransformed: false,
        isRowReferenced: (id) => ids().rows.has(id),
        isColumnReferenced: (id) => ids().columns.has(id),
    };
}

function planned(result: StructureResult): StructureOutcome {
    if (!result.ok) throw new Error(result.refusal.message);
    return result.outcome;
}

/** Insert Pending Inserted Row `i1` after row 3 (source row 2): it becomes row 4. */
function with_inserted_row(): PendingStructuralChanges {
    return planned(insert_rows(
        EMPTY_PENDING_STRUCTURAL_CHANGES,
        context(),
        { kind: 'source', sourceRow: 2 },
        'after',
        ['i1'],
        TEMPLATE,
        1,
    )).next;
}

const workbook = (data: PendingStructuralChanges) =>
    webview_formula_workbook(true, SHEETS, (index) => index === 0 ? data : undefined);

/** `=SUM(A2:A4)`, committed on Data (or Other) while A4 is the inserted row `i1`. */
function anchored_sum(changes: PendingStructuralChanges, sheet_index = 0): CsvDirtyEntry {
    const text = sheet_index === 0 ? '=SUM(A2:A4)' : '=SUM(Data!A2:A4)';
    const fields = committed_formula_fields(text, true, workbook(changes), sheet_index);
    if (fields.kind !== 'fields' || fields.formulaAnchors === undefined) throw new Error('not anchored');
    return { value: text, base: '', formulaAnchors: fields.formulaAnchors };
}

const recorded = (action: HistoryAction): HistoryAction => {
    const outcome = record_history_action(empty_history_stack(), action);
    if (outcome.kind !== 'recorded') throw new Error('not recorded');
    return outcome.state.undoStack[0].action;
};

function replay(
    action: HistoryAction,
    direction: 'undo' | 'redo',
    current: PendingStructuralChanges,
): PendingStructuralChanges {
    const result = plan_pending_row_history_replay(action, direction, () => current);
    if (result.kind !== 'plan') throw new Error(`Expected a plan, got ${result.kind}`);
    return result.plans[0].next;
}

const delete_i1 = (changes: PendingStructuralChanges, ctx: WorksheetStructureContext) =>
    planned(delete_rows(changes, ctx, [{ kind: 'pending', pendingRowId: 'i1' }]));

describe('discarded tombstones named by stored anchors', () => {
    it('keeps a referenced tombstone, so a range cornered on it shrinks to its live neighbors', () => {
        const inserted = with_inserted_row();
        // A cell edit in column B of row 6 (source row 5) holds the formula.
        const cells = { '5:1': anchored_sum(inserted) };
        const deleted = delete_i1(inserted, context(() => [{ target: DATA, cells: Object.values(cells) }]));
        expect(deleted.next.rowLayout?.discardedPendingRows.map((row) => row.id)).toEqual(['i1']);
        expect(formula_display(cells['5:1'].value, cells['5:1'].formulaAnchors, workbook(deleted.next), 0))
            .toEqual({ kind: 'text', text: '=SUM(A2:A3)' });

        // Without the tombstone the corner names nothing the layout holds.
        const dropped = delete_i1(inserted, context()).next;
        expect(formula_display(cells['5:1'].value, cells['5:1'].formulaAnchors, workbook(dropped), 0))
            .toEqual({ kind: 'text', text: '=SUM(#REF!)' });
    });

    it('keeps a tombstone named from another worksheet or from its own Pending Rows', () => {
        const inserted = with_inserted_row();
        const from_other = delete_i1(inserted, context(() => [
            { target: DATA, cells: [] },
            { target: OTHER, cells: [anchored_sum(inserted, 1)] },
        ]));
        expect(from_other.next.rowLayout?.discardedPendingRows.map((row) => row.id)).toEqual(['i1']);

        // A formula in an appended row of Data names i1; the store reads it itself.
        const appended: PendingStructuralChanges = own_pending_structural_changes({
            ...inserted,
            appendedRows: [
                ...inserted.appendedRows,
                {
                    id: 'a1',
                    cells: { 1: { value: '=SUM(A2:A4)', formulaAnchors: anchored_sum(inserted).formulaAnchors } },
                    formatTemplateId: 't',
                    createdOrder: 2,
                },
            ],
        });
        const from_row = delete_i1(appended, context());
        expect(from_row.next.rowLayout?.discardedPendingRows.map((row) => row.id)).toEqual(['i1']);
    });

    it('drops an unreferenced tombstone in the action that discards its row', () => {
        const deleted = delete_i1(with_inserted_row(), context(() => [{ target: DATA, cells: [] }])).next;
        expect(deleted.rowLayout).toBeUndefined();
    });

    it('undo and redo of the delete restore both cases', () => {
        const inserted = with_inserted_row();
        const cells = [anchored_sum(inserted)];
        for (const ctx of [context(() => [{ target: DATA, cells }]), context()]) {
            const deleted = delete_i1(inserted, ctx);
            const action = recorded({ label: 'Delete row', changes: [deleted.change] });
            const undone = replay(action, 'undo', deleted.next);
            expect(undone).toEqual(own_pending_structural_changes(inserted));
            expect(replay(action, 'redo', undone)).toEqual(deleted.next);
        }
    });

    it('drops the tombstone on the next structural action once its formula is discarded', () => {
        const inserted = with_inserted_row();
        let cells = [anchored_sum(inserted)];
        const ctx = context(() => [{ target: DATA, cells }]);
        const deleted = delete_i1(inserted, ctx).next;
        expect(deleted.rowLayout?.discardedPendingRows).toHaveLength(1);
        // The referencing cell edit is discarded; the next row action drops the tombstone.
        cells = [];
        const moved = planned(move_rows(deleted, context(() => [{ target: DATA, cells }]), [
            { kind: 'source', sourceRow: 1 },
        ], { kind: 'source', sourceRow: 4 })).next;
        expect(moved.rowLayout?.discardedPendingRows).toEqual([]);
        expect(moved.rowLayout?.runs.some((run) => run.kind === 'pending')).toBe(false);
    });
});

describe('referenced_pending_ids', () => {
    it('collects pending identities a worksheet is named by, and no others', () => {
        const inserted = with_inserted_row();
        const own = anchored_sum(inserted);
        const elsewhere = anchored_sum(inserted, 1);
        expect(referenced_pending_ids(DATA, [
            { target: DATA, cells: [own, 'plain'] },
            { target: OTHER, cells: [elsewhere] },
        ]).rows).toEqual(new Set(['i1']));
        // Other is named by nothing: Data's own anchors omit their worksheet.
        expect(referenced_pending_ids(OTHER, [
            { target: DATA, cells: [own] },
            { target: OTHER, cells: [] },
        ]).rows).toEqual(new Set());
    });
});
