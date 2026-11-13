import { describe, expect, it } from 'vitest';
import type { SheetMeta } from '../data-source/interface';
import type { PendingStructuralChanges } from '../pending-changes';
import {
    capture_pending_formula_reference_bases,
    pending_formula_cells_referencing_provisional_rows,
    pending_formulas_reference_provisional_rows,
} from '../pending-formula-rebase';

function sheet(name: string, sourceRowCount: number): SheetMeta {
    return {
        name,
        rowCount: sourceRowCount,
        sourceRowCount,
        columnCount: 2,
        merges: [],
        hasFormatting: true,
    };
}

function pending(
    value: string,
    admittedAt: number,
    provisionalStartRow?: number,
    provisionalRowCount?: number,
): PendingStructuralChanges {
    return {
        formatTemplates: [{ id: 'format', format: { kind: 'none' } }],
        appendedRows: [{
            id: `row:${value}`,
            cells: { 0: { value } },
            formatTemplateId: 'format',
            createdOrder: 1,
        }],
        tailRemovals: [],
        appendBasis: {
            sourceRowCount: admittedAt,
            ...(provisionalStartRow === undefined ? {} : { provisionalStartRow }),
            ...(provisionalRowCount === undefined ? {} : { provisionalRowCount }),
            columnCount: 2,
            schemaFingerprint: 'schema',
        },
        conflicts: [],
    };
}

describe('pending formula rebase conflicts', () => {
    it('detects fixed and relative A1 references to an old provisional row', () => {
        const sheets = [sheet('Data', 6)];
        for (const formula of ['=A5', '=$A$5']) {
            const changes = pending(formula, 4);
            expect(pending_formulas_reference_provisional_rows(
                changes, changes, 0, 0, sheets,
            )).toBe(true);
        }
    });

    it('resolves explicit cross-sheet A1 references against the rebased target', () => {
        const formula_rows = pending('=Target!A5', 2);
        const target_rows = pending('value', 4);
        expect(pending_formulas_reference_provisional_rows(
            formula_rows,
            target_rows,
            0,
            1,
            [sheet('Formula', 2), sheet('Target', 6)],
        )).toBe(true);
    });

    it('does not treat structured references as provisional coordinates', () => {
        const changes = pending('=[@Amount]', 4);
        expect(pending_formulas_reference_provisional_rows(
            changes, changes, 0, 0, [sheet('Data', 6)],
        )).toBe(false);
    });

    it('keeps the original provisional coordinate when the pending removal count changes', () => {
        const changes: PendingStructuralChanges = {
            ...pending('=A6', 6, 5),
            tailRemovals: [{
                appendHistoryId: 'removed-5',
                sourceRow: 4,
                savedFingerprint: 'saved-5',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }, {
                appendHistoryId: 'removed-6',
                sourceRow: 5,
                savedFingerprint: 'saved-6',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }],
        };

        // The current provisional start is row 4, but the formula was authored
        // when the appended row occupied row 5 (A6 in one-based notation).
        expect(pending_formulas_reference_provisional_rows(
            changes, changes, 0, 0, [sheet('Data', 6)],
        )).toBe(true);
    });

    it('keeps a removed pending row coordinate in the provisional high-water range', () => {
        // Two rows originally occupied A5:A6. The second pending row was removed,
        // but a formula retained on the first still names its old A6 coordinate.
        const changes = pending('=A6', 4, 4, 2);
        expect(changes.appendedRows).toHaveLength(1);
        expect(pending_formulas_reference_provisional_rows(
            changes,
            changes,
            0,
            0,
            [sheet('Data', 6)],
        )).toBe(true);
    });

    it('identifies the exact source-cell formula that names a provisional row', () => {
        const target = pending('value', 4);
        expect(pending_formula_cells_referencing_provisional_rows(
            {
                formatTemplates: [],
                appendedRows: [],
                tailRemovals: [],
                conflicts: [],
            },
            {
                '1:0': { value: '=Target!A5' },
                '2:0': { value: 'unrelated' },
            },
            target,
            0,
            1,
            [sheet('Formula', 3), sheet('Target', 6)],
        )).toEqual([{
            rowIdentity: { kind: 'source', sourceRow: 1 },
            sourceColumn: 0,
        }]);
    });

    it('keeps the authoring basis across successive source-row rebases', () => {
        const target_when_authored = pending('value', 4, 4, 1);
        const authored = capture_pending_formula_reference_bases(
            '=Target!A5',
            0,
            [sheet('Formula', 2), sheet('Target', 4)],
            [{ formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] }, target_when_authored],
        );
        expect(authored).toMatchObject([{
            targetSheetIndex: 1,
            targetSheetName: 'Target',
            provisionalStartRow: 4,
            provisionalRowCount: 1,
        }]);

        expect(pending_formula_cells_referencing_provisional_rows(
            { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] },
            { '0:0': { value: '=Target!A5', formulaReferenceBases: authored } },
            target_when_authored,
            0,
            1,
            [sheet('Formula', 2), sheet('Target', 8)],
        )).toEqual([{
            rowIdentity: { kind: 'source', sourceRow: 0 },
            sourceColumn: 0,
        }]);
    });

    it('keeps the conflict check for references a partly anchored formula leaves unanchored', () => {
        // `=X!A3+SUM(Target!A1:A5)`: X!A3 is anchored; the Target range spans
        // the appended row A5 without a corner on it, so only bases protect it.
        const text = '=X!A3+SUM(Target!A1:A5)';
        const target_when_authored = pending('value', 4, 4, 1);
        const empty = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };
        const authored = capture_pending_formula_reference_bases(
            `=${' '.repeat(4)}+SUM(Target!A1:A5)`,
            0,
            [sheet('Formula', 2), sheet('Target', 4), sheet('X', 4)],
            [empty, target_when_authored, empty],
        );
        expect(authored).toHaveLength(1);
        const anchors = { references: [{
            start: 1,
            end: 5,
            worksheet: { sheetIndex: 2, sheetName: 'X' },
            corners: [{ row: { kind: 'fixed' as const, row: 3 } }],
        }] };
        // Target grows by four source rows: its appended row leaves the range.
        const grown = [sheet('Formula', 2), sheet('Target', 8), sheet('X', 4)];
        expect(pending_formula_cells_referencing_provisional_rows(
            empty,
            { '0:0': { value: text, formulaAnchors: anchors, formulaReferenceBases: authored } },
            target_when_authored,
            0,
            1,
            grown,
        )).toEqual([{ rowIdentity: { kind: 'source', sourceRow: 0 }, sourceColumn: 0 }]);
        // A formula whose every reference is anchored stores no bases and needs no check.
        expect(pending_formula_cells_referencing_provisional_rows(
            empty,
            { '0:0': { value: '=Target!A5', formulaAnchors: anchors } },
            target_when_authored,
            0,
            1,
            grown,
        )).toEqual([]);
    });

    it('does not conflict a formula authored after the pending band rebased', () => {
        const target = pending('value', 4, 4, 1);
        const rebased_sheets = [sheet('Formula', 2), sheet('Target', 8)];
        const authored = capture_pending_formula_reference_bases(
            '=Target!A9',
            0,
            rebased_sheets,
            [{ formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] }, target],
        );
        expect(pending_formula_cells_referencing_provisional_rows(
            { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] },
            { '0:0': { value: '=Target!A9', formulaReferenceBases: authored } },
            target,
            0,
            1,
            rebased_sheets,
        )).toEqual([]);
    });

    it('captures references to rows created by the same composed batch', () => {
        const empty: PendingStructuralChanges = {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        };
        expect(capture_pending_formula_reference_bases(
            '=A6',
            0,
            [sheet('Data', 4)],
            [empty],
            { 0: 2 },
        )).toMatchObject([{
            targetSheetIndex: 0,
            targetSheetName: 'Data',
            provisionalStartRow: 4,
            provisionalRowCount: 2,
        }]);
    });
});
