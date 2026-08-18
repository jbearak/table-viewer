import { describe, expect, it } from 'vitest';
import type { CellHyperlink, RichText } from '../cell-content';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    combined_overlay,
    history_value,
    hyperlink_only_overlay,
    value_only_overlay,
    type CellOverlayState,
} from '../webview/history-cell-state-model';
import {
    build_cell_history_change,
    type CellHistoryCapture,
    type PersistedCellHistoryState,
} from '../webview/history-capture-model';
import { empty_history_stack, record_history_action } from '../webview/history-stack-model';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/' };

const DISK: PersistedCellHistoryState = { value: history_value('disk'), hyperlink: null };

function capture(
    before: CellOverlayState,
    after: CellOverlayState,
    persisted: PersistedCellHistoryState = DISK,
    row = 0,
    column = 0,
): CellHistoryCapture {
    return {
        worksheet: SHEET,
        sourceRow: row,
        sourceColumn: column,
        before,
        after,
        persisted,
    };
}

describe('build_cell_history_change', () => {
    it('captures a first edit as entering the overlay', () => {
        const change = build_cell_history_change(capture(
            absent_overlay(),
            value_only_overlay(history_value('typed'), history_value('disk')),
        ));
        expect(change?.kind).toBe('cell');
        if (change?.kind !== 'cell') throw new Error('expected a cell change');
        expect(change.delta.value?.mode).toBe('membership');
        expect(change.delta.value?.expected.content.text).toBe('disk');
        expect(change.delta.value?.desired.content.text).toBe('typed');
        // Untouched dimensions stay out of the delta, so replay leaves them alone.
        expect(change.delta.hyperlink).toBeUndefined();
    });

    it('captures a revert as leaving the overlay', () => {
        const change = build_cell_history_change(capture(
            value_only_overlay(history_value('typed'), history_value('disk')),
            absent_overlay(),
        ));
        if (change?.kind !== 'cell') throw new Error('expected a cell change');
        expect(change.delta.value?.mode).toBe('membership');
        expect(change.delta.value?.desired.overlay).toBe('absent');
    });

    it('captures a link attached to an unedited cell without touching the value', () => {
        const change = build_cell_history_change(capture(
            absent_overlay(),
            hyperlink_only_overlay(history_value('disk'), LINK, null),
        ));
        if (change?.kind !== 'cell') throw new Error('expected a cell change');
        expect(change.delta.value).toBeUndefined();
        expect(change.delta.hyperlink?.desired.content).toEqual(LINK);
        expect(change.delta.hyperlink?.expected.content).toBeNull();
    });

    it('captures both dimensions of a combined overlay', () => {
        const change = build_cell_history_change(capture(
            absent_overlay(),
            combined_overlay(history_value('typed'), history_value('disk'), LINK, null),
        ));
        if (change?.kind !== 'cell') throw new Error('expected a cell change');
        expect(change.delta.value?.desired.content.text).toBe('typed');
        expect(change.delta.hyperlink?.desired.content).toEqual(LINK);
    });

    it('captures a formatting-only edit, whose text never moved', () => {
        const bold: RichText = { runs: [{ text: 'disk', style: { bold: true } }] };
        const change = build_cell_history_change(capture(
            absent_overlay(),
            value_only_overlay(history_value('disk', bold), history_value('disk')),
        ));
        if (change?.kind !== 'cell') throw new Error('expected a cell change');
        expect(change.delta.value?.desired.content.runs).toEqual(bold);
    });

    it('records nothing for a transition that moved nothing', () => {
        const overlay = value_only_overlay(history_value('typed'), history_value('disk'));
        expect(build_cell_history_change(capture(overlay, overlay))).toBeUndefined();
    });

    it('keeps the exact overlay intent the writer supplied', () => {
        // Both entries would serialize to {value: 'disk', base: 'disk', link},
        // so only the writer's own overlay distinguishes them.
        const link_only = build_cell_history_change(capture(
            absent_overlay(),
            hyperlink_only_overlay(history_value('disk'), LINK, null),
        ));
        const in_overlay = build_cell_history_change(capture(
            absent_overlay(),
            combined_overlay(history_value('disk'), history_value('disk'), LINK, null),
        ));
        if (link_only?.kind !== 'cell' || in_overlay?.kind !== 'cell') {
            throw new Error('expected cell changes');
        }
        expect(link_only.delta.value).toBeUndefined();
        expect(in_overlay.delta.value?.desired.overlay).toBe('present');
    });
});

describe('a gesture assembled from cell changes', () => {
    it('reaches recording as a plain action, leaving ownership to recording', () => {
        const change = build_cell_history_change(capture(
            absent_overlay(),
            value_only_overlay(history_value('typed'), history_value('disk')),
        ));
        if (change === undefined) throw new Error('expected a change');
        const action = { label: 'Edit cell', changes: [change] };
        expect(Object.isFrozen(action)).toBe(false);

        // Recording is what owns it, and it accepts the plain action.
        const outcome = record_history_action(empty_history_stack(), action);
        expect(outcome.kind).toBe('recorded');
        if (outcome.kind !== 'recorded') throw new Error('expected a recording');
        expect(outcome.state.undoStack[0].action.label).toBe('Edit cell');
        expect(outcome.state.undoStack[0].action).not.toBe(action);
    });

    it('a gesture that moved nothing records nothing', () => {
        const outcome = record_history_action(empty_history_stack(), { label: 'Paste', changes: [] });
        expect(outcome.kind).toBe('empty');
    });
});
