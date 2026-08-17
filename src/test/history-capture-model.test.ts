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
    begin_gesture_capture,
    build_cell_history_change,
    capture_history_action,
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

describe('begin_gesture_capture', () => {
    it('keeps changes in application order', () => {
        const gesture = begin_gesture_capture();
        gesture.record('0:0', capture(
            absent_overlay(), value_only_overlay(history_value('a'), history_value('disk')), DISK, 0, 0));
        gesture.record('1:0', capture(
            absent_overlay(), value_only_overlay(history_value('b'), history_value('disk')), DISK, 1, 0));

        const rows = gesture.changes.map((change) =>
            change.kind === 'cell' ? change.delta.sourceRow : -1);
        expect(rows).toEqual([0, 1]);
    });

    it('remembers the exact overlay it left, so a second touch transitions from it', () => {
        const gesture = begin_gesture_capture();
        const first = value_only_overlay(history_value('a'), history_value('disk'));
        gesture.record('0:0', capture(absent_overlay(), first));

        expect(gesture.overlay_at('0:0')).toBe(first);
        expect(gesture.overlay_at('1:0')).toBeUndefined();

        gesture.record('0:0', capture(
            gesture.overlay_at('0:0') ?? absent_overlay(),
            value_only_overlay(history_value('b'), history_value('disk')),
        ));
        const second = gesture.changes[1];
        if (second?.kind !== 'cell') throw new Error('expected a cell change');
        // Not 'disk': the second write starts from where the first one left it.
        expect(second.delta.value?.expected.content.text).toBe('a');
        expect(second.delta.value?.mode).toBe('semantic');
    });

    it('drops a no-op transition but still remembers the overlay', () => {
        const gesture = begin_gesture_capture();
        const overlay = value_only_overlay(history_value('a'), history_value('disk'));
        gesture.record('0:0', capture(overlay, overlay));

        expect(gesture.changes).toEqual([]);
        expect(gesture.overlay_at('0:0')).toBe(overlay);
    });

    it('builds one action for the whole gesture', () => {
        const gesture = begin_gesture_capture();
        gesture.record('0:0', capture(
            absent_overlay(), value_only_overlay(history_value('a'), history_value('disk')), DISK, 0, 0));
        gesture.record('1:0', capture(
            absent_overlay(), value_only_overlay(history_value('b'), history_value('disk')), DISK, 1, 0));

        const action = gesture.action('Paste');
        expect(action.label).toBe('Paste');
        expect(action.changes).toHaveLength(2);
    });
});

describe('capture_history_action', () => {
    it('returns a plain action, leaving ownership to recording', () => {
        const change = build_cell_history_change(capture(
            absent_overlay(),
            value_only_overlay(history_value('typed'), history_value('disk')),
        ));
        if (change === undefined) throw new Error('expected a change');
        const action = capture_history_action('Edit cell', [change]);
        expect(Object.isFrozen(action)).toBe(false);

        // Recording is what owns it, and it accepts the plain action.
        const outcome = record_history_action(empty_history_stack(), action);
        expect(outcome.kind).toBe('recorded');
        if (outcome.kind !== 'recorded') throw new Error('expected a recording');
        expect(outcome.state.undoStack[0].action.label).toBe('Edit cell');
        expect(outcome.state.undoStack[0].action).not.toBe(action);
    });

    it('an empty gesture records nothing', () => {
        const gesture = begin_gesture_capture();
        const outcome = record_history_action(empty_history_stack(), gesture.action('Paste'));
        expect(outcome.kind).toBe('empty');
    });
});
