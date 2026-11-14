// Pending-change notices (ADR 0006): before Save, Table Viewer speaks only
// about what the grid can't show. Plain input, plain output: no App render.
import { describe, expect, it } from 'vitest';
import type {
    FormulaDeletedItem,
    FormulaDivergenceItem,
    FormulaDivergenceReview,
} from '../formula-divergence-review';
import type { PendingStructuralConflict } from '../pending-changes';
import type { ColumnLayout } from '../worksheet-layout';
import {
    INLINE_FORMULA_LIMIT,
    formula_cell_label,
    formula_impact_text,
    formula_location,
    is_conflict_dismissal,
    pending_change_notices,
    save_counts_text,
    save_summary,
    saved_cell_edit_count,
    short_rows_note,
    type PendingChangeNotice,
    type PendingChangeNoticeInput,
} from '../webview/pending-change-notices';

const workbook: PendingChangeNoticeInput = {
    singleTable: false,
    activeSheetIndex: 0,
    worksheets: [{ name: 'Data', columnNames: ['Item', 'Qty', 'Price', 'Total'] }],
    refusals: [],
    dismissed: new Set(),
};

function review(parts: Partial<FormulaDivergenceReview>): FormulaDivergenceReview {
    return { items: [], counts: [], deleted: [], deletedCounts: [], ...parts };
}

function deleted(row: number, column: number, parts: Partial<FormulaDeletedItem> = {}): FormulaDeletedItem {
    return {
        targetSheetIndex: 0,
        sheetIndex: 0,
        row,
        column,
        formula: '=#REF!*B2',
        written: '=C2*B2',
        rows: [],
        columns: [{ kind: 'source', sourceColumn: 2 }],
        ...parts,
    };
}

function flagged(row: number, parts: Partial<FormulaDivergenceItem> = {}): FormulaDivergenceItem {
    return {
        targetSheetIndex: 0,
        sheetIndex: 0,
        row,
        column: 1,
        formula: '=SUM(B2:B4)',
        written: '=SUM(B2:B5)',
        classes: ['moved'],
        axes: ['row'],
        ...parts,
    };
}

function with_review(value: FormulaDivergenceReview | null, current = true): PendingChangeNoticeInput {
    return { ...workbook, formulaReview: { review: value, current } };
}

const kinds = (notices: readonly PendingChangeNotice[]) => notices.map((notice) => notice.kind);

describe('pending_change_notices', () => {
    it('says nothing about a plain insert, delete, or move: the grid tints are the record', () => {
        expect(pending_change_notices(workbook)).toEqual([]);
        // The host found nothing to warn about.
        expect(pending_change_notices(with_review(review({})))).toEqual([]);
    });

    it('counts the formulas a deleted column breaks, names the column, and lists them', () => {
        const [notice] = pending_change_notices(with_review(review({
            deleted: [deleted(1, 3), deleted(2, 3, { formula: '=#REF!*B3', written: '=C3*B3' })],
            deletedCounts: [{ targetSheetIndex: 0, formulas: 2 }],
        })));
        expect(notice).toMatchObject({
            kind: 'deletedReferences',
            role: 'status',
            severity: 'warning',
            sentences: [
                '2 formulas use column Price, which you deleted. After you save, they will show #REF!.',
                'Restore the column, or undo, to keep them working.',
            ],
        });
        // One worksheet: locations aren't qualified by its name.
        expect(notice!.formulas!.items.map((item) => [item.location, item.formula, item.written])).toEqual([
            ['D2', '=#REF!*B2', '=C2*B2'],
            ['D3', '=#REF!*B3', '=C3*B3'],
        ]);
        expect(notice!.formulas!.collapsed).toBe(false);
        expect(notice!.formulas!.items[0]!.goTo).toEqual({
            label: 'Go to cell',
            ariaLabel: 'Go to D2',
            intent: { kind: 'goToCell', sheetIndex: 0, row: 1, column: 3 },
            disabled: false,
        });
        // Never labelled like the external-change notice.
        expect(JSON.stringify(notice)).not.toContain('Review changes');
    });

    it('speaks of a deleted row without a number, since deleted rows show none', () => {
        const [notice] = pending_change_notices(with_review(review({
            deleted: [deleted(5, 2, { rows: [{ kind: 'source', sourceRow: 2 }], columns: [], formula: '=#REF!' })],
            deletedCounts: [{ targetSheetIndex: 0, formulas: 1 }],
        })));
        expect(notice!.sentences).toEqual([
            '1 formula uses a row you deleted. After you save, it will show #REF!.',
            'Restore the row, or undo, to keep it working.',
        ]);
    });

    it('names the worksheet only when the deletion is on another one', () => {
        const input: PendingChangeNoticeInput = {
            ...workbook,
            activeSheetIndex: 1,
            worksheets: [...workbook.worksheets, { name: 'Summary' }],
            formulaReview: {
                current: true,
                review: review({
                    deleted: [deleted(0, 0, { sheetIndex: 1 })],
                    deletedCounts: [{ targetSheetIndex: 0, formulas: 1 }],
                }),
            },
        };
        const [notice] = pending_change_notices(input);
        expect(notice!.sentences[0]).toBe(
            '1 formula uses column Price on Data, which you deleted. After you save, it will show #REF!.');
        expect(notice!.formulas!.items[0]!.location).toBe('Summary!A1');
    });

    it('falls back to plain words for unnamed or several deleted rows and columns', () => {
        const unnamed = pending_change_notices({
            ...with_review(review({
                deleted: [deleted(1, 0, { columns: [{ kind: 'source', sourceColumn: 9 }] })],
                deletedCounts: [{ targetSheetIndex: 0, formulas: 1 }],
            })),
        });
        expect(unnamed[0]!.sentences[0]).toBe('1 formula uses a column you deleted. After you save, it will show #REF!.');
        const both = pending_change_notices(with_review(review({
            deleted: [
                deleted(1, 0, { columns: [{ kind: 'source', sourceColumn: 1 }] }),
                deleted(2, 0, { columns: [], rows: [{ kind: 'source', sourceRow: 4 }] }),
            ],
            deletedCounts: [{ targetSheetIndex: 0, formulas: 2 }],
        })));
        expect(both[0]!.sentences).toEqual([
            '2 formulas use rows and columns you deleted. After you save, they will show #REF!.',
            'Restore the rows and columns, or undo, to keep them working.',
        ]);
        const named_pair = pending_change_notices(with_review(review({
            deleted: [deleted(1, 0, { columns: [{ kind: 'source', sourceColumn: 1 }, { kind: 'source', sourceColumn: 2 }] })],
            deletedCounts: [{ targetSheetIndex: 0, formulas: 1 }],
        })));
        expect(named_pair[0]!.sentences[0]).toBe(
            '1 formula uses columns Qty and Price, which you deleted. After you save, it will show #REF!.');
        // A deleted Pending Column is named by its header.
        const pending = pending_change_notices({
            ...workbook,
            worksheets: [{ name: 'Data', pendingColumnNames: new Map([['c1', 'Notes']]) }],
            formulaReview: {
                current: true,
                review: review({
                    deleted: [deleted(1, 0, { columns: [{ kind: 'pending', pendingColumnId: 'c1' }] })],
                    deletedCounts: [{ targetSheetIndex: 0, formulas: 1 }],
                }),
            },
        });
        expect(pending[0]!.sentences[0]).toContain('uses column Notes, which you deleted');
    });

    it('puts a long list behind a disclosure and says when the host capped it', () => {
        const many = Array.from({ length: INLINE_FORMULA_LIMIT + 2 }, (_, row) => deleted(row, 3));
        const [notice] = pending_change_notices(with_review(review({
            deleted: many,
            deletedCounts: [{ targetSheetIndex: 0, formulas: 700 }],
        })));
        expect(notice!.formulas).toMatchObject({
            total: 700,
            collapsed: true,
            disclosureLabel: 'Show 700 formulas',
            truncatedNote: `Showing the first ${INLINE_FORMULA_LIMIT + 2}.`,
        });
        expect(notice!.sentences[0]).toMatch(/^700 formulas use column Price/);
    });

    it('lists a formula naming two worksheets once', () => {
        const [notice] = pending_change_notices({
            ...workbook,
            worksheets: [...workbook.worksheets, { name: 'Other', columnNames: ['A'] }],
            formulaReview: {
                current: true,
                review: review({
                    deleted: [
                        deleted(1, 3),
                        deleted(1, 3, { targetSheetIndex: 1, columns: [{ kind: 'source', sourceColumn: 0 }] }),
                    ],
                    deletedCounts: [{ targetSheetIndex: 0, formulas: 1 }, { targetSheetIndex: 1, formulas: 1 }],
                }),
            },
        });
        expect(notice!.formulas!.items).toHaveLength(1);
        expect(notice!.sentences[0]).toBe('1 formula uses columns you deleted. After you save, it will show #REF!.');
    });

    it('explains a range a move changed, with the formula as saved and as written', () => {
        const [notice] = pending_change_notices(with_review(review({
            items: [flagged(6)],
            counts: [{ targetSheetIndex: 0, formulas: 1 }],
        })));
        expect(notice).toMatchObject({
            kind: 'changedRanges',
            role: 'status',
            sentences: [
                'Moving rows changed the range in 1 formula.',
                'A row you moved was the first or last row of its range.',
                'Excel might adjust it differently, so check it before you save.',
            ],
        });
        expect(notice!.formulas!.items).toEqual([expect.objectContaining({
            location: 'B7',
            formula: '=SUM(B2:B4)',
            written: '=SUM(B2:B5)',
        })]);
        expect(notice!.formulas!.items[0]!.note).toBeUndefined();
    });

    it('gives each formula its own reason when the reasons differ', () => {
        const [notice] = pending_change_notices(with_review(review({
            items: [
                flagged(6),
                flagged(7, { classes: ['refilled'], axes: ['column'] }),
            ],
            counts: [{ targetSheetIndex: 0, formulas: 2 }],
        })));
        expect(notice!.sentences).toEqual([
            'Your row and column changes changed the range in 2 formulas.',
            'Excel might adjust them differently, so check them before you save.',
        ]);
        expect(notice!.formulas!.items.map((item) => item.note)).toEqual([
            'A row you moved was the first or last row of its range.',
            'Columns went in beside a deleted first or last column of its range.',
        ]);
    });

    it('leaves out the as-written text when it matches', () => {
        const [notice] = pending_change_notices(with_review(review({
            items: [flagged(1, { formula: '=SUM(B2:B4)', written: '=SUM(B2:B4)' })],
            counts: [{ targetSheetIndex: 0, formulas: 1 }],
        })));
        expect(notice!.formulas!.items[0]!.written).toBeUndefined();
    });

    it('keeps a stale answer on screen but holds its Go to cell until the new one arrives', () => {
        const [notice] = pending_change_notices(with_review(review({
            deleted: [deleted(1, 3)],
            deletedCounts: [{ targetSheetIndex: 0, formulas: 1 }],
        }), false));
        expect(notice!.formulas!.items[0]!.goTo.disabled).toBe(true);
    });

    it('says what Save will refuse first: rule splits and formulas it cannot adjust', () => {
        const notices = pending_change_notices({
            ...with_review(review({
                items: [flagged(2, { classes: ['unadjustable'], formula: '=INDEX(A:A,1):B5', written: '=INDEX(A:A,1):B5' })],
                counts: [{ targetSheetIndex: 0, formulas: 1 }],
                deleted: [deleted(1, 3)],
                deletedCounts: [{ targetSheetIndex: 0, formulas: 1 }],
            })),
            refusals: ['Moving these rows would split the conditional formatting on B2:B500 into more than 64 rules. Save will refuse it.'],
        });
        expect(kinds(notices)).toEqual(['saveRefusal', 'deletedReferences']);
        expect(notices[0]).toMatchObject({
            role: 'alert',
            severity: 'refusal',
            sentences: [
                'Moving these rows would split the conditional formatting on B2:B500 into more than 64 rules. Save will refuse it.',
                "Table Viewer can't adjust 1 formula for these row and column changes, so Save will refuse it. "
                    + 'Undo the change, or edit it.',
            ],
        });
        expect(notices[0]!.formulas!.items[0]!.location).toBe('B3');
        // A refusal can't be dismissed: Save would stay refused with no word why.
        expect(notices[0]!.dismissKey).toBeUndefined();
    });

    it('says when the host could not check formulas', () => {
        const notices = pending_change_notices(with_review(null));
        expect(kinds(notices)).toEqual(['formulaCheckFailed']);
        expect(notices[0]!.sentences).toEqual([
            "Table Viewer couldn't check what these row and column changes do to formulas.",
        ]);
    });

    it('drops a dismissed warning until its content changes', () => {
        const input = with_review(review({
            deleted: [deleted(1, 3)],
            deletedCounts: [{ targetSheetIndex: 0, formulas: 1 }],
        }));
        const [notice] = pending_change_notices(input);
        const dismissed = new Set([notice!.dismissKey!]);
        expect(pending_change_notices({ ...input, dismissed })).toEqual([]);
        const changed = with_review(review({
            deleted: [deleted(1, 3), deleted(2, 3)],
            deletedCounts: [{ targetSheetIndex: 0, formulas: 2 }],
        }));
        expect(kinds(pending_change_notices({ ...changed, dismissed }))).toEqual(['deletedReferences']);
    });

    it('brings a dismissed warning back when the same formula breaks for another reason', () => {
        // Summary!A1 = SUM(Data!A2:A3): delete Data's column A and dismiss,
        // undo, then delete rows 2-3. Same cell, same rendering, same count.
        const sheets = {
            ...workbook,
            worksheets: [{ name: 'Summary', columnNames: ['Total'] }, { name: 'Data', columnNames: ['Amount'] }],
        };
        const breaks = (parts: Partial<FormulaDeletedItem>): PendingChangeNoticeInput => ({
            ...sheets,
            formulaReview: {
                current: true,
                review: review({
                    deleted: [deleted(0, 0, { targetSheetIndex: 1, formula: '=SUM(#REF!)', written: '=SUM(Data!A2:A3)', ...parts })],
                    deletedCounts: [{ targetSheetIndex: 1, formulas: 1 }],
                }),
            },
        });
        const column = breaks({ rows: [], columns: [{ kind: 'source', sourceColumn: 0 }] });
        const [notice] = pending_change_notices(column);
        const dismissed = new Set([notice!.dismissKey!]);
        expect(pending_change_notices({ ...column, dismissed })).toEqual([]);
        const rows = breaks({ columns: [], rows: [{ kind: 'source', sourceRow: 1 }, { kind: 'source', sourceRow: 2 }] });
        expect(kinds(pending_change_notices({ ...rows, dismissed }))).toEqual(['deletedReferences']);
        // Only which row was deleted differs: the words match, the warning still returns.
        const one_row = breaks({ columns: [], rows: [{ kind: 'source', sourceRow: 1 }] });
        const other_row = breaks({ columns: [], rows: [{ kind: 'source', sourceRow: 2 }] });
        const [first] = pending_change_notices(one_row);
        expect(pending_change_notices(other_row)[0]!.sentences).toEqual(first!.sentences);
        expect(kinds(pending_change_notices({ ...other_row, dismissed: new Set([first!.dismissKey!]) })))
            .toEqual(['deletedReferences']);
    });
});

describe('conflict notices', () => {
    const basis: PendingStructuralConflict = { reason: 'structuralBasisChanged', pendingRowIds: [], tailRemovalIds: [] };
    const rows: PendingStructuralConflict = { reason: 'rowLimitExceeded', pendingRowIds: ['p1'], tailRemovalIds: [] };
    const conflicted = (items: readonly PendingStructuralConflict[], extra: object = {}): PendingChangeNoticeInput => ({
        ...workbook,
        conflicts: { worksheetKey: 'Data', items, columnValuesLost: 0, ...extra },
    });

    it('shows the layout notice with its three actions, waiting for the formula counts', () => {
        const [notice] = pending_change_notices(conflicted([basis], { impact: { state: 'pending' } }));
        expect(notice).toMatchObject({
            kind: 'layoutConflict',
            role: 'alert',
            label: 'Row and column changes that need review',
            status: 'Checking formulas…',
            sentences: [
                'Data changed on disk after you inserted, deleted, or moved rows or columns.',
                "Table Viewer can't tell where those changes belong in the new version.",
            ],
        });
        expect(notice!.actions.map((action) => [action.label, action.disabled ?? false])).toEqual([
            ['Keep new rows at the end', true],
            ['Discard row and column changes on Data', true],
            ['Dismiss notice', false],
        ]);
    });

    it('adds the counts and lost values once the host answers, and Retry when it cannot', () => {
        const [ready] = pending_change_notices(conflicted([basis], {
            columnValuesLost: 2,
            impact: { state: 'ready', keep: { ref: 0, moved: 12 }, discard: { ref: 4, moved: 12 } },
        }));
        expect(ready!.sentences.slice(2)).toEqual([
            'Values typed in 2 new columns will be discarded.',
            'Keep new rows at the end: 12 formulas will point at different rows or columns.',
            'Discard row and column changes on Data: 4 formulas will show #REF! and 12 will point at different rows or columns.',
        ]);
        expect(ready!.status).toBeUndefined();
        const [unavailable] = pending_change_notices(conflicted([basis], { impact: { state: 'unavailable' } }));
        expect(unavailable!.sentences).toContain('Formula impact unavailable. Retry, or choose an action without the count.');
        expect(unavailable!.actions[0]).toEqual({ label: 'Retry', intent: { kind: 'retryFormulaImpact' } });
        expect(unavailable!.actions.every((action) => !action.disabled)).toBe(true);
    });

    it('offers only Discard for an unsupported structure, with its reason', () => {
        const [notice] = pending_change_notices(conflicted([{
            reason: 'unsupportedStructure',
            pendingRowIds: [],
            tailRemovalIds: [],
            message: "Can't save these row and column changes: no.",
        }]));
        expect(notice!.sentences).toEqual(["Data: Can't save these row and column changes: no."]);
        expect(notice!.actions.map((action) => action.label)).toEqual([
            'Discard row and column changes on Data',
            'Dismiss notice',
        ]);
    });

    it('keeps the pending-row notice to the reasons it can have', () => {
        const [notice] = pending_change_notices(conflicted([rows]));
        expect(notice).toMatchObject({
            kind: 'pendingRowConflict',
            heading: 'Pending rows need review',
            sentences: [
                'The worksheet structure changed, so these row changes cannot be saved until you edit or remove '
                    + 'pending rows, or cancel affected removals.',
                'The worksheet no longer has room for every pending row.',
            ],
        });
        expect(notice!.actions.map((action) => action.intent)).toEqual([
            { kind: 'goToAffectedRow', target: { kind: 'pendingRow', pendingRowId: 'p1' } },
            { kind: 'removePendingRows', pendingRowIds: ['p1'] },
            { kind: 'dismiss', key: notice!.dismissKey },
        ]);
        // A layout conflict beside it gets its own notice, not dead text here.
        const both = pending_change_notices(conflicted([basis, rows]));
        expect(kinds(both)).toEqual(['layoutConflict', 'pendingRowConflict']);
        expect(both[1]!.sentences.join(' ')).not.toContain('changed on disk');
    });

    it('dismisses each conflict notice on its own', () => {
        const input = conflicted([basis, rows]);
        const [layout, pending_rows] = pending_change_notices(input);
        expect(layout!.dismissKey).not.toBe(pending_rows!.dismissKey);
        expect(kinds(pending_change_notices({ ...input, dismissed: new Set([layout!.dismissKey!]) })))
            .toEqual(['pendingRowConflict']);
        expect(kinds(pending_change_notices({ ...input, dismissed: new Set([pending_rows!.dismissKey!]) })))
            .toEqual(['layoutConflict']);
        // Save clears these dismissals, and only these.
        expect(is_conflict_dismissal(layout!.dismissKey!)).toBe(true);
        expect(is_conflict_dismissal(pending_rows!.dismissKey!)).toBe(true);
        expect(is_conflict_dismissal('deleted:[1,[]]')).toBe(false);
    });

    it('comes before every formula warning', () => {
        const notices = pending_change_notices({
            ...conflicted([basis]),
            formulaReview: {
                current: true,
                review: review({ deleted: [deleted(1, 3)], deletedCounts: [{ targetSheetIndex: 0, formulas: 1 }] }),
            },
        });
        expect(kinds(notices)).toEqual(['layoutConflict', 'deletedReferences']);
    });
});

describe('save_summary', () => {
    const counts = (parts: { rows?: object; columns?: object }) => ({
        rows: { inserted: 0, appended: 0, deleted: 0, moved: 0, ...parts.rows },
        columns: { inserted: 0, deleted: 0, moved: 0, renamed: 0, ...parts.columns },
    });

    it('names no worksheet for a CSV or TSV file', () => {
        expect(save_summary({
            singleTable: true,
            activeSheetIndex: 0,
            worksheets: [{ sheetIndex: 0, name: 'Sheet1', counts: counts({ rows: { inserted: 1 } }), cellEdits: 0 }],
        })).toBe('Save: 1 row inserted.');
    });

    it('names worksheets in a workbook only when it helps', () => {
        const data = { sheetIndex: 0, name: 'Data', counts: counts({ rows: { inserted: 1 }, columns: { deleted: 1 } }), cellEdits: 3 };
        expect(save_summary({ singleTable: false, activeSheetIndex: 0, worksheets: [data] }))
            .toBe('Save: 1 row inserted, 1 column deleted, 3 cells edited.');
        // The changes are on a worksheet that isn't showing.
        expect(save_summary({ singleTable: false, activeSheetIndex: 1, worksheets: [data] }))
            .toBe('Save: Data: 1 row inserted, 1 column deleted, 3 cells edited.');
        expect(save_summary({
            singleTable: false,
            activeSheetIndex: 0,
            worksheets: [data, { sheetIndex: 1, name: 'Summary', cellEdits: 1 }],
        })).toBe('Save: Data: 1 row inserted, 1 column deleted, 3 cells edited; Summary: 1 cell edited.');
    });

    it('adds the padding note and is undefined with nothing countable', () => {
        expect(save_summary({
            singleTable: true,
            activeSheetIndex: 0,
            worksheets: [{
                sheetIndex: 0,
                name: 'Sheet1',
                counts: counts({ columns: { moved: 1 } }),
                cellEdits: 0,
                note: 'Short rows will be padded to 3 columns.',
            }],
        })).toBe('Save: 1 column moved. Short rows will be padded to 3 columns.');
        expect(save_summary({ singleTable: true, activeSheetIndex: 0, worksheets: [] })).toBeUndefined();
    });

    it('spells every count, leaving zeros out', () => {
        expect(save_counts_text(counts({
            rows: { inserted: 2, appended: 1, deleted: 1, moved: 3 },
            columns: { inserted: 1, deleted: 2, moved: 1, renamed: 1 },
        }), 0)).toBe('2 rows inserted, 1 row added at the end, 1 row deleted, 3 rows moved, 1 column inserted, '
            + '2 columns deleted, 1 column moved, 1 column renamed');
    });

    it('counts cell edits Save writes, not those on deleted rows or columns or renamed headers', () => {
        const changes = {
            rowLayout: {
                runs: [{ kind: 'source' as const, start: 0, count: 5 }],
                removedSourceRows: [{ start: 2, count: 2 }],
                discardedPendingRows: [],
            },
            columnLayout: {
                columns: [0, 1, 2].map((sourceColumn) => ({ kind: 'source' as const, sourceColumn })),
                removedSourceColumns: [2],
                discardedPendingColumns: [],
            },
        };
        // 0:1 is a renamed header; 2:0 and 3:1 are on deleted rows; 1:2 is in a deleted column.
        expect(saved_cell_edit_count(['0:1', '1:0', '2:0', '3:1', '1:2', '4:1'], changes, 1)).toBe(2);
        expect(saved_cell_edit_count(['1:0'], undefined, 0)).toBe(1);
    });
});

describe('small helpers', () => {
    it('labels a formula by the column name the grid shows, when there is one', () => {
        const worksheets = [
            { name: 'Data', prospectiveColumnNames: ['Item', 'Qty', undefined, 'Total'] },
            { name: 'Summary' },
        ];
        expect(formula_location({ singleTable: false, worksheets: worksheets.slice(0, 1) }, 0, 1, 3)).toBe('Total, row 2');
        expect(formula_location({ singleTable: false, worksheets }, 0, 1, 3)).toBe('Total, row 2 on Data');
        // No name over the column, or no Header Row: A1, qualified in a workbook of several sheets.
        expect(formula_location({ singleTable: false, worksheets }, 0, 1, 2)).toBe('Data!C2');
        expect(formula_location({ singleTable: false, worksheets }, 1, 0, 0)).toBe('Summary!A1');
        expect(formula_location({ singleTable: true, worksheets }, 1, 0, 0)).toBe('A1');
    });

    it('labels a prospective cell, qualified and quoted when asked', () => {
        expect(formula_cell_label('Summary', 3, 1)).toBe('Summary!B4');
        expect(formula_cell_label("Bob's sheet", 0, 27)).toBe("'Bob''s sheet'!AB1");
        expect(formula_cell_label(undefined, 6, 1)).toBe('B7');
    });

    it('counts #REF! formulas and formulas pointing at different rows or columns', () => {
        expect(formula_impact_text({ ref: 4, moved: 12 }))
            .toBe('4 formulas will show #REF! and 12 will point at different rows or columns.');
        expect(formula_impact_text({ ref: 1, moved: 0 })).toBe('1 formula will show #REF!.');
        expect(formula_impact_text({ ref: 0, moved: 1 })).toBe('1 formula will point at different rows or columns.');
        expect(formula_impact_text({ ref: 0, moved: 0 })).toBeUndefined();
    });

    it('notes padding only for a live column change with a shorter record', () => {
        const swapped: ColumnLayout = {
            columns: [
                { kind: 'source', sourceColumn: 0 },
                { kind: 'source', sourceColumn: 2 },
                { kind: 'source', sourceColumn: 1 },
            ],
            removedSourceColumns: [],
            discardedPendingColumns: [],
        };
        expect(short_rows_note({ columnLayout: swapped }, 2)).toBe('Short rows will be padded to 3 columns.');
        expect(short_rows_note({ columnLayout: swapped }, 3)).toBeUndefined();
        expect(short_rows_note({}, 2)).toBeUndefined();
    });
});
