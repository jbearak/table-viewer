import { describe, expect, it } from 'vitest';
import { highlight_history_source } from '../webview/highlight-capture-model';
import type { HighlightCellDelta } from '../types';
import {
    absent_overlay,
    history_value,
    overlay_state_from_dirty_entry,
} from '../webview/history-cell-state-model';
import { build_cell_history_change } from '../webview/history-capture-model';
import { action_requires_edit_session } from '../webview/history-replay-request-model';
import {
    type HighlightHistoryDelta,
    type HistoryChange,
} from '../webview/history-stack-model';

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

describe('action_requires_edit_session', () => {
    // Built through the real constructor rather than as a literal: a hand-written
    // delta can satisfy the type while describing a shape the capture layer never
    // produces.
    const cell = build_cell_history_change({
        worksheet: { sheetIndex: 0 },
        sourceRow: 0,
        sourceColumn: 0,
        before: absent_overlay(),
        after: overlay_state_from_dirty_entry({ value: 'b', base: 'a' }),
        persisted: { value: history_value('a'), hyperlink: null },
    })!;
    const highlight: HistoryChange = {
        kind: 'highlight',
        delta: {
            worksheet: { sheetIndex: 0 },
            sourceRow: 0,
            sourceColumn: 0,
            before: null,
            after: 'yellow',
        },
    };

    it('is false for a highlight-only gesture', () => {
        // Highlights are durable workbook state, changed outside edit mode.
        expect(action_requires_edit_session({ label: 'Highlight cells', changes: [highlight] }))
            .toBe(false);
    });

    it('is true for a cell gesture', () => {
        expect(action_requires_edit_session({ label: 'Edit', changes: [cell] })).toBe(true);
    });

    it('is false for a structural gesture', () => {
        const structural: HistoryChange = {
            kind: 'pendingRows',
            delta: {
                worksheet: { sheetIndex: 0 },
                before: {
                    formatTemplates: [],
                    appendedRows: [],
                    tailRemovals: [],
                    conflicts: [],
                },
                after: {
                    formatTemplates: [],
                    appendedRows: [],
                    tailRemovals: [],
                    conflicts: [],
                },
            },
        };
        expect(action_requires_edit_session({ label: 'Rows', changes: [structural] }))
            .toBe(false);
    });

    it('is true for a MIXED gesture, decided on the cell and not the highlight', () => {
        // One chronological history means an action can hold both. Deciding on the
        // absence of highlights instead would let a mixed undo write pending edits
        // with no session behind it.
        expect(action_requires_edit_session({ label: 'Both', changes: [highlight, cell] }))
            .toBe(true);
    });

    it('is false for an empty action, which writes nothing', () => {
        expect(action_requires_edit_session({ label: 'Nothing', changes: [] })).toBe(false);
    });
});
