// View steps in the history stack and in the modules around it: recorded,
// owned, measured, carried through every rewrite of history, named in the
// Edit menu, kept out of the cell replay protocol, and worded.
import { describe, expect, it } from 'vitest';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    value_only_overlay,
} from '../webview/history-cell-state-model';
import {
    view_partly_applied_warning,
    view_replay_dropped_warning,
    view_replay_refusal_warning,
    view_replay_wait_warning,
    view_skip_warning,
} from '../webview/history-command-model';
import { entry_for_current_header } from '../webview/history-header-rebase';
import { history_menu_projection } from '../webview/history-menu-projection';
import { create_history_replay_coordinator } from '../webview/history-replay-coordinator';
import { build_prepare_request } from '../webview/history-replay-request-model';
import {
    action_has_view_change,
    commit_history_move,
    DEFAULT_HISTORY_BOUNDS,
    empty_history_stack,
    install_structural_save_barrier,
    measure_history_action,
    peek_history,
    rebase_saved_cell_history,
    record_history_action,
    rekey_committed_tail_removal_history,
    rekey_saved_appended_row_history,
    view_step_change,
    type HistoryAction,
    type HistoryChange,
    type HistoryStackState,
} from '../webview/history-stack-model';
import { create_history_store } from '../webview/history-store';
import {
    columns_view_step,
    transform_view_step,
    type ViewStep,
} from '../webview/view-history-model';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const SCHEMA = 'schema-1';

function action_of(step: ViewStep | undefined): HistoryAction {
    if (step === undefined) throw new Error('fixture built no step');
    return { label: step.label, changes: [{ kind: 'view', delta: step.delta }] };
}

const sort_action = () => action_of(transform_view_step(
    SHEET, SCHEMA, undefined, { sort: [{ colIndex: 1, direction: 'desc' }], filters: [] },
));
const hide_rows_action = (rows: number[]) => action_of(transform_view_step(
    SHEET, SCHEMA, undefined, { sort: [], filters: [], hiddenRows: rows },
));
const hide_columns_action = () => action_of(columns_view_step(SHEET, SCHEMA, [], [2, 3]));

function cell_change(row: number, text: string): HistoryChange {
    const delta = build_cell_history_delta({
        worksheet: SHEET,
        sourceRow: row,
        sourceColumn: 0,
        before: absent_overlay(),
        after: value_only_overlay(history_value(text), history_value('base')),
        persistedValue: history_value('base'),
        persistedHyperlink: null,
    });
    if (delta === undefined) throw new Error('fixture built a delta that moved nothing');
    return { kind: 'cell', delta };
}

function recorded(state: HistoryStackState, action: HistoryAction): HistoryStackState {
    const outcome = record_history_action(state, action);
    if (outcome.kind !== 'recorded') throw new Error(`fixture was ${outcome.kind}`);
    return outcome.state;
}

function moved(state: HistoryStackState, direction: 'undo' | 'redo'): HistoryStackState {
    const peek = peek_history(state, direction);
    if (peek.kind !== 'available') throw new Error('fixture had nothing to move');
    return commit_history_move(state, direction, peek.entry).state;
}

describe('a view step in the stack', () => {
    it('is recorded with its label and clears redo like any recording', () => {
        let state = recorded(empty_history_stack(), { label: 'Edit cell', changes: [cell_change(1, 'a')] });
        state = moved(state, 'undo');
        expect(state.redoStack).toHaveLength(1);
        state = recorded(state, sort_action());
        expect(state.redoStack).toHaveLength(0);
        expect(state.undoStack.map((entry) => entry.action.label)).toEqual(['Sort']);
        expect(view_step_change(state.undoStack[0].action)?.delta.slice).toBe('transform');
    });

    it('moves between the stacks unchanged, and back', () => {
        const state = recorded(empty_history_stack(), hide_columns_action());
        const stored = state.undoStack[0].action;
        const undone = moved(state, 'undo');
        expect(undone.undoStack).toHaveLength(0);
        expect(undone.redoStack[0].action).toBe(stored);
        expect(moved(undone, 'redo').undoStack[0].action).toBe(stored);
    });

    it('owns what it keeps: the gesture can change its arrays afterwards', () => {
        const rows = [4, 7];
        const action = hide_rows_action(rows);
        const state = recorded(empty_history_stack(), action);
        const delta = (action.changes[0] as Extract<HistoryChange, { kind: 'view' }>).delta;
        if (delta.slice !== 'transform') throw new Error('expected a transform delta');
        (delta.hiddenRows!.hidden as number[]).push(99);
        const kept = view_step_change(state.undoStack[0].action)!.delta;
        expect(kept).toMatchObject({ hiddenRows: { hidden: [4, 7], shown: [] } });
        expect(Object.isFrozen(kept)).toBe(true);
        expect(Object.isFrozen((kept as { hiddenRows: { hidden: readonly number[] } }).hiddenRows.hidden))
            .toBe(true);
    });

    it('counts no cells and costs more the more rows it names', () => {
        const few = measure_history_action(hide_rows_action([1, 2]));
        const many = measure_history_action(hide_rows_action(Array.from({ length: 5_000 }, (_u, i) => i)));
        expect(few.cellCount).toBe(0);
        expect(many.cellCount).toBe(0);
        expect(few.byteCost).toBeGreaterThan(0);
        expect(many.byteCost).toBeGreaterThan(few.byteCost + 5_000);
    });

    it('is one of the actions the count bound evicts', () => {
        const bounds = { ...DEFAULT_HISTORY_BOUNDS, maxActions: 2 };
        let state = empty_history_stack();
        for (const action of [sort_action(), hide_columns_action(), hide_rows_action([1])]) {
            const outcome = record_history_action(state, action, bounds);
            state = outcome.state;
        }
        expect(state.undoStack.map((entry) => entry.action.label)).toEqual(['Hide 2 columns', 'Hide row']);
    });

    it('is refused behind a barrier when it alone passes the hard bound', () => {
        const bounds = { ...DEFAULT_HISTORY_BOUNDS, hardMaxBytes: 2_000 };
        const outcome = record_history_action(
            recorded(empty_history_stack(), sort_action()),
            hide_rows_action(Array.from({ length: 5_000 }, (_u, i) => i)),
            bounds,
        );
        expect(outcome.kind).toBe('refused');
        expect(outcome.state.undoStack).toHaveLength(0);
        expect(outcome.state.barrier).toEqual({ reason: 'action-too-large', label: 'Hide 5000 rows' });
    });

    it('is carried unchanged through each rewrite a save makes', () => {
        let state = recorded(empty_history_stack(), { label: 'Edit cell', changes: [cell_change(1, 'a')] });
        state = recorded(state, sort_action());
        state = recorded(state, hide_rows_action([3]));
        const views = (from: HistoryStackState) => from.undoStack
            .filter((entry) => action_has_view_change(entry.action))
            .map((entry) => entry.action.changes[0]);
        const before = views(state);

        const rebased = rebase_saved_cell_history(state, [{
            worksheet: SHEET,
            sourceRow: 1,
            sourceColumn: 0,
            value: history_value('a'),
        }]);
        expect(rebased).not.toBe(state);
        expect(views(rebased)).toEqual(before);
        expect(rebased.undoStack.map((entry) => entry.action.label))
            .toEqual(['Edit cell', 'Sort', 'Hide row']);

        expect(views(rekey_saved_appended_row_history(state, []))).toEqual(before);
        expect(views(rekey_committed_tail_removal_history(state, []))).toEqual(before);
    });

    it('is dropped with everything else by the structural-save barrier', () => {
        const state = install_structural_save_barrier(recorded(empty_history_stack(), sort_action()));
        expect(state.undoStack).toHaveLength(0);
        expect(peek_history(state, 'undo')).toEqual({
            kind: 'blocked',
            barrier: { reason: 'structural-save', label: 'Save' },
        });
    });
});

describe('a view step under a Header Row change', () => {
    it('is carried as it is when the body start moved', () => {
        const store = create_history_store(undefined, { body_start: () => 0 });
        const record = store.stage_record(hide_rows_action([2, 5]));
        record.commit();
        const entry = store.snapshot().undoStack[0];
        const result = entry_for_current_header(entry, () => ({ bodyStart: 3, sourceRowCount: 10 }));
        expect(result).toEqual({ ok: true, entry });
    });
});

describe('the Edit menu for a view step', () => {
    it('names the step in both directions', () => {
        let state = recorded(empty_history_stack(), sort_action());
        state = recorded(state, hide_rows_action([1, 2, 3]));
        expect(history_menu_projection(state, false)).toMatchObject({
            undoAvailable: true, undoLabel: 'Hide 3 rows', redoAvailable: false,
        });
        state = moved(state, 'undo');
        expect(history_menu_projection(state, false)).toMatchObject({
            undoLabel: 'Sort', redoAvailable: true, redoLabel: 'Hide 3 rows',
        });
    });
});

describe('a view step and the cell replay protocol', () => {
    function coordinator_over(state_of: () => HistoryStackState) {
        const posted: unknown[] = [];
        let sessions = 0;
        const coordinator = create_history_replay_coordinator({
            history: state_of,
            ensure_session: async () => { sessions += 1; return true; },
            read_overlay: () => absent_overlay(),
            post: (message) => { posted.push(message); },
            next_id: (prefix) => `${prefix}-1`,
        });
        return { coordinator, posted, sessions: () => sessions };
    }

    it('is refused as busy, with no session acquired and nothing posted', async () => {
        const state = recorded(empty_history_stack(), sort_action());
        const { coordinator, posted, sessions } = coordinator_over(() => state);
        expect(await coordinator.begin('undo')).toEqual({ kind: 'refused', reason: 'busy' });
        expect(posted).toEqual([]);
        expect(sessions()).toBe(0);
        expect(coordinator.is_busy()).toBe(false);
    });

    it('is refused when it reaches the top while a session is being acquired', async () => {
        let state = recorded(empty_history_stack(), { label: 'Edit cell', changes: [cell_change(1, 'a')] });
        let open: (() => void) | undefined;
        const posted: unknown[] = [];
        const coordinator = create_history_replay_coordinator({
            history: () => state,
            ensure_session: () => new Promise<boolean>((resolve) => { open = () => resolve(true); }),
            read_overlay: () => absent_overlay(),
            post: (message) => { posted.push(message); },
            next_id: (prefix) => `${prefix}-1`,
        });
        const begun = coordinator.begin('undo');
        state = recorded(state, sort_action());
        open!();
        expect(await begun).toEqual({ kind: 'refused', reason: 'busy' });
        expect(posted).toEqual([]);
        expect(coordinator.is_busy()).toBe(false);
    });

    it('is never built into a prepare request', () => {
        const state = recorded(empty_history_stack(), hide_columns_action());
        expect(build_prepare_request(state.undoStack[0], 'undo', {
            read_overlay: () => absent_overlay(),
            next_id: (prefix) => `${prefix}-1`,
        })).toBeUndefined();
    });
});

describe('what a view replay says', () => {
    it('words each wait for its direction', () => {
        expect(view_replay_wait_warning('applying', 'undo'))
            .toBe('Undo did not run because another change is still being applied. Try again.');
        expect(view_replay_wait_warning('updating', 'redo'))
            .toBe('Redo did not run because the table view is still updating. Try again.');
        expect(view_replay_wait_warning('refreshing', 'undo'))
            .toBe('Undo did not run because the file was refreshing. Try again.');
        expect(view_replay_wait_warning('finishing', 'redo'))
            .toBe('Redo did not run because editing is still finishing. Try again.');
        expect(view_replay_wait_warning('preview', 'undo')).toBe('Undo is unavailable in preview.');
    });

    it('names the step and the reason in a refusal', () => {
        expect(view_replay_refusal_warning('undo', 'Sort', 'Another panel is editing this file.'))
            .toBe("Can't undo “Sort”: Another panel is editing this file.");
    });

    it('says what was skipped, whole or in part, in either direction', () => {
        expect(view_skip_warning('undo', 'Sort', ['columns-changed'], true))
            .toBe('Undo skipped “Sort”: the columns of this worksheet changed since then.');
        expect(view_skip_warning('redo', 'Hide 3 rows', ['header-row', 'rows-gone'], false))
            .toBe('Redo skipped part of “Hide 3 rows”: the header row can\'t be hidden; '
                + 'rows that are no longer in the worksheet were left out.');
        expect(view_skip_warning('undo', 'Hide row', ['rows-above-header'], true, 'Data'))
            .toBe('Sheet “Data”: Undo skipped “Hide row”: rows above the header row stay hidden.');
        expect(view_skip_warning('redo', 'Hide row', ['too-many-hidden'], true))
            .toBe('Redo skipped “Hide row”: too many rows would be hidden.');
    });

    it('says when a replay landed short or outside history', () => {
        expect(view_partly_applied_warning('undo', 'Hide 3 rows'))
            .toBe('Undo of “Hide 3 rows” was only partly applied.');
        expect(view_replay_dropped_warning('redo'))
            .toBe('The view change was redone, but it is no longer in history.');
    });
});
