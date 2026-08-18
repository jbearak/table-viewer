import { describe, expect, it } from 'vitest';
import { highlight_state_deltas } from '../highlight-delta';
import type { CellHighlightState, HighlightCellDelta } from '../types';

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
): HighlightCellDelta[] {
    return [...highlight_state_deltas(before, after)];
}

describe('highlight_state_deltas', () => {
    it('reports a painted cell as null to colour', () => {
        expect(deltas(state([{}]), state([{ '2:3': 'yellow' }]))).toEqual([{
            sheetIndex: 0,
            sourceRow: 2,
            sourceColumn: 3,
            before: null,
            after: 'yellow',
        }]);
    });

    it('reports a cleared cell too, not just a painted one', () => {
        // Clearing is the half a diff over the new state's keys alone would miss.
        expect(deltas(state([{ '0:0': 'green' }]), state([{}])))
            .toEqual([expect.objectContaining({ before: 'green', after: null })]);
    });

    it('reports a recoloured cell as one delta', () => {
        expect(deltas(state([{ '1:1': 'yellow' }]), state([{ '1:1': 'blue' }])))
            .toEqual([expect.objectContaining({ before: 'yellow', after: 'blue' })]);
    });

    it('ignores a cell the gesture left alone', () => {
        expect(deltas(
            state([{ '0:0': 'yellow', '1:1': 'blue' }]),
            state([{ '0:0': 'yellow', '1:1': 'green' }]),
        )).toEqual([expect.objectContaining({ sourceRow: 1, before: 'blue', after: 'green' })]);
    });

    it('spans every sheet the gesture touched', () => {
        expect(deltas(
            state([{}, {}]),
            state([{ '0:0': 'yellow' }, { '5:5': 'blue' }]),
        ).map((delta) => delta.sheetIndex)).toEqual([0, 1]);
    });

    it('reports a whole sheet appearing or disappearing', () => {
        expect(deltas(state([undefined]), state([{ '0:0': 'yellow' }])))
            .toEqual([expect.objectContaining({ before: null, after: 'yellow' })]);
        expect(deltas(state([{ '0:0': 'yellow' }]), state([undefined])))
            .toEqual([expect.objectContaining({ before: 'yellow', after: null })]);
    });

    it('skips a sheet whose schema moved, rather than pairing different cells', () => {
        // The schema is the sheet's row/column identity fingerprint. Across a
        // change in it, `2:3` on one side is not the cell `2:3` is on the other,
        // so a delta would describe an undo that repaints the wrong cells.
        expect(deltas(
            state([{ '2:3': 'yellow' }], 'schema-1'),
            state([{ '2:3': 'blue' }], 'schema-2'),
        )).toEqual([]);
    });

    it('skips a malformed key rather than guessing a coordinate', () => {
        expect(deltas(state([{}]), state([{ 'not-a-key': 'yellow', '1:2': 'blue' }]))
            .map((delta) => [delta.sourceRow, delta.sourceColumn])).toEqual([[1, 2]]);
    });

    it('reports nothing when the state did not move', () => {
        const unchanged = state([{ '0:0': 'yellow' }]);
        expect(deltas(unchanged, unchanged)).toEqual([]);
        expect(deltas(undefined, undefined)).toEqual([]);
    });

    it('reports a first-ever highlight, where there was no state at all', () => {
        expect(deltas(undefined, state([{ '0:0': 'yellow' }])))
            .toEqual([expect.objectContaining({ before: null, after: 'yellow' })]);
    });

    it('reports every highlight going away with the state', () => {
        // "Clear all" on a file whose highlight state then becomes undefined.
        expect(deltas(state([{ '0:0': 'yellow', '1:1': 'blue' }]), undefined))
            .toEqual([
                expect.objectContaining({ before: 'yellow', after: null }),
                expect.objectContaining({ before: 'blue', after: null }),
            ]);
    });
});
