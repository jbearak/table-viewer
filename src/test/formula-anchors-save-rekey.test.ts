// Formula Anchors across an append-only save: the save turns Pending Appended
// Rows into source rows, so every anchor history keeps that names one of them
// must name its source row instead. Otherwise undo restores an anchor to a
// pending ID that no longer exists, and the formula shows `?? (reason)` and
// turns read-only.
import { describe, expect, it } from 'vitest';
import type { FormulaAnchors } from '../formula-anchors';
import {
    own_pending_structural_changes,
    type PendingAppendedRow,
    type PendingColumn,
    type PendingRowFormatTemplate,
    type PendingStructuralChanges,
} from '../pending-changes';
import type { WorksheetTarget } from '../types';
import {
    commit_history_move,
    empty_history_stack,
    peek_history,
    record_history_action,
    rekey_saved_appended_row_history,
    rekey_saved_formula_anchors,
    type HistoryAction,
    type HistoryChange,
    type HistoryStackState,
    type SavedHistoryRowAssignment,
} from '../webview/history-stack-model';
import {
    committed_formula_fields,
    formula_display,
    webview_formula_workbook,
    type AnchorSheetMeta,
} from '../webview/formula-anchor-model';

const DATA: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data' };
const OTHER: WorksheetTarget = { sheetIndex: 1, sheetName: 'Other' };

const TEMPLATE: PendingRowFormatTemplate = {
    id: 't',
    format: { kind: 'xlsx', templateSourceRow: 5, styleFingerprint: 's', cellStyleIndexes: [] },
};

/** `Data`: header on row 1, body rows 2..6 (source rows 1..5); `Other`: three rows. */
function sheets(data_rows = 6): readonly AnchorSheetMeta[] {
    return [
        {
            name: 'Data',
            sourceRowCount: data_rows,
            columnCount: 3,
            excelFirstRowHeader: { mode: 'on', detected: false, active: true, available: true, sourceRow: 0 },
        },
        { name: 'Other', sourceRowCount: 3, columnCount: 2 },
    ];
}

function appended(id: string, createdOrder: number, cells: PendingAppendedRow['cells'] = {}): PendingAppendedRow {
    return { id, cells, formatTemplateId: TEMPLATE.id, createdOrder };
}

function changes(rows: readonly PendingAppendedRow[]): PendingStructuralChanges {
    return own_pending_structural_changes({
        formatTemplates: [TEMPLATE],
        appendedRows: rows,
        tailRemovals: [],
        conflicts: [],
    });
}

/** Before the save: Data has appended rows a1 (row 7) and a2 (row 8). */
const before_save = webview_formula_workbook(
    true,
    sheets(),
    (index) => index === 0 ? changes([appended('a1', 1), appended('a2', 2)]) : undefined,
);
/** After the save wrote a1 and a2 as source rows 6 and 7. */
const after_save = webview_formula_workbook(true, sheets(8), () => undefined);

function anchored(text: string, sheet_index = 0): FormulaAnchors {
    const fields = committed_formula_fields(text, true, before_save, sheet_index);
    if (fields.kind !== 'fields' || fields.formulaAnchors === undefined) {
        throw new Error(`${text} was not anchored`);
    }
    return fields.formulaAnchors;
}

function a2_with(text: string): PendingAppendedRow {
    return appended('a2', 2, text === '' ? {} : {
        1: { value: text, formulaAnchors: anchored(text) },
    });
}

function row_change(
    id: string,
    before: PendingAppendedRow | null,
    after: PendingAppendedRow | null,
    index: number,
): HistoryChange {
    return {
        kind: 'rowAppend',
        delta: {
            worksheet: DATA,
            pendingRowId: id,
            before,
            after,
            beforeIndex: before === null ? null : index,
            afterIndex: after === null ? null : index,
            formatTemplates: [TEMPLATE],
        },
    };
}

function record(actions: readonly HistoryAction[]): HistoryStackState {
    return actions.reduce((state, action) => {
        const outcome = record_history_action(state, action);
        if (outcome.kind !== 'recorded') throw new Error('not recorded');
        return outcome.state;
    }, empty_history_stack());
}

const SAVED: readonly SavedHistoryRowAssignment[] = [
    {
        worksheet: DATA,
        pendingRowId: 'a1',
        sourceRow: 6,
        savedFingerprint: 'f1',
        savedRow: { cells: {}, format: TEMPLATE.format },
    },
    {
        worksheet: DATA,
        pendingRowId: 'a2',
        sourceRow: 7,
        savedFingerprint: 'f2',
        savedRow: { cells: a2_with('=A7*2').cells, format: TEMPLATE.format },
    },
];

const source_identity = (sourceRow: number) => ({
    kind: 'identity' as const,
    row: { kind: 'source' as const, sourceRow },
});

describe('Formula Anchors across an append-only save', () => {
    it('undoing a later formula edit restores a formula that renders and stays editable', () => {
        // a2's B cell holds `=A7`, then `=A7*2`; A7 is the appended row a1.
        expect(anchored('=A7').references[0].corners[0].row)
            .toEqual({ kind: 'identity', row: { kind: 'pending', pendingRowId: 'a1' } });
        let history = record([
            { label: 'Append row', changes: [row_change('a1', null, appended('a1', 1), 0)] },
            { label: 'Append row', changes: [row_change('a2', null, a2_with(''), 1)] },
            { label: 'Edit cell', changes: [row_change('a2', a2_with(''), a2_with('=A7'), 1)] },
            { label: 'Edit cell', changes: [row_change('a2', a2_with('=A7'), a2_with('=A7*2'), 1)] },
        ]);
        history = rekey_saved_appended_row_history(history, SAVED);

        const undo = peek_history(history, 'undo');
        if (undo.kind !== 'available') throw new Error('Expected an undo');
        const [change] = undo.entry.action.changes;
        if (change.kind !== 'cell') throw new Error('Expected a saved-row cell change');
        expect(change.delta).toMatchObject({ sourceRow: 7, sourceColumn: 1 });
        // Undo restores the before overlay: `=A7`, anchored on source row 6.
        const restored = change.delta.beforeOverlay;
        if (restored.kind !== 'present' || restored.value.kind !== 'present') {
            throw new Error('Expected a restored formula');
        }
        expect(restored.value.value.text).toBe('=A7');
        expect(restored.value.formulaAnchors?.references[0].corners[0].row).toEqual(source_identity(6));
        // It renders as itself, not as `?? (reason)`, so the cell stays editable.
        expect(formula_display(restored.value.value.text, restored.value.formulaAnchors, after_save, 0))
            .toEqual({ kind: 'text', text: '=A7' });
        // The redo side names the saved row too.
        const redo_side = change.delta.afterOverlay;
        if (redo_side.kind === 'present' && redo_side.value.kind === 'present') {
            expect(JSON.stringify(redo_side.value.formulaAnchors)).not.toContain('pending');
        }

        // The rekey survives the undo itself.
        const undone = commit_history_move(history, 'undo', undo.entry);
        if (undone.kind !== 'moved') throw new Error('Expected the undo to move');
        const rekeyed_again = rekey_saved_appended_row_history(undone.state, SAVED);
        expect(JSON.stringify(rekeyed_again)).not.toContain('"pendingRowId":"a1"');
    });

    it('rekeys a reference to the saved rows from another worksheet by its own target', () => {
        const anchors = anchored('=SUM(Data!A7:A8)', 1);
        expect(anchors.references[0].worksheet).toMatchObject({ sheetName: 'Data' });
        const assignments = new Map(SAVED.map((row) => [row.pendingRowId, row]));
        const rekeyed = rekey_saved_formula_anchors(anchors, OTHER, assignments);
        expect(rekeyed.references[0].corners.map((corner) => corner.row))
            .toEqual([source_identity(6), source_identity(7)]);
        expect(formula_display('=SUM(Data!A7:A8)', rekeyed, after_save, 1))
            .toEqual({ kind: 'text', text: '=SUM(Data!A7:A8)' });
        // A pending ID on another worksheet is not the saved row.
        expect(rekey_saved_formula_anchors(anchored('=A7'), OTHER, assignments))
            .toEqual(anchored('=A7'));
    });

    it('rekeys the Pending Rows and Pending Columns a layout gesture recorded', () => {
        // Undone before the save: an inserted column whose cell in row a1 holds
        // `=A7`, and an inserted row on Other holding `=Data!A7`. Redo after the
        // save must restore both naming a1 by its source row.
        const formula = { value: '=A7', formulaAnchors: anchored('=A7') };
        const column: PendingColumn = {
            id: 'c1',
            header: 'New',
            cells: { 'p:a1': formula, 's:1': { value: 'x' } },
            highlights: { 'p:a1': 'yellow' },
            format: { kind: 'none' },
            createdOrder: 3,
        };
        // On Other, so its layout arm saved no rows of its own.
        const cross_sheet = { value: '=Data!A7', formulaAnchors: anchored('=Data!A7', 1) };
        const inserted: PendingAppendedRow = {
            ...appended('i1', 4, { 1: cross_sheet }),
            origin: 'insert',
        };
        const history = record([
            { label: 'Append row', changes: [row_change('a1', null, appended('a1', 1), 0)] },
            {
                label: 'Insert column',
                changes: [{
                    kind: 'columnLayout',
                    delta: {
                        worksheet: DATA,
                        before: null,
                        after: {
                            columns: [0, 1, 2].map((sourceColumn) => ({ kind: 'source' as const, sourceColumn }))
                                .concat([{ kind: 'pending' as const, pendingColumnId: 'c1' } as never]),
                            removedSourceColumns: [],
                            discardedPendingColumns: [],
                        },
                        pendingRows: [],
                        pendingColumns: [{ id: 'c1', before: null, after: column }],
                        formatTemplates: [],
                    },
                }],
            },
            {
                label: 'Insert row',
                changes: [{
                    kind: 'rowLayout',
                    delta: {
                        worksheet: OTHER,
                        before: null,
                        after: {
                            runs: [
                                { kind: 'source', start: 0, count: 1 },
                                { kind: 'pending', ids: ['i1'] },
                                { kind: 'source', start: 1, count: 2 },
                            ],
                            removedSourceRows: [],
                            discardedPendingRows: [],
                        },
                        pendingRows: [{ id: 'i1', before: null, after: inserted }],
                        pendingColumns: [],
                        formatTemplates: [TEMPLATE],
                    },
                }],
            },
        ]);
        const rekeyed = rekey_saved_appended_row_history(history, SAVED.slice(0, 1));
        const changes = rekeyed.undoStack.flatMap((entry) => entry.action.changes);
        const column_change = changes.find((change) => change.kind === 'columnLayout');
        const row_change_after = changes.find((change) => change.kind === 'rowLayout');
        if (column_change?.kind !== 'columnLayout' || row_change_after?.kind !== 'rowLayout') {
            throw new Error('Expected both layout changes');
        }
        const saved_column = column_change.delta.pendingColumns[0].after!;
        expect(Object.keys(saved_column.cells)).toEqual(['s:6', 's:1']);
        expect(saved_column.highlights).toEqual({ 's:6': 'yellow' });
        expect(saved_column.cells['s:6'].formulaAnchors?.references[0].corners[0].row)
            .toEqual(source_identity(6));
        // The inserted row's anchor names Data's saved row by its reference's worksheet.
        const saved_row = row_change_after.delta.pendingRows[0].after!;
        expect(saved_row.cells[1].formulaAnchors?.references[0].corners[0].row)
            .toEqual(source_identity(6));
        expect(formula_display('=Data!A7', saved_row.cells[1].formulaAnchors, after_save, 1))
            .toEqual({ kind: 'text', text: '=Data!A7' });
        expect(JSON.stringify([column_change, row_change_after])).not.toContain('"a1"');
    });
});
