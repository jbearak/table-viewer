import { describe, expect, it } from 'vitest';
import { highlight_history_source } from '../webview/highlight-capture-model';
import type { HighlightCellDelta } from '../types';
import type { HighlightHistoryDelta } from '../webview/history-stack-model';

const SHEETS = [
    { name: 'Data', worksheetId: 'rId1' },
    { name: 'Notes', worksheetId: 'rId2' },
];

function delta(sheetIndex: number, sourceRow = 0, sourceColumn = 0): HighlightCellDelta {
    return { sheetIndex, sourceRow, sourceColumn, before: null, after: 'yellow' };
}

function captured(
    deltas: readonly HighlightCellDelta[],
    sheets: typeof SHEETS = SHEETS,
): HighlightHistoryDelta[] {
    return [...highlight_history_source(deltas, sheets)].map((change) => {
        if (change.kind !== 'highlight') throw new Error('expected a highlight change');
        return change.delta;
    });
}

describe('highlight_history_source', () => {
    it('records the whole worksheet target, never a bare index', () => {
        // A target that resolved by index alone would name a different worksheet
        // after a sheet move, and undo would repaint someone else's cells.
        expect(captured([delta(1, 4, 5)])).toEqual([{
            worksheet: { sheetIndex: 1, sheetName: 'Notes', worksheetId: 'rId2' },
            sourceRow: 4,
            sourceColumn: 5,
            before: null,
            after: 'yellow',
        }]);
    });

    it('carries both sides of the transition through untouched', () => {
        expect(captured([{
            sheetIndex: 0,
            sourceRow: 1,
            sourceColumn: 1,
            before: 'blue',
            after: null,
        }])).toEqual([expect.objectContaining({ before: 'blue', after: null })]);
    });

    it('skips a delta naming a sheet it has no identity for', () => {
        expect(captured([delta(0), delta(1), delta(7)])
            .map((change) => change.worksheet.sheetIndex)).toEqual([0, 1]);
    });

    it('records nothing for no deltas', () => {
        expect(captured([])).toEqual([]);
    });
});
