/**
 * Formula Anchors in the webview: the workbook the editor, the cell renderer,
 * and the live calculator render formulas against, what committing a formula
 * stores, and what an unrenderable formula shows (design: "Formula Anchors",
 * "Rendering formulas", and "Formula display and calculation" in the row and
 * column structure spec).
 *
 * Every formula the grid shows, opens in an editor, or sends to the
 * calculator goes through {@link formula_display}: source formulas with
 * implicit anchors, pending formulas with their stored ones. While no
 * worksheet has a live layout change and the formula stores no anchors, the
 * text is returned untouched, so a workbook without layouts behaves exactly as
 * before.
 */

import {
    formula_anchor_context,
    formula_anchor_workbook,
    formula_needs_rendering,
    prospective_column_of,
    prospective_row_count,
    prospective_row_of,
    unrenderable_formula_reason,
    workbook_has_live_layout_change,
    type AnchorStructuralChanges,
    type FormulaAnchorWorkbook,
} from '../formula-anchor-layout';
import type {
    FormulaCalculationAddress,
    FormulaCalculationEdit,
    FormulaCalculationLayout,
} from '../formula-calculation';
import {
    anchor_formula,
    render_formula,
    type AnchorWorksheet,
    type FormulaAnchors,
} from '../formula-anchors';
import {
    appended_rows,
    pending_structure_carries_formula_anchors,
    type PendingFormulaReferenceBasis,
    type PendingStructuralChanges,
} from '../pending-changes';
import { MAX_WORKBOOK_FORMULAS } from '../spreadsheet-safety';
import { xlsx_edit_writes_formula } from '../xlsx-cell-value';
import type { PendingFormulaCalculationEdit } from './edit-session-registry';
import type { SheetMeta } from '../data-source/interface';
import type { WorksheetTarget } from '../types';
import { UNKNOWN_XLSX_FORMULA_RESULT, type FormulaReferenceIssue } from '../xlsx-formula';

/** The worksheet facts anchoring reads from snapshot metadata. */
export type AnchorSheetMeta = Pick<
    SheetMeta,
    'name' | 'worksheetId' | 'sourceRowCount' | 'columnCount' | 'excelFirstRowHeader'
>;

/** H: the Header Row's 1-based number, or 0 without one, as the host and the store compute it. */
export function sheet_body_start(sheet: Pick<SheetMeta, 'excelFirstRowHeader'>): number {
    const header = sheet.excelFirstRowHeader;
    return header?.active === true && header.sourceRow !== undefined ? header.sourceRow + 1 : 0;
}

/**
 * The workbook as anchoring and rendering see it, from snapshot metadata and
 * each worksheet's structural Pending Changes. `xlsx` is false for CSV and
 * TSV, whose values are never anchored or rendered.
 */
export function webview_formula_workbook(
    xlsx: boolean,
    sheets: readonly AnchorSheetMeta[],
    changes_for: (sheet_index: number) => AnchorStructuralChanges | undefined,
): FormulaAnchorWorkbook {
    return formula_anchor_workbook(xlsx ? 'xlsx' : 'csv', sheets.map((sheet, sheetIndex) => {
        const target: WorksheetTarget = {
            sheetIndex,
            sheetName: sheet.name,
            ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
        };
        const changes = changes_for(sheetIndex);
        return {
            target,
            name: sheet.name,
            bodyStart: sheet_body_start(sheet),
            sourceRowCount: sheet.sourceRowCount,
            sourceColumnCount: sheet.columnCount,
            ...(changes === undefined ? {} : { changes }),
        };
    }));
}

export { unrenderable_formula_reason } from '../formula-anchor-layout';

/** The Unknown formula result an unrenderable formula displays. */
export function unrenderable_formula_result(issue: FormulaReferenceIssue): string {
    return `${UNKNOWN_XLSX_FORMULA_RESULT} (${unrenderable_formula_reason(issue)})`;
}

export type FormulaDisplay =
    | { readonly kind: 'text'; readonly text: string }
    | {
        readonly kind: 'unrenderable';
        /** The stored text, for copying. */
        readonly text: string;
        readonly reason: string;
        /** `??` with the reason. */
        readonly result: string;
    };

/**
 * The text a formula shows, opens in the editor, and calculates as: rendered
 * from its anchors for the current layouts, then through `retarget` (pending
 * cell moves). A formula with a construct no layout change can adjust is
 * `unrenderable` and keeps its stored text for copying only.
 */
export function formula_display(
    text: string,
    anchors: FormulaAnchors | undefined,
    workbook: FormulaAnchorWorkbook | undefined,
    sheet_index: number,
    retarget: (text: string) => string = (value) => value,
): FormulaDisplay {
    if (workbook === undefined || workbook.format !== 'xlsx' || !formula_needs_rendering(workbook, anchors)) {
        return { kind: 'text', text: retarget(text) };
    }
    let rendered;
    try {
        rendered = render_formula(text, anchors, formula_anchor_context(workbook, sheet_index));
    } catch {
        // Anchors that no longer fit their worksheet (a worksheet the workbook
        // lost) name nothing the layouts hold.
        return { kind: 'text', text: retarget(text) };
    }
    if (rendered.kind === 'unrenderable') {
        return {
            kind: 'unrenderable',
            text,
            reason: unrenderable_formula_reason(rendered.issue),
            result: unrenderable_formula_result(rendered.issue),
        };
    }
    return { kind: 'text', text: retarget(rendered.text) };
}

/** What a committed `.xlsx` formula stores beside its text. */
export type CommittedFormulaFields =
    | {
        readonly kind: 'fields';
        readonly formulaAnchors?: FormulaAnchors;
        readonly formulaReferenceBases?: readonly PendingFormulaReferenceBasis[];
    }
    | { readonly kind: 'refused'; readonly reason: string };

/**
 * Anchor a committed formula against the workbook's current layouts. Anchors
 * are stored only where `anchor_formula` keeps them (a target worksheet with a
 * live layout change, or a corner on a Pending Row or Pending Column), and a
 * formula with anchors drops its `formulaReferenceBases`. Without anchors the
 * bases are captured as before. A formula `anchor_formula` refuses is refused
 * with its message. Never anchors CSV or TSV, whose `=` values are text.
 */
export function committed_formula_fields(
    text: string,
    writes_formula: boolean,
    workbook: FormulaAnchorWorkbook | undefined,
    sheet_index: number,
    bases?: () => readonly PendingFormulaReferenceBasis[],
): CommittedFormulaFields {
    if (!writes_formula) return { kind: 'fields' };
    if (workbook === undefined || workbook.format !== 'xlsx') {
        return bases === undefined ? { kind: 'fields' } : { kind: 'fields', formulaReferenceBases: bases() };
    }
    const anchored = anchor_formula(text, formula_anchor_context(workbook, sheet_index));
    if (anchored.kind === 'refused') return anchored;
    if (anchored.anchors !== undefined) return { kind: 'fields', formulaAnchors: anchored.anchors };
    return bases === undefined ? { kind: 'fields' } : { kind: 'fields', formulaReferenceBases: bases() };
}

/** The stored fields of {@link CommittedFormulaFields}, for spreading into a cell. */
export function committed_formula_cell_fields(
    fields: Extract<CommittedFormulaFields, { kind: 'fields' }>,
): {
    readonly formulaAnchors?: FormulaAnchors;
    readonly formulaReferenceBases?: readonly PendingFormulaReferenceBasis[];
} {
    return {
        ...(fields.formulaAnchors === undefined ? {} : { formulaAnchors: fields.formulaAnchors }),
        ...(fields.formulaReferenceBases === undefined
            ? {}
            : { formulaReferenceBases: fields.formulaReferenceBases }),
    };
}

// --- Calculation at prospective coordinates ----------------------------------

/** What the calculation request is built from. */
export interface ProspectiveFormulaInputs {
    readonly workbook: FormulaAnchorWorkbook;
    readonly sheets: readonly (AnchorSheetMeta & { readonly formulaCells?: readonly number[] })[];
    readonly changes_for: (sheet_index: number) => PendingStructuralChanges | undefined;
    /** Cell edits at canonical source coordinates. */
    readonly edits: readonly FormulaCalculationEdit[];
    /** Pending Row cells. */
    readonly pending_edits: readonly PendingFormulaCalculationEdit[];
}

export interface ProspectiveFormulaRequest {
    readonly edits: readonly FormulaCalculationEdit[];
    readonly targets: readonly FormulaCalculationAddress[];
    readonly layouts: readonly FormulaCalculationLayout[];
    readonly prospectiveRowCounts: readonly number[];
    /** More formulas than one request may calculate; no targets are sent. */
    readonly tooMany: boolean;
}

/**
 * Whether the calculation request must be prospective: some worksheet has a
 * live layout change, or some formula stores anchors. Otherwise the request
 * is today's, unchanged.
 */
export function needs_prospective_formula_request(
    workbook: FormulaAnchorWorkbook | undefined,
    edits: readonly { readonly formulaAnchors?: FormulaAnchors }[],
    pending_edits: readonly { readonly formulaAnchors?: FormulaAnchors }[],
    changes_for: (sheet_index: number) => PendingStructuralChanges | undefined,
): boolean {
    if (workbook === undefined || workbook.format !== 'xlsx') return false;
    return workbook_has_live_layout_change(workbook)
        || edits.some((edit) => edit.formulaAnchors !== undefined)
        || pending_edits.some((edit) => edit.formulaAnchors !== undefined)
        || workbook.worksheets.some((_worksheet, index) => {
            const changes = changes_for(index);
            return changes !== undefined && pending_structure_carries_formula_anchors(changes);
        });
}

function layout_of(
    worksheet: AnchorWorksheet,
    changes: PendingStructuralChanges | undefined,
): FormulaCalculationLayout {
    return {
        bodyStart: worksheet.rows.fixedCount,
        ...(changes?.rowLayout === undefined ? {} : { rowLayout: changes.rowLayout }),
        ...(changes?.columnLayout === undefined ? {} : { columnLayout: changes.columnLayout }),
        band: [...appended_rows(changes)]
            .sort((left, right) => left.createdOrder - right.createdOrder)
            .map((row) => row.id),
        ...(changes === undefined || changes.tailRemovals.length === 0 ? {} : {
            tailRemovedSourceRows: changes.tailRemovals.map((removal) => removal.sourceRow),
        }),
    };
}

/** 0-based prospective row of a Pending Column cell key (`s:`, `p:`, or `f:`). */
function prospective_row_of_key(worksheet: AnchorWorksheet, key: string): number | undefined {
    const rest = key.slice(2);
    if (key.startsWith('p:')) return prospective_row_of(worksheet, { kind: 'pending', pendingRowId: rest });
    const row = Number(rest);
    if (!Number.isSafeInteger(row)) return undefined;
    if (key.startsWith('f:')) return row < worksheet.rows.fixedCount ? row : undefined;
    return key.startsWith('s:') ? prospective_row_of(worksheet, { kind: 'source', sourceRow: row }) : undefined;
}

/**
 * The calculation request at prospective coordinates: every cell edit,
 * Pending Row cell, and Pending Column cell at the address it will occupy
 * after save, edits on removed rows and columns left out, and every formula
 * of the workbook as a target, so each one renders and calculates for the
 * current layouts.
 */
export function prospective_formula_request(inputs: ProspectiveFormulaInputs): ProspectiveFormulaRequest {
    const { workbook } = inputs;
    const edits: FormulaCalculationEdit[] = [];
    const targets = new Map<string, FormulaCalculationAddress>();
    const target = (sheetIndex: number, row: number | undefined, column: number | undefined) => {
        if (row === undefined || column === undefined) return;
        targets.set(`${sheetIndex}:${row}:${column}`, { sheetIndex, row, column });
    };
    for (const edit of inputs.edits) {
        const worksheet = workbook.worksheets[edit.sheetIndex];
        if (worksheet === undefined) continue;
        const row = prospective_row_of(worksheet, { kind: 'source', sourceRow: edit.row });
        const column = prospective_column_of(worksheet, { kind: 'source', sourceColumn: edit.column });
        if (row === undefined || column === undefined) continue;
        edits.push({ ...edit, row, column });
        if (edit.writesFormula) target(edit.sheetIndex, row, column);
    }
    for (const edit of inputs.pending_edits) {
        const worksheet = workbook.worksheets[edit.sheetIndex];
        if (worksheet === undefined) continue;
        const row = prospective_row_of(worksheet, { kind: 'pending', pendingRowId: edit.pendingRowId });
        const column = prospective_column_of(worksheet, { kind: 'source', sourceColumn: edit.column });
        if (row === undefined || column === undefined) continue;
        edits.push({
            sheetIndex: edit.sheetIndex,
            row,
            column,
            value: edit.value,
            writesFormula: edit.writesFormula,
            ...(edit.runs === undefined ? {} : { runs: edit.runs }),
            ...(edit.formulaAnchors === undefined ? {} : { formulaAnchors: edit.formulaAnchors }),
        });
        if (edit.writesFormula) target(edit.sheetIndex, row, column);
    }
    const layouts = workbook.worksheets.map((worksheet, sheetIndex) => {
        const changes = inputs.changes_for(sheetIndex);
        for (const pending_column of changes?.pendingColumns ?? []) {
            const column = prospective_column_of(worksheet, { kind: 'pending', pendingColumnId: pending_column.id });
            if (column === undefined) continue;
            for (const [key, cell] of Object.entries(pending_column.cells)) {
                const row = prospective_row_of_key(worksheet, key);
                if (row === undefined) continue;
                const runs = cell.valueRuns?.runs;
                const writes_formula = xlsx_edit_writes_formula(
                    cell.value,
                    runs !== undefined && runs.length > 0 ? runs : undefined,
                );
                edits.push({
                    sheetIndex,
                    row,
                    column,
                    value: cell.value,
                    writesFormula: writes_formula,
                    ...(runs !== undefined && runs.length > 0 ? { runs } : {}),
                    ...(cell.formulaAnchors === undefined ? {} : { formulaAnchors: cell.formulaAnchors }),
                });
                if (writes_formula) target(sheetIndex, row, column);
            }
        }
        const packed = inputs.sheets[sheetIndex]?.formulaCells ?? [];
        for (let offset = 0; offset + 1 < packed.length; offset += 2) {
            target(
                sheetIndex,
                prospective_row_of(worksheet, { kind: 'source', sourceRow: packed[offset] }),
                prospective_column_of(worksheet, { kind: 'source', sourceColumn: packed[offset + 1] }),
            );
        }
        return layout_of(worksheet, changes);
    });
    edits.sort((left, right) => (left.sheetIndex - right.sheetIndex)
        || (left.row - right.row)
        || (left.column - right.column));
    const too_many = targets.size > MAX_WORKBOOK_FORMULAS || edits.length > MAX_WORKBOOK_FORMULAS;
    return {
        edits: too_many ? [] : edits,
        targets: too_many ? [] : [...targets.values()],
        layouts,
        prospectiveRowCounts: workbook.worksheets.map(prospective_row_count),
        tooMany: too_many,
    };
}

/**
 * The key a source cell's calculation result is stored under: its prospective
 * `row:column` in a prospective request, or `undefined` when it has none (a
 * removed row or column); its source `row:column` otherwise.
 */
export function formula_result_key(
    worksheet: AnchorWorksheet | undefined,
    prospective: boolean,
    source_row: number,
    source_column: number,
): string | undefined {
    if (!prospective || worksheet === undefined) return `${source_row}:${source_column}`;
    const row = prospective_row_of(worksheet, { kind: 'source', sourceRow: source_row });
    const column = prospective_column_of(worksheet, { kind: 'source', sourceColumn: source_column });
    return row === undefined || column === undefined ? undefined : `${row}:${column}`;
}
