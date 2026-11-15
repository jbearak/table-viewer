import { describe, expect, it } from 'vitest';
import { history_refusal_warning } from '../webview/history-command-model';
import {
    HEADER_CHANGE_BARRIER_MESSAGE,
    history_needs_header_change_barrier,
    install_header_change_barrier,
    type HistoryChange,
    type HistoryStackState,
} from '../webview/history-stack-model';

const DATA = { sheetIndex: 0, sheetName: 'Data' };
const OTHER = { sheetIndex: 1, sheetName: 'Other' };

function state(undo: readonly HistoryChange[], redo: readonly HistoryChange[] = []): HistoryStackState {
    const entry = (change: HistoryChange, id: number) => ({
        action: { label: 'Edit', changes: [change] },
        cellCount: 1,
        byteCost: 1,
        epoch: 0,
        id,
    });
    return {
        undoStack: undo.map(entry),
        redoStack: redo.map((change, index) => entry(change, 100 + index)),
        barrier: undefined,
        epoch: 0,
    } as unknown as HistoryStackState;
}

const cell = (worksheet: typeof DATA, sourceRow: number) => ({
    kind: 'cell',
    delta: { worksheet, sourceRow, sourceColumn: 0 },
}) as unknown as HistoryChange;

const layout = (worksheet: typeof DATA) => ({
    kind: 'rowLayout',
    delta: { worksheet, before: null, after: null, pendingRows: [], pendingColumns: [], formatTemplates: [] },
}) as unknown as HistoryChange;

describe('history across a Header Row change', () => {
    // The header moves from row 1 (body start 1) to row 4 (body start 4):
    // source rows 0 through 3 cross the body boundary.
    const crossing = { start: 0, end: 4 };

    it('keeps cell history on rows that stay in the body, and on other worksheets', () => {
        expect(history_needs_header_change_barrier(state([cell(DATA, 6), cell(OTHER, 1)]), DATA, crossing))
            .toBe(false);
    });

    it('needs a barrier for a cell recorded on a row that crossed the body boundary, on either stack', () => {
        expect(history_needs_header_change_barrier(state([cell(DATA, 3)]), DATA, crossing)).toBe(true);
        expect(history_needs_header_change_barrier(state([], [cell(DATA, 0)]), DATA, crossing)).toBe(true);
    });

    it('needs a barrier for any row or column structure of the worksheet, but not another one', () => {
        expect(history_needs_header_change_barrier(state([layout(DATA)]), DATA, crossing)).toBe(true);
        expect(history_needs_header_change_barrier(state([layout(OTHER)]), DATA, crossing)).toBe(false);
    });

    it('installs a barrier that empties history and says why undo stops there', () => {
        const barred = install_header_change_barrier(state([layout(DATA)]));
        expect(barred.undoStack).toEqual([]);
        expect(barred.redoStack).toEqual([]);
        expect(barred.barrier).toEqual({ reason: 'header-change', label: 'Header Row' });
        expect(barred.epoch).toBe(1);
        expect(history_refusal_warning('blocked', 'undo', 'Header Row', 'header-change'))
            .toBe(HEADER_CHANGE_BARRIER_MESSAGE);
    });
});
