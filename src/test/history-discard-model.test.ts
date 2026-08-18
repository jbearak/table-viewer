import { describe, expect, it } from 'vitest';
import type { CellHyperlink } from '../cell-content';
import type { WorksheetTarget } from '../types';
import {
    discard_history_source,
    type DiscardedWorksheet,
} from '../webview/history-discard-model';
import {
    overlay_for_direction,
    type CellHistoryDelta,
    type HistoryDirtyEntry,
} from '../webview/history-cell-state-model';
import type { HistoryChange } from '../webview/history-stack-model';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const OTHER: WorksheetTarget = { sheetIndex: 2, sheetName: 'Notes', worksheetId: 'rId2' };
const LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/' };

function worksheet(
    target: WorksheetTarget,
    entries: Record<string, HistoryDirtyEntry>,
): DiscardedWorksheet {
    return { target, entries: new Map(Object.entries(entries)) };
}

function deltas(worksheets: readonly DiscardedWorksheet[]): CellHistoryDelta[] {
    return [...discard_history_source(worksheets)].map((change: HistoryChange) => {
        if (change.kind !== 'cell') throw new Error('a discard records only cell changes');
        return change.delta;
    });
}

describe('discard_history_source', () => {
    it('records one removal per entry, across every worksheet', () => {
        const changes = deltas([
            worksheet(SHEET, {
                '0:0': { value: 'a', base: 'A' },
                '3:4': { value: 'b', base: 'B' },
            }),
            worksheet(OTHER, { '7:1': { value: 'c', base: 'C' } }),
        ]);
        expect(changes.map((delta) => [
            delta.worksheet.sheetIndex,
            delta.sourceRow,
            delta.sourceColumn,
        ])).toEqual([[0, 0, 0], [0, 3, 4], [2, 7, 1]]);
    });

    it('records the whole worksheet target, never a bare index', () => {
        const [delta] = deltas([worksheet(OTHER, { '0:0': { value: 'a', base: 'A' } })]);
        expect(delta.worksheet).toEqual(OTHER);
    });

    it('leaves the cell with no overlay, which is what a discard does', () => {
        const [delta] = deltas([worksheet(SHEET, { '0:0': { value: 'a', base: 'A' } })]);
        expect(overlay_for_direction(delta, 'undo').kind).toBe('present');
        expect(overlay_for_direction(delta, 'redo').kind).toBe('absent');
    });

    it('makes every transition membership, so no content is written back', () => {
        // The load-bearing property. A `semantic` redo would write the historical
        // persisted text over whatever is on disk now; `membership` removes the
        // overlay instead. It is also why the fabricated persisted side below is
        // never compared.
        const [delta] = deltas([
            worksheet(SHEET, { '0:0': { value: 'a', base: 'A', link: LINK, baseLink: null } }),
        ]);
        expect(delta.value?.mode).toBe('membership');
        expect(delta.hyperlink?.mode).toBe('membership');
    });

    it('records a link-only entry through its hyperlink dimension alone', () => {
        // Its value fields are the unedited anchor, not a value change, so a
        // value transition here would make undo rewrite the cell's text.
        const [delta] = deltas([
            worksheet(SHEET, { '0:0': { value: 'a', base: 'a', link: LINK, baseLink: null } }),
        ]);
        expect(delta.value).toBeUndefined();
        expect(delta.hyperlink?.mode).toBe('membership');
    });

    it('carries a pending base into the recorded overlay', () => {
        // Undoing the discard has to restore the entry with its base still
        // unobserved; promoting the placeholder would admit a save against it.
        const [delta] = deltas([
            worksheet(SHEET, { '0:0': { value: 'a', base: '', base_pending: true } }),
        ]);
        const before = overlay_for_direction(delta, 'undo');
        expect(before.kind === 'present' && before.value.kind === 'present'
            && before.value.basePending).toBe(true);
    });

    it('skips a malformed key rather than guessing a coordinate', () => {
        // One cell not undoable, versus an undo writing over a cell the user
        // never edited.
        expect(deltas([worksheet(SHEET, {
            'not-a-key': { value: 'a', base: 'A' },
            '1:-2': { value: 'b', base: 'B' },
            '01:2': { value: 'c', base: 'C' },
            '5:6': { value: 'd', base: 'D' },
        })]).map((delta) => [delta.sourceRow, delta.sourceColumn])).toEqual([[5, 6]]);
    });

    it('yields nothing for a session with no edits', () => {
        expect(deltas([worksheet(SHEET, {})])).toEqual([]);
    });

    it('yields lazily, so an oversized discard is never fully materialized', () => {
        // The recorder walks with a budget that stops mid-walk. A source that
        // built every sheet's changes first would allocate exactly the peak the
        // budget exists to avoid.
        let visited = 0;
        const entries: Iterable<[string, HistoryDirtyEntry]> = {
            *[Symbol.iterator]() {
                for (let row = 0; row < 1000; row += 1) {
                    visited += 1;
                    yield [`${row}:0`, { value: 'a', base: 'A' }] as [string, HistoryDirtyEntry];
                }
            },
        };
        const source = discard_history_source([{
            target: SHEET,
            entries: entries as ReadonlyMap<string, HistoryDirtyEntry>,
        }]);
        source.next();
        source.next();
        expect(visited).toBe(2);
    });
});
