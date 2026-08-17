import { describe, expect, it } from 'vitest';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    hyperlink_only_overlay,
    value_only_overlay,
    type CellHistoryDelta,
} from '../webview/history-cell-state-model';
import {
    action_focus_worksheet,
    action_is_single_worksheet,
    action_replay_changes,
    clear_history,
    commit_history_move,
    empty_history_stack,
    history_action,
    history_usage,
    measure_history_action,
    peek_history,
    record_history_action,
    type HistoryAction,
    type HistoryBounds,
    type HistoryChange,
    type HistoryEntry,
    type HistoryStackState,
} from '../webview/history-stack-model';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const LINK = { kind: 'external', target: 'https://example.com/' } as const;
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

/** A link attached to an unedited cell: the value dimension stays untouched. */
function link_only_change(text: string): HistoryChange {
    const anchor = history_value(text);
    const delta = build_cell_history_delta({
        worksheet: SHEET,
        sourceRow: 0,
        sourceColumn: 0,
        before: absent_overlay(),
        after: hyperlink_only_overlay(anchor, LINK, null),
        persistedValue: anchor,
        persistedHyperlink: null,
    });
    if (delta === undefined) throw new Error('fixture built a delta that moved nothing');
    return { kind: 'cell', delta };
}

/** A short pending value recommitted against a base that moved underneath. */
function rebased_change(before_base: string, after_base: string): HistoryChange {
    const delta = build_cell_history_delta({
        worksheet: SHEET,
        sourceRow: 0,
        sourceColumn: 0,
        before: value_only_overlay(history_value('v'), history_value(before_base)),
        after: value_only_overlay(history_value('v'), history_value(after_base)),
        persistedValue: history_value(after_base),
        persistedHyperlink: null,
    });
    if (delta === undefined) throw new Error('fixture built a delta that moved nothing');
    return { kind: 'cell', delta };
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

/** Peeks and commits in one step, as a caller does once replay has landed. */
function move(state: HistoryStackState, direction: 'undo' | 'redo'): HistoryStackState {
    const peeked = peek_history(state, direction);
    if (peeked.kind !== 'available') return state;
    return commit_history_move(state, direction, peeked.entry).state;
}

function top(state: HistoryStackState, direction: 'undo' | 'redo'): HistoryEntry {
    const peeked = peek_history(state, direction);
    if (peeked.kind !== 'available') throw new Error(`nothing to ${direction}`);
    return peeked.entry;
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
        const undone = move(two, 'undo');
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

    it('takes ownership of a directly constructed action', () => {
        // Nothing in the type system forces a caller through `history_action`:
        // a mutable array is assignable to a readonly property. Recording has to
        // be the ownership boundary, because the costs are measured once and a
        // later mutation would change what replay does while the bounds still
        // described the old graph.
        const changes: HistoryChange[] = [cell_change(0, 0, 'v')];
        const outcome = record_history_action(empty_history_stack(), { label: 'Edit', changes });
        const recorded = outcome.state.undoStack[0];
        changes.push(cell_change(1, 0, 'w'));

        expect(recorded?.action.changes).toHaveLength(1);
        expect(recorded?.cellCount).toBe(1);
        expect(Object.isFrozen(recorded?.action.changes)).toBe(true);
    });

    it('does not rebuild an action it already owns', () => {
        // `history_action` exists so a caller can hold an owned action; rebuilding
        // it on the way in would pay for the whole canonical graph twice.
        const action = history_action('Edit', [cell_change(0, 0, 'x'.repeat(1_000))]);
        const outcome = record_history_action(empty_history_stack(), action);
        expect(outcome.state.undoStack[0]?.action).toBe(action);
    });

    it('shares a caller-built action\'s content rather than copying it', () => {
        // Canonicalizing rebuilds the skeleton, which is a handful of small
        // objects per cell. The CONTENT is shared: a supported gesture is a
        // million cells, and duplicating that would double peak memory exactly
        // when there is least of it.
        const change = cell_change(0, 0, 'x'.repeat(1_000));
        const outcome = record_history_action(empty_history_stack(), {
            label: 'Edit',
            changes: [change],
        });
        const recorded = outcome.state.undoStack[0]?.action.changes[0];
        if (recorded?.kind !== 'cell' || change.kind !== 'cell') {
            throw new Error('fixture did not build a cell change');
        }

        expect(recorded.delta).not.toBe(change.delta);
        expect(recorded.delta.value?.desired.content.text)
            .toBe(change.delta.value?.desired.content.text);
    });

    it('charges the label, which a caller can build from data', () => {
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1_000,
            hardMaxBytes: 5_000,
        };
        const outcome = record_history_action(
            empty_history_stack(),
            { label: 'x'.repeat(50_000), changes: [cell_change(0, 0, 'v')] },
            hard,
        );
        expect(outcome.kind).toBe('refused');
    });

    it('refuses a pre-built action that exceeds the hard bound', () => {
        // The short circuit does not apply to an already-owned action, but the
        // bound still does.
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1_000,
            hardMaxBytes: 5_000,
        };
        const action = history_action('Huge', [cell_change(0, 0, 'x'.repeat(50_000))]);
        expect(record_history_action(empty_history_stack(), action, hard).kind).toBe('refused');
    });

    it('strips a property nobody declared, rather than retaining it unmeasured', () => {
        // A structural type admits extras. Retaining one would carry unmeasured
        // bytes — a long string riding along on a highlight delta is charged the
        // fixed per-change overhead — straight past the hard bound.
        const change = {
            ...highlight_change(0, 0),
            smuggled: 'x'.repeat(10_000),
        } as unknown as HistoryChange;

        const action = history_action('Highlight', [change]);
        expect(action.changes[0]).not.toHaveProperty('smuggled');
        expect(action.changes[0]?.delta).not.toHaveProperty('smuggled');
    });

    it('strips an undeclared property from a cell delta too', () => {
        const base = cell_change(0, 0, 'v');
        const change = {
            kind: 'cell',
            delta: { ...base.delta, smuggled: 'x'.repeat(10_000) },
        } as unknown as HistoryChange;

        const entry = measure_history_action(history_action('Edit', [change]));
        expect(entry.action.changes[0]?.delta).not.toHaveProperty('smuggled');
        expect(entry.byteCost).toBeLessThan(10_000);
    });

    it('copies an accessor-backed delta instead of reading it twice', () => {
        // A getter is a valid implementation of a readonly property and can answer
        // differently on the second read, which would retain a graph nobody
        // measured.
        const first = cell_change(0, 0, 'v').delta as CellHistoryDelta;
        let answered = 0;
        const change = Object.freeze({
            kind: 'cell',
            get delta() {
                answered += 1;
                return first;
            },
        }) as unknown as HistoryChange;

        const action = history_action('Edit', [change]);
        expect(answered).toBe(1);
        expect(action.changes[0]?.delta).toEqual(first);
    });

    it('copies an action whose changes are an accessor', () => {
        // A getter is a valid implementation of a readonly property, and it can
        // answer differently tomorrow. Retaining the object would change what
        // replay does while the measured costs described today's array.
        let backing = [cell_change(0, 0, 'v')];
        const action: HistoryAction = Object.freeze({
            label: 'Edit',
            get changes() { return backing; },
        });

        const outcome = record_history_action(empty_history_stack(), action);
        const recorded = outcome.state.undoStack[0];
        backing = [cell_change(1, 0, 'w'), cell_change(2, 0, 'x')];

        expect(recorded?.action).not.toBe(action);
        expect(recorded?.action.changes).toHaveLength(1);
        expect(recorded?.cellCount).toBe(1);
    });

    it('copies a change whose payload the caller could still mutate', () => {
        // A shallow-frozen wrapper around a mutable delta is not ownership: the
        // caller could retarget the replay or invalidate the measured cost.
        const worksheet = { ...SHEET };
        const change: HistoryChange = Object.freeze({
            kind: 'highlight',
            delta: Object.freeze({
                worksheet,
                sourceRow: 0,
                sourceColumn: 0,
                before: null,
                after: 'yellow',
            }),
        } as const);

        const action = history_action('Highlight', [change]);
        worksheet.sheetName = 'Renamed';

        expect(action.changes[0]?.delta.worksheet.sheetName).toBe('Data');
        expect(action.changes[0]?.delta).not.toBe(change.delta);
    });
});

describe('action_replay_changes', () => {
    it('replays redo in application order', () => {
        const first = cell_change(0, 0, 'B');
        const second = cell_change(0, 0, 'C');
        const action = history_action('Paste', [first, second]);
        expect(action_replay_changes(action, 'redo').map((change) => change.delta)).toEqual(
            [first.delta, second.delta],
        );
    });

    it('replays undo in reverse, so an overlapping paste unwinds in order', () => {
        // A->B then B->C on one cell. Undoing the A->B delta first would find C
        // where its compare-and-swap expected B and refuse the whole replay.
        const first = cell_change(0, 0, 'B');
        const second = cell_change(0, 0, 'C');
        const action = history_action('Paste', [first, second]);
        expect(action_replay_changes(action, 'undo').map((change) => change.delta)).toEqual(
            [second.delta, first.delta],
        );
    });

    it('does not disturb the recorded order', () => {
        const action = history_action('Paste', [cell_change(0, 0, 'B'), cell_change(1, 0, 'C')]);
        action_replay_changes(action, 'undo');
        expect(action_replay_changes(action, 'redo')).toEqual(action.changes);
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

    it('charges a payload the transitions and overlays share only once', () => {
        // `build_cell_history_delta` puts the same HistoryValue object in the
        // transition and in the overlay snapshot, so the string exists once in
        // memory. Charging both views would refuse gestures that fit the hard
        // bound — losing the user's undo to protect memory never allocated.
        const long = 'x'.repeat(100_000);
        const entry = measure_history_action(history_action('Edit', [cell_change(0, 0, long)]));
        // The edit retains the new value and the base once each; charging the
        // overlay separately would put this near four times the value's size.
        expect(entry.byteCost).toBeLessThan(long.length * 2 * 2);
        expect(entry.byteCost).toBeGreaterThan(long.length * 2);
    });

    it('charges longer content more', () => {
        const small = measure_history_action(history_action('S', [cell_change(0, 0, 'x')]));
        const large = measure_history_action(history_action('L', [cell_change(0, 0, 'x'.repeat(5_000))]));
        expect(large.byteCost).toBeGreaterThan(small.byteCost);
    });

    it('charges a link-only edit for the long value it retains as an anchor', () => {
        // The hyperlink transition is a few dozen bytes while the untouched
        // value dimension retains the cell's whole string, twice. Charging only
        // the transitions would let this slip past the hard bound by orders of
        // magnitude.
        const long = 'x'.repeat(50_000);
        const entry = measure_history_action(history_action('Link', [link_only_change(long)]));
        expect(entry.byteCost).toBeGreaterThan(long.length * 2);
    });

    it('charges a recommit for the long bases it retains behind a short value', () => {
        // Disk moved from one long string to another; the pending value stayed
        // short, but both bases are retained.
        const entry = measure_history_action(history_action('Recommit', [
            rebased_change('a'.repeat(50_000), 'b'.repeat(50_000)),
        ]));
        expect(entry.byteCost).toBeGreaterThan(100_000 * 2);
    });

    it('refuses a link-only edit whose retained anchor exceeds the hard bound', () => {
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 10_000,
            hardMaxBytes: 20_000,
        };
        const outcome = record_history_action(
            empty_history_stack(),
            history_action('Link', [link_only_change('x'.repeat(50_000))]),
            hard,
        );
        expect(outcome.kind).toBe('refused');
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
        const undone = move(resumed.state, 'undo');
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
        const state = move(record_all(['A', 'B']), 'undo');
        expect(state.undoStack.map((entry) => entry.action.label)).toEqual(['A']);
        expect(state.redoStack.map((entry) => entry.action.label)).toEqual(['B']);

        const redone = move(state, 'redo');
        expect(redone.undoStack.map((entry) => entry.action.label)).toEqual(['A', 'B']);
        expect(redone.redoStack).toHaveLength(0);
    });

    it('is a no-op when the stack is empty', () => {
        const state = empty_history_stack();
        expect(move(state, 'undo')).toBe(state);
        expect(move(state, 'redo')).toBe(state);
    });

    it('stops rebuilding a gesture as soon as it passes the hard bound', () => {
        // An oversized gesture must be refused without first rebuilding the whole
        // of it: the caller's graph and the existing history are both still live
        // while it is being rebuilt, so the process can run out of memory on the
        // way to deciding not to keep it.
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1_000,
            hardMaxBytes: 2_000,
        };
        let read = 0;
        const changes: HistoryChange[] = Array.from({ length: 100 }, (_unused, index) => {
            const change = cell_change(index, 0, 'x'.repeat(1_000));
            return { get kind() { read += 1; return change.kind; }, delta: change.delta } as HistoryChange;
        });
        const outcome = record_history_action(empty_history_stack(), { label: 'Huge', changes }, hard);

        expect(outcome.kind).toBe('refused');
        // Abandoned within the first few changes rather than walking all hundred.
        expect(read).toBeLessThan(10);
        // Nothing was retained, so the caller's array is still its own.
        expect(Object.isFrozen(changes)).toBe(false);
    });

    it('reports a second commit of the same peeked entry as already committed', () => {
        // Replay is asynchronous; a commit that ran twice must not carry a
        // second, never-replayed gesture onto the redo stack, where redo would
        // apply content the user never undid.
        const start = record_all(['A', 'B']);
        const entry = top(start, 'undo');
        const once = commit_history_move(start, 'undo', entry);
        const twice = commit_history_move(once.state, 'undo', entry);

        expect(once.kind).toBe('moved');
        expect(twice.kind).toBe('already-committed');
        expect(twice.state).toBe(once.state);
        expect(twice.state.undoStack.map((item) => item.action.label)).toEqual(['A']);
        expect(twice.state.redoStack.map((item) => item.action.label)).toEqual(['B']);
    });

    it('drops a replayed entry that a concurrent record buried', () => {
        // The user edited while the undo replay was in flight. The replay landed,
        // so leaving B on the undo stack would claim its change is still applied;
        // pushing it onto the redo stack would put it out of chronological order.
        const start = record_all(['A', 'B']);
        const entry = top(start, 'undo');
        const branched = record_history_action(start, history_action('C', [cell_change(9, 0, 'c')])).state;

        const outcome = commit_history_move(branched, 'undo', entry);
        expect(outcome.kind).toBe('dropped');
        expect(outcome.state.undoStack.map((item) => item.action.label)).toEqual(['A', 'C']);
        expect(outcome.state.redoStack).toHaveLength(0);
    });

    it('leaves the entries above a dropped one undoable', () => {
        const start = record_all(['A', 'B']);
        const entry = top(start, 'undo');
        const branched = record_history_action(start, history_action('C', [cell_change(9, 0, 'c')])).state;
        const dropped = commit_history_move(branched, 'undo', entry).state;

        expect(top(dropped, 'undo').action.label).toBe('C');
        expect(move(dropped, 'undo').undoStack.map((item) => item.action.label)).toEqual(['A']);
    });

    it('drops a redo whose entry a concurrent record cleared', () => {
        // Recording clears the redo stack, so a redo in flight when the user made
        // a fresh edit finds its entry gone from both stacks though nothing ever
        // committed it. Calling that already-committed would leave a reapplied
        // change with no record, and the next undo would skip it and unwind an
        // older gesture instead.
        const undone = move(record_all(['A', 'B']), 'undo');
        const entry = top(undone, 'redo');
        const branched = record_history_action(undone, history_action('C', [cell_change(9, 0, 'c')])).state;
        expect(branched.redoStack).toHaveLength(0);

        expect(commit_history_move(branched, 'redo', entry).kind).toBe('dropped');
    });

    it('drops a commit whose entry a clear discarded', () => {
        const start = record_all(['A', 'B']);
        const entry = top(start, 'undo');
        expect(commit_history_move(clear_history(start), 'undo', entry).kind).toBe('dropped');
    });

    it('ignores a stale commit of a move the user has since redone', () => {
        // Undo B, redo B: the same entry is back on the undo stack, so entry
        // identity alone would read a delayed duplicate of the first undo's
        // commit as a fresh move — leaving history claiming B is undone while its
        // content is redone.
        const start = record_all(['A', 'B']);
        const first_peek = top(start, 'undo');
        const undone = commit_history_move(start, 'undo', first_peek).state;
        const redone = move(undone, 'redo');
        expect(redone.undoStack.map((item) => item.action.label)).toEqual(['A', 'B']);

        const stale = commit_history_move(redone, 'undo', first_peek);
        expect(stale.kind).toBe('already-committed');
        expect(stale.state).toBe(redone);
        expect(stale.state.undoStack.map((item) => item.action.label)).toEqual(['A', 'B']);
    });

    it('recognizes a duplicate commit after the entry moved twice more', () => {
        // The count says which way a stale commit is stale, so a commit two moves
        // behind still reads as already-committed rather than as a vanished entry.
        const start = record_all(['A', 'B']);
        const peeked = top(start, 'undo');
        const undone = commit_history_move(start, 'undo', peeked).state;
        const redone = move(undone, 'redo');
        const undone_again = move(redone, 'undo');

        expect(commit_history_move(undone_again, 'undo', peeked).kind).toBe('already-committed');
    });

    it('reports a commit after another undo already moved the entry', () => {
        const start = record_all(['A', 'B']);
        const entry = top(start, 'undo');
        const moved = move(start, 'undo');

        const outcome = commit_history_move(moved, 'undo', entry);
        expect(outcome.kind).toBe('already-committed');
        expect(outcome.state).toBe(moved);
        expect(moved.undoStack.map((item) => item.action.label)).toEqual(['A']);
    });

    it('round-trips a longer sequence back to where it started', () => {
        const start = record_all(['A', 'B', 'C']);
        let state = start;
        for (const _ of [0, 1, 2]) state = move(state, 'undo');
        expect(state.undoStack).toHaveLength(0);
        for (const _ of [0, 1, 2]) state = move(state, 'redo');
        expect(state.undoStack.map((entry) => entry.action.label)).toEqual(['A', 'B', 'C']);
        expect(state.redoStack).toHaveLength(0);
    });
});

describe('history_usage', () => {
    it('counts undone actions as still retained', () => {
        const state = move(record_all(['A', 'B']), 'undo');
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

    it('does not let change order decide whether a gesture spans sheets', () => {
        // An id-less target compared against an identified one falls back to the
        // name, while the reverse comparison insists on the id.
        const identified: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
        const anonymous: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data' };
        const forward = history_action('Paste', [
            cell_change(0, 0, 'v', anonymous),
            cell_change(1, 0, 'v', identified),
        ]);
        const reversed = history_action('Paste', [
            cell_change(0, 0, 'v', identified),
            cell_change(1, 0, 'v', anonymous),
        ]);
        expect(action_is_single_worksheet(forward)).toBe(true);
        expect(action_is_single_worksheet(reversed)).toBe(true);
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
