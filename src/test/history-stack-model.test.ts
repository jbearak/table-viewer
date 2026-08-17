import { describe, expect, it } from 'vitest';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    value_only_overlay,
    type CellHistoryDelta,
} from '../webview/history-cell-state-model';
import {
    action_focus_worksheet,
    action_is_single_worksheet,
    clear_history,
    commit_history_move,
    empty_history_stack,
    history_action,
    history_usage,
    measure_history_action,
    peek_history,
    record_history_action,
    type HistoryBounds,
    type HistoryChange,
    type HistoryStackState,
} from '../webview/history-stack-model';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const OTHER_SHEET: WorksheetTarget = { sheetIndex: 1, sheetName: 'Notes', worksheetId: 'rId2' };

function cell_change(
    row: number,
    column: number,
    text: string,
    worksheet: WorksheetTarget = SHEET,
): HistoryChange {
    const delta = build_cell_history_delta({
        worksheet,
        sourceRow: row,
        sourceColumn: column,
        before: absent_overlay(),
        after: value_only_overlay(history_value(text), history_value('base')),
        persistedValue: history_value('base'),
        persistedHyperlink: null,
    });
    if (delta === undefined) throw new Error('fixture built a delta that moved nothing');
    return { kind: 'cell', delta };
}

function highlight_change(
    row: number,
    column: number,
    worksheet: WorksheetTarget = SHEET,
): HistoryChange {
    return {
        kind: 'highlight',
        delta: {
            worksheet,
            sourceRow: row,
            sourceColumn: column,
            before: null,
            after: 'yellow',
        },
    };
}

/** Records a series of actions and returns the resulting state. */
function record_all(
    labels: readonly string[],
    bounds?: HistoryBounds,
    changes_for: (index: number) => readonly HistoryChange[] = (index) => [cell_change(index, 0, 'x')],
): HistoryStackState {
    let state = empty_history_stack();
    labels.forEach((label, index) => {
        const outcome = record_history_action(state, history_action(label, changes_for(index)), bounds);
        state = outcome.state;
    });
    return state;
}

describe('record_history_action', () => {
    it('pushes an action onto the undo stack', () => {
        const outcome = record_history_action(
            empty_history_stack(),
            history_action('Edit', [cell_change(0, 0, 'v')]),
        );
        expect(outcome.kind).toBe('recorded');
        expect(outcome.state.undoStack).toHaveLength(1);
        expect(outcome.state.undoStack[0]?.action.label).toBe('Edit');
    });

    it('refuses an action that moved nothing', () => {
        const outcome = record_history_action(empty_history_stack(), history_action('Nothing', []));
        expect(outcome.kind).toBe('empty');
        expect(outcome.state.undoStack).toHaveLength(0);
    });

    it('clears the redo stack, because recording branches the history', () => {
        // Redo entries describe content that no longer exists once the user has
        // edited from an undone position. Keeping them would let redo write
        // stale content over the new edit.
        const two = record_all(['A', 'B']);
        const undone = commit_history_move(two, 'undo');
        expect(undone.redoStack).toHaveLength(1);

        const outcome = record_history_action(undone, history_action('C', [cell_change(9, 0, 'c')]));
        expect(outcome.state.redoStack).toHaveLength(0);
        expect(outcome.state.undoStack.map((entry) => entry.action.label)).toEqual(['A', 'C']);
    });

    it('freezes the recorded action against later mutation of the caller\'s array', () => {
        const changes = [cell_change(0, 0, 'v')];
        const action = history_action('Edit', changes);
        changes.push(cell_change(1, 0, 'w'));
        expect(action.changes).toHaveLength(1);
        expect(Object.isFrozen(action.changes)).toBe(true);
    });
});

describe('measure_history_action', () => {
    it('counts a cell once even when the gesture touched it twice', () => {
        // A paste that overlaps its own source can emit two deltas for one
        // cell. The cell bound is about retained cells, not recorded changes.
        const entry = measure_history_action(history_action('Paste', [
            cell_change(4, 2, 'first'),
            cell_change(4, 2, 'second'),
        ]));
        expect(entry.cellCount).toBe(1);
    });

    it('counts a cell\'s value and its highlight separately', () => {
        const entry = measure_history_action(history_action('Both', [
            cell_change(4, 2, 'v'),
            highlight_change(4, 2),
        ]));
        expect(entry.cellCount).toBe(2);
    });

    it('does not collapse the same address on two worksheets', () => {
        const entry = measure_history_action(history_action('Discard all', [
            cell_change(1, 1, 'v', SHEET),
            cell_change(1, 1, 'v', OTHER_SHEET),
        ]));
        expect(entry.cellCount).toBe(2);
    });

    it('charges longer content more', () => {
        const small = measure_history_action(history_action('S', [cell_change(0, 0, 'x')]));
        const large = measure_history_action(history_action('L', [cell_change(0, 0, 'x'.repeat(5_000))]));
        expect(large.byteCost).toBeGreaterThan(small.byteCost);
    });
});

describe('bounds', () => {
    const bounds: HistoryBounds = {
        maxActions: 3,
        maxCells: 1_000_000,
        softMaxBytes: 128 * 1024 * 1024,
        hardMaxBytes: 256 * 1024 * 1024,
    };

    it('evicts oldest-first past the action bound', () => {
        const state = record_all(['A', 'B', 'C', 'D', 'E'], bounds);
        expect(state.undoStack.map((entry) => entry.action.label)).toEqual(['C', 'D', 'E']);
    });

    it('reports how many entries an eviction dropped', () => {
        const full = record_all(['A', 'B', 'C'], bounds);
        const outcome = record_history_action(full, history_action('D', [cell_change(3, 0, 'd')]), bounds);
        expect(outcome.kind).toBe('recorded');
        expect(outcome.kind === 'recorded' && outcome.evicted).toBe(1);
    });

    it('evicts for the cell bound as well as the action bound', () => {
        const cell_bounded: HistoryBounds = { ...bounds, maxActions: 100, maxCells: 3 };
        const state = record_all(
            ['A', 'B', 'C'],
            cell_bounded,
            (index) => [cell_change(index * 2, 0, 'v'), cell_change(index * 2 + 1, 0, 'v')],
        );
        // Two cells per action, so only the newest fits under a bound of three.
        expect(state.undoStack.map((entry) => entry.action.label)).toEqual(['C']);
    });

    it('keeps the newest action when it alone overshoots the soft bound', () => {
        // The gesture a user most wants back is the enormous one they just made.
        const soft: HistoryBounds = { ...bounds, maxActions: 100, softMaxBytes: 100 };
        const state = record_all(['A', 'Big'], soft, (index) => (
            index === 0 ? [cell_change(0, 0, 'a')] : [cell_change(1, 0, 'b'.repeat(1_000))]
        ));
        expect(state.undoStack.map((entry) => entry.action.label)).toEqual(['Big']);
        expect(history_usage(state).bytes).toBeGreaterThan(soft.softMaxBytes);
    });

    it('refuses an action past the hard bound, clearing history behind a barrier', () => {
        const hard: HistoryBounds = { ...bounds, maxActions: 100, hardMaxBytes: 1_000 };
        const existing = record_all(['A', 'B'], hard);
        const outcome = record_history_action(
            existing,
            history_action('Huge paste', [cell_change(0, 0, 'x'.repeat(10_000))]),
            hard,
        );
        expect(outcome.kind).toBe('refused');
        expect(outcome.state.undoStack).toHaveLength(0);
        expect(outcome.state.redoStack).toHaveLength(0);
        expect(outcome.state.barrier).toEqual({ reason: 'action-too-large', label: 'Huge paste' });
    });

    it('reports a barrier rather than an exhausted stack, so undo can explain itself', () => {
        const hard: HistoryBounds = { ...bounds, hardMaxBytes: 1_000 };
        const refused = record_history_action(
            record_all(['A'], hard),
            history_action('Huge paste', [cell_change(0, 0, 'x'.repeat(10_000))]),
            hard,
        );
        expect(peek_history(refused.state, 'undo')).toEqual({
            kind: 'blocked',
            barrier: { reason: 'action-too-large', label: 'Huge paste' },
        });
        // Redo is simply empty: a barrier is about reaching backwards.
        expect(peek_history(refused.state, 'redo').kind).toBe('exhausted');
    });

    it('does not cross the barrier once recording resumes', () => {
        const hard: HistoryBounds = { ...bounds, hardMaxBytes: 1_000 };
        const refused = record_history_action(
            record_all(['A'], hard),
            history_action('Huge paste', [cell_change(0, 0, 'x'.repeat(10_000))]),
            hard,
        );
        const resumed = record_history_action(refused.state, history_action('After', [cell_change(1, 0, 'v')]), hard);
        const undone = commit_history_move(resumed.state, 'undo');
        expect(undone.undoStack).toHaveLength(0);
        expect(peek_history(undone, 'undo').kind).toBe('blocked');
    });
});

describe('peek_history and commit_history_move', () => {
    it('reports exhausted on an empty stack with no barrier', () => {
        expect(peek_history(empty_history_stack(), 'undo').kind).toBe('exhausted');
        expect(peek_history(empty_history_stack(), 'redo').kind).toBe('exhausted');
    });

    it('peeks the newest entry without consuming it', () => {
        const state = record_all(['A', 'B']);
        const peeked = peek_history(state, 'undo');
        expect(peeked.kind === 'available' && peeked.entry.action.label).toBe('B');
        // Replay is async and refusable, so a peek must leave the stack alone.
        expect(peek_history(state, 'undo')).toEqual(peeked);
        expect(state.undoStack).toHaveLength(2);
    });

    it('moves the entry to the other stack on commit', () => {
        const state = commit_history_move(record_all(['A', 'B']), 'undo');
        expect(state.undoStack.map((entry) => entry.action.label)).toEqual(['A']);
        expect(state.redoStack.map((entry) => entry.action.label)).toEqual(['B']);

        const redone = commit_history_move(state, 'redo');
        expect(redone.undoStack.map((entry) => entry.action.label)).toEqual(['A', 'B']);
        expect(redone.redoStack).toHaveLength(0);
    });

    it('is a no-op when the stack is empty, so a double commit cannot corrupt it', () => {
        const state = empty_history_stack();
        expect(commit_history_move(state, 'undo')).toBe(state);
        expect(commit_history_move(state, 'redo')).toBe(state);
    });

    it('round-trips a longer sequence back to where it started', () => {
        const start = record_all(['A', 'B', 'C']);
        let state = start;
        for (const _ of [0, 1, 2]) state = commit_history_move(state, 'undo');
        expect(state.undoStack).toHaveLength(0);
        for (const _ of [0, 1, 2]) state = commit_history_move(state, 'redo');
        expect(state.undoStack.map((entry) => entry.action.label)).toEqual(['A', 'B', 'C']);
        expect(state.redoStack).toHaveLength(0);
    });
});

describe('history_usage', () => {
    it('counts undone actions as still retained', () => {
        const state = commit_history_move(record_all(['A', 'B']), 'undo');
        expect(history_usage(state).actions).toBe(2);
        expect(history_usage(state).cells).toBe(2);
    });

    it('reports nothing for an empty stack', () => {
        expect(history_usage(empty_history_stack())).toEqual({ actions: 0, cells: 0, bytes: 0 });
    });
});

describe('clear_history', () => {
    it('drops both stacks', () => {
        const cleared = clear_history(record_all(['A', 'B']));
        expect(cleared.undoStack).toHaveLength(0);
        expect(cleared.redoStack).toHaveLength(0);
    });

    it('keeps a barrier, because the reason undo cannot reach back is still true', () => {
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000,
            softMaxBytes: 1_000,
            hardMaxBytes: 1_000,
        };
        const refused = record_history_action(
            empty_history_stack(),
            history_action('Huge', [cell_change(0, 0, 'x'.repeat(10_000))]),
            hard,
        );
        expect(clear_history(refused.state).barrier).toEqual(refused.state.barrier);
    });
});

describe('worksheet focus', () => {
    it('reports the worksheet of the first change, which is where the cursor lands', () => {
        const action = history_action('Discard all', [
            cell_change(0, 0, 'v', OTHER_SHEET),
            cell_change(1, 0, 'v', SHEET),
        ]);
        expect(action_focus_worksheet(action)).toEqual(OTHER_SHEET);
        expect(action_is_single_worksheet(action)).toBe(false);
    });

    it('recognizes a single-worksheet action', () => {
        const action = history_action('Paste', [cell_change(0, 0, 'v'), cell_change(1, 0, 'v')]);
        expect(action_is_single_worksheet(action)).toBe(true);
    });

    it('matches worksheets by identity, not by index', () => {
        // An external reorder moves a sheet's index without changing which sheet
        // the gesture belongs to.
        const reordered: WorksheetTarget = { ...SHEET, sheetIndex: 7 };
        const action = history_action('Paste', [
            cell_change(0, 0, 'v', SHEET),
            cell_change(1, 0, 'v', reordered),
        ]);
        expect(action_is_single_worksheet(action)).toBe(true);
    });

    it('carries the full worksheet target, not a bare index', () => {
        // A bare index replays onto whatever sheet now sits at it.
        const delta: CellHistoryDelta = (cell_change(2, 3, 'v').delta as CellHistoryDelta);
        expect(delta.worksheet.worksheetId).toBe('rId1');
        expect(delta.worksheet.sheetName).toBe('Data');
    });
});
