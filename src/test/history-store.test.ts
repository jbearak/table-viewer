import { describe, expect, it } from 'vitest';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    value_only_overlay,
} from '../webview/history-cell-state-model';
import type { HistoryAction, HistoryBounds, HistoryChange } from '../webview/history-stack-model';
import { create_history_store } from '../webview/history-store';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };

function cell_change(row: number, column: number, text: string): HistoryChange {
    const delta = build_cell_history_delta({
        worksheet: SHEET,
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

function typed(label: string, text = 'typed'): HistoryAction {
    return { label, changes: [cell_change(0, 0, text)] };
}

/** Small enough that a single change cannot fit, so recording refuses. */
const TINY: HistoryBounds = {
    maxActions: 100,
    maxCells: 1_000_000,
    softMaxBytes: 1,
    hardMaxBytes: 1,
};

describe('create_history_store', () => {
    it('starts empty and hands back a stable snapshot', () => {
        const store = create_history_store();
        const first = store.snapshot();
        expect(first.undoStack).toEqual([]);
        expect(first.redoStack).toEqual([]);
        expect(first.barrier).toBeUndefined();
        // Same reference until something moves, so useSyncExternalStore does not
        // see a change on every render.
        expect(store.snapshot()).toBe(first);
    });

    it('holds a recording back until it is committed and notified', () => {
        const store = create_history_store();
        const before = store.snapshot();
        let notifications = 0;
        store.subscribe(() => { notifications += 1; });

        const staged = store.stage_record(typed('Typing'));
        expect(staged.outcome.kind).toBe('recorded');
        // Staged: the outcome is known, but nobody can see it yet.
        expect(store.snapshot()).toBe(before);
        expect(notifications).toBe(0);

        expect(staged.commit()).toBe(true);
        expect(store.snapshot().undoStack).toHaveLength(1);
        expect(notifications).toBe(0);

        staged.notify();
        expect(notifications).toBe(1);
    });

    it('reports an action that moved nothing as empty and publishes nothing', () => {
        const store = create_history_store();
        const before = store.snapshot();
        let notifications = 0;
        store.subscribe(() => { notifications += 1; });

        const staged = store.stage_record({ label: 'Typing', changes: [] });
        expect(staged.outcome.kind).toBe('empty');
        expect(staged.valid()).toBe(true);
        expect(staged.commit()).toBe(false);
        staged.notify();

        expect(store.snapshot()).toBe(before);
        expect(notifications).toBe(0);
    });

    it('installs the barrier when an action is refused', () => {
        const store = create_history_store();
        store.stage_record(typed('Earlier')).commit();

        const staged = store.stage_record(typed('Huge'), TINY);
        expect(staged.outcome.kind).toBe('refused');
        // A refusal is still a state change: it clears history behind a barrier.
        expect(staged.commit()).toBe(true);
        const state = store.snapshot();
        expect(state.undoStack).toEqual([]);
        expect(state.barrier?.reason).toBe('action-too-large');
    });

    it('refuses to commit a staging the history moved out from under', () => {
        const store = create_history_store();
        const first = store.stage_record(typed('First', 'a'));
        const second = store.stage_record(typed('Second', 'b'));

        expect(second.commit()).toBe(true);
        expect(first.valid()).toBe(false);
        expect(first.commit()).toBe(false);

        const state = store.snapshot();
        expect(state.undoStack).toHaveLength(1);
        expect(state.undoStack[0].action.label).toBe('Second');
    });

    it('commits and notifies at most once', () => {
        const store = create_history_store();
        let notifications = 0;
        store.subscribe(() => { notifications += 1; });

        const staged = store.stage_record(typed('Typing'));
        expect(staged.commit()).toBe(true);
        expect(staged.commit()).toBe(true);
        staged.notify();
        staged.notify();

        expect(store.snapshot().undoStack).toHaveLength(1);
        expect(notifications).toBe(1);
    });

    it('lets a caller check every participant before moving any of them', () => {
        const store = create_history_store();
        const staged = store.stage_record(typed('Typing'));
        expect(staged.valid()).toBe(true);
        // Asking changed nothing, so the commit that follows still lands.
        expect(staged.valid()).toBe(true);
        expect(staged.commit()).toBe(true);
    });

    it('clears the history and invalidates an outstanding staging', () => {
        const store = create_history_store();
        store.stage_record(typed('Earlier')).commit();
        let notifications = 0;
        store.subscribe(() => { notifications += 1; });

        const staged = store.stage_record(typed('Later', 'b'));
        store.clear();

        expect(store.snapshot().undoStack).toEqual([]);
        expect(notifications).toBe(1);
        expect(staged.valid()).toBe(false);
        expect(staged.commit()).toBe(false);
        expect(store.snapshot().undoStack).toEqual([]);
    });

    it('clears a barrier, unlike clear_history', () => {
        const store = create_history_store();
        store.stage_record(typed('Huge'), TINY).commit();
        expect(store.snapshot().barrier).toBeDefined();

        store.clear();
        expect(store.snapshot().barrier).toBeUndefined();
    });

    it('does not notify when clearing an already-empty history', () => {
        const store = create_history_store();
        let notifications = 0;
        store.subscribe(() => { notifications += 1; });

        store.clear();
        expect(notifications).toBe(0);
    });

    it('stops notifying an unsubscribed listener', () => {
        const store = create_history_store();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => { notifications += 1; });

        const first = store.stage_record(typed('First', 'a'));
        first.commit();
        first.notify();
        unsubscribe();
        const second = store.stage_record(typed('Second', 'b'));
        second.commit();
        second.notify();

        expect(notifications).toBe(1);
    });

    it('survives a listener unsubscribing during notification', () => {
        const store = create_history_store();
        const seen: string[] = [];
        const unsubscribe = store.subscribe(() => {
            seen.push('first');
            unsubscribe();
        });
        store.subscribe(() => { seen.push('second'); });

        const staged = store.stage_record(typed('Typing'));
        staged.commit();
        staged.notify();

        expect(seen).toEqual(['first', 'second']);
    });

    it('accepts an initial state', () => {
        const seed = create_history_store();
        seed.stage_record(typed('Earlier')).commit();

        const store = create_history_store(seed.snapshot());
        expect(store.snapshot().undoStack).toHaveLength(1);
    });
});
