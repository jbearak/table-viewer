// The webview's `.xlsx` action-time checks and Review Changes warning
// (delivery step 9c): the store's merge rules over the merges the host's
// support scan ships, the filtered-column move rule over the shipped
// AutoFilter, and the warning before Save for a rule the layouts would split
// past the writer's cap.
import { describe, expect, it } from 'vitest';
import {
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    MAX_STRUCTURAL_CONFLICT_MESSAGE_LENGTH,
    own_pending_structural_changes,
    type PendingStructuralChanges,
    type StructuralBasis,
} from '../pending-changes';
import {
    delete_rows,
    FILTERED_COLUMN_MOVE_MESSAGE,
    merge_anchor_message,
    MERGE_SPLIT_MESSAGE,
    move_columns,
    move_rows,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    merge_ranges_of,
    rule_split_warning_message,
    rule_split_warnings,
    structure_auto_filter,
} from '../webview/row-structure-model';
import type { AnchorWorksheetInput } from '../formula-anchor-layout';
import { is_wire_csv_save_rejection } from '../types';
import {
    move_columns as move_layout_columns,
    source_column_layout,
    source_row_layout,
} from '../worksheet-layout';
import { restructure_worksheet, WorksheetStructureRefusalError } from '../ooxml-surgery/worksheet-structure';

const FILTERED_WORKSHEET = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + Array.from({ length: 7 }, (_, row) => `<row r="${row + 1}">${['A', 'B', 'C', 'D', 'E', 'F']
        .map((letter) => `<c r="${letter}${row + 1}"><v>${row}</v></c>`).join('')}</row>`).join('')
    + '</sheetData><autoFilter ref="A1:E7"><filterColumn colId="1"><filters><filter val="1"/></filters></filterColumn></autoFilter></worksheet>';

const BASIS: StructuralBasis = {
    kind: 'xlsx',
    worksheetPartDigest: 'w',
    sharedStringsDigest: null,
    stylesDigest: 's',
    workbookDigest: 'b',
    sourceRowCount: 7,
    sourceColumnCount: 6,
};

/** Header Row 1, body rows 1-6, six columns. */
function context(overrides: Partial<WorksheetStructureContext> = {}): WorksheetStructureContext {
    return {
        worksheet: { sheetIndex: 0, sheetName: 'Data' },
        bodyStart: 1,
        sourceRowCount: 7,
        sourceColumnCount: 6,
        bodyViewTransformed: false,
        structuralBasis: BASIS,
        ...overrides,
    };
}

const source = (sourceRow: number) => ({ kind: 'source' as const, sourceRow });
const column = (sourceColumn: number) => ({ kind: 'source' as const, sourceColumn });

describe('shipped merges', () => {
    it('read as canonical merge ranges, skipping one the parser cannot read', () => {
        expect(merge_ranges_of(['E2:F3', 'B7', 'not a range'])).toEqual([
            { startRow: 1, startCol: 4, endRow: 2, endCol: 5 },
            { startRow: 6, startCol: 1, endRow: 6, endCol: 1 },
        ]);
    });

    it('drive the store\'s merge rules: deleting a surviving merge\'s first row, and moving part of one', () => {
        const merges = merge_ranges_of(['E2:F3']);
        expect(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context({ merges }), [source(1)]))
            .toMatchObject({ ok: false, refusal: { reason: 'merge-anchor', message: merge_anchor_message('rows') } });
        // Its second row is not its anchor, and deleting both drops the merge.
        expect(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context({ merges }), [source(2)]).ok).toBe(true);
        expect(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context({ merges }), [source(1), source(2)]).ok).toBe(true);
        expect(move_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context({ merges }), [source(2)], source(5)))
            .toMatchObject({ ok: false, refusal: { message: MERGE_SPLIT_MESSAGE } });
    });
});

describe('the shipped AutoFilter', () => {
    it('reads as its range\'s columns and filtered columns, or nothing when no column is filtered', () => {
        expect(structure_auto_filter({ ref: 'B1:D9', filteredColumns: [1, 3] })).toEqual({
            autoFilter: { firstColumn: 1, lastColumn: 3, filteredColumns: [1, 3] },
        });
        expect(structure_auto_filter({ ref: 'B1:D9', filteredColumns: [] })).toEqual({});
        expect(structure_auto_filter(undefined)).toEqual({});
    });

    it('refuses a column move that carries a filtered column outside the rendered range, as the writer does', () => {
        const filtered = context(structure_auto_filter({ ref: 'A1:E7', filteredColumns: [1] }));
        const cases: { readonly moved: number; readonly before: number | 'end'; readonly ok: boolean }[] = [
            // Filtered column B past the range's last column E, to after F.
            { moved: 1, before: 'end', ok: false },
            // B before A: the corners stay on A and E, so B leaves the range.
            { moved: 1, before: 0, ok: false },
            // B after C, still between the corners.
            { moved: 1, before: 3, ok: true },
            // An unfiltered column out of the range.
            { moved: 2, before: 'end', ok: true },
            // The last corner, E, moved to the end: the range follows it.
            { moved: 4, before: 'end', ok: true },
            // The first corner, A, moved past B: B is now before the range.
            { moved: 0, before: 3, ok: false },
        ];
        for (const { moved, before, ok } of cases) {
            const result = move_columns(
                EMPTY_PENDING_STRUCTURAL_CHANGES,
                filtered,
                [column(moved)],
                before === 'end' ? 'end' : column(before),
            );
            expect([moved, before, result.ok]).toEqual([moved, before, ok]);
            if (!result.ok) {
                expect(result.refusal).toEqual({ reason: 'filtered-column', message: FILTERED_COLUMN_MOVE_MESSAGE });
            }
            // The writer, given the same layout, agrees.
            const layout = move_layout_columns(source_column_layout(6), [column(moved)], before === 'end' ? 'end' : column(before));
            if (!layout.ok) throw new Error(layout.refusal.message);
            let writer_ok = true;
            try {
                restructure_worksheet({
                    worksheet_xml: Buffer.from(FILTERED_WORKSHEET, 'utf8'),
                    layout: { bodyStart: 1, rowLayout: source_row_layout(1, 6), columnLayout: layout.layout },
                    inserted_row_formats: new Map(),
                    appended_row_formats: [],
                    inserted_column_formats: new Map(),
                });
            } catch (error) {
                expect(error).toBeInstanceOf(WorksheetStructureRefusalError);
                expect((error as WorksheetStructureRefusalError).code).toBe('filtered-column-outside-range');
                writer_ok = false;
            }
            expect([moved, before, writer_ok]).toEqual([moved, before, ok]);
        }
    });
});

describe('the Review Changes split warning', () => {
    const rules = [{ kind: 'conditionalFormatting' as const, sqref: 'A2:A201', formulas: ['Other!$B2>0'] }];

    function inputs(changes?: PendingStructuralChanges): AnchorWorksheetInput[] {
        return [
            {
                target: { sheetIndex: 0, sheetName: 'Data' },
                name: 'Data',
                bodyStart: 1,
                sourceRowCount: 201,
                sourceColumnCount: 1,
                ...(changes === undefined ? {} : { changes }),
            },
            { target: { sheetIndex: 1, sheetName: 'Other' }, name: 'Other', bodyStart: 0, sourceRowCount: 1, sourceColumnCount: 2 },
        ];
    }

    function removed(count: number): PendingStructuralChanges {
        return {
            ...EMPTY_PENDING_STRUCTURAL_CHANGES,
            rowLayout: {
                runs: [{ kind: 'source', start: 1, count: 200 }],
                removedSourceRows: Array.from({ length: count }, (_, index) => ({ start: 2 + index * 2, count: 1 })),
                discardedPendingRows: [],
            },
        };
    }

    it('warns about a rule the layouts would split into more than 64 rules, counted per element', () => {
        const changes = removed(70);
        const warnings = rule_split_warnings(inputs(changes), 0, rules);
        expect(warnings).toEqual([{ kind: 'conditionalFormatting', sqref: 'A2:A201' }]);
        expect(rule_split_warning_message(warnings[0]!, changes)).toBe(
            'Deleting these rows would split the conditional formatting on A2:A201 into more than 64 rules. Save will refuse it.',
        );
    });

    it('stays quiet within the cap, without a layout change, and for a rule with no formulas', () => {
        expect(rule_split_warnings(inputs(removed(10)), 0, rules)).toEqual([]);
        expect(rule_split_warnings(inputs(), 0, rules)).toEqual([]);
        expect(rule_split_warnings(inputs(removed(70)), 0, [{ kind: 'dataValidation', sqref: 'A2:A201', formulas: [] }]))
            .toEqual([]);
    });

    it('names the gesture when the worksheet\'s changes are of one kind', () => {
        const warning = { kind: 'dataValidation' as const, sqref: 'B2:B500' };
        const moved: PendingStructuralChanges = {
            ...EMPTY_PENDING_STRUCTURAL_CHANGES,
            rowLayout: {
                runs: [{ kind: 'source', start: 3, count: 1 }, { kind: 'source', start: 1, count: 2 }],
                removedSourceRows: [],
                discardedPendingRows: [],
            },
        };
        expect(rule_split_warning_message(warning, moved)).toBe(
            'Moving these rows would split the data validation on B2:B500 into more than 64 rules. Save will refuse it.',
        );
        expect(rule_split_warning_message(warning, {
            ...moved,
            rowLayout: { ...moved.rowLayout!, removedSourceRows: [{ start: 2, count: 1 }] },
        })).toMatch(/^These row and column changes would split/);
    });
});

describe('an unsupportedStructure conflict\'s message', () => {
    const conflict = (fields: Record<string, unknown>) => ({
        reason: 'unsupportedStructure',
        pendingRowIds: [],
        tailRemovalIds: [],
        ...fields,
    });

    it('round-trips through the strict codec and the save rejection, bounded, on that reason only', () => {
        const owned = own_pending_structural_changes({ conflicts: [conflict({ message: "Can't save: it splits." })] });
        expect(owned.conflicts).toEqual([conflict({ message: "Can't save: it splits." })]);
        expect(() => own_pending_structural_changes({ conflicts: [conflict({ message: '' })] })).toThrow();
        expect(() => own_pending_structural_changes({
            conflicts: [conflict({ message: 'x'.repeat(MAX_STRUCTURAL_CONFLICT_MESSAGE_LENGTH + 1) })],
        })).toThrow();
        expect(() => own_pending_structural_changes({
            conflicts: [{ reason: 'structuralBasisChanged', pendingRowIds: [], tailRemovalIds: [], message: 'no' }],
        })).toThrow();
        const rejection = {
            reason: 'structuralConflict',
            worksheetOperationIndex: 0,
            structuralReason: 'unsupportedStructure',
            pendingRowIds: [],
            tailRemovalIds: [],
        };
        expect(is_wire_csv_save_rejection({ ...rejection, message: 'Why.' })).toBe(true);
        expect(is_wire_csv_save_rejection({ ...rejection, message: 7 })).toBe(false);
        expect(is_wire_csv_save_rejection({ ...rejection, structuralReason: 'templateChanged', message: 'Why.' })).toBe(false);
    });
});
