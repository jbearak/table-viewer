import {
    apply_cell_edits,
    cells_present,
    formula_count,
    widen_dimension,
    type XlsxCellEdit,
} from '../xlsx-cell-write';
import {
    apply_hyperlink_edits,
    cleared_display_texts,
} from '../xlsx-hyperlink-write';
import type { WorksheetEditRequest, WorksheetEditResult } from './types';
import { is_xlsx_formula_text } from '../xlsx-formula';

/**
 * Apply cell and hyperlink changes to one worksheet part without knowing about
 * its containing ZIP package. The host remains responsible for locating parts,
 * committing replacements atomically, and removing calcChain when reported.
 */
export function apply_worksheet_edits(request: WorksheetEditRequest): WorksheetEditResult {
    const hyperlink_edits = request.hyperlink_edits ?? [];
    const cleared_displays = hyperlink_edits.length > 0
        ? cleared_display_texts(request.worksheet_xml, hyperlink_edits)
        : [];
    const present = cleared_displays.length > 0
        ? cells_present(request.worksheet_xml, cleared_displays)
        : new Set<string>();
    const promotions: XlsxCellEdit[] = [];
    for (const { row, col, text } of cleared_displays) {
        if (present.has(`${row}:${col}`)) continue;
        promotions.push({ row, col, value: text, force_text: true });
    }

    // Promotions precede explicit edits so the existing last-write-wins rule
    // gives the user's value priority when both address one coordinate.
    const cell_edits = promotions.length > 0
        ? [...promotions, ...request.cell_edits]
        : request.cell_edits;
    let worksheet_xml = cell_edits.length > 0
        ? apply_cell_edits(request.worksheet_xml, cell_edits, request.write_options)
        : request.worksheet_xml;

    if (cell_edits.length > 0) {
        let min_row = Infinity;
        let min_col = Infinity;
        let max_row = 0;
        let max_col = 0;
        for (const edit of cell_edits) {
            if (edit.row < min_row) min_row = edit.row;
            if (edit.col < min_col) min_col = edit.col;
            if (edit.row > max_row) max_row = edit.row;
            if (edit.col > max_col) max_col = edit.col;
        }
        worksheet_xml = widen_dimension(
            worksheet_xml,
            min_row,
            min_col,
            max_row,
            max_col,
        );
    }

    let relationships_xml: string | null = null;
    if (hyperlink_edits.length > 0) {
        const result = apply_hyperlink_edits(
            worksheet_xml,
            request.relationships_xml,
            hyperlink_edits,
        );
        worksheet_xml = result.sheet_xml;
        relationships_xml = result.rels_xml;
    }

    const formula_removed = cell_edits.length > 0
        && formula_count(worksheet_xml) < formula_count(request.worksheet_xml);
    return {
        worksheet_xml,
        relationships_xml,
        formula_removed,
        calculation_chain_stale: cell_edits.length > 0 && (
            formula_removed
            || cell_edits.some((edit) => (
                edit.force_text !== true
                && edit.runs === undefined
                && is_xlsx_formula_text(edit.value)
            ))
        ),
    };
}
