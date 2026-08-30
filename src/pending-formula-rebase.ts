import type { SheetMeta } from './data-source/interface';
import type {
    PendingFormulaReferenceBasis,
    PendingStructuralChanges,
    RowIdentity,
} from './pending-changes';
import { is_xlsx_formula_edit } from './xlsx-cell-write';
import { workbook_a1_formula_references } from './xlsx-formula';

/**
 * Whether formulas in one pending-row set name provisional coordinates owned by
 * another set whose physical starting row has moved. Structured references are
 * intentionally absent: they follow table columns rather than physical rows.
 */
export interface PendingFormulaConflictCell {
    readonly rowIdentity: RowIdentity;
    readonly sourceColumn: number;
}

function basis_matches_sheet(
    basis: PendingFormulaReferenceBasis,
    sheet: SheetMeta,
    sheet_index: number,
): boolean {
    if (basis.targetWorksheetId !== undefined || sheet.worksheetId !== undefined) {
        return basis.targetWorksheetId !== undefined
            && basis.targetWorksheetId === sheet.worksheetId;
    }
    return basis.targetSheetName === sheet.name
        && basis.targetSheetIndex === sheet_index;
}

/** Capture the pending bands a newly-authored formula means right now. */
export function capture_pending_formula_reference_bases(
    value: string,
    formula_sheet_index: number,
    sheets: readonly SheetMeta[],
    structural_by_sheet: readonly PendingStructuralChanges[],
): readonly PendingFormulaReferenceBasis[] {
    if (!is_xlsx_formula_edit({ row: 0, col: 0, value })) return [];
    const references = workbook_a1_formula_references(
        value,
        formula_sheet_index,
        sheets.map((sheet) => sheet.name),
    );
    const bases: PendingFormulaReferenceBasis[] = [];
    for (const [target_index, structural] of structural_by_sheet.entries()) {
        const sheet = sheets[target_index];
        if (!sheet || structural.appendedRows.length === 0) continue;
        const provisionalStartRow = sheet.sourceRowCount - structural.tailRemovals.length;
        const provisionalRowCount = structural.appendedRows.length;
        const last = provisionalStartRow + provisionalRowCount - 1;
        if (!references.some((reference) =>
            reference.sourceSheetIndex === target_index
            && reference.lastRow >= provisionalStartRow
            && reference.firstRow <= last)) continue;
        bases.push(Object.freeze({
            targetSheetIndex: target_index,
            targetSheetName: sheet.name,
            ...(sheet.worksheetId === undefined ? {} : {
                targetWorksheetId: sheet.worksheetId,
            }),
            provisionalStartRow,
            provisionalRowCount,
        }));
    }
    return Object.freeze(bases);
}

export function pending_formula_cells_referencing_provisional_rows(
    formula_structural: PendingStructuralChanges,
    formula_source_cells: Readonly<Record<string, string | {
        readonly value: string;
        readonly formulaReferenceBases?: readonly PendingFormulaReferenceBasis[];
    }>>,
    target_structural: PendingStructuralChanges,
    formula_sheet_index: number,
    target_sheet_index: number,
    sheets: readonly SheetMeta[],
): readonly PendingFormulaConflictCell[] {
    const basis = target_structural.appendBasis;
    if (!basis || target_structural.appendedRows.length === 0) return [];
    const target = sheets[target_sheet_index];
    if (!target) return [];
    const first_provisional_row = basis.provisionalStartRow
        ?? basis.sourceRowCount - target_structural.tailRemovals.length;
    const current_provisional_row = target.sourceRowCount
        - target_structural.tailRemovals.length;
    const last_provisional_row = first_provisional_row
        + (basis.provisionalRowCount ?? target_structural.appendedRows.length) - 1;
    const sheet_names = sheets.map((sheet) => sheet.name);
    const references_provisional = (
        value: string,
        authored_bases: readonly PendingFormulaReferenceBasis[] | undefined,
    ): boolean => {
        if (authored_bases !== undefined) {
            const authored = authored_bases.find((entry) =>
                basis_matches_sheet(entry, target, target_sheet_index));
            return authored !== undefined
                && authored.provisionalStartRow !== current_provisional_row;
        }
        return current_provisional_row !== first_provisional_row
            && is_xlsx_formula_edit({ row: 0, col: 0, value })
            && workbook_a1_formula_references(
                value,
                formula_sheet_index,
                sheet_names,
            ).some((reference) => reference.sourceSheetIndex === target_sheet_index
                && reference.lastRow >= first_provisional_row
                && reference.firstRow <= last_provisional_row);
    };
    const conflicts: PendingFormulaConflictCell[] = [];
    for (const row of formula_structural.appendedRows) {
        for (const [column, cell] of Object.entries(row.cells)) {
            if (!references_provisional(cell.value, cell.formulaReferenceBases)) continue;
            conflicts.push({
                rowIdentity: { kind: 'pending', pendingRowId: row.id },
                sourceColumn: Number(column),
            });
        }
    }
    for (const [key, entry] of Object.entries(formula_source_cells)) {
        const [sourceRow, sourceColumn, extra] = key.split(':').map(Number);
        if (extra !== undefined
            || !Number.isSafeInteger(sourceRow)
            || !Number.isSafeInteger(sourceColumn)) continue;
        const value = typeof entry === 'string' ? entry : entry.value;
        const authored = typeof entry === 'string' ? undefined : entry.formulaReferenceBases;
        if (!references_provisional(value, authored)) continue;
        conflicts.push({
            rowIdentity: { kind: 'source', sourceRow },
            sourceColumn,
        });
    }
    return conflicts;
}

export function pending_formulas_reference_provisional_rows(
    formula_structural: PendingStructuralChanges,
    target_structural: PendingStructuralChanges,
    formula_sheet_index: number,
    target_sheet_index: number,
    sheets: readonly SheetMeta[],
): boolean {
    return pending_formula_cells_referencing_provisional_rows(
        formula_structural,
        {},
        target_structural,
        formula_sheet_index,
        target_sheet_index,
        sheets,
    ).length > 0;
}
