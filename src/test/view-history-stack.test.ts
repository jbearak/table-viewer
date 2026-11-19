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
    SIZE_WRITE_REFUSED_MESSAGE,
    SIZE_WRITE_UNRESOLVED_MESSAGE,
    UNRESOLVED_SAVE_SIZE_REASON,
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
    width_step_changes,
    header_step_changes,
    type HistoryAction,
    type HistoryChange,
    type HistoryStackState,
} from '../webview/history-stack-model';
import { create_history_store } from '../webview/history-store';
import {
    column_widths_view_step,
    columns_view_step,
    header_step_label,
    header_view_delta,
    row_fit_view_step,
    row_heights_view_step,
    transform_view_step,
    type HeaderViewDelta,
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

    it('is carried unchanged when a save rebases the cells it wrote', () => {
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

    });

    it('is carried unchanged when a save gives an added row its place in the file', () => {
        const pending = { id: 'pending-0', cells: {}, formatTemplateId: 'plain', createdOrder: 1 };
        const added: HistoryAction = {
            label: 'Add row',
            changes: [{
                kind: 'pendingRows',
                delta: {
                    worksheet: SHEET,
                    before: { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] },
                    after: {
                        formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
                        appendedRows: [pending],
                        tailRemovals: [],
                        conflicts: [],
                    },
                },
            }],
        };
        let state = recorded(empty_history_stack(), sort_action());
        state = recorded(state, added);
        state = recorded(state, hide_rows_action([3]));
        const views = state.undoStack.filter((entry) => action_has_view_change(entry.action));

        const rekeyed = rekey_saved_appended_row_history(state, [{
            worksheet: SHEET,
            pendingRowId: 'pending-0',
            sourceRow: 4,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }]);

        // The rewrite ran: the added row's entry now speaks of a row in the file.
        expect(rekeyed).not.toBe(state);
        expect(state.undoStack[1].action.changes.map((change) => change.kind)).toEqual(['pendingRows']);
        expect(rekeyed.undoStack[1].action.changes.map((change) => change.kind)).toEqual(['tailRemoval']);
        expect(rekeyed.undoStack.map((entry) => entry.action.label))
            .toEqual(['Sort', 'Add row', 'Hide row']);
        expect(rekeyed.undoStack.filter((entry) => action_has_view_change(entry.action))
            .map((entry) => entry.action)).toEqual(views.map((entry) => entry.action));
    });

    it('is carried unchanged when a save commits the removal of a row at the end', () => {
        const removal = {
            appendHistoryId: 'saved-0',
            sourceRow: 5,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: { kind: 'none' as const } },
        };
        const removed: HistoryAction = {
            label: 'Delete row',
            changes: [{
                kind: 'pendingRows',
                delta: {
                    worksheet: SHEET,
                    before: { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] },
                    after: { formatTemplates: [], appendedRows: [], tailRemovals: [removal], conflicts: [] },
                },
            }],
        };
        let state = recorded(empty_history_stack(), sort_action());
        state = recorded(state, removed);
        state = recorded(state, hide_rows_action([3]));
        const views = state.undoStack.filter((entry) => action_has_view_change(entry.action));

        const rekeyed = rekey_committed_tail_removal_history(state, [{ worksheet: SHEET, removal }]);

        // The rewrite ran: the removal's entry is not the one recorded.
        expect(rekeyed).not.toBe(state);
        expect(rekeyed.undoStack[1].action).not.toEqual(state.undoStack[1].action);
        expect(rekeyed.undoStack.map((entry) => entry.action.label))
            .toEqual(['Sort', 'Delete row', 'Hide row']);
        expect(rekeyed.undoStack.filter((entry) => action_has_view_change(entry.action))
            .map((entry) => entry.action)).toEqual(views.map((entry) => entry.action));
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

const OTHER_SHEET: WorksheetTarget = { sheetIndex: 1, sheetName: 'More', worksheetId: 'rId2' };

const resize_column_action = () => action_of(column_widths_view_step(
    SHEET, [{ column: 2, before: null, after: 180 }],
));
const resize_rows_action = () => action_of(row_heights_view_step(
    SHEET, { height: 60, before: [{ start: 0, end: 1, height: null }, { start: 4, end: 4, height: 30 }] },
));
/** "Restore column widths on all sheets": one action, one change per worksheet. */
function restore_all_action(): HistoryAction {
    const first = column_widths_view_step(SHEET, [{ column: 0, before: 90, after: null }], 'off')!;
    const second = column_widths_view_step(OTHER_SHEET, [{ column: 1, before: 70, after: 120 }], 'off')!;
    return {
        label: first.label,
        changes: [{ kind: 'view', delta: first.delta }, { kind: 'view', delta: second.delta }],
    };
}

describe('a size step in the stack', () => {
    it('is recorded with its label, clears redo, and moves between the stacks', () => {
        let state = recorded(empty_history_stack(), { label: 'Edit cell', changes: [cell_change(1, 'a')] });
        state = recorded(state, sort_action());
        state = moved(state, 'undo');
        expect(state.redoStack).toHaveLength(1);

        state = recorded(state, resize_column_action());
        expect(state.redoStack).toHaveLength(0);
        state = recorded(state, resize_rows_action());
        expect(state.undoStack.map((entry) => entry.action.label))
            .toEqual(['Edit cell', 'Resize column', 'Resize 3 rows']);

        const stored = state.undoStack[2].action;
        const undone = moved(state, 'undo');
        expect(undone.redoStack[0].action).toBe(stored);
        expect(moved(undone, 'redo').undoStack[2].action).toBe(stored);
    });

    it('owns what it keeps, and keeps "no stored size" as null', () => {
        const columns = [
            { column: 0, before: null, after: 180 },
            { column: 1, before: 90, after: null },
        ];
        const widths = action_of(column_widths_view_step(SHEET, columns, 'on'));
        const runs = [{ start: 0, end: 4, height: null }, { start: 7, end: 7, height: 30 }];
        const reset = action_of(row_heights_view_step(SHEET, { height: null, before: [{ start: 2, end: 2, height: 44 }] }));
        const heights = action_of(row_heights_view_step(SHEET, { height: 60, before: runs }));
        let state = recorded(empty_history_stack(), widths);
        state = recorded(state, heights);
        state = recorded(state, reset);

        // The gesture's own arrays change afterwards; the stack's do not.
        const given = (widths.changes[0] as Extract<HistoryChange, { kind: 'view' }>).delta;
        if (given.slice !== 'columnWidths') throw new Error('expected a width delta');
        (given.columns as { column: number; before: number | null; after: number | null }[]).push({
            column: 9, before: 1, after: 2,
        });
        const given_rows = (heights.changes[0] as Extract<HistoryChange, { kind: 'view' }>).delta;
        if (given_rows.slice !== 'rowHeights') throw new Error('expected a row-height delta');
        (given_rows.before as { start: number; end: number; height: number | null }[]).length = 0;

        expect(view_step_change(state.undoStack[0].action)!.delta).toEqual({
            worksheet: SHEET,
            slice: 'columnWidths',
            columns: [
                { column: 0, before: null, after: 180 },
                { column: 1, before: 90, after: null },
            ],
            autoFit: 'on',
        });
        expect(view_step_change(state.undoStack[1].action)!.delta).toEqual({
            worksheet: SHEET,
            slice: 'rowHeights',
            after: 60,
            before: [{ start: 0, end: 4, height: null }, { start: 7, end: 7, height: 30 }],
        });
        expect(view_step_change(state.undoStack[2].action)!.delta).toEqual({
            worksheet: SHEET,
            slice: 'rowHeights',
            after: null,
            before: [{ start: 2, end: 2, height: 44 }],
        });
        for (const entry of state.undoStack) {
            expect(Object.isFrozen(view_step_change(entry.action)!.delta)).toBe(true);
        }
    });

    it('keeps an auto-fit\'s own height for each row through Undo and Redo', () => {
        const fit = action_of(row_fit_view_step(
            SHEET,
            [{ start: 0, end: 1, height: 60 }, { start: 2, end: 2, height: null }, { start: 5, end: 5, height: 42 }],
            [{ start: 0, end: 2, height: 30 }, { start: 5, end: 5, height: null }],
        ));
        let state = recorded(empty_history_stack(), fit);
        // The gesture's own arrays change afterwards; the stack's do not.
        const given = (fit.changes[0] as Extract<HistoryChange, { kind: 'view' }>).delta;
        if (given.slice !== 'rowHeights' || !Array.isArray(given.after)) {
            throw new Error('expected per-row heights');
        }
        (given.after as { start: number; end: number; height: number | null }[]).length = 0;
        const expected = {
            worksheet: SHEET,
            slice: 'rowHeights',
            after: [
                { start: 0, end: 1, height: 60 },
                { start: 2, end: 2, height: null },
                { start: 5, end: 5, height: 42 },
            ],
            before: [{ start: 0, end: 2, height: 30 }, { start: 5, end: 5, height: null }],
        };
        expect(view_step_change(state.undoStack[0].action)!.delta).toEqual(expected);
        const owned = view_step_change(state.undoStack[0].action)!.delta;
        if (owned.slice !== 'rowHeights') throw new Error('expected a row-height delta');
        expect(Object.isFrozen(owned.after)).toBe(true);
        state = moved(state, 'undo');
        expect(view_step_change(state.redoStack[0].action)!.delta).toEqual(expected);
        state = moved(state, 'redo');
        expect(view_step_change(state.undoStack[0].action)!.delta).toEqual(expected);
    });

    it('holds one width change per worksheet when a gesture spans worksheets', () => {
        const action = restore_all_action();
        const state = recorded(empty_history_stack(), action);
        const kept = state.undoStack[0].action;
        expect(kept.label).toBe('Restore column widths');
        // Not a single-change view step, and still a width step as a whole.
        expect(view_step_change(kept)).toBeUndefined();
        expect(action_has_view_change(kept)).toBe(true);
        expect(width_step_changes(kept)?.map((change) => change.delta.worksheet.sheetName))
            .toEqual(['Data', 'More']);
        expect(width_step_changes(kept)?.[1].delta.columns).toEqual([{ column: 1, before: 70, after: 120 }]);
        // Anything else is not a width step.
        expect(width_step_changes(sort_action())).toBeUndefined();
        expect(width_step_changes(resize_rows_action())).toBeUndefined();
        expect(width_step_changes({ label: 'x', changes: [action.changes[0], action.changes[0]] })).toBeUndefined();
        expect(width_step_changes({ label: 'x', changes: [action.changes[0], cell_change(1, 'a')] })).toBeUndefined();
    });

    it('counts no cells, and costs by what it names', () => {
        const one = measure_history_action(resize_column_action());
        const many = measure_history_action(action_of(column_widths_view_step(
            SHEET,
            Array.from({ length: 500 }, (_u, column) => ({ column, before: null, after: 100 + column })),
        )));
        expect(one.cellCount).toBe(0);
        expect(one.byteCost).toBeGreaterThan(0);
        expect(many.byteCost).toBeGreaterThan(one.byteCost + 500);
    });

    it('stays far under the byte bound at the most rows a worksheet can hold heights for', () => {
        // The worst case for runs: 10,000 rows, no two adjacent rows alike.
        const before = Array.from({ length: 10_000 }, (_u, index) => ({
            start: index * 2,
            end: index * 2,
            height: index % 2 === 0 ? null : 30 + (index % 7),
        }));
        const action = action_of(row_heights_view_step(SHEET, { height: 60, before }));
        expect(action.label).toBe('Resize 10000 rows');
        const cost = measure_history_action(action).byteCost;
        expect(cost).toBeLessThan(DEFAULT_HISTORY_BOUNDS.hardMaxBytes / 4);
        expect(record_history_action(empty_history_stack(), action).kind).toBe('recorded');
        // A select-all resize of a long worksheet is one run.
        const select_all = action_of(row_heights_view_step(
            SHEET, { height: 60, before: [{ start: 0, end: 9_999, height: null }] },
        ));
        expect(measure_history_action(select_all).byteCost).toBeLessThan(2_000);
    });

    it('is one of the actions the count bound evicts', () => {
        const bounds = { ...DEFAULT_HISTORY_BOUNDS, maxActions: 2 };
        let state = empty_history_stack();
        for (const action of [resize_column_action(), resize_rows_action(), sort_action()]) {
            state = record_history_action(state, action, bounds).state;
        }
        expect(state.undoStack.map((entry) => entry.action.label)).toEqual(['Resize 3 rows', 'Sort']);
    });

    it('is carried unchanged when a save rebases the cells it wrote', () => {
        let state = recorded(empty_history_stack(), { label: 'Edit cell', changes: [cell_change(1, 'a')] });
        state = recorded(state, resize_column_action());
        state = recorded(state, resize_rows_action());
        state = recorded(state, restore_all_action());
        const sizes = (from: HistoryStackState) => from.undoStack.slice(1).map((entry) => entry.action);
        const before = sizes(state);

        const rebased = rebase_saved_cell_history(state, [{
            worksheet: SHEET,
            sourceRow: 1,
            sourceColumn: 0,
            value: history_value('a'),
        }]);

        expect(rebased).not.toBe(state);
        expect(sizes(rebased)).toEqual(before);
    });

    it('is carried unchanged when a save gives an added row its place in the file', () => {
        const pending = { id: 'pending-0', cells: {}, formatTemplateId: 'plain', createdOrder: 1 };
        const added: HistoryAction = {
            label: 'Add row',
            changes: [{
                kind: 'pendingRows',
                delta: {
                    worksheet: SHEET,
                    before: { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] },
                    after: {
                        formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
                        appendedRows: [pending],
                        tailRemovals: [],
                        conflicts: [],
                    },
                },
            }],
        };
        let state = recorded(empty_history_stack(), resize_rows_action());
        state = recorded(state, added);
        state = recorded(state, resize_column_action());

        const rekeyed = rekey_saved_appended_row_history(state, [{
            worksheet: SHEET,
            pendingRowId: 'pending-0',
            sourceRow: 4,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }]);

        expect(rekeyed).not.toBe(state);
        expect(rekeyed.undoStack[1].action.changes.map((change) => change.kind)).toEqual(['tailRemoval']);
        expect(rekeyed.undoStack[0].action).toEqual(state.undoStack[0].action);
        expect(rekeyed.undoStack[2].action).toEqual(state.undoStack[2].action);
    });

    it('is dropped with everything else by the structural-save barrier', () => {
        let state = recorded(empty_history_stack(), resize_column_action());
        state = recorded(state, resize_rows_action());
        state = install_structural_save_barrier(state);
        expect(state.undoStack).toHaveLength(0);
        expect(peek_history(state, 'undo')).toMatchObject({ kind: 'blocked' });
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

    it('carries a size step as it is: its rows are source rows, which a Header Row change leaves alone', () => {
        const store = create_history_store(undefined, { body_start: () => 0 });
        for (const action of [resize_rows_action(), resize_column_action(), restore_all_action()]) {
            store.stage_record(action).commit();
        }
        for (const entry of store.snapshot().undoStack) {
            expect(entry_for_current_header(entry, () => ({ bodyStart: 3, sourceRowCount: 10 })))
                .toEqual({ ok: true, entry });
        }
    });
});

/** A header step: one action, one `header` change per worksheet. */
function header_action(...deltas: (HeaderViewDelta | undefined)[]): HistoryAction {
    const kept = deltas.map((delta) => {
        if (delta === undefined) throw new Error('fixture built no header change');
        return delta;
    });
    return {
        label: header_step_label(kept),
        changes: kept.map((delta) => ({ kind: 'view' as const, delta })),
    };
}
const use_row_3 = (sheet = SHEET) => header_view_delta(sheet, {
    before: { mode: 'auto', row: 0 }, after: { mode: 'on', row: 2 }, hidden: [0, 1], shown: [],
});
const turn_off = (sheet = SHEET) => header_view_delta(sheet, {
    before: { mode: 'on', row: 0 }, after: { mode: 'off' }, hidden: [], shown: [],
});

describe('a header step in the stack', () => {
    it('is recorded with its label, clears redo, and moves between the stacks', () => {
        let state = recorded(empty_history_stack(), { label: 'Edit cell', changes: [cell_change(1, 'a')] });
        state = recorded(state, sort_action());
        state = moved(state, 'undo');
        expect(state.redoStack).toHaveLength(1);

        state = recorded(state, header_action(use_row_3()));
        expect(state.redoStack).toHaveLength(0);
        expect(state.undoStack.map((entry) => entry.action.label))
            .toEqual(['Edit cell', 'Use row 3 as header']);

        const stored = state.undoStack[1].action;
        const undone = moved(state, 'undo');
        expect(undone.redoStack[0].action).toBe(stored);
        expect(moved(undone, 'redo').undoStack[1].action).toBe(stored);
    });

    it('owns what it keeps: the caller can change its arrays and sides afterwards', () => {
        const action = header_action(use_row_3());
        const state = recorded(empty_history_stack(), action);
        const given = (action.changes[0] as Extract<HistoryChange, { kind: 'view' }>).delta as HeaderViewDelta;
        (given.hiddenRows!.hidden as number[]).push(99);
        (given.after as { row?: number }).row = 7;
        const kept = header_step_changes(state.undoStack[0].action)![0].delta;
        expect(kept).toEqual({
            worksheet: SHEET,
            slice: 'header',
            before: { mode: 'auto', row: 0 },
            after: { mode: 'on', row: 2 },
            hiddenRows: { hidden: [0, 1], shown: [] },
        });
        expect(Object.isFrozen(kept)).toBe(true);
        expect(Object.isFrozen(kept.after)).toBe(true);
        expect(Object.isFrozen(kept.hiddenRows!.hidden)).toBe(true);
    });

    it('holds one header change per worksheet when a gesture spans worksheets', () => {
        const action = header_action(turn_off(), turn_off(OTHER_SHEET));
        expect(action.label).toBe('Show first row as data on all sheets');
        const kept = recorded(empty_history_stack(), action).undoStack[0].action;
        expect(header_step_changes(kept)?.map((change) => change.delta.worksheet.sheetName))
            .toEqual(['Data', 'More']);
        // One change is a header step too; other shapes are not.
        expect(header_step_changes(header_action(turn_off()))).toHaveLength(1);
        expect(header_step_changes(sort_action())).toBeUndefined();
        expect(header_step_changes(resize_column_action())).toBeUndefined();
        expect(width_step_changes(action)).toBeUndefined();
        expect(header_step_changes({ label: 'x', changes: [action.changes[0], action.changes[0]] }))
            .toBeUndefined();
        expect(header_step_changes({ label: 'x', changes: [action.changes[0], cell_change(1, 'a')] }))
            .toBeUndefined();
    });

    it('counts no cells, and costs more the more hidden rows it names', () => {
        const few = measure_history_action(header_action(use_row_3()));
        const many = measure_history_action(header_action(header_view_delta(SHEET, {
            before: { mode: 'on', row: 5_000 },
            after: { mode: 'off' },
            hidden: [],
            shown: Array.from({ length: 5_000 }, (_unused, row) => row),
        })));
        expect(few.cellCount).toBe(0);
        expect(many.cellCount).toBe(0);
        expect(few.byteCost).toBeGreaterThan(0);
        expect(many.byteCost).toBeGreaterThan(few.byteCost + 5_000);
    });

    it('is carried unchanged when a save rebases the cells it wrote', () => {
        let state = recorded(empty_history_stack(), { label: 'Edit cell', changes: [cell_change(1, 'a')] });
        state = recorded(state, header_action(use_row_3()));
        const before = state.undoStack[1].action.changes;
        const rebased = rebase_saved_cell_history(state, [{
            worksheet: SHEET,
            sourceRow: 1,
            sourceColumn: 0,
            value: history_value('a'),
        }]);
        expect(rebased).not.toBe(state);
        expect(rebased.undoStack[1].action.changes).toEqual(before);
        expect(rebased.undoStack.map((entry) => entry.action.label))
            .toEqual(['Edit cell', 'Use row 3 as header']);
    });

    it('is carried as it is by the header rebase: it names source rows', () => {
        const store = create_history_store(undefined, { body_start: () => 0 });
        store.stage_record(header_action(use_row_3(), turn_off(OTHER_SHEET))).commit();
        const entry = store.snapshot().undoStack[0];
        expect(entry_for_current_header(entry, () => ({ bodyStart: 3, sourceRowCount: 10 })))
            .toEqual({ ok: true, entry });
    });

    it('is dropped with everything else by the structural-save barrier', () => {
        const state = install_structural_save_barrier(
            recorded(empty_history_stack(), header_action(use_row_3())),
        );
        expect(state.undoStack).toHaveLength(0);
    });

    it('is never built into a cell replay request', () => {
        const state = recorded(empty_history_stack(), header_action(use_row_3()));
        expect(action_has_view_change(state.undoStack[0].action)).toBe(true);
        expect(view_step_change(state.undoStack[0].action)?.delta.slice).toBe('header');
    });
});

describe('the Edit menu for a header step', () => {
    it('names each kind of step in both directions', () => {
        const unhide = header_view_delta(SHEET, {
            before: { mode: 'on', row: 2 }, after: { mode: 'off' }, hidden: [], shown: [0, 1],
        });
        const actions = [
            header_action(use_row_3()),
            header_action(turn_off()),
            header_action(unhide),
            header_action(use_row_3(), use_row_3(OTHER_SHEET)),
        ];
        expect(actions.map((action) => action.label)).toEqual([
            'Use row 3 as header',
            'Turn off header row',
            'Unhide rows',
            'Use first row as header on all sheets',
        ]);
        let state = empty_history_stack();
        for (const action of actions) state = recorded(state, action);
        state = moved(moved(moved(state, 'undo'), 'undo'), 'undo');
        expect(history_menu_projection(state, false)).toMatchObject({
            undoAvailable: true,
            undoLabel: 'Use row 3 as header',
            redoAvailable: true,
            redoLabel: 'Turn off header row',
        });
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

describe('the Edit menu for a size step', () => {
    it('names each kind of step in both directions', () => {
        const labels = [
            action_of(column_widths_view_step(SHEET, [{ column: 0, before: null, after: 90 }])),
            action_of(column_widths_view_step(SHEET, [
                { column: 0, before: 90, after: 120 },
                { column: 1, before: null, after: 120 },
                { column: 2, before: null, after: 120 },
            ])),
            action_of(column_widths_view_step(SHEET, [{ column: 0, before: 120, after: 64 }], 'on')),
            action_of(column_widths_view_step(SHEET, [{ column: 0, before: 64, after: 120 }], 'off')),
            action_of(row_heights_view_step(SHEET, { height: 60, before: [{ start: 3, end: 3, height: null }] })),
            action_of(row_heights_view_step(SHEET, { height: 60, before: [{ start: 0, end: 2, height: null }] })),
            action_of(row_heights_view_step(SHEET, { height: null, before: [{ start: 3, end: 3, height: 60 }] })),
            action_of(row_heights_view_step(SHEET, { height: null, before: [{ start: 0, end: 2, height: 60 }] })),
        ];
        expect(labels.map((action) => action.label)).toEqual([
            'Resize column',
            'Resize 3 columns',
            'Auto-fit columns',
            'Restore column widths',
            'Resize row',
            'Resize 3 rows',
            'Reset row height',
            'Reset 3 row heights',
        ]);
        let state = empty_history_stack();
        for (const action of labels) state = recorded(state, action);
        expect(history_menu_projection(state, false)).toMatchObject({
            undoAvailable: true, undoLabel: 'Reset 3 row heights', redoAvailable: false,
        });
        state = moved(moved(state, 'undo'), 'undo');
        expect(history_menu_projection(state, false)).toMatchObject({
            undoLabel: 'Resize 3 rows', redoAvailable: true, redoLabel: 'Reset row height',
        });
    });
});

describe('a size step and the cell replay protocol', () => {
    it('is never built into a prepare request', () => {
        for (const action of [resize_column_action(), resize_rows_action(), restore_all_action()]) {
            const state = recorded(empty_history_stack(), action);
            expect(build_prepare_request(state.undoStack[0], 'undo', {
                read_overlay: () => absent_overlay(),
                next_id: (prefix) => `${prefix}-1`,
            })).toBeUndefined();
        }
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

    it('is refused as a view step, with no session acquired and nothing posted, so the caller replays it', async () => {
        const state = recorded(empty_history_stack(), sort_action());
        const { coordinator, posted, sessions } = coordinator_over(() => state);
        expect(await coordinator.begin('undo')).toEqual({ kind: 'refused', reason: 'view-step' });
        expect(posted).toEqual([]);
        expect(sessions()).toBe(0);
        expect(coordinator.is_busy()).toBe(false);
    });

    it('is refused as a view step when it reaches the top while a session is being acquired, so the press starts again', async () => {
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
        expect(await begun).toEqual({ kind: 'refused', reason: 'view-step' });
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

    it('says why a header step, or part of it, was skipped', () => {
        expect(view_skip_warning('undo', 'Use row 3 as header', ['header-row-gone'], true))
            .toBe('Undo skipped “Use row 3 as header”: '
                + 'the row it used as the header row is no longer in the worksheet.');
        expect(view_skip_warning('redo', 'Unhide rows', ['header-unavailable'], true, 'Data'))
            .toBe("Sheet “Data”: Redo skipped “Unhide rows”: the header row can't be restored on this worksheet.");
        expect(view_skip_warning('undo', 'Show first row as data on all sheets', ['sheets-gone'], false))
            .toBe('Undo skipped part of “Show first row as data on all sheets”: '
                + 'worksheets that are no longer in the workbook were left out.');
        expect(view_replay_refusal_warning(
            'undo',
            'Use row 2 as header',
            'Save first: the header row has unsaved changes, and it would stop being the header row.',
        )).toBe("Can't undo “Use row 2 as header”: Save first: the header row has unsaved changes, "
            + 'and it would stop being the header row.');
    });

    it('says what a size step left out, and why a size write did not land', () => {
        expect(view_skip_warning('undo', 'Resize 3 columns', ['columns-gone'], false))
            .toBe('Undo skipped part of “Resize 3 columns”: columns that are no longer in the worksheet were left out.');
        expect(view_skip_warning('redo', 'Restore column widths', ['sheets-gone'], false))
            .toBe('Redo skipped part of “Restore column widths”: worksheets that are no longer in the workbook were left out.');
        expect(view_skip_warning('redo', 'Resize 3 rows', ['too-many-heights'], true))
            .toBe('Redo skipped “Resize 3 rows”: too many rows would have a custom height.');
        expect(view_skip_warning('undo', 'Resize row', ['rows-gone'], true, 'Data'))
            .toBe('Sheet “Data”: Undo skipped “Resize row”: rows that are no longer in the worksheet were left out.');
        expect(SIZE_WRITE_REFUSED_MESSAGE).toBe('Could not resize because the file was refreshing. Try again.');
        expect(SIZE_WRITE_UNRESOLVED_MESSAGE).toBe('Could not resize: choose whether your last save finished first.');
        expect(view_replay_refusal_warning('undo', 'Resize column', UNRESOLVED_SAVE_SIZE_REASON))
            .toBe("Can't undo “Resize column”: choose whether your last save finished first.");
    });

    it('says when a replay landed short or outside history', () => {
        expect(view_partly_applied_warning('undo', 'Hide 3 rows'))
            .toBe('Undo of “Hide 3 rows” was only partly applied.');
        expect(view_replay_dropped_warning('redo'))
            .toBe('The view change was redone, but it is no longer in history.');
    });
});
