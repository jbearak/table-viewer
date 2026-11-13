// Where row insert (delivery step 6) meets Formula Anchors (#333).
//
// Inserts are CSV/TSV-only in step 6, and CSV/TSV values are text, so no real
// flow anchors a formula to an inserted row yet. The structure, anchoring,
// and rendering layers are format-agnostic, though, and step 9's `.xlsx`
// inserts will run through them unchanged. So this file anchors formulas the
// way an `.xlsx` commit does, against layouts the insert and salvage
// operations build, and checks the CSV/TSV side with the delimited workbook,
// codec, and writer.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { referenced_pending_ids, type AnchorReferenceSource } from '../formula-anchor-layout';
import {
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    inserted_rows,
    appended_rows,
    type PendingRowFormatTemplate,
    type PendingStructuralChanges,
} from '../pending-changes';
import { own_wire_pending_changes, type CsvDirtyEntry, type WorksheetTarget } from '../types';
import { build_csv_source, plan_csv_save } from '../viewer-controller';
import {
    delete_rows,
    insert_rows,
    keep_inserted_rows_at_end,
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

/** Header on row 1, body rows 2..6 (source rows 1..5). */
const SHEETS: readonly AnchorSheetMeta[] = [{
    name: 'Data',
    sourceRowCount: 6,
    columnCount: 2,
    excelFirstRowHeader: { mode: 'on', detected: false, active: true, available: true, sourceRow: 0 },
}];

const TEMPLATE: PendingRowFormatTemplate = { id: 't', format: { kind: 'none' } };

function context(sources: () => readonly AnchorReferenceSource[] = () => []): WorksheetStructureContext {
    let referenced: ReturnType<typeof referenced_pending_ids> | undefined;
    const ids = () => referenced ??= referenced_pending_ids(DATA, sources());
    return {
        worksheet: DATA,
        bodyStart: 1,
        sourceRowCount: 6,
        sourceColumnCount: 2,
        bodyViewTransformed: false,
        isRowReferenced: (id) => ids().rows.has(id),
        isColumnReferenced: (id) => ids().columns.has(id),
    };
}

function planned(result: StructureResult): StructureOutcome {
    if (!result.ok) throw new Error(result.refusal.message);
    return result.outcome;
}

const xlsx_workbook = (changes: PendingStructuralChanges) =>
    webview_formula_workbook(true, SHEETS, () => changes);

/** Anchor `text` as an `.xlsx` commit on Data would, against `changes`. */
function anchored(text: string, changes: PendingStructuralChanges): CsvDirtyEntry {
    const fields = committed_formula_fields(text, true, xlsx_workbook(changes), 0);
    if (fields.kind !== 'fields' || fields.formulaAnchors === undefined) throw new Error(`${text} not anchored`);
    return { value: text, base: '', formulaAnchors: fields.formulaAnchors };
}

const shown = (cell: CsvDirtyEntry, changes: PendingStructuralChanges) =>
    formula_display(cell.value, cell.formulaAnchors, xlsx_workbook(changes), 0);

const recorded = (action: HistoryAction): HistoryAction => {
    const outcome = record_history_action(empty_history_stack(), action);
    if (outcome.kind !== 'recorded') throw new Error('not recorded');
    return outcome.state.undoStack[0].action;
};

/**
 * `i1` inserted after row 3 (source row 2) and `i2` after source row 4:
 * rows 2..8 are s1, s2, i1, s3, s4, i2, s5.
 */
function with_two_inserts(): PendingStructuralChanges {
    const first = planned(insert_rows(
        EMPTY_PENDING_STRUCTURAL_CHANGES,
        context(),
        { kind: 'source', sourceRow: 2 },
        'after',
        ['i1'],
        TEMPLATE,
        1,
    )).next;
    return planned(insert_rows(first, context(), { kind: 'source', sourceRow: 4 }, 'after', ['i2'], TEMPLATE, 2)).next;
}

describe('formulas anchored to inserted rows', () => {
    it('anchor an inserted row by identity at commit', () => {
        const inserted = with_two_inserts();
        const cell = anchored('=A4', inserted);
        expect(JSON.stringify(cell.formulaAnchors)).toContain('"pendingRowId":"i1"');
        expect(shown(cell, inserted)).toEqual({ kind: 'text', text: '=A4' });
    });

    it('keep a deleted inserted row’s tombstone through the next insert while a formula names it', () => {
        const inserted = with_two_inserts();
        // Corners on s4 (row 6) and i2 (row 7).
        const cells = [anchored('=SUM(A6:A7)', inserted)];
        const named = context(() => [{ target: DATA, cells }]);
        const deleted = planned(delete_rows(inserted, named, [{ kind: 'pending', pendingRowId: 'i2' }])).next;
        expect(deleted.rowLayout?.discardedPendingRows.map((row) => row.id)).toEqual(['i2']);
        // A later insert is a structural action on the same axis: with the
        // references it keeps the tombstone, without them it drops it.
        const kept = planned(insert_rows(deleted, named, { kind: 'source', sourceRow: 1 }, 'before', ['i3'], TEMPLATE, 3)).next;
        expect(kept.rowLayout?.discardedPendingRows.map((row) => row.id)).toEqual(['i2']);
        // Rows 2..8 hold i3, s1, s2, i1, s3, s4, (i2), s5: the range shrinks
        // from the tombstone to s4, its live neighbor, one row down.
        expect(shown(cells[0], kept)).toEqual({ kind: 'text', text: '=SUM(A7:A7)' });
        const dropped = planned(insert_rows(deleted, context(), { kind: 'source', sourceRow: 1 }, 'before', ['i3'], TEMPLATE, 3)).next;
        expect(dropped.rowLayout?.discardedPendingRows).toEqual([]);
    });

    it('“Keep new rows at the end” keeps identities, drops tombstones, and moves trailing references with N', () => {
        const inserted = with_two_inserts();
        // Rows 2..8: s1, s2, i1, s3, s4, i2, s5. N = 7, so row 10 is trailing k = 2.
        const on_i1 = anchored('=A4', inserted);
        const on_i2 = anchored('=A7', inserted);
        const trailing = anchored('=A10', inserted);
        expect(JSON.stringify(trailing.formulaAnchors)).toContain('"trailing"');
        const range = anchored('=SUM(A3:A4)', inserted);
        const cells = [on_i1, on_i2, trailing, range];
        const named = context(() => [{ target: DATA, cells }]);
        const deleted = planned(delete_rows(inserted, named, [{ kind: 'pending', pendingRowId: 'i2' }])).next;
        expect(deleted.rowLayout?.discardedPendingRows.map((row) => row.id)).toEqual(['i2']);
        expect(shown(on_i2, deleted)).toEqual({ kind: 'text', text: '=#REF!' });
        // N = 6: the trailing reference follows the deletion up a row.
        expect(shown(trailing, deleted)).toEqual({ kind: 'text', text: '=A9' });

        const salvage = planned(keep_inserted_rows_at_end(deleted, named, 100));
        const salvaged = salvage.next;
        // i1 is now the band's only appended row, under the same identity.
        expect(inserted_rows(salvaged)).toEqual([]);
        expect(appended_rows(salvaged).map((row) => [row.id, row.origin ?? 'append'])).toEqual([['i1', 'append']]);
        expect(salvaged.rowLayout).toBeUndefined();
        // Body rows 2..6 are s1..s5 and i1 sits at row 7 in the band.
        expect(shown(on_i1, salvaged)).toEqual({ kind: 'text', text: '=A7' });
        expect(shown(range, salvaged)).toEqual({ kind: 'text', text: '=SUM(A3:A7)' });
        // The salvage drops every tombstone, as the spec says, even a named one.
        expect(shown(on_i2, salvaged)).toEqual({ kind: 'text', text: '=#REF!' });
        // N = 5 and the band holds one row, so trailing k = 2 is the empty row 8.
        expect(shown(trailing, salvaged)).toEqual({ kind: 'text', text: '=A8' });

        // Undo puts i1 back in the layout and the tombstone back, so every
        // formula renders as it did before the salvage.
        const action = recorded({ label: 'Keep new rows at the end', changes: [salvage.change] });
        const undone = plan_pending_row_history_replay(action, 'undo', () => salvaged);
        if (undone.kind !== 'plan') throw new Error(`Expected a plan, got ${undone.kind}`);
        const restored = undone.plans[0].next;
        expect(restored.rowLayout?.discardedPendingRows.map((row) => row.id)).toEqual(['i2']);
        for (const cell of cells) expect(shown(cell, restored)).toEqual(shown(cell, deleted));
    });
});

describe('formulas in inserted rows of a CSV or TSV file', () => {
    it('never anchor a value committed in an inserted row', () => {
        const inserted = with_two_inserts();
        const csv = webview_formula_workbook(false, SHEETS, () => inserted);
        const fields = committed_formula_fields('=A4', true, csv, 0);
        expect(fields).toEqual({ kind: 'fields' });
    });

    it('refuse an inserted row cell carrying anchors on the delimited wire', () => {
        const inserted = with_two_inserts();
        const forged = {
            ...inserted,
            appendedRows: inserted.appendedRows.map((row) => row.id === 'i1'
                ? { ...row, cells: { 0: { value: '=A4', formulaAnchors: anchored('=A4', inserted).formulaAnchors } } }
                : row),
        };
        // The same rows without anchors are ordinary CSV text.
        expect(own_wire_pending_changes({ ...DATA, cells: {}, ...inserted }, { delimited: true })).toBeDefined();
        expect(own_wire_pending_changes({ ...DATA, cells: {}, ...forged }, { delimited: true })).toBeUndefined();
    });

    it('save `=` text in an inserted row verbatim, before and after “Keep new rows at the end”', async () => {
        const text = 'h,v\ns1,1\ns2,2\ns3,3\ns4,4\ns5,5\n';
        const bytes = new TextEncoder().encode(text);
        // A CSV source's rows are its data records; the header is not one.
        const basis = {
            kind: 'delimited' as const,
            byteLength: bytes.byteLength,
            digest: createHash('sha256').update(bytes).digest('hex'),
            sourceRowCount: 5,
            sourceColumnCount: 2,
        };
        const append_basis = {
            sourceRowCount: 5,
            columnCount: 2,
            schemaFingerprint: `sha256:${createHash('sha256').update(JSON.stringify({
                columnCount: 2,
                columnNames: ['h', 'v'],
            })).digest('hex')}`,
        };
        const ctx: WorksheetStructureContext = {
            ...context(),
            bodyStart: 0,
            sourceRowCount: 5,
            structuralBasis: basis,
        };
        const inserted = planned(insert_rows(
            EMPTY_PENDING_STRUCTURAL_CHANGES,
            ctx,
            // After s2: source rows are 0-based data records here.
            { kind: 'source', sourceRow: 1 },
            'after',
            ['i1'],
            TEMPLATE,
            1,
            append_basis,
        )).next;
        const typed: PendingStructuralChanges = {
            ...inserted,
            appendedRows: inserted.appendedRows.map((row) => ({
                ...row,
                cells: { 0: { value: '=SUM(B2:B4)', valueEditOrder: 1 } },
            })),
        };
        const source = await build_csv_source(bytes, '/tmp/data.csv');
        const save = async (structural: PendingStructuralChanges) => new TextDecoder().decode(plan_csv_save({
            source,
            file_path: '/tmp/data.csv',
            worksheets: [{ sheet_index: 0, edits: {}, wanted_bases: new Set(), structural_changes: structural }],
        }).produce(bytes));
        expect(await save(typed)).toBe('h,v\ns1,1\ns2,2\n=SUM(B2:B4),\ns3,3\ns4,4\ns5,5\n');
        const salvaged = planned(keep_inserted_rows_at_end(typed, ctx, 100)).next;
        expect(await save(salvaged)).toBe('h,v\ns1,1\ns2,2\ns3,3\ns4,4\ns5,5\n=SUM(B2:B4),\n');
    });
});
