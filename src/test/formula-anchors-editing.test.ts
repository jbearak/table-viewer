// @vitest-environment jsdom

// Formula Anchors in the webview: anchoring at commit (stored only where the
// spec says), refusing formulas that cannot be anchored, the editor's and the
// grid's rendered formula text after a row delete built through the store's
// operations, `??` for unrenderable formulas, the prospective calculation
// request, and unchanged behavior without layouts.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellData } from '../types';
import { use_editing } from '../webview/use-editing';
import { create_edit_session_store, type EditSessionStore } from '../webview/edit-session-store';
import {
    committed_formula_fields,
    formula_display,
    formula_workbook_with_appended_rows,
    formula_result_key,
    layout_affected_formula_cells,
    needs_prospective_formula_request,
    prospective_formula_request,
    prospective_formula_targets,
    webview_formula_workbook,
    type AnchorSheetMeta,
} from '../webview/formula-anchor-model';
import { delete_rows, type WorksheetStructureContext } from '../webview/pending-row-store';
import { formula_anchor_context } from '../formula-anchor-layout';
import { anchor_formula } from '../formula-anchors';
import { all_workbook_formula_cells_impact, workbook_impact_with_cells } from '../formula-dependencies';
import {
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    type PendingAppendedRow,
    type PendingStructuralChanges,
} from '../pending-changes';
import type { FormulaAnchorWorkbook } from '../formula-anchor-layout';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `Data`: header on row 1, body rows 2..6 (source rows 1..5); `Other`: no header, 3 rows. */
const SHEETS: readonly AnchorSheetMeta[] = [
    {
        name: 'Data',
        sourceRowCount: 6,
        columnCount: 3,
        excelFirstRowHeader: { mode: 'on', detected: false, active: true, available: true, sourceRow: 0 },
    },
    { name: 'Other', sourceRowCount: 3, columnCount: 2 },
];

const DATA_CONTEXT: WorksheetStructureContext = {
    worksheet: { sheetIndex: 0, sheetName: 'Data' },
    bodyStart: 1,
    sourceRowCount: 6,
    sourceColumnCount: 3,
    bodyViewTransformed: false,
};

/** Delete the body rows at the given source rows of `Data` through the store's operation. */
function delete_data_rows(source_rows: readonly number[]): PendingStructuralChanges {
    const result = delete_rows(
        EMPTY_PENDING_STRUCTURAL_CHANGES,
        DATA_CONTEXT,
        source_rows.map((sourceRow) => ({ kind: 'source', sourceRow })),
    );
    if (!result.ok) throw new Error(result.refusal.message);
    return result.outcome.next;
}

function workbook(
    data?: PendingStructuralChanges,
    other?: PendingStructuralChanges,
    xlsx = true,
): FormulaAnchorWorkbook {
    return webview_formula_workbook(xlsx, SHEETS, (index) => index === 0 ? data : other);
}

const appended = (id: string, createdOrder: number): PendingAppendedRow => ({
    id,
    cells: {},
    formatTemplateId: 't',
    createdOrder,
});

const WITH_BAND: PendingStructuralChanges = {
    ...EMPTY_PENDING_STRUCTURAL_CHANGES,
    formatTemplates: [{ id: 't', format: { kind: 'xlsx', templateSourceRow: 5, styleFingerprint: 's', cellStyleIndexes: [] } }],
    appendedRows: [appended('a1', 0)],
};

const BASES = [{ targetSheetIndex: 0, targetSheetName: 'Data', provisionalStartRow: 6, provisionalRowCount: 1 }];

describe('committed_formula_fields', () => {
    it('stores no anchors, only the bases, for source references without a layout change', () => {
        const fields = committed_formula_fields('=SUM(A2:A6)+Other!B2', true, workbook(), 0, () => BASES);
        expect(fields).toEqual({ kind: 'fields', formulaReferenceBases: BASES });
    });

    it('stores anchors when the target sheet has a live layout change, and bases for the rest', () => {
        const bases = vi.fn(() => BASES);
        const fields = committed_formula_fields('=Data!A3+B1', true, workbook(delete_data_rows([2])), 1, bases);
        expect(fields.kind).toBe('fields');
        if (fields.kind !== 'fields') return;
        // The unanchored `B1` keeps its bases, captured without the anchored reference.
        expect(fields.formulaReferenceBases).toEqual(BASES);
        expect(bases).toHaveBeenCalledWith('=       +B1');
        // Only the reference to the restructured sheet is stored; `B1` on Other stays implicit.
        expect(fields.formulaAnchors?.references).toEqual([{
            start: 1,
            end: 8,
            worksheet: { sheetIndex: 0, sheetName: 'Data' },
            corners: [{
                row: { kind: 'identity', row: { kind: 'source', sourceRow: 3 } },
                column: { kind: 'identity', column: { kind: 'source', sourceColumn: 0 } },
            }],
        }]);
    });

    it('stores anchors for a corner on a Pending Row of a source-layout sheet', () => {
        // Row 7 of Data is the first appended row.
        const fields = committed_formula_fields('=A7+A2', true, workbook(WITH_BAND), 0, () => BASES);
        expect(fields.kind === 'fields' && fields.formulaAnchors?.references).toEqual([{
            start: 1,
            end: 3,
            corners: [{
                row: { kind: 'identity', row: { kind: 'pending', pendingRowId: 'a1' } },
                column: { kind: 'identity', column: { kind: 'source', sourceColumn: 0 } },
            }],
        }]);
        // `A2` is not anchored, so it keeps its bases.
        expect(fields.kind === 'fields' && fields.formulaReferenceBases).toEqual(BASES);
        // A formula whose every reference is anchored stores no bases.
        expect(committed_formula_fields('=A7*2', true, workbook(WITH_BAND), 0, () => BASES))
            .not.toHaveProperty('formulaReferenceBases');
    });

    it('anchors a composed formula to a row of its own batch once Append admits it', () => {
        // Composing rows 7 and 8 of Data: `=A7` in row 8 names the first composed row.
        const extended = formula_workbook_with_appended_rows(
            workbook(), 0, SHEETS[0], EMPTY_PENDING_STRUCTURAL_CHANGES, ['c1', 'c2'],
        );
        const fields = committed_formula_fields('=A7', true, extended, 0, () => BASES);
        expect(fields.kind === 'fields' && fields.formulaAnchors?.references[0]?.corners[0]?.row).toEqual({
            kind: 'identity',
            row: { kind: 'pending', pendingRowId: 'c1' },
        });
        // Before admission the same text names no Pending Row, so only the bases are kept.
        expect(committed_formula_fields('=A7', true, workbook(), 0, () => BASES))
            .toEqual({ kind: 'fields', formulaReferenceBases: BASES });
    });

    it('refuses a formula the tokenizer cannot anchor on a restructured sheet', () => {
        const fields = committed_formula_fields('=INDEX(A:A,1):B5', true, workbook(delete_data_rows([2])), 0);
        expect(fields).toEqual({
            kind: 'refused',
            reason: "Table Viewer can't adjust the reference `INDEX(A:A,1):B5` while rows on this sheet"
                + ' are being inserted, deleted, or moved.',
        });
        // The same formula is fine while nothing moves.
        expect(committed_formula_fields('=INDEX(A:A,1):B5', true, workbook(), 0).kind).toBe('fields');
    });

    it('never anchors CSV or TSV text', () => {
        const csv = workbook(delete_data_rows([2]), undefined, false);
        expect(committed_formula_fields('=A3', true, csv, 0, () => BASES))
            .toEqual({ kind: 'fields', formulaReferenceBases: BASES });
        expect(committed_formula_fields('=A3', true, csv, 0)).toEqual({ kind: 'fields' });
        expect(committed_formula_fields('plain', false, workbook(delete_data_rows([2])), 0))
            .toEqual({ kind: 'fields' });
    });
});

describe('formula_display', () => {
    const retarget = (text: string) => text.replace('B9', 'C9');

    it('returns the text, through the move retargeter, without a layout or anchors', () => {
        for (const text of ['=SUM(A2:A6)', '=INDEX(A:A,1):B5', '=Other!A1+B9']) {
            expect(formula_display(text, undefined, workbook(), 0, retarget))
                .toEqual({ kind: 'text', text: retarget(text) });
            expect(formula_display(text, undefined, undefined, 0)).toEqual({ kind: 'text', text });
        }
        // A band row anchored on a source-layout sheet still renders: it is where Append put it.
        const anchors = anchor_formula('=A7', formula_anchor_context(workbook(WITH_BAND), 0));
        expect(anchors.kind === 'anchored' && anchors.anchors).toBeTruthy();
        expect(formula_display('=A7', anchors.kind === 'anchored' ? anchors.anchors : undefined, workbook(WITH_BAND), 0))
            .toEqual({ kind: 'text', text: '=A7' });
    });

    it('renders source and stored anchors after a row delete', () => {
        const deleted = workbook(delete_data_rows([2]));
        expect(formula_display('=SUM(A2:A6)', undefined, deleted, 0)).toEqual({ kind: 'text', text: '=SUM(A2:A5)' });
        expect(formula_display('=A3', undefined, deleted, 0)).toEqual({ kind: 'text', text: '=#REF!' });
        expect(formula_display('=Data!A6*2', undefined, deleted, 1)).toEqual({ kind: 'text', text: '=Data!A5*2' });
        // Anchored after the delete to the row now numbered 3, it follows that row.
        const anchored = anchor_formula('=A3', formula_anchor_context(deleted, 0));
        const anchors = anchored.kind === 'anchored' ? anchored.anchors : undefined;
        expect(formula_display('=A3', anchors, deleted, 0)).toEqual({ kind: 'text', text: '=A3' });
        expect(formula_display('=A3', anchors, workbook(), 0)).toEqual({ kind: 'text', text: '=A4' });
    });

    it('shows an unknown result with the reason for a formula it cannot render', () => {
        expect(formula_display('=INDEX(A:A,1):A3', undefined, workbook(delete_data_rows([2])), 0)).toEqual({
            kind: 'unrenderable',
            text: '=INDEX(A:A,1):A3',
            reason: "can't adjust a range built from a function",
            result: "?? (can't adjust a range built from a function)",
        });
    });
});

describe('prospective calculation request', () => {
    it('is not needed without a layout change or stored anchors', () => {
        expect(needs_prospective_formula_request(workbook(), [], [], () => undefined)).toBe(false);
        expect(needs_prospective_formula_request(
            workbook(delete_data_rows([2]), undefined, false), [], [], () => undefined,
        )).toBe(false);
        expect(needs_prospective_formula_request(workbook(delete_data_rows([2])), [], [], () => undefined))
            .toBe(true);
    });

    it('places edits and their targets at their prospective coordinates', () => {
        const changes = delete_data_rows([2]);
        const request = prospective_formula_request({
            workbook: workbook(changes),
            changes_for: (index) => index === 0 ? changes : undefined,
            edits: [
                { sheetIndex: 0, row: 4, column: 1, value: '=A2', writesFormula: true },
                // On the removed row: not addressable.
                { sheetIndex: 0, row: 2, column: 0, value: '5', writesFormula: false },
            ],
            pending_edits: [],
        });
        expect(request.edits).toEqual([{ sheetIndex: 0, row: 3, column: 1, value: '=A2', writesFormula: true }]);
        expect(request.editTargets).toEqual([{ sheetIndex: 0, row: 3, column: 1 }]);
        expect(request.graphRoots).toEqual([{ sheetIndex: 0, row: 4, column: 1 }]);
        expect(request.prospectiveRowCounts).toEqual([5, 3]);
        expect(request.layouts[0]).toEqual({ bodyStart: 1, rowLayout: changes.rowLayout, band: [] });
        expect(request.layouts[1]).toEqual({ bodyStart: 0, band: [] });
    });

    it('targets only the source formulas a layout change affects', () => {
        const deleted = workbook(delete_data_rows([2]));
        // Data!C2 sums Data; Data!C5 names only Other; Other!B1 names Data; Other!B2 names Other.
        const sheets = [
            {
                formulaDependencies: [1, 2, 0, 1, 0, 5, 0, 4, 2, 1, 0, 0, 0, 0],
                structuredFormulaReferences: { names: [], references: [] },
            },
            { formulaDependencies: [0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0] },
        ];
        const affected = layout_affected_formula_cells(deleted, sheets);
        expect(affected).toEqual([
            { sheetIndex: 0, row: 1, column: 2 },
            { sheetIndex: 1, row: 0, column: 1 },
        ]);
        // Without a live layout change nothing is affected.
        expect(layout_affected_formula_cells(workbook(), sheets)).toEqual([]);
        const impact = workbook_impact_with_cells(all_workbook_formula_cells_impact([]), affected);
        expect(prospective_formula_targets(deleted, impact, [{ sheetIndex: 0, row: 3, column: 1 }])).toEqual({
            targets: [
                { sheetIndex: 0, row: 3, column: 1 },
                { sheetIndex: 0, row: 1, column: 2 },
                { sheetIndex: 1, row: 0, column: 1 },
            ],
            tooMany: false,
        });
    });

    it('keys source results at their prospective coordinates, or at the source without one', () => {
        const deleted = workbook(delete_data_rows([2])).worksheets[0];
        expect(formula_result_key(deleted, true, 4, 2)).toBe('3:2');
        expect(formula_result_key(deleted, true, 2, 2)).toBeUndefined();
        expect(formula_result_key(deleted, false, 4, 2)).toBe('4:2');
    });
});

// --- The editing hook -----------------------------------------------------

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let hook_result: ReturnType<typeof use_editing> | null = null;

const cell = (raw: string): CellData => ({ raw, formatted: raw, bold: false, italic: false });
const formula = (text: string): CellData => ({ raw: '0', formatted: '0', bold: false, italic: false, formula: text });

const ROWS: (CellData | null)[][] = [
    [cell('Amount'), cell('Units'), cell('Total')],
    [cell('10'), cell('1'), formula('=SUM(A2:A6)')],
    [cell('20'), cell('2'), formula('=A4*2')],
    [cell('30'), cell('3'), formula('=INDEX(A:A,1):A3')],
    // C5 is a string that happens to start with `=`.
    [cell('40'), cell('4'), cell('=A4')],
    [cell('50'), cell('5'), null],
];

/** Wired the way GridShell wires the hook on an `.xlsx` worksheet. */
function Harness({
    formula_workbook,
    store,
    refused,
    bases,
}: {
    formula_workbook: FormulaAnchorWorkbook;
    store: EditSessionStore;
    refused: (reason: string) => void;
    bases: () => typeof BASES;
}) {
    const get_cell_raw = (row: number, column: number): string | undefined => {
        const value = ROWS[row]?.[column];
        if (value === undefined) return undefined;
        return value?.formula ?? (value === null ? '' : String(value.raw ?? ''));
    };
    hook_result = use_editing(get_cell_raw, 0, undefined, store, {
        syntax: 'markdown',
        get_cell: (row, column) => ROWS[row]?.[column] ?? null,
        formula_edit_text: (row, column, text, after_order) => {
            const entry = store.get(`${row}:${column}`);
            const writes_formula = entry === undefined
                ? ROWS[row]?.[column]?.formula !== undefined
                : entry.value.startsWith('=');
            void after_order;
            return writes_formula
                ? formula_display(text, entry?.formulaAnchors, formula_workbook, 0).text
                : text;
        },
        formula_reference_bases: bases,
        anchor_formula: (value) => anchor_formula(value, formula_anchor_context(formula_workbook, 0)),
        on_formula_refused: refused,
        rendered_persisted_formula: (text) => formula_display(text, undefined, formula_workbook, 0).text,
    });
    return null;
}

async function render_hook(formula_workbook: FormulaAnchorWorkbook) {
    const store = create_edit_session_store();
    const refused = vi.fn();
    const bases = vi.fn(() => BASES);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(Harness, { formula_workbook, store, refused, bases }));
    });
    return { store, refused, bases };
}

afterEach(() => {
    if (root && container) {
        act(() => root!.unmount());
        container.remove();
    }
    root = null;
    container = null;
    hook_result = null;
});

describe('editing formulas against a layout', () => {
    it('opens the editor on the rendered formula after a row delete', async () => {
        await render_hook(workbook(delete_data_rows([2])));
        await act(async () => { hook_result!.start_editing(1, 2); });
        expect(hook_result!.editing_cell?.value).toBe('=SUM(A2:A5)');
    });

    it('records the source text as the base and stores anchors when the formula changes', async () => {
        const { store, bases } = await render_hook(workbook(delete_data_rows([2])));
        await act(async () => { hook_result!.commit_edit(1, 2, '=SUM(A2:A4)'); });
        const entry = store.get('1:2');
        expect(entry?.value).toBe('=SUM(A2:A4)');
        // Base validation still compares against the file.
        expect(entry?.base).toBe('=SUM(A2:A6)');
        expect(entry?.formulaAnchors?.references).toHaveLength(1);
        expect(entry?.formulaReferenceBases).toBeUndefined();
        expect(bases).not.toHaveBeenCalled();
        // Reopening shows the text the anchors render.
        await act(async () => { hook_result!.start_editing(1, 2); });
        expect(hook_result!.editing_cell?.value).toBe('=SUM(A2:A4)');
    });

    it('treats retyping the rendered formula as a revert and the stored text as an edit', async () => {
        const { store } = await render_hook(workbook(delete_data_rows([2])));
        await act(async () => { hook_result!.commit_edit(1, 2, '=SUM(A2:A5)'); });
        expect(store.get('1:2')).toBeUndefined();
        // `=SUM(A2:A6)` is the file's text, but it now names a different range.
        await act(async () => { hook_result!.commit_edit(1, 2, '=SUM(A2:A6)'); });
        const entry = store.get('1:2');
        expect(entry?.value).toBe('=SUM(A2:A6)');
        expect(entry?.base).toBe('=SUM(A2:A6)');
        expect(entry?.writeValue).toBe(true);
        expect(entry?.formulaAnchors).toBeDefined();
    });

    it('compares a string that starts with = as text, not as a rendered formula', async () => {
        const { store } = await render_hook(workbook(delete_data_rows([2])));
        // As a formula `=A4` would render `=A3`; as a string it stays `=A4`, so
        // typing the formula `=A3` is an edit, not a revert.
        await act(async () => { hook_result!.commit_edit(4, 2, '=A3'); });
        expect(store.get('4:2')).toMatchObject({ value: '=A3', base: '=A4' });
    });

    it('refuses a formula it cannot anchor, with the reason, and changes nothing', async () => {
        const { store, refused } = await render_hook(workbook(delete_data_rows([2])));
        let result: boolean | undefined;
        await act(async () => { result = hook_result!.commit_edit(4, 1, '=INDEX(A:A,1):B5'); });
        expect(result).toBe(false);
        expect(store.size()).toBe(0);
        expect(refused).toHaveBeenCalledWith(
            "Table Viewer can't adjust the reference `INDEX(A:A,1):B5` while rows on this sheet"
                + ' are being inserted, deleted, or moved.',
        );
    });

    it('edits exactly as before on a worksheet with the source layout', async () => {
        const { store, refused, bases } = await render_hook(workbook());
        await act(async () => { hook_result!.start_editing(1, 2); });
        expect(hook_result!.editing_cell?.value).toBe('=SUM(A2:A6)');
        await act(async () => { hook_result!.commit_edit(1, 2, '=SUM(A2:A6)'); });
        expect(store.get('1:2')).toBeUndefined();
        await act(async () => { hook_result!.commit_edit(1, 2, '=SUM(A2:A4)'); });
        expect(store.get('1:2')).toEqual({
            value: '=SUM(A2:A4)',
            base: '=SUM(A2:A6)',
            formattingKnown: true,
            formulaReferenceBases: BASES,
        });
        await act(async () => { hook_result!.commit_edit(4, 1, '=INDEX(A:A,1):B5'); });
        expect(store.get('4:1')?.value).toBe('=INDEX(A:A,1):B5');
        expect(refused).not.toHaveBeenCalled();
        expect(bases).toHaveBeenCalled();
    });
});
