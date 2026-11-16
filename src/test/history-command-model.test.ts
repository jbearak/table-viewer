import { describe, expect, it } from 'vitest';
import {
    header_wait_warning,
    history_gesture_unrecorded_warning,
    history_refusal_warning,
    history_session_unavailable_warning,
    history_unanswered_warning,
    view_replay_wait_warning,
} from '../webview/history-command-model';

const worksheet = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };

describe('history_refusal_warning', () => {
    it('says why a replay refused over a refreshing file did nothing', () => {
        expect(history_refusal_warning('document-changed', 'undo', undefined))
            .toBe('Undo did not run because the file was refreshing. Try again.');
        expect(history_refusal_warning('document-changed', 'redo', undefined))
            .toBe('Redo did not run because the file was refreshing. Try again.');
    });

    it('says the same of a replay the host refused before it wrote anything', () => {
        // What the caller says when the refresh the replay lost to has not
        // arrived, so there is nothing to try it again against.
        expect(history_refusal_warning('not-current', 'undo', undefined))
            .toBe('Undo did not run because the file was refreshing. Try again.');
    });

    it('has no words for the refusals the caller answers another way', () => {
        // `busy` and `view-step`: the press is held, or started again.
        // `nothing-to-replay`: carried out, with nothing to carry out.
        // `header-row`: worded by `header_wait_warning`.
        for (const reason of ['busy', 'view-step', 'nothing-to-replay', 'header-row'] as const) {
            expect(history_refusal_warning(reason, 'undo', undefined)).toBeNull();
        }
    });

    it('says a host that is busy with something this window cannot see', () => {
        expect(history_refusal_warning('host-busy', 'redo', undefined))
            .toBe('Redo did not run because another change is still being applied. Try again.');
    });

    it('says a protocol fault as unavailable: a press must not vanish', () => {
        expect(history_refusal_warning('malformed', 'undo', undefined))
            .toBe(history_refusal_warning('unavailable', 'undo', undefined));
        expect(history_refusal_warning('malformed', 'undo', undefined))
            .toBe('Undo is unavailable: the change it would apply can no longer be reached.');
    });
});

describe('what a press says when it could not be carried out', () => {
    it('names a save still in flight', () => {
        expect(view_replay_wait_warning('saving', 'undo'))
            .toBe('Undo did not run because the file is still being saved. Try again.');
        expect(view_replay_wait_warning('saving', 'redo'))
            .toBe('Redo did not run because the file is still being saved. Try again.');
    });

    it('says a request the host has not answered', () => {
        expect(history_unanswered_warning('undo'))
            .toBe('Undo has not finished yet. If this window stays busy, reopen the file.');
        expect(history_unanswered_warning('redo'))
            .toBe('Redo has not finished yet. If this window stays busy, reopen the file.');
    });

    it('says a press not carried out because the change made before it was not applied', () => {
        expect(history_gesture_unrecorded_warning('undo'))
            .toBe('Undo did not run because the change made before it was not applied.');
        expect(history_gesture_unrecorded_warning('redo'))
            .toBe('Redo did not run because the change made before it was not applied.');
    });

    it('says an editing session that could not be started', () => {
        expect(history_session_unavailable_warning('redo'))
            .toBe('Redo is unavailable because editing could not be started.');
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
            .toBe("Can't undo this change while the header row is off: "
                + 'it was made when row 2 was the header row. '
                + 'Use row 2 as the header row to undo it.');
    });

    it('names the header row a change was made under when it cannot be carried for another reason', () => {
        expect(header_wait_warning({ reason: 'notice', worksheet, from: 1, to: 2 }, 'undo'))
            .toBe("Can't undo this change while row 2 is the header row: "
                + 'it was made when row 1 was the header row. '
                + 'Use row 1 as the header row to undo it.');
        expect(header_wait_warning({ reason: 'notice', worksheet, from: 0, to: 2 }, 'redo'))
            .toBe("Can't redo this change while row 2 is the header row: "
                + 'it was made when the header row was off. '
                + 'Turn the header row off to redo it.');
    });

    it('says which worksheet when the workbook has more than one', () => {
        expect(header_wait_warning(
            { reason: 'header-cell', worksheet, from: 1, to: 3, row: 2 }, 'undo', 'Second',
        )).toBe("Sheet “Second”: Can't undo this cell change while row 3 is the header row: "
            + 'it was made when row 3 was an ordinary row. '
            + 'Use another row as the header row, or turn the header row off, to undo it.');
        for (const wait of [
            { reason: 'header-cell' as const, worksheet, from: 1, to: 0, row: 0 },
            { reason: 'rows' as const, worksheet, from: 1, to: 3 },
            { reason: 'rows' as const, worksheet, from: 2, to: 0 },
            { reason: 'notice' as const, worksheet, from: 1, to: 2 },
        ]) {
            expect(header_wait_warning(wait, 'redo', 'Second'))
                .toBe(`Sheet “Second”: ${header_wait_warning(wait, 'redo')}`);
        }
    });
});
