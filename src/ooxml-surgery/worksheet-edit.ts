import {
    apply_cell_edits,
    apply_utf8_splices,
    cells_present,
    col_index_to_letter,
    formula_count,
    set_dimension_row_extent,
    update_formula_cached_values,
    writable_worksheet_sheet_data,
    widen_dimension,
    type XlsxCellEdit,
} from '../xlsx-cell-write';
import {
    apply_hyperlink_edits,
    cleared_display_texts,
} from '../xlsx-hyperlink-write';
import type { WorksheetEditRequest, WorksheetEditResult } from './types';
import { is_xlsx_formula_text } from '../xlsx-formula';
import { utf8_text } from '../ooxml-worksheet-scan';

function appended_row_xml(
    row: NonNullable<WorksheetEditRequest['row_changes']>['appendRows'][number],
    namespace_prefix = '',
): string {
    if (!Number.isSafeInteger(row.row) || row.row < 0 || row.row >= 1_048_576) {
        throw new Error('Invalid appended XLSX row coordinate');
    }
    if (row.cellStyleIndexes.length === 0 || row.cellStyleIndexes.length > 256) {
        throw new Error('Invalid appended XLSX row width');
    }
    const height = row.height;
    if (height !== undefined && (!Number.isFinite(height) || height <= 0)) {
        throw new Error('Invalid appended XLSX row height');
    }
    if (row.rowStyleIndex !== undefined && (
        !Number.isSafeInteger(row.rowStyleIndex) || row.rowStyleIndex < 0
    )) throw new Error('Invalid appended XLSX row style');
    for (const flag of [row.thickTop, row.thickBottom, row.phonetic]) {
        if (flag !== undefined && flag !== true) {
            throw new Error('Invalid appended XLSX row-format flag');
        }
    }
    const cells = row.cellStyleIndexes.map((style, column) => {
        if (style === null || (style === 0 && (row.rowStyleIndex ?? 0) === 0)) return '';
        if (!Number.isSafeInteger(style) || style < 0) {
            throw new Error('Invalid appended XLSX cell style');
        }
        return `<${namespace_prefix}c r="${col_index_to_letter(column)}${row.row + 1}" s="${style}"/>`;
    }).join('');
    const style_attrs = row.rowStyleIndex === undefined
        ? ''
        : ` s="${row.rowStyleIndex}" customFormat="1"`;
    const height_attrs = height === undefined ? '' : ` ht="${height}" customHeight="1"`;
    const safe_attrs = [
        row.thickTop === true ? ' thickTop="1"' : '',
        row.thickBottom === true ? ' thickBot="1"' : '',
        row.phonetic === true ? ' ph="1"' : '',
    ].join('');
    return `<${namespace_prefix}row r="${row.row + 1}"${style_attrs}${height_attrs}${safe_attrs}>`
        + `${cells}</${namespace_prefix}row>`;
}

/** Remove a proved suffix and install blank/styled append shells in one splice. */
function apply_row_changes(
    xml: Uint8Array,
    changes: NonNullable<WorksheetEditRequest['row_changes']>,
): Uint8Array {
    if (changes.removeRows.length === 0 && changes.appendRows.length === 0) return xml;
    const {
        name: sheet_data_name,
        element: sheet_data,
        rows,
    } = writable_worksheet_sheet_data(xml);
    if (!Number.isSafeInteger(changes.sourceRowCount)
        || changes.sourceRowCount < 0
        || changes.sourceRowCount > 1_048_576) {
        throw new Error('Invalid XLSX source row extent');
    }
    const removals = [...changes.removeRows];
    if (new Set(removals).size !== removals.length
        || removals.some((row, index) => !Number.isSafeInteger(row)
            || row < 0
            || (index > 0 && row <= removals[index - 1]))) {
        throw new Error('Invalid XLSX tail-removal order');
    }
    const current_rows = [...rows.keys()].sort((left, right) => left - right);
    if (removals.length > 0) {
        const suffix = current_rows.slice(-removals.length);
        if (suffix.length !== removals.length
            || suffix.some((row, index) => row !== removals[index])) {
            throw new Error('XLSX tail removals are no longer the physical suffix');
        }
        for (const row of removals) {
            if (rows.get(row)?.length !== 1) {
                throw new Error('An XLSX tail row is missing or ambiguous');
            }
        }
    }
    const removal_set = new Set(removals);
    const retained_last = current_rows
        .filter((row) => !removal_set.has(row))
        .at(-1) ?? -1;
    let expected_append = changes.sourceRowCount - removals.length;
    for (const append of changes.appendRows) {
        if (append.row !== expected_append
            || (rows.has(append.row) && !removal_set.has(append.row))) {
            throw new Error('XLSX appended rows are not a contiguous new suffix');
        }
        expected_append += 1;
    }
    const namespace_prefix = sheet_data_name.includes(':')
        ? `${sheet_data_name.slice(0, sheet_data_name.indexOf(':'))}:`
        : '';
    const append_xml = changes.appendRows.map((row) =>
        appended_row_xml(row, namespace_prefix)).join('');
    const self_closing = sheet_data.inner_start === sheet_data.end;
    let updated: Uint8Array;
    if (self_closing) {
        if (removals.length > 0) throw new Error('An empty worksheet has no rows to remove');
        const open = utf8_text(xml, sheet_data.start, sheet_data.end);
        const expanded = open.replace(/\/\s*>$/, '>');
        updated = apply_utf8_splices(xml, [{
            start: sheet_data.start,
            end: sheet_data.end,
            text: `${expanded}${append_xml}</${sheet_data_name}>`,
        }]);
    } else {
        const splices = removals.map((row) => {
            const span = rows.get(row)![0];
            return { start: span.start, end: span.end, text: '' };
        });
        if (append_xml !== '') {
            splices.push({
                start: sheet_data.inner_end,
                end: sheet_data.inner_end,
                text: append_xml,
            });
        }
        updated = apply_utf8_splices(xml, splices);
    }
    const logical_retained_last = changes.sourceRowCount - removals.length - 1;
    const final_last = changes.appendRows.at(-1)?.row
        ?? Math.max(retained_last, logical_retained_last);
    const width = changes.appendRows[0]?.cellStyleIndexes.length ?? 1;
    return set_dimension_row_extent(updated, Math.max(0, final_last), Math.max(0, width - 1));
}

/**
 * Apply cell and hyperlink changes to one worksheet part without knowing about
 * its containing ZIP package. The host remains responsible for locating parts,
 * committing replacements atomically, and removing calcChain when reported.
 */
export function apply_worksheet_edits(request: WorksheetEditRequest): WorksheetEditResult {
    const structurally_changed = (request.row_changes?.removeRows.length ?? 0) > 0
        || (request.row_changes?.appendRows.length ?? 0) > 0;
    const hyperlink_edits = request.hyperlink_edits ?? [];
    const cleared_displays = hyperlink_edits.length > 0
        ? cleared_display_texts(request.worksheet_xml, hyperlink_edits)
        : [];
    const present = cleared_displays.length > 0
        ? cells_present(request.worksheet_xml, cleared_displays)
        : new Set<string>();
    const removed_rows = new Set(request.row_changes?.removeRows ?? []);
    const promotions: XlsxCellEdit[] = [];
    for (const { row, col, text } of cleared_displays) {
        if (removed_rows.has(row) || present.has(`${row}:${col}`)) continue;
        promotions.push({ row, col, value: text, force_text: true });
    }

    // Promotions precede explicit edits so the existing last-write-wins rule
    // gives the user's value priority when both address one coordinate.
    const cell_edits = promotions.length > 0
        ? [...promotions, ...request.cell_edits]
        : request.cell_edits;
    const structural_xml = request.row_changes
        ? apply_row_changes(request.worksheet_xml, request.row_changes)
        : request.worksheet_xml;
    let worksheet_xml = cell_edits.length > 0
        ? apply_cell_edits(structural_xml, cell_edits, request.write_options)
        : structural_xml;
    const invalidations = request.write_options.formula_result_invalidations ?? [];
    const structural_cache_targets = invalidations.length > 0
        ? invalidations
        : request.write_options.formula_result_updates?.map(({ row, column }) => ({
            row,
            column,
        })) ?? [];
    if (cell_edits.length === 0 && structural_cache_targets.length > 0) {
        worksheet_xml = update_formula_cached_values(
            worksheet_xml,
            structural_cache_targets,
            request.write_options.formula_result_updates ?? [],
        );
    }

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

    const formula_removed = (cell_edits.length > 0 || structurally_changed)
        && formula_count(worksheet_xml) < formula_count(request.worksheet_xml);
    return {
        worksheet_xml,
        relationships_xml,
        formula_removed,
        calculation_chain_stale: (cell_edits.length > 0 || structurally_changed) && (
            formula_removed
            || structurally_changed
            || cell_edits.some((edit) => (
                edit.force_text !== true
                && edit.runs === undefined
                && is_xlsx_formula_text(edit.value)
            ))
        ),
    };
}
