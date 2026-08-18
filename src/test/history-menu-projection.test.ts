import { describe, expect, it } from 'vitest';
import {
    history_menu_projection,
    history_menu_projections_equal,
} from '../webview/history-menu-projection';
import {
    empty_history_stack,
    history_action,
    record_history_action,
    type HistoryStackState,
} from '../webview/history-stack-model';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    value_only_overlay,
} from '../webview/history-cell-state-model';
import type { WorksheetTarget } from '../types';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data' };

const BOUNDS = {
    maxActions: 100,
    maxCells: 1_000_000,
    softMaxBytes: 128 * 1024 * 1024,
    hardMaxBytes: 256 * 1024 * 1024,
};

function recorded(label: string, state = empty_history_stack()): HistoryStackState {
    const delta = build_cell_history_delta({
        worksheet: SHEET,
        sourceRow: 0,
        sourceColumn: 0,
        before: absent_overlay(),
        after: value_only_overlay(history_value('next'), history_value('base')),
        persistedValue: history_value('base'),
        persistedHyperlink: null,
    });
    if (delta === undefined) throw new Error('fixture built a delta that moved nothing');
    return record_history_action(
        state,
        history_action(label, [{ kind: 'cell', delta }]),
        BOUNDS,
    ).state;
}

describe('what the desktop menu is told about this window s history', () => {
    it('says nothing is available for an empty stack', () => {
        expect(history_menu_projection(empty_history_stack(), false)).toEqual({
            undoAvailable: false,
            redoAvailable: false,
            textEditing: false,
        });
    });

    it('names the gesture at the top of each stack', () => {
        const projection = history_menu_projection(recorded('Paste'), false);
        expect(projection.undoAvailable).toBe(true);
        expect(projection.undoLabel).toBe('Paste');
        // Nothing has been undone yet, so redo is empty AND unlabelled — a stale
        // label on an unavailable item is what the omission prevents.
        expect(projection.redoAvailable).toBe(false);
        expect(projection.redoLabel).toBeUndefined();
    });

    it('reports a barrier as simply nothing further to undo', () => {
        // A barrier is why the stack ends, not a third state for the item: it greys
        // out either way, and a disabled item cannot be clicked to hear the reason.
        const state: HistoryStackState = {
            ...empty_history_stack(),
            barrier: { reason: 'action-too-large', label: 'Paste 4M cells' },
        };
        const projection = history_menu_projection(state, false);
        expect(projection.undoAvailable).toBe(false);
        expect(projection.undoLabel).toBeUndefined();
    });

    it('passes through the one thing the stack cannot know', () => {
        // And there is exactly one. A replay in flight is deliberately absent: it
        // changes neither menu item, so a field for it would be one nothing reads.
        expect(history_menu_projection(recorded('Paste'), true).textEditing).toBe(true);
        expect(history_menu_projection(recorded('Paste'), false).textEditing).toBe(false);
    });
});

describe('deciding whether the menu needs rebuilding', () => {
    const base = history_menu_projection(recorded('Paste'), false);

    it('treats an identical projection as no change', () => {
        expect(history_menu_projections_equal(
            base,
            history_menu_projection(recorded('Paste'), false),
        )).toBe(true);
    });

    it('treats never having posted as a change', () => {
        // A window whose history is empty still has to say so once: the menu was
        // built with enabled items before any viewer reported.
        expect(history_menu_projections_equal(undefined, base)).toBe(false);
    });

    it('notices each field that would change a menu item', () => {
        const changed = [
            history_menu_projection(recorded('Highlight'), false),
            history_menu_projection(empty_history_stack(), false),
            history_menu_projection(recorded('Paste'), true),
        ];
        for (const next of changed) {
            expect(history_menu_projections_equal(base, next)).toBe(false);
        }
    });
});
