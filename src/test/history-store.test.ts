import { describe, expect, it } from 'vitest';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    value_only_overlay,
} from '../webview/history-cell-state-model';
import {
    peek_history,
    type HistoryAction,
    type HistoryBounds,
    type HistoryChange,
    type HistoryEntry,
    type SavedHistoryRowAssignment,
    type SavedTailRemovalCommit,
} from '../webview/history-stack-model';
import type { PendingTailRemoval } from '../pending-changes';
import { create_history_store } from '../webview/history-store';
import { create_edit_session_store } from '../webview/edit-session-store';
import { commit_staged_transaction, type StagedMutation } from '../webview/staged-mutation';
import { make_dirty_entry } from '../types';

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

    it('passes caller bounds through saved-row rekeys and reports refusal', () => {
        const store = create_history_store();
        store.stage_record({
            label: 'Append row',
            changes: [{
                kind: 'rowAppend',
                delta: {
                    worksheet: SHEET,
                    pendingRowId: 'pending-a',
                    before: null,
                    after: {
                        id: 'pending-a',
                        cells: { 0: { value: 'saved' } },
                        formatTemplateId: 'plain',
                        createdOrder: 1,
                    },
                    beforeIndex: null,
                    afterIndex: 0,
                    formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
                },
            }],
        }).commit();
        const saved: SavedHistoryRowAssignment[] = [{
            worksheet: SHEET,
            pendingRowId: 'pending-a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: { 0: { value: 'saved' } }, format: { kind: 'none' } },
        }];
        expect(store.rekey_saved_rows(saved, TINY)).toMatchObject({
            kind: 'unrecordable',
            reason: 'action-too-large',
            hardMaxBytes: 1,
        });
        expect(store.snapshot().barrier?.reason).toBe('action-too-large');
    });

    it('passes caller bounds through committed-removal rekeys and reports refusal', () => {
        const removal: PendingTailRemoval = {
            appendHistoryId: 'saved-a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: { 0: { value: 'saved' } }, format: { kind: 'none' } },
        };
        const store = create_history_store();
        store.stage_record({
            label: 'Remove appended row',
            changes: [{
                kind: 'tailRemoval',
                delta: {
                    worksheet: SHEET,
                    appendHistoryId: removal.appendHistoryId,
                    before: removal,
                    after: null,
                    beforeIndex: 0,
                    afterIndex: null,
                },
            }],
        }).commit();
        const committed: SavedTailRemovalCommit[] = [{ worksheet: SHEET, removal }];
        expect(store.rekey_saved_removals(committed, TINY)).toMatchObject({
            kind: 'unrecordable',
            reason: 'action-too-large',
            hardMaxBytes: 1,
        });
        expect(store.snapshot().barrier?.reason).toBe('action-too-large');
    });
});

describe('create_history_store — stage_move', () => {
    /** Record one action and hand back the entry a replay would be given. */
    function with_recorded_entry(): {
        readonly store: ReturnType<typeof create_history_store>;
        readonly entry: HistoryEntry;
    } {
        const store = create_history_store();
        const staged = store.stage_record(typed('Edit cell'));
        staged.commit();
        staged.notify();
        const peeked = peek_history(store.snapshot(), 'undo');
        if (peeked.kind !== 'available') throw new Error('fixture recorded nothing');
        return { store, entry: peeked.entry };
    }

    it('moves the entry to the other stack on commit', () => {
        const { store, entry } = with_recorded_entry();
        const staged = store.stage_move('undo', entry);
        expect(staged.outcome.kind).toBe('moved');
        // Nothing has moved yet: staging decides, committing applies.
        expect(store.snapshot().undoStack).toHaveLength(1);
        expect(staged.commit()).toBe(true);
        expect(store.snapshot().undoStack).toHaveLength(0);
        expect(store.snapshot().redoStack).toHaveLength(1);
    });

    it('publishes once, and only after the commit', () => {
        const { store, entry } = with_recorded_entry();
        let notifications = 0;
        store.subscribe(() => { notifications += 1; });
        const staged = store.stage_move('undo', entry);
        expect(notifications).toBe(0);
        staged.commit();
        expect(notifications).toBe(0);
        staged.notify();
        staged.notify();
        expect(notifications).toBe(1);
    });

    it('is invalidated by anything else moving the history first', () => {
        const { store, entry } = with_recorded_entry();
        const staged = store.stage_move('undo', entry);
        const interloper = store.stage_record(typed('Edit cell', 'later'));
        interloper.commit();
        expect(staged.valid()).toBe(false);
        expect(staged.commit()).toBe(false);
        // The interloping recording stands; the stale move did not rebase onto it.
        expect(store.snapshot().undoStack).toHaveLength(2);
    });

    it('reports a duplicate commit as already-committed and publishes nothing', () => {
        const { store, entry } = with_recorded_entry();
        const first = store.stage_move('undo', entry);
        first.commit();
        first.notify();

        let notifications = 0;
        store.subscribe(() => { notifications += 1; });
        const second = store.stage_move('undo', entry);
        expect(second.outcome.kind).toBe('already-committed');
        expect(second.commit()).toBe(false);
        second.notify();
        expect(notifications).toBe(0);
        expect(store.snapshot().redoStack).toHaveLength(1);
    });

    it('a clear across the move is a dropped commit', () => {
        const { store, entry } = with_recorded_entry();
        store.clear();
        const staged = store.stage_move('undo', entry);
        // The entry's content HAS been replayed, so it cannot go back on a stack
        // a clear deliberately discarded — the caller is told rather than left
        // to infer it from an unchanged state.
        expect(staged.outcome.kind).toBe('dropped');
        staged.commit();
        expect(store.snapshot().undoStack).toHaveLength(0);
        expect(store.snapshot().redoStack).toHaveLength(0);
    });
});

describe('commit_staged_transaction', () => {
    function stub(valid: boolean, changes = true): StagedMutation & {
        readonly log: string[];
    } {
        const log: string[] = [];
        return {
            log,
            valid: () => valid,
            commit: () => { log.push('commit'); return changes; },
            notify: () => { log.push('notify'); },
        };
    }

    it('commits nothing when any participant is invalid', () => {
        const good = stub(true);
        const bad = stub(false);
        expect(commit_staged_transaction([good, bad])).toBe(false);
        expect(good.log).toEqual([]);
        expect(bad.log).toEqual([]);
    });

    it('every store has swapped before the first notification runs', () => {
        // The reason notification is its own pass: a listener woken by the first
        // store would read the others still holding their old state.
        const order: string[] = [];
        const participant = (name: string): StagedMutation => ({
            valid: () => true,
            commit: () => { order.push(`commit:${name}`); return true; },
            notify: () => { order.push(`notify:${name}`); },
        });
        commit_staged_transaction([participant('edits'), participant('history')]);
        expect(order).toEqual([
            'commit:edits', 'commit:history', 'notify:edits', 'notify:history',
        ]);
    });

    it('answers true when any participant changed and false when none did', () => {
        expect(commit_staged_transaction([stub(true, false), stub(true, true)])).toBe(true);
        expect(commit_staged_transaction([stub(true, false), stub(true, false)])).toBe(false);
    });

    it('an empty transaction changes nothing and is not an error', () => {
        expect(commit_staged_transaction([])).toBe(false);
    });

    it('moves a real history store and edit store together', () => {
        const store = create_edit_session_store();
        store.adopt_session('session-1');
        const { store: history, entry } = (() => {
            const created = create_history_store();
            const staged = created.stage_record(typed('Edit cell'));
            staged.commit();
            const peeked = peek_history(created.snapshot(), 'undo');
            if (peeked.kind !== 'available') throw new Error('fixture recorded nothing');
            return { store: created, entry: peeked.entry };
        })();

        const writes = store.stage_writes('session-1', [
            { key: '0:0', entry: make_dirty_entry('typed', 'base') },
        ]);
        const move = history.stage_move('undo', entry);
        expect(writes).toBeDefined();
        expect(commit_staged_transaction([writes!, move])).toBe(true);
        expect(store.size()).toBe(1);
        expect(history.snapshot().redoStack).toHaveLength(1);
    });

    it('leaves both stores untouched when one has moved on', () => {
        const store = create_edit_session_store();
        store.adopt_session('session-1');
        const history = create_history_store();
        const recorded = history.stage_record(typed('Edit cell'));
        recorded.commit();
        const peeked = peek_history(history.snapshot(), 'undo');
        if (peeked.kind !== 'available') throw new Error('fixture recorded nothing');

        const writes = store.stage_writes('session-1', [
            { key: '0:0', entry: make_dirty_entry('typed', 'base') },
        ]);
        const move = history.stage_move('undo', peeked.entry);
        // The history moves under the staging — a fresh edit was recorded.
        history.stage_record(typed('Edit cell', 'later')).commit();

        expect(commit_staged_transaction([writes!, move])).toBe(false);
        expect(store.size()).toBe(0);
        expect(history.snapshot().redoStack).toHaveLength(0);
    });
});

describe('create_history_store, body starts', () => {
    const OTHER: WorksheetTarget = { sheetIndex: 1, sheetName: 'Notes', worksheetId: 'rId2' };
    const other_cell = (): HistoryChange => {
        const change = cell_change(4, 0, 'other');
        if (change.kind !== 'cell') throw new Error('not a cell');
        return { kind: 'cell', delta: { ...change.delta, worksheet: OTHER } };
    };

    it('stamps each entry with where its worksheets\' bodies started, omitting 0', () => {
        let starts: Record<string, number> = { rId1: 2, rId2: 0 };
        const store = create_history_store(undefined, {
            body_start: (worksheet) => starts[worksheet.worksheetId ?? ''] ?? 0,
        });
        store.stage_record({ label: 'Both', changes: [cell_change(3, 0, 'a'), other_cell()] }).commit();
        store.stage_record({ label: 'Other', changes: [other_cell()] }).commit();
        starts = { rId1: 0, rId2: 1 };
        store.stage_record({ label: 'Later', changes: [cell_change(5, 0, 'b'), other_cell()] }).commit();

        const [both, other, later] = store.snapshot().undoStack;
        expect(both.bodyStarts).toEqual({ 'id:rId1': 2 });
        // Header off everywhere the entry touches: no stamp at all.
        expect(other.bodyStarts).toBeUndefined();
        expect(later.bodyStarts).toEqual({ 'id:rId2': 1 });
    });

    it('records no stamp without a body-start reader', () => {
        const store = create_history_store();
        store.stage_record(typed('Edit')).commit();
        expect(store.snapshot().undoStack[0].bodyStarts).toBeUndefined();
    });

    it('asks once per worksheet, from the action it owns, after the bounded walk', () => {
        const asked: string[] = [];
        const store = create_history_store(undefined, {
            body_start: (worksheet) => { asked.push(worksheet.worksheetId ?? ''); return 3; },
        });
        let walks = 0;
        const source = {
            label: 'Streamed',
            changes: {
                *[Symbol.iterator]() {
                    walks += 1;
                    yield cell_change(0, 0, 'a');
                    yield cell_change(1, 0, 'b');
                    yield other_cell();
                },
            },
        };
        const staged = store.stage_record(source);
        expect(staged.outcome.kind).toBe('recorded');
        expect(walks).toBe(1);
        expect(asked).toEqual(['rId1', 'rId2']);
        staged.commit();
        expect(store.snapshot().undoStack[0].bodyStarts).toEqual({ 'id:rId1': 3, 'id:rId2': 3 });

        // A stream too large to keep is refused where the bound is passed, and
        // nothing is asked about an action history does not own.
        asked.length = 0;
        let yielded = 0;
        const refused = store.stage_record({
            label: 'Too large',
            changes: {
                *[Symbol.iterator]() {
                    while (true) {
                        if (yielded > 3) throw new Error('recorder read past the bound');
                        yielded += 1;
                        yield cell_change(yielded, 0, 'x');
                    }
                },
            },
        }, TINY);
        expect(refused.outcome.kind).toBe('refused');
        expect(asked).toEqual([]);
    });

    it('keeps the stamp when the entry moves between the stacks, and when a redo is adopted', () => {
        const store = create_history_store(undefined, { body_start: () => 2 });
        store.stage_record(typed('Edit')).commit();
        const recorded = store.snapshot().undoStack[0];
        store.stage_move('undo', recorded).commit();
        const undone = store.snapshot().redoStack[0];
        expect(undone.bodyStarts).toEqual({ 'id:rId1': 2 });

        // A redo in flight when a fresh recording clears the redo stack lands
        // afterwards and is adopted, as the entry it was.
        store.stage_record(typed('Newer')).commit();
        expect(store.snapshot().redoStack).toEqual([]);
        const adopted = store.stage_move('redo', undone);
        expect(adopted.outcome.kind).toBe('moved');
        adopted.commit();
        const top = store.snapshot().undoStack.at(-1)!;
        expect(top.id).toBe(recorded.id);
        expect(top.bodyStarts).toEqual({ 'id:rId1': 2 });
        expect(top.action).toBe(recorded.action);
    });

    it('keeps the stamp when a save rewrites the entry', () => {
        const store = create_history_store(undefined, { body_start: () => 2 });
        store.stage_record(typed('Edit')).commit();
        expect(store.rebase_saved_cells([{
            worksheet: SHEET, sourceRow: 0, sourceColumn: 0, value: history_value('typed'),
        }])).toEqual({ kind: 'rekeyed', changed: true });
        expect(store.snapshot().undoStack[0].bodyStarts).toEqual({ 'id:rId1': 2 });

        const rows = create_history_store(undefined, { body_start: () => 2 });
        rows.stage_record({
            label: 'Append row',
            changes: [{
                kind: 'rowAppend',
                delta: {
                    worksheet: SHEET,
                    pendingRowId: 'pending-a',
                    before: null,
                    after: {
                        id: 'pending-a',
                        cells: { 0: { value: 'saved' } },
                        formatTemplateId: 'plain',
                        createdOrder: 1,
                    },
                    beforeIndex: null,
                    afterIndex: 0,
                    formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
                },
            }],
        }).commit();
        const removal: PendingTailRemoval = {
            appendHistoryId: 'pending-a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: { 0: { value: 'saved' } }, format: { kind: 'none' } },
        };
        expect(rows.rekey_saved_rows([{
            worksheet: SHEET,
            pendingRowId: 'pending-a',
            sourceRow: removal.sourceRow,
            savedFingerprint: removal.savedFingerprint,
            savedRow: removal.savedRow,
        }])).toEqual({ kind: 'rekeyed', changed: true });
        expect(rows.snapshot().undoStack[0].action.changes[0].kind).toBe('tailRemoval');
        expect(rows.snapshot().undoStack[0].bodyStarts).toEqual({ 'id:rId1': 2 });
    });

    it('has no barrier a Header Row change installs', () => {
        const store = create_history_store();
        expect(Object.keys(store).filter((name) => name.includes('barrier')))
            .toEqual(['install_structural_save_barrier']);
    });
});
