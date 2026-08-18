import { describe, expect, it } from 'vitest';
import { highlight_history_source } from '../webview/highlight-capture-model';
import type { CellHighlightState } from '../types';
import type { HighlightHistoryDelta } from '../webview/history-stack-model';

const SHEETS = [
    { name: 'Data', worksheetId: 'rId1' },
    { name: 'Notes', worksheetId: 'rId2' },
];

function state(
    sheets: (Record<string, string> | undefined)[],
    schema = 'schema-1',
): CellHighlightState {
    return {
        sourceDigest: 'digest',
        sheets: sheets.map((cells) => cells === undefined
            ? undefined
            : { schema, cells: cells as never }),
    };
}

function deltas(
    before: CellHighlightState | undefined,
    after: CellHighlightState | undefined,
    sheets: typeof SHEETS = SHEETS,
): HighlightHistoryDelta[] {
    return [...highlight_history_source({ before, after, sheets })].map((change) => {
        if (change.kind !== 'highlight') throw new Error('expected a highlight change');
        return change.delta;
    });
}

describe('highlight_history_source', () => {
    it('records a painted cell as null to colour', () => {
        const captured = deltas(state([{}]), state([{ '2:3': 'yellow' }]));
        expect(captured).toEqual([{
            worksheet: { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' },
            sourceRow: 2,
            sourceColumn: 3,
            before: null,
            after: 'yellow',
        }]);
    });

    it('records a cleared cell too, not just a painted one', () => {
        // Clearing is the half a diff over the new state's keys alone would miss.
        const captured = deltas(state([{ '0:0': 'green' }]), state([{}]));
        expect(captured).toEqual([expect.objectContaining({
            sourceRow: 0,
            sourceColumn: 0,
            before: 'green',
            after: null,
        })]);
    });

    it('records a recoloured cell as one change', () => {
        const captured = deltas(state([{ '1:1': 'yellow' }]), state([{ '1:1': 'blue' }]));
        expect(captured).toEqual([expect.objectContaining({ before: 'yellow', after: 'blue' })]);
    });

    it('ignores a cell the gesture left alone', () => {
        const captured = deltas(
            state([{ '0:0': 'yellow', '1:1': 'blue' }]),
            state([{ '0:0': 'yellow', '1:1': 'green' }]),
        );
        expect(captured).toEqual([expect.objectContaining({ sourceRow: 1, before: 'blue', after: 'green' })]);
    });

    it('records the whole worksheet target, never a bare index', () => {
        // A target that resolved by index alone would name a different worksheet
        // after a sheet move, and undo would repaint someone else's cells.
        const captured = deltas(state([undefined, {}]), state([undefined, { '0:0': 'blue' }]));
        expect(captured[0]!.worksheet).toEqual({
            sheetIndex: 1,
            sheetName: 'Notes',
            worksheetId: 'rId2',
        });
    });

    it('spans every sheet the gesture touched', () => {
        const captured = deltas(
            state([{}, {}]),
            state([{ '0:0': 'yellow' }, { '5:5': 'blue' }]),
        );
        expect(captured.map((delta) => delta.worksheet.sheetIndex)).toEqual([0, 1]);
    });

    it('captures a whole sheet appearing or disappearing', () => {
        expect(deltas(state([undefined]), state([{ '0:0': 'yellow' }])))
            .toEqual([expect.objectContaining({ before: null, after: 'yellow' })]);
        expect(deltas(state([{ '0:0': 'yellow' }]), state([undefined])))
            .toEqual([expect.objectContaining({ before: 'yellow', after: null })]);
    });

    it('skips a sheet whose schema moved, rather than pairing different cells', () => {
        // The schema is the sheet's row/column identity fingerprint. Across a
        // change in it, `2:3` on one side is not the cell `2:3` is on the other,
        // so a diff would record an undo that repaints the wrong cells.
        const before = state([{ '2:3': 'yellow' }], 'schema-1');
        const after = state([{ '2:3': 'blue' }], 'schema-2');
        expect(deltas(before, after)).toEqual([]);
    });

    it('skips a sheet it has no identity for', () => {
        const captured = deltas(state([{}, {}]), state([{ '0:0': 'yellow' }, { '0:0': 'blue' }]), [
            SHEETS[0]!,
        ]);
        expect(captured.map((delta) => delta.worksheet.sheetIndex)).toEqual([0]);
    });

    it('skips a malformed key rather than guessing a coordinate', () => {
        const captured = deltas(state([{}]), state([{ 'not-a-key': 'yellow', '1:2': 'blue' }]));
        expect(captured.map((delta) => [delta.sourceRow, delta.sourceColumn])).toEqual([[1, 2]]);
    });

    it('records nothing when the state did not move', () => {
        const unchanged = state([{ '0:0': 'yellow' }]);
        expect(deltas(unchanged, unchanged)).toEqual([]);
        expect(deltas(undefined, undefined)).toEqual([]);
    });

    it('captures a first-ever highlight, where there was no state at all', () => {
        expect(deltas(undefined, state([{ '0:0': 'yellow' }])))
            .toEqual([expect.objectContaining({ before: null, after: 'yellow' })]);
    });

    it('captures every highlight going away with the state', () => {
        // "Clear all" on a file whose highlight state then becomes undefined.
        expect(deltas(state([{ '0:0': 'yellow', '1:1': 'blue' }]), undefined))
            .toEqual([
                expect.objectContaining({ before: 'yellow', after: null }),
                expect.objectContaining({ before: 'blue', after: null }),
            ]);
    });
});
