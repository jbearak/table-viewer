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
    unrenderable_formula_reason,
    type AnchorStructuralChanges,
    type FormulaAnchorWorkbook,
} from '../formula-anchor-layout';
import {
    anchor_formula,
    render_formula,
    type FormulaAnchors,
} from '../formula-anchors';
import type { PendingFormulaReferenceBasis } from '../pending-changes';
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
