import { describe, expect, it } from 'vitest';
import { header_wait_warning, history_refusal_warning } from '../webview/history-command-model';

const worksheet = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };

describe('history_refusal_warning', () => {
    it('says why a replay refused over a refreshing file did nothing', () => {
        expect(history_refusal_warning('document-changed', 'undo', undefined))
            .toBe('Undo did not run because the file was refreshing. Try again.');
        expect(history_refusal_warning('document-changed', 'redo', undefined))
            .toBe('Redo did not run because the file was refreshing. Try again.');
    });

    it('stays silent for a key repeat, an empty stack, a protocol fault, and a header wait worded elsewhere', () => {
        for (const reason of ['busy', 'nothing-to-replay', 'malformed', 'header-row'] as const) {
            expect(history_refusal_warning(reason, 'undo', undefined)).toBeNull();
        }
    });
});

describe('header_wait_warning', () => {
    it('names the row that became the header for a cell change made on it as an ordinary row', () => {
        expect(header_wait_warning(
            { reason: 'header-cell', worksheet, from: 1, to: 3, row: 2 }, 'undo',
        )).toBe("Can't undo this cell change while row 3 is the header row: "
            + 'it was made when row 3 was an ordinary row. '
            + 'Use another row as the header row, or turn the header row off, to undo it.');
        // The header was off when the cell was typed.
        expect(header_wait_warning(
            { reason: 'header-cell', worksheet, from: 0, to: 1, row: 0 }, 'redo',
        )).toBe("Can't redo this cell change while row 1 is the header row: "
            + 'it was made when row 1 was an ordinary row. '
            + 'Use another row as the header row, or turn the header row off, to redo it.');
    });

    it('names the old header row for a column-name change', () => {
        for (const to of [0, 3]) {
            expect(header_wait_warning(
                { reason: 'header-cell', worksheet, from: 1, to, row: 0 }, 'undo',
            )).toBe("Can't undo this change while row 1 is not the header row: "
                + 'it changed a column name when row 1 was the header row. '
                + 'Use row 1 as the header row to undo it.');
        }
    });

    it('says which header row brings a row change back into reach', () => {
        expect(header_wait_warning({ reason: 'rows', worksheet, from: 1, to: 3 }, 'redo'))
            .toBe("Can't redo this row change while row 3 is the header row: "
                + 'it changes rows that are now in or above the header. '
                + 'Use row 1 as the header row to redo it.');
        expect(header_wait_warning({ reason: 'rows', worksheet, from: 0, to: 2 }, 'undo'))
            .toBe("Can't undo this row change while row 2 is the header row: "
                + 'it changes rows that are now in or above the header. '
                + 'Turn the header row off to undo it.');
        expect(header_wait_warning({ reason: 'rows', worksheet, from: 2, to: 0 }, 'undo'))
            .toBe("Can't undo this row change while the header row is off: "
                + 'it was made when row 2 was the header row. '
                + 'Use row 2 as the header row to undo it.');
    });

    it('points at the notice when that is what blocks', () => {
        expect(header_wait_warning({ reason: 'notice', worksheet, from: 1, to: 2 }, 'undo'))
            .toBe("Can't undo this change until the row and column changes notice is resolved.");
    });
});
