/**
 * Which Saves may keep their saved cells on screen until the reloaded file
 * arrives (the "saved presentation"). After a Save the grid still holds the
 * rows read before it; for a few seconds on a large workbook those rows show
 * each saved cell's old value. A Save that passes every test below has its
 * cells laid into the loader's rows instead (RowLoader.present_saved_cells),
 * so every reader shows what the file now holds, until the reload replaces
 * the rows as before.
 *
 * Deliberately narrow: only a Save whose cells the reload will show exactly as
 * saved, and nothing else.
 * - Value edits only. A link, a formula, a moved cell or a layout change can
 *   change cells other than the ones written, or show differently once read
 *   back.
 * - No formulas anywhere in the workbook. A saved value can change a formula
 *   result elsewhere, and not every dependent is knowable here (INDIRECT,
 *   3-D references).
 * - One worksheet, the one on screen, in its natural row order.
 * - Nothing left unsaved on that worksheet, so no pending edit is ever
 *   compared with a saved cell.
 */
import { parse_cell_key } from '../cell-key';
import { xlsx_edit_writes_formula } from '../xlsx-cell-value';
import {
    dirty_entry_value_dimension_present,
    type CsvSaveOperation,
    type CsvSaveWorksheetOperation,
} from '../types';

/** The Save as the grid recorded it when it was proposed. */
export interface SavedPresentationProposal {
    readonly save_request_id: string;
    /** The loader generation the Save was made against. */
    readonly generation: number;
}

/** What App knows about the Save and the workbook at its success. */
export interface SavedPresentationFacts {
    /** The success lifecycle's revision. */
    readonly revision: number;
    /** The highest revision a refresh ended for without adopting. */
    readonly ended_revision: number;
    /** No sheet of the workbook has a formula cell. */
    readonly formula_free: boolean;
    /** The worksheet's rows are in their natural order: no sort, no filter. */
    readonly natural_view: boolean;
}

export type SavedPresentationRefusal =
    | 'not-proposed-here'
    | 'reloaded-since-proposal'
    | 'refresh-already-ended'
    | 'not-one-worksheet'
    | 'not-this-worksheet'
    | 'structural'
    | 'workbook-has-formulas'
    | 'permuted-view'
    | 'link'
    | 'formula'
    | 'moved'
    | 'header-row'
    | 'not-a-value-edit'
    | 'bad-key'
    | 'left-dirty'
    | 'nothing-saved';

export interface SavedPresentationInput {
    readonly operation: CsvSaveOperation;
    /** The operation's payload for the mounted worksheet, if it has one. */
    readonly worksheet: CsvSaveWorksheetOperation | undefined;
    readonly proposal: SavedPresentationProposal | undefined;
    /** The loader's generation now. */
    readonly generation: number;
    readonly facts: SavedPresentationFacts;
    /** `.xlsx` editing: formulas and rich text apply. */
    readonly xlsx_editing: boolean;
    /** The source row of the active promoted header, if one is promoted. */
    readonly header_source_row: number | undefined;
    /** Entries still unsaved on this worksheet after the Save's own went. */
    readonly remaining_dirty: number;
}

/** Why this Save keeps today's behaviour, or undefined when it may present. */
export function saved_presentation_refusal(
    input: SavedPresentationInput,
): SavedPresentationRefusal | undefined {
    const { operation, worksheet, proposal, facts } = input;
    if (proposal?.save_request_id !== operation.saveRequestId) return 'not-proposed-here';
    if (proposal.generation !== input.generation) return 'reloaded-since-proposal';
    if (facts.ended_revision >= facts.revision) return 'refresh-already-ended';
    if (operation.worksheets.length !== 1) return 'not-one-worksheet';
    if (worksheet === undefined) return 'not-this-worksheet';
    if (worksheet.structuralChanges !== undefined) return 'structural';
    if (!facts.formula_free) return 'workbook-has-formulas';
    if (!facts.natural_view) return 'permuted-view';
    if (input.remaining_dirty > 0) return 'left-dirty';
    const entries = Object.entries(worksheet.dirtyEdits);
    if (entries.length === 0) return 'nothing-saved';
    for (const [key, entry] of entries) {
        const coordinates = parse_cell_key(key);
        if (coordinates === undefined) return 'bad-key';
        if (entry.link !== undefined) return 'link';
        if (entry.movedFrom !== undefined) return 'moved';
        if (!dirty_entry_value_dimension_present(entry)) return 'not-a-value-edit';
        if (
            input.xlsx_editing
            && xlsx_edit_writes_formula(entry.value, entry.valueRuns?.runs)
        ) return 'formula';
        if (coordinates.sourceRow === input.header_source_row) return 'header-row';
    }
    return undefined;
}
