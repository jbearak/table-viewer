import { describe, expect, it, vi } from 'vitest';
import type {
    HistoryReplayHighlightInput,
    HistoryReplayPreparedCell,
} from '../history-replay-protocol';
import {
    resolve_replay_display_focus,
    type ReplayFocusInputs,
} from '../history-replay-focus-model';

const SHEET = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const OTHER = { sheetIndex: 1, sheetName: 'Notes', worksheetId: 'rId2' };

function cell(
    ordinal: number,
    source_row: number,
    sheet_index = 0,
): HistoryReplayPreparedCell {
    return {
        ordinal,
        worksheet: sheet_index === 0 ? SHEET : OTHER,
        resolvedSheetIndex: sheet_index,
        sourceRow: source_row,
        sourceColumn: 0,
        overlay: { kind: 'absent' },
        persisted: { text: 'disk' },
        persistedHyperlink: null,
    };
}

function highlight(ordinal: number, source_row: number): HistoryReplayHighlightInput {
    return {
        ordinal,
        worksheet: SHEET,
        sourceRow: source_row,
        sourceColumn: 0,
        expected: null,
        desired: 'yellow',
    };
}

function inputs(overrides: Partial<ReplayFocusInputs> = {}): ReplayFocusInputs {
    return {
        cells: [],
        highlights: [],
        highlightSheetIndices: new Map(),
        focusSheetIndex: 0,
        ...overrides,
    };
}

/** An unsorted, unfiltered view: display row equals source row. */
const identity = (_sheet: number, source_row: number): number => source_row;

describe('resolve_replay_display_focus', () => {
    it('bounds the rows the replay touched in an unsorted view', () => {
        const focus = resolve_replay_display_focus(
            inputs({ cells: [cell(0, 7), cell(1, 3), cell(2, 5)] }),
            identity,
            4,
        );
        expect(focus).toEqual({ displayRowStart: 3, displayRowEnd: 7, mappingGeneration: 4 });
        expect(Object.isFrozen(focus)).toBe(true);
    });

    it('follows a sort rather than the source interval', () => {
        // Source rows 1 and 2 sit at display 9 and 0. A resolver that reported the
        // source interval would send the cursor to rows 1-2, which under this sort
        // hold entirely different data.
        const sorted = new Map([[1, 9], [2, 0]]);
        const focus = resolve_replay_display_focus(
            inputs({ cells: [cell(0, 1), cell(1, 2)] }),
            (_sheet, source_row) => sorted.get(source_row),
            1,
        );
        expect(focus).toEqual({ displayRowStart: 0, displayRowEnd: 9, mappingGeneration: 1 });
    });

    it('bounds only the visible rows of a partly filtered region', () => {
        // The hidden row is not a reason to refuse: the command has a truthful
        // visible target, and stretching the interval to cover the filtered row
        // would select rows the replay never touched.
        const visible = new Map([[2, 0], [8, 1]]);
        expect(resolve_replay_display_focus(
            inputs({ cells: [cell(0, 2), cell(1, 5), cell(2, 8)] }),
            (_sheet, source_row) => visible.get(source_row),
            2,
        )).toEqual({ displayRowStart: 0, displayRowEnd: 1, mappingGeneration: 2 });
    });

    it('answers null when every touched row is filtered out', () => {
        expect(resolve_replay_display_focus(
            inputs({ cells: [cell(0, 2), cell(1, 5)] }),
            () => undefined,
            2,
        )).toBeNull();
    });

    it('counts highlights, which carry no resolved sheet of their own', () => {
        // A highlight input is renderer-supplied and names a worksheet, not an
        // index; the lease's ordinal map is where the host's resolution lives.
        const focus = resolve_replay_display_focus(
            inputs({
                highlights: [highlight(0, 4), highlight(1, 6)],
                highlightSheetIndices: new Map([[0, 0], [1, 0]]),
            }),
            identity,
            1,
        );
        expect(focus).toEqual({ displayRowStart: 4, displayRowEnd: 6, mappingGeneration: 1 });
    });

    it('ignores rows on any sheet but the focus sheet', () => {
        // The cursor lands on one sheet, and a workbook-wide gesture can span
        // several; a row on another sheet is not a candidate position on this one.
        const focus = resolve_replay_display_focus(
            inputs({
                cells: [cell(0, 3), cell(1, 99, 1)],
                highlights: [highlight(2, 40)],
                highlightSheetIndices: new Map([[2, 1]]),
            }),
            identity,
            1,
        );
        expect(focus).toEqual({ displayRowStart: 3, displayRowEnd: 3, mappingGeneration: 1 });
    });

    it('costs one lookup per touched row, not one per row of the span', () => {
        // A two-cell gesture spanning a million rows. Walking the focus interval
        // would be a million inverse-map lookups on a keypress.
        const lookup = vi.fn(identity);
        const focus = resolve_replay_display_focus(
            inputs({ cells: [cell(0, 0), cell(1, 999_999), cell(2, 0)] }),
            lookup,
            1,
        );
        expect(focus).toEqual({
            displayRowStart: 0,
            displayRowEnd: 999_999,
            mappingGeneration: 1,
        });
        // Two, not three: the duplicated source row is asked about once.
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('answers null for a replay that touched nothing on the focus sheet', () => {
        expect(resolve_replay_display_focus(inputs(), identity, 1)).toBeNull();
    });
});
