import { describe, expect, it } from 'vitest';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    hyperlink_only_overlay,
    value_only_overlay,
    type CellHistoryDelta,
    type HistoryValue,
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
    MAX_BARRIER_LABEL_LENGTH,
    peek_history,
    record_history_action,
    rekey_committed_tail_removal_history,
    rekey_saved_appended_row_history,
    type HistoryAction,
    type HistoryBounds,
    type HistoryChange,
    type HistoryEntry,
    type HistoryStackState,
    type SavedHistoryRowAssignment,
    type SavedTailRemovalCommit,
} from '../webview/history-stack-model';
import type {
    PendingAppendedRow,
    PendingRowFormatTemplate,
    PendingTailRemoval,
} from '../pending-changes';

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

/**
 * A change whose new value carries rich-text runs, built around the delta builder.
 *
 * `build_cell_history_delta` snapshots, so runs handed to it arrive at the
 * recorder already copied. Grafting them onto a finished delta is what puts them
 * in front of the recorder's own walk, which is the walk under test.
 */
function rich_change(runs: readonly { readonly text: string }[]): HistoryChange {
    const delta = cell_change(0, 0, 'v').delta as CellHistoryDelta;
    const value = { text: 'v', runs: { runs } } as HistoryValue;
    return {
        kind: 'cell',
        delta: {
            ...delta,
            value: {
                ...delta.value!,
                desired: { ...delta.value!.desired, content: value },
            },
            afterOverlay: value_only_overlay(value, history_value('base')),
        },
    };
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
        // it on the way in would pay for the whole owned graph twice.
        const action = history_action('Edit', [cell_change(0, 0, 'x'.repeat(1_000))]);
        const outcome = record_history_action(empty_history_stack(), action);
        expect(outcome.state.undoStack[0]?.action).toBe(action);
    });

    it('rebuilds even a delta the model built, because a snapshot is not owned', () => {
        // `build_cell_history_delta` snapshots: its strings are the CALLER's, shared
        // by value rather than materialized, so retaining one would retain whatever
        // those strings hold alive — uncharged. Every delta crosses the action
        // boundary.
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
        expect(Object.isFrozen(recorded.delta)).toBe(true);
    });

    it('rebuilds a delta it did not build, sharing the content', () => {
        // A hand-assembled delta is untrusted structure — a getter, a prototype
        // field, an undeclared extra — so it is rebuilt. Only the SKELETON: the
        // content strings are interned, not duplicated, because a supported gesture
        // is a million cells.
        const built = cell_change(0, 0, 'x'.repeat(1_000)).delta as CellHistoryDelta;
        const forged: HistoryChange = { kind: 'cell', delta: { ...built } };
        const outcome = record_history_action(empty_history_stack(), {
            label: 'Edit',
            changes: [forged],
        });
        const recorded = outcome.state.undoStack[0]?.action.changes[0];
        if (recorded?.kind !== 'cell') throw new Error('fixture did not build a cell change');

        expect(recorded.delta).not.toBe(forged.delta);
        expect(recorded.delta.value?.desired.content.text).toBe(built.value?.desired.content.text);
    });

    it('truncates a label built from data rather than retaining it', () => {
        const outcome = record_history_action(empty_history_stack(), {
            label: 'x'.repeat(50_000),
            changes: [cell_change(0, 0, 'v')],
        });
        const label = outcome.state.undoStack[0]?.action.label ?? '';
        expect(label.length).toBe(MAX_BARRIER_LABEL_LENGTH);
        expect(label.endsWith('…')).toBe(true);
    });

    it('copies a short label built by slicing a huge parent', () => {
        // V8 answers `slice` with a view that retains the WHOLE of its parent, so a
        // label sliced out of pasted content charges a few hundred bytes while
        // keeping hundreds of MiB alive — hardMaxBytes defeated by the one string
        // not measured against it. Short labels are therefore materialized too,
        // not only over-long ones.
        //
        // Flatness is not observable from JS: this asserts the value survives the
        // copy, and reading `barrier_label` is what confirms it is a copy.
        const parent = `Paste ${'x'.repeat(200_000)}`;
        const outcome = record_history_action(empty_history_stack(), {
            label: parent.slice(0, 20),
            changes: [cell_change(0, 0, 'v')],
        });

        expect(outcome.state.undoStack[0]?.action.label).toBe('Paste xxxxxxxxxxxxxx');
    });

    it('does not truncate a label into a lone surrogate', () => {
        // The pair straddles the cut: its high half is the last unit kept.
        const label = `${'a'.repeat(MAX_BARRIER_LABEL_LENGTH - 2)}😀 and more`;
        const outcome = record_history_action(empty_history_stack(), {
            label,
            changes: [cell_change(0, 0, 'v')],
        });
        const kept = outcome.state.undoStack[0]?.action.label ?? '';

        // Dropped whole rather than kept as a lone high surrogate.
        expect(kept).toBe(`${'a'.repeat(MAX_BARRIER_LABEL_LENGTH - 2)}…`);
        expect([...kept].every((unit) => unit.codePointAt(0)! < 0xd800)).toBe(true);
    });

    it('answers an empty action before the bounds can install a barrier', () => {
        // A label built from data must not be able to destroy valid history for a
        // gesture that never needed recording.
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 10,
            hardMaxBytes: 20,
        };
        const existing = record_all(['A']);
        const outcome = record_history_action(existing, { label: 'x'.repeat(50_000), changes: [] }, hard);

        expect(outcome.kind).toBe('empty');
        expect(outcome.state).toBe(existing);
    });

    it('truncates the label a barrier reports', () => {
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1_000,
            hardMaxBytes: 2_000,
        };
        const outcome = record_history_action(
            empty_history_stack(),
            { label: 'y'.repeat(50_000), changes: [cell_change(0, 0, 'x'.repeat(50_000))] },
            hard,
        );
        expect(outcome.kind).toBe('refused');
        expect(outcome.state.barrier?.label.length).toBe(MAX_BARRIER_LABEL_LENGTH);
    });

    describe('a streamed action source', () => {
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1_000,
            hardMaxBytes: 5_000,
        };

        it('records a generator the same as an array', () => {
            function* changes(): Generator<HistoryChange> {
                yield cell_change(0, 0, 'a');
                yield cell_change(1, 0, 'b');
            }
            const outcome = record_history_action(
                empty_history_stack(),
                { label: 'Streamed', changes: changes() },
                hard,
            );
            expect(outcome.kind).toBe('recorded');
            expect(outcome.state.undoStack[0]?.action.changes).toHaveLength(2);
        });

        it('stops consuming the source at the first oversized prefix', () => {
            // The point of streaming: a workbook-wide discard must not be walked
            // to the end just to be refused. The generator THROWS if asked for
            // one change past the prefix that busts the bound, so a recorder that
            // merely reported a refusal after draining would fail here rather
            // than pass quietly.
            let yielded = 0;
            function* changes(): Generator<HistoryChange> {
                while (true) {
                    if (yielded > 3) throw new Error('recorder read past the bound');
                    yielded += 1;
                    yield cell_change(yielded, 0, 'x'.repeat(4_000));
                }
            }
            const outcome = record_history_action(
                empty_history_stack(),
                { label: 'Discard All', changes: changes() },
                hard,
            );
            expect(outcome.kind).toBe('refused');
            expect(yielded).toBeLessThanOrEqual(3);
        });

        it('answers an empty source without installing a barrier', () => {
            function* changes(): Generator<HistoryChange> {}
            const outcome = record_history_action(
                empty_history_stack(),
                { label: 'Discard All', changes: changes() },
                hard,
            );
            expect(outcome.kind).toBe('empty');
            expect(outcome.state.barrier).toBeUndefined();
        });

        it('walks the source once, so the retained action can be replayed twice', () => {
            // A retained action is read again by every replay. Holding an
            // exhausted iterator would make the second undo see no changes at
            // all, so what is retained must be the walked array.
            function* changes(): Generator<HistoryChange> {
                yield cell_change(0, 0, 'a');
            }
            const outcome = record_history_action(
                empty_history_stack(),
                { label: 'Streamed', changes: changes() },
                hard,
            );
            const entry = outcome.state.undoStack[0];
            expect(entry?.action.changes).toHaveLength(1);
            expect(entry?.action.changes).toHaveLength(1);
            expect([...(entry?.action.changes ?? [])]).toHaveLength(1);
        });
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

    it('counts one cell once when its two targets could not be shared', () => {
        // Interning is bounded, so a very long identity leaves two equal targets
        // unshared on purpose. Counting by object identity would then call one cell
        // two and evict history the user could still undo.
        const name = 'n'.repeat(200_000);
        const entry = measure_history_action(history_action('Paste', [
            cell_change(4, 2, 'first', { sheetIndex: 0, sheetName: name }),
            cell_change(4, 2, 'second', { sheetIndex: 0, sheetName: name }),
        ]));
        expect(entry.cellCount).toBe(1);
    });

    it('counts one cell once across two targets sharing a worksheet id', () => {
        // An external reorder reassigns indices, so an id outranks whatever index
        // arrived with it.
        const entry = measure_history_action(history_action('Paste', [
            cell_change(4, 2, 'first', { sheetIndex: 0, worksheetId: 'rId1' }),
            cell_change(4, 2, 'second', { sheetIndex: 7, worksheetId: 'rId1' }),
        ]));
        expect(entry.cellCount).toBe(1);
    });

    it('counts one cell once when an id outranks a name that disagrees', () => {
        const entry = measure_history_action(history_action('Paste', [
            cell_change(4, 2, 'first', { sheetIndex: 0, sheetName: 'Before', worksheetId: 'rId1' }),
            cell_change(4, 2, 'second', { sheetIndex: 0, sheetName: 'After', worksheetId: 'rId1' }),
        ]));
        expect(entry.cellCount).toBe(1);
    });

    it('counts one cell once across two indices when only a name identifies it', () => {
        const entry = measure_history_action(history_action('Paste', [
            cell_change(4, 2, 'first', { sheetIndex: 0, sheetName: 'Data' }),
            cell_change(4, 2, 'second', { sheetIndex: 3, sheetName: 'Data' }),
        ]));
        expect(entry.cellCount).toBe(1);
    });

    it('counts positional targets at different indices separately', () => {
        // Nothing but the index identifies these, so the index has to be believed.
        const entry = measure_history_action(history_action('Discard all', [
            cell_change(4, 2, 'first', { sheetIndex: 0 }),
            cell_change(4, 2, 'second', { sheetIndex: 1 }),
        ]));
        expect(entry.cellCount).toBe(2);
    });

    it('does not deduplicate a named target against an identified one', () => {
        // Matching indices are not evidence: one target names its sheet, the other
        // identifies a different one.
        const entry = measure_history_action(history_action('Discard all', [
            cell_change(4, 2, 'first', { sheetIndex: 0, sheetName: 'Data' }),
            cell_change(4, 2, 'second', { sheetIndex: 0, worksheetId: 'rId9' }),
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

    it('charges a worksheet name and id, which nothing bounds', () => {
        // A name comes from the file and an id from its relationships, so neither is
        // length-bounded; a gesture carrying a megabyte-long name past the byte
        // bound is a gesture that exhausted the heap history was bounded to protect.
        const huge: WorksheetTarget = {
            sheetIndex: 0,
            sheetName: 'n'.repeat(60_000),
            worksheetId: 'i'.repeat(40_000),
        };
        const entry = measure_history_action(history_action('Edit', [cell_change(0, 0, 'v', huge)]));
        expect(entry.byteCost).toBeGreaterThan(100_000 * 2);
    });

    it('shares one worksheet target across a wide gesture', () => {
        // Materializing per delta would turn one shared name into a copy per cell,
        // each charged once by an estimator that deduplicated by value — the bound
        // defeated by the copying meant to make it honest. The action's owner hands
        // out one target instead, and the estimator charges the object.
        const name = 'n'.repeat(5_000);
        const sheet: WorksheetTarget = { sheetIndex: 0, sheetName: name };
        const outcome = record_history_action(empty_history_stack(), {
            label: 'Paste',
            changes: [0, 1, 2].map((row) => cell_change(row, 0, 'v', sheet)),
        });
        const changes = outcome.state.undoStack[0]?.action.changes ?? [];

        expect(changes).toHaveLength(3);
        expect(changes[1]?.delta.worksheet).toBe(changes[0]?.delta.worksheet);
        expect(changes[2]?.delta.worksheet).toBe(changes[0]?.delta.worksheet);
        // Charged once, because one copy is what is retained.
        expect(outcome.state.undoStack[0]?.byteCost).toBeLessThan(5_000 * 2 * 2);
    });

    it('charges one string once however many cells of the action hold it', () => {
        // The owner materializes each distinct string once and hands that one
        // string to every delta asking for an equal one, so a charge per delta
        // would measure ten copies of memory that exists once — and refuse, behind
        // a barrier that clears valid history, a paste that fits the bound easily.
        const text = 'v'.repeat(100_000);
        const wide = measure_history_action(history_action(
            'Paste',
            [0, 1, 2, 3, 4].map((row) => cell_change(row, 0, text)),
        ));
        const one = measure_history_action(history_action('Paste', [cell_change(0, 0, text)]));

        expect(wide.byteCost - one.byteCost).toBeLessThan(100_000 * 2);
    });

    it('charges an identity shared by two targets once', () => {
        // Two targets, because they are two distinct tuples replay must not
        // conflate — but one `worksheetId` string between them, because that is
        // what the owner shares by value and therefore what memory holds.
        const id = 'r'.repeat(50_000);
        const entry = measure_history_action(history_action('Paste', [
            cell_change(0, 0, 'v', { sheetIndex: 0, worksheetId: id }),
            cell_change(1, 0, 'v', { sheetIndex: 1, worksheetId: id }),
        ]));

        expect(entry.action.changes[1]?.delta.worksheet)
            .not.toBe(entry.action.changes[0]?.delta.worksheet);
        expect(entry.byteCost).toBeLessThan(50_000 * 2 * 2);
    });

    it('does not share a worksheet target between two gestures', () => {
        // Ownership is per action, because an action is what gets recorded, refused,
        // evicted and released. Two actions each own their copy and each are charged
        // for it — which is what the bounds cap, since either may outlive the other.
        const sheet: WorksheetTarget = { sheetIndex: 0, sheetName: 'n'.repeat(5_000) };
        const first = record_history_action(empty_history_stack(), history_action('A', [cell_change(0, 0, 'v', sheet)]));
        const second = record_history_action(first.state, history_action('B', [cell_change(1, 0, 'v', sheet)]));
        const [a, b] = second.state.undoStack;

        expect(a?.action.changes[0]?.delta.worksheet).not.toBe(b?.action.changes[0]?.delta.worksheet);
        expect(a?.action.changes[0]?.delta.worksheet.sheetName)
            .toBe(b?.action.changes[0]?.delta.worksheet.sheetName);
        expect(a?.byteCost).toBeGreaterThan(5_000 * 2);
        expect(b?.byteCost).toBeGreaterThan(5_000 * 2);
    });

    it('charges one worksheet identity once across a wide gesture', () => {
        // A million-cell paste names one worksheet, whose name exists once in memory
        // however many deltas point at it. Charging each of them would refuse
        // gestures that fit the bound.
        const named: WorksheetTarget = { sheetIndex: 0, sheetName: 'n'.repeat(50_000) };
        const entry = measure_history_action(history_action('Paste', [
            cell_change(0, 0, 'v', named),
            cell_change(1, 0, 'v', named),
            cell_change(2, 0, 'v', named),
        ]));
        expect(entry.byteCost).toBeLessThan(50_000 * 2 * 2);
    });

    it('charges a multi-cell highlight gesture for one worksheet identity', () => {
        // A target per highlighted cell would charge a long sheet name once per cell
        // and refuse a gesture that retains exactly one copy of it — clearing valid
        // history to protect memory that was never allocated.
        const sheet: WorksheetTarget = { sheetIndex: 0, sheetName: 'n'.repeat(20_000) };
        const entry = measure_history_action(history_action('Highlight', [
            highlight_change(0, 0, sheet),
            highlight_change(1, 0, sheet),
            highlight_change(2, 0, sheet),
        ]));
        expect(entry.byteCost).toBeLessThan(20_000 * 2 * 2);
        expect(entry.action.changes[1]?.delta.worksheet)
            .toBe(entry.action.changes[0]?.delta.worksheet);
    });

    it('shares an identity of any length within one action', () => {
        // No length cutoff: the action's index is keyed on the strings it already
        // owns, so there is no composite key whose cost would grow with the identity.
        const name = 'n'.repeat(50_000);
        const entry = measure_history_action(history_action('Paste', [
            cell_change(0, 0, 'v', { sheetIndex: 0, sheetName: name }),
            cell_change(1, 0, 'v', { sheetIndex: 0, sheetName: name }),
        ]));
        expect(entry.byteCost).toBeLessThan(50_000 * 2 * 2);
        expect(entry.action.changes[1]?.delta.worksheet)
            .toBe(entry.action.changes[0]?.delta.worksheet);
    });

    it('does not share targets that disagree on a field replay would ignore', () => {
        // What is shared has to be what is RETAINED, or the estimator's per-object
        // charge is wrong again: these two are one sheet to replay and two different
        // snapshots to hold.
        const entry = measure_history_action(history_action('Paste', [
            cell_change(0, 0, 'v', { sheetIndex: 0, sheetName: 'Before', worksheetId: 'rId1' }),
            cell_change(1, 0, 'v', { sheetIndex: 0, sheetName: 'After', worksheetId: 'rId1' }),
        ]));
        expect(entry.action.changes[1]?.delta.worksheet)
            .not.toBe(entry.action.changes[0]?.delta.worksheet);
        // Still one cell each, since replay identity is a separate question.
        expect(entry.cellCount).toBe(2);
    });

    it('shares a short identity that arrives as two different objects', () => {
        // A real sheet name is a few dozen characters, so a composite key over it is
        // free to build and equal targets from different sources become one.
        const outcome = record_history_action(empty_history_stack(), history_action('Paste', [
            cell_change(0, 0, 'v', { sheetIndex: 0, sheetName: 'Data' }),
            cell_change(1, 0, 'v', { sheetIndex: 0, sheetName: 'Data' }),
        ]));
        const changes = outcome.state.undoStack[0]?.action.changes ?? [];
        expect(changes[1]?.delta.worksheet).toBe(changes[0]?.delta.worksheet);
    });

    it('charges a run\'s shape, not only its text', () => {
        // A cell of one-character runs is mostly shape: a budget told only about text
        // would let the whole run graph be allocated before anything checked.
        const many = rich_change(Array.from({ length: 2_000 }, () => ({ text: 'y' })));
        const few = rich_change(Array.from({ length: 2 }, () => ({ text: 'y' })));
        expect(measure_history_action(history_action('Many', [many])).byteCost)
            .toBeGreaterThan(measure_history_action(history_action('Few', [few])).byteCost + 10_000);
    });

    it('stops rebuilding inside one change whose runs exceed the hard bound', () => {
        // One cell can hold enough rich text to exceed the bound by itself, and a
        // budget checked only BETWEEN changes would rebuild all of it — the
        // caller's graph and the whole clone alive together — before deciding to
        // keep none of it.
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 10_000,
            hardMaxBytes: 20_000,
        };
        let read = 0;
        // Distinct texts, because equal ones are shared and cost nothing after the
        // first — the shape is what has to be charged here.
        const runs = Array.from({ length: 500 }, (_unused, index) => ({
            get text() { read += 1; return `${index}${'y'.repeat(1_000)}`; },
        })) as { readonly text: string }[];
        const change = rich_change(runs);

        expect(record_history_action(empty_history_stack(), { label: 'Rich', changes: [change] }, hard).kind)
            .toBe('refused');
        // Abandoned within the first few runs rather than copying all five hundred.
        expect(read).toBeLessThan(30);
    });

    it('refuses a gesture whose worksheet name alone exceeds the hard bound', () => {
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 10_000,
            hardMaxBytes: 20_000,
        };
        const named: WorksheetTarget = { sheetIndex: 0, sheetName: 'n'.repeat(50_000) };
        const outcome = record_history_action(
            empty_history_stack(),
            history_action('Edit', [cell_change(0, 0, 'v', named)]),
            hard,
        );
        expect(outcome.kind).toBe('refused');
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

describe('rekeyed history bounds', () => {
    it('keeps the next reachable redo entries when only the redo stack exceeds bounds', () => {
        let state = record_all(['A', 'B', 'C']);
        state = move(move(move(state, 'undo'), 'undo'), 'undo');
        expect(state.redoStack.map((entry) => entry.action.label)).toEqual(['C', 'B', 'A']);

        const bounded = rekey_saved_appended_row_history(state, [{
            worksheet: SHEET,
            pendingRowId: 'unrelated-pending-row',
            sourceRow: 10,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }], {
            maxActions: 2,
            maxCells: 1_000,
            softMaxBytes: 128 * 1024 * 1024,
            hardMaxBytes: 256 * 1024 * 1024,
        });

        expect(bounded.redoStack.map((entry) => entry.action.label)).toEqual(['B', 'A']);
        expect(top(bounded, 'redo').action.label).toBe('A');
    });

    it('stops saved-row payload expansion at the hard bound', () => {
        const rows = Array.from({ length: 10_000 }, (_unused, index) => ({
            id: `pending-${index}`,
            cells: {},
            formatTemplateId: 'plain',
            createdOrder: index + 1,
        }));
        const recorded = record_history_action(empty_history_stack(), {
            label: 'Discard changes',
            changes: [{
                kind: 'pendingRows',
                delta: {
                    worksheet: SHEET,
                    before: {
                        formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
                        appendedRows: rows,
                        tailRemovals: [],
                        conflicts: [],
                    },
                    after: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                },
            }],
        });
        if (recorded.kind !== 'recorded') throw new Error('Expected pending-row history');
        let saved_row_reads = 0;
        const assignments = rows.map((row, sourceRow) => Object.defineProperty({
            worksheet: SHEET,
            pendingRowId: row.id,
            sourceRow,
            savedFingerprint: `fingerprint-${sourceRow}`,
        }, 'savedRow', {
            enumerable: true,
            get: () => {
                saved_row_reads += 1;
                return { cells: {}, format: { kind: 'none' as const } };
            },
        }) as SavedHistoryRowAssignment);
        const tiny: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1,
            hardMaxBytes: 1,
        };

        const rekeyed = rekey_saved_appended_row_history(recorded.state, assignments, tiny);

        expect(rekeyed.barrier?.reason).toBe('action-too-large');
        expect(saved_row_reads).toBeLessThanOrEqual(1);
    });

    it('stops walking saved pending rows at the hard bound', () => {
        let row_reads = 0;
        let row_payload_reads = 0;
        const rows = Array.from({ length: 10_000 }, (_unused, index) =>
            Object.defineProperties({
                formatTemplateId: 'plain',
                createdOrder: index + 1,
            }, {
                id: {
                    enumerable: true,
                    get: () => { row_reads += 1; return `pending-${index}`; },
                },
                cells: {
                    enumerable: true,
                    get: () => {
                        row_payload_reads += 1;
                        return { 0: { value: 'x'.repeat(8 * 1024 * 1024) } };
                    },
                },
            }) as PendingAppendedRow);
        const action: HistoryAction = {
            label: 'Discard changes',
            changes: [{
                kind: 'pendingRows',
                delta: {
                    worksheet: SHEET,
                    before: {
                        formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
                        appendedRows: rows,
                        tailRemovals: [],
                        conflicts: [],
                    },
                    after: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                },
            }],
        };
        const state: HistoryStackState = {
            ...empty_history_stack(),
            undoStack: [{ action, cellCount: 0, byteCost: 0, epoch: 0, id: {}, moves: 0 }],
        };
        const tiny: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1,
            hardMaxBytes: 1,
        };

        const rekeyed = rekey_saved_appended_row_history(state, [{
            worksheet: SHEET,
            pendingRowId: 'pending-0',
            sourceRow: 0,
            savedFingerprint: 'fingerprint-0',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }], tiny);

        expect(rekeyed.barrier?.reason).toBe('action-too-large');
        expect(row_reads).toBeLessThanOrEqual(5);
        expect(row_payload_reads).toBe(0);
    });

    it('indexes saved-row templates once before a bounded expansion', () => {
        let template_id_reads = 0;
        const templates = Array.from({ length: 10_000 }, (_unused, index) =>
            Object.defineProperty({ format: { kind: 'none' as const } }, 'id', {
                enumerable: true,
                get: () => { template_id_reads += 1; return `template-${index}`; },
            }) as PendingRowFormatTemplate);
        const row: PendingAppendedRow = {
            id: 'pending-0',
            cells: {},
            formatTemplateId: 'template-0',
            createdOrder: 1,
        };
        const action: HistoryAction = {
            label: 'Discard changes',
            changes: [{
                kind: 'pendingRows',
                delta: {
                    worksheet: SHEET,
                    before: {
                        formatTemplates: templates,
                        appendedRows: [row],
                        tailRemovals: [],
                        conflicts: [],
                    },
                    after: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                },
            }],
        };
        const state: HistoryStackState = {
            ...empty_history_stack(),
            undoStack: [{ action, cellCount: 0, byteCost: 0, epoch: 0, id: {}, moves: 0 }],
        };
        const tiny: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1,
            hardMaxBytes: 1,
        };

        rekey_saved_appended_row_history(state, [{
            worksheet: SHEET,
            pendingRowId: row.id,
            sourceRow: 0,
            savedFingerprint: 'fingerprint-0',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }], tiny);

        expect(template_id_reads).toBeLessThanOrEqual(10_001);
    });

    it('indexes committed removals once and refuses before reading saved payloads', () => {
        const removals: PendingTailRemoval[] = Array.from(
            { length: 1_000 },
            (_unused, index) => ({
                appendHistoryId: `saved-${index}`,
                sourceRow: index,
                savedFingerprint: `fingerprint-${index}`,
                savedRow: { cells: {}, format: { kind: 'none' } },
            }),
        );
        const recorded = record_history_action(empty_history_stack(), {
            label: 'Remove appended rows',
            changes: removals.map((removal, index) => ({
                kind: 'tailRemoval' as const,
                delta: {
                    worksheet: SHEET,
                    appendHistoryId: removal.appendHistoryId,
                    before: removal,
                    after: null,
                    beforeIndex: index,
                    afterIndex: null,
                },
            })),
        });
        if (recorded.kind !== 'recorded') throw new Error('Expected removal history');
        let key_reads = 0;
        let saved_row_reads = 0;
        const committed = removals.map((plain) => {
            const removal = Object.defineProperties({}, {
                appendHistoryId: {
                    enumerable: true,
                    get: () => { key_reads += 1; return plain.appendHistoryId; },
                },
                sourceRow: {
                    enumerable: true,
                    get: () => { key_reads += 1; return plain.sourceRow; },
                },
                savedFingerprint: { enumerable: true, value: plain.savedFingerprint },
                savedRow: {
                    enumerable: true,
                    get: () => { saved_row_reads += 1; return plain.savedRow; },
                },
            }) as PendingTailRemoval;
            return Object.defineProperties({}, {
                worksheet: {
                    enumerable: true,
                    get: () => { key_reads += 1; return SHEET; },
                },
                removal: { enumerable: true, value: removal },
            }) as SavedTailRemovalCommit;
        });
        const tiny: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1,
            hardMaxBytes: 1,
        };

        const rekeyed = rekey_committed_tail_removal_history(recorded.state, committed, tiny);

        expect(rekeyed.barrier?.reason).toBe('action-too-large');
        expect(key_reads).toBe(3_000);
        expect(saved_row_reads).toBe(0);
    });

    it('refuses committed pending removals before expanding their snapshot', () => {
        let row_reads = 0;
        let saved_row_reads = 0;
        const removals = Array.from({ length: 10_000 }, (_unused, index) =>
            Object.defineProperty({
                sourceRow: index,
                savedFingerprint: `fingerprint-${index}`,
                savedRow: { cells: {}, format: { kind: 'none' as const } },
            }, 'appendHistoryId', {
                enumerable: true,
                get: () => { row_reads += 1; return `saved-${index}`; },
            }) as PendingTailRemoval);
        const action: HistoryAction = {
            label: 'Remove appended rows',
            changes: [{
                kind: 'pendingRows',
                delta: {
                    worksheet: SHEET,
                    before: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: removals,
                        conflicts: [],
                    },
                    after: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                },
            }],
        };
        const state: HistoryStackState = {
            ...empty_history_stack(),
            undoStack: [{ action, cellCount: 0, byteCost: 0, epoch: 0, id: {}, moves: 0 }],
        };
        const removal = Object.defineProperty({
            appendHistoryId: 'saved-0',
            sourceRow: 0,
            savedFingerprint: 'fingerprint-0',
        }, 'savedRow', {
            enumerable: true,
            get: () => {
                saved_row_reads += 1;
                return { cells: {}, format: { kind: 'none' as const } };
            },
        }) as PendingTailRemoval;
        const tiny: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1,
            hardMaxBytes: 1,
        };

        const rekeyed = rekey_committed_tail_removal_history(
            state,
            [{ worksheet: SHEET, removal }],
            tiny,
        );

        expect(rekeyed.barrier?.reason).toBe('action-too-large');
        expect(row_reads).toBeLessThanOrEqual(2);
        expect(saved_row_reads).toBe(0);
    });

    it('stops a two-sided committed-removal merge at the hard bound', () => {
        let removal_id_reads = 0;
        const removal = (index: number, fingerprint: string): PendingTailRemoval =>
            Object.defineProperty({
                sourceRow: index,
                savedFingerprint: fingerprint,
                savedRow: { cells: {}, format: { kind: 'none' as const } },
            }, 'appendHistoryId', {
                enumerable: true,
                get: () => { removal_id_reads += 1; return `saved-${index}`; },
            }) as PendingTailRemoval;
        const before = Array.from(
            { length: 10_000 },
            (_unused, index) => removal(index, `before-${index}`),
        );
        const after = Array.from(
            { length: 10_000 },
            (_unused, index) => removal(index, index === 0 ? 'changed' : `before-${index}`),
        );
        const action: HistoryAction = {
            label: 'Remove appended rows',
            changes: [{
                kind: 'pendingRows',
                delta: {
                    worksheet: SHEET,
                    before: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: before,
                        conflicts: [],
                    },
                    after: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: after,
                        conflicts: [],
                    },
                },
            }],
        };
        const state: HistoryStackState = {
            ...empty_history_stack(),
            undoStack: [{ action, cellCount: 0, byteCost: 0, epoch: 0, id: {}, moves: 0 }],
        };
        const tiny: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1,
            hardMaxBytes: 1,
        };

        const rekeyed = rekey_committed_tail_removal_history(state, [{
            worksheet: SHEET,
            removal: before[0],
        }], tiny);

        expect(rekeyed.barrier?.reason).toBe('action-too-large');
        expect(removal_id_reads).toBeLessThanOrEqual(10);
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

    it('refuses an oversized gesture without walking past the bound', () => {
        // The changes are not copied before the budgeted walk: a copy would
        // enumerate and allocate the whole of a million-change gesture before the
        // budget could stop, which is the peak-memory spike the budget exists to
        // avoid.
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1_000,
            hardMaxBytes: 2_000,
        };
        let yielded = 0;
        const backing = Array.from({ length: 100 }, (_unused, index) => cell_change(index, 0, 'x'.repeat(1_000)));
        const changes = Object.create(backing, {
            [Symbol.iterator]: {
                value: function* iterate() {
                    for (const change of backing) {
                        yielded += 1;
                        yield change;
                    }
                },
            },
        }) as readonly HistoryChange[];

        expect(record_history_action(empty_history_stack(), { label: 'Huge', changes }, hard).kind)
            .toBe('refused');
        expect(yielded).toBeLessThan(10);
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

    it('adopts a landed redo whose stack a concurrent record cleared', () => {
        // Recording clears the redo stack, so a redo in flight when the user made a
        // fresh edit finds its entry gone from both stacks though nothing ever
        // committed it. Its content is applied all the same, so discarding it would
        // leave a reapplied change with no record — the next undo would skip it and
        // unwind an older gesture instead.
        const undone = move(record_all(['A', 'B']), 'undo');
        const entry = top(undone, 'redo');
        const branched = record_history_action(undone, history_action('C', [cell_change(9, 0, 'c')])).state;
        expect(branched.redoStack).toHaveLength(0);

        const outcome = commit_history_move(branched, 'redo', entry);
        expect(outcome.kind).toBe('moved');
        // Newest, which is also where it belongs: its content landed last.
        expect(outcome.state.undoStack.map((item) => item.action.label)).toEqual(['A', 'C', 'B']);
        expect(outcome.state.redoStack).toHaveLength(0);
    });

    it('does not adopt an adopted redo twice', () => {
        const undone = move(record_all(['A', 'B']), 'undo');
        const entry = top(undone, 'redo');
        const branched = record_history_action(undone, history_action('C', [cell_change(9, 0, 'c')])).state;
        const adopted = commit_history_move(branched, 'redo', entry).state;

        const again = commit_history_move(adopted, 'redo', entry);
        expect(again.kind).toBe('already-committed');
        expect(again.state.undoStack.map((item) => item.action.label)).toEqual(['A', 'C', 'B']);
    });

    it('does not adopt a redo entry a previous commit dropped', () => {
        // The entry leaves the stack on the non-top drop path, so a duplicate
        // delivery finds it in neither stack — indistinguishable, without the
        // ledger, from a redo whose first commit never arrived. Adopting it here
        // would resurrect a gesture this function already refused, and evict a
        // newer action to make room for it.
        const undone = move(move(record_all(['A', 'B']), 'undo'), 'undo');
        const buried = undone.redoStack[0];
        expect(buried.action.label).toBe('B');

        const dropped = commit_history_move(undone, 'redo', buried);
        expect(dropped.kind).toBe('dropped');
        expect(dropped.state.redoStack.map((item) => item.action.label)).toEqual(['A']);

        const again = commit_history_move(dropped.state, 'redo', buried);
        expect(again.kind).toBe('already-committed');
        expect(again.state).toBe(dropped.state);
        expect(again.state.undoStack).toHaveLength(0);
    });

    it('can unwind everything an adoption left applied', () => {
        const undone = move(record_all(['A', 'B']), 'undo');
        const entry = top(undone, 'redo');
        const branched = record_history_action(undone, history_action('C', [cell_change(9, 0, 'c')])).state;
        let state = commit_history_move(branched, 'redo', entry).state;

        for (const _ of [0, 1, 2]) state = move(state, 'undo');
        expect(state.undoStack).toHaveLength(0);
        expect(state.redoStack.map((item) => item.action.label)).toEqual(['B', 'C', 'A']);
    });

    it('does not adopt a landed redo whose history a clear discarded', () => {
        // The clear means the document under history stopped being the one it
        // described — a workbook replaced, a sheet set beyond re-identification.
        // Readmitting the entry would let undo write the old workbook's content
        // into the new one wherever their worksheet identities happen to agree.
        const undone = move(record_all(['A', 'B']), 'undo');
        const entry = top(undone, 'redo');

        const outcome = commit_history_move(clear_history(undone), 'redo', entry);
        expect(outcome.kind).toBe('dropped');
        expect(outcome.state.undoStack).toHaveLength(0);
    });

    it('does not adopt a landed redo whose history a refusal discarded', () => {
        const hard: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1_000,
            hardMaxBytes: 2_000,
        };
        const undone = move(record_all(['A', 'B']), 'undo');
        const entry = top(undone, 'redo');
        const refused = record_history_action(
            undone,
            history_action('Huge', [cell_change(9, 0, 'x'.repeat(5_000))]),
            hard,
        );
        expect(refused.kind).toBe('refused');

        expect(commit_history_move(refused.state, 'redo', entry).kind).toBe('dropped');
    });

    it('re-applies the bounds when adopting, because adoption grows the history', () => {
        // Recording trims to the bound and clears redo; appending the landed redo
        // on top would otherwise leave the history one entry over its limit.
        const bounds: HistoryBounds = {
            maxActions: 3,
            maxCells: 1_000_000,
            softMaxBytes: 128 * 1024 * 1024,
            hardMaxBytes: 256 * 1024 * 1024,
        };
        const undone = move(record_all(['A', 'B', 'C', 'D'], bounds), 'undo');
        expect(undone.undoStack.map((item) => item.action.label)).toEqual(['B', 'C']);
        const entry = top(undone, 'redo');
        const branched = record_history_action(
            undone,
            history_action('E', [cell_change(9, 0, 'e')]),
            bounds,
        ).state;
        expect(branched.undoStack.map((item) => item.action.label)).toEqual(['B', 'C', 'E']);

        const outcome = commit_history_move(branched, 'redo', entry, bounds);
        expect(outcome.kind).toBe('moved');
        expect(outcome.state.undoStack.map((item) => item.action.label)).toEqual(['C', 'E', 'D']);
        expect(outcome.kind === 'moved' && outcome.evicted).toBe(1);
    });

    it('does not adopt a duplicate redo commit after the first adoption aged out', () => {
        // A committed entry can leave history altogether — eviction drops the
        // oldest — and an adopted redo that later ages out would otherwise look
        // exactly like one whose first commit never arrived. Adopting it again
        // would evict a newer action to resurrect an old one as the next undo.
        const bounds: HistoryBounds = {
            maxActions: 2,
            maxCells: 1_000_000,
            softMaxBytes: 128 * 1024 * 1024,
            hardMaxBytes: 256 * 1024 * 1024,
        };
        const undone = move(record_all(['A', 'B'], bounds), 'undo');
        const entry = top(undone, 'redo');
        const branched = record_history_action(
            undone,
            history_action('C', [cell_change(9, 0, 'c')]),
            bounds,
        ).state;
        const adopted = commit_history_move(branched, 'redo', entry, bounds).state;
        expect(adopted.undoStack.map((item) => item.action.label)).toEqual(['C', 'B']);

        // B ages out behind two fresh gestures, so nothing on either stack
        // remembers it.
        let aged = adopted;
        for (const label of ['D', 'E']) {
            aged = record_history_action(aged, history_action(label, [cell_change(8, 0, label)]), bounds).state;
        }
        expect(aged.undoStack.map((item) => item.action.label)).toEqual(['D', 'E']);

        const again = commit_history_move(aged, 'redo', entry, bounds);
        expect(again.kind).toBe('already-committed');
        expect(again.state.undoStack.map((item) => item.action.label)).toEqual(['D', 'E']);
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

describe('string materialization at the ownership boundary', () => {
    // Flatness is not observable from JavaScript, so these pin the VALUES that
    // survive materialization. The heap behaviour is why the copy exists: a 20-unit
    // slice of a 100MiB parent retains 50MiB unmaterialized and 0.0MiB after.

    it('reproduces retained text exactly, at every size around the chunk boundary', () => {
        for (const length of [1, 4_095, 4_096, 4_097, 12_289]) {
            const text = Array.from({ length }, (_unused, index) => String.fromCharCode(0x41 + (index % 26))).join('');
            const outcome = record_history_action(empty_history_stack(), history_action('Edit', [
                cell_change(0, 0, text),
            ]));
            const retained = outcome.state.undoStack[0]?.action.changes[0];
            if (retained?.kind !== 'cell') throw new Error('fixture did not build a cell change');
            expect(retained.delta.value?.desired.content.text).toBe(text);
        }
    });

    it('preserves an astral character split across a chunk boundary', () => {
        // The units are copied one at a time, so the halves of a pair straddling the
        // 4096-unit cut land in different chunks.
        const text = `${'a'.repeat(4_095)}😀${'b'.repeat(10)}`;
        const outcome = record_history_action(empty_history_stack(), history_action('Edit', [
            cell_change(0, 0, text),
        ]));
        const retained = outcome.state.undoStack[0]?.action.changes[0];
        if (retained?.kind !== 'cell') throw new Error('fixture did not build a cell change');

        expect(retained.delta.value?.desired.content.text).toBe(text);
        expect([...(retained.delta.value?.desired.content.text ?? '')]).toContain('😀');
    });

    it('retains a cell value sliced out of a large parent', () => {
        const parent = `Cell ${'x'.repeat(500_000)}`;
        const outcome = record_history_action(empty_history_stack(), history_action('Edit', [
            cell_change(0, 0, parent.slice(0, 9)),
        ]));
        const retained = outcome.state.undoStack[0]?.action.changes[0];
        if (retained?.kind !== 'cell') throw new Error('fixture did not build a cell change');

        expect(retained.delta.value?.desired.content.text).toBe('Cell xxxx');
    });
});

describe('structural action allocation', () => {
    it('preserves the prior JSON-length charge for escaped structural text', () => {
        const label = 'Remove row';
        const outcome = record_history_action(empty_history_stack(), {
            label,
            changes: [{
                kind: 'tailRemoval',
                delta: {
                    worksheet: SHEET,
                    appendHistoryId: 'saved-row',
                    before: null,
                    after: {
                        appendHistoryId: 'saved-row',
                        sourceRow: 8,
                        savedFingerprint: 'control:\u0001 astral:😀 lone:\ud800',
                        savedRow: {
                            cells: { 0: { value: 'quote:" slash:\\' } },
                            format: { kind: 'none' },
                        },
                    },
                    beforeIndex: null,
                    afterIndex: 0,
                },
            }],
        });
        if (outcome.kind !== 'recorded') throw new Error('Expected structural history');
        const retained = outcome.state.undoStack[0];
        const change = retained.action.changes[0];
        if (change.kind !== 'tailRemoval') throw new Error('Expected tail-removal history');

        const worksheet_string_bytes = ((SHEET.sheetName?.length ?? 0)
            + (SHEET.worksheetId?.length ?? 0)) * 2;
        expect(retained.byteCost).toBe(
            label.length * 2
            + 1_024
            + worksheet_string_bytes
            + JSON.stringify(change.delta).length * 2,
        );
    });

    it('owns and charges a maximum-row pending snapshot without serializing it', () => {
        const structural = {
            formatTemplates: [{ id: 'plain', format: { kind: 'none' as const } }],
            appendedRows: Array.from({ length: 10_000 }, (_unused, index) => ({
                id: `pending-row-${index}`,
                cells: { 0: { value: `value-${index}` } },
                formatTemplateId: 'plain',
                createdOrder: index + 1,
            })),
            tailRemovals: [],
            conflicts: [],
        };
        const stringify = JSON.stringify;
        let structural_serializations = 0;
        JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
            if (typeof value === 'object' && value !== null && (
                'appendedRows' in value || ('before' in value && 'after' in value)
            )) structural_serializations += 1;
            return stringify(value, ...rest as []);
        }) as typeof JSON.stringify;
        try {
            const outcome = record_history_action(empty_history_stack(), {
                label: 'Discard changes',
                changes: [{
                    kind: 'pendingRows',
                    delta: {
                        worksheet: SHEET,
                        before: structural,
                        after: {
                            formatTemplates: [],
                            appendedRows: [],
                            tailRemovals: [],
                            conflicts: [],
                        },
                    },
                }],
            });
            expect(outcome.kind).toBe('recorded');
        } finally {
            JSON.stringify = stringify;
        }

        expect(structural_serializations).toBe(0);
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

    it('sees through an id-less change to two sheets sharing a name', () => {
        // Two targets sharing a name but carrying different ids each match an
        // id-less target, so comparing every change to the FIRST one called this
        // single-sheet whenever the id-less change happened to be applied first.
        const anonymous: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data' };
        const one: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
        const two: WorksheetTarget = { sheetIndex: 1, sheetName: 'Data', worksheetId: 'rId9' };
        const action = history_action('Discard all', [
            cell_change(0, 0, 'v', anonymous),
            cell_change(1, 0, 'v', one),
            cell_change(2, 0, 'v', two),
        ]);
        expect(action_is_single_worksheet(action)).toBe(false);
    });

    it('separates two positional changes at different indices', () => {
        // Nothing but the index identifies these, so the index has to be believed.
        const action = history_action('Discard all', [
            cell_change(0, 0, 'v', { sheetIndex: 0 }),
            cell_change(1, 0, 'v', { sheetIndex: 1 }),
        ]);
        expect(action_is_single_worksheet(action)).toBe(false);
    });

    it('spans sheets when two targets share no identifier at all', () => {
        // An id-only target and a name-only target have one distinct id and one
        // distinct name between them, so counting each identifier separately called
        // two demonstrably different sheets one sheet.
        const action = history_action('Discard all', [
            cell_change(0, 0, 'v', { sheetIndex: 0, worksheetId: 'rId1' }),
            cell_change(1, 0, 'v', { sheetIndex: 1, sheetName: 'Other' }),
        ]);
        expect(action_is_single_worksheet(action)).toBe(false);
    });

    it('links an id-only and a name-only target through one that carries both', () => {
        // A target carrying both identifiers asserts they name the same sheet, so
        // the three identifiers become one connected group.
        const action = history_action('Paste', [
            cell_change(0, 0, 'v', { sheetIndex: 0, worksheetId: 'rId1' }),
            cell_change(1, 0, 'v', { sheetIndex: 0, sheetName: 'Data' }),
            cell_change(2, 0, 'v', { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' }),
        ]);
        expect(action_is_single_worksheet(action)).toBe(true);
    });

    it('spans sheets when a positional target joins an identified one', () => {
        const action = history_action('Discard all', [
            cell_change(0, 0, 'v', { sheetIndex: 0, worksheetId: 'rId1' }),
            cell_change(1, 0, 'v', { sheetIndex: 4 }),
        ]);
        expect(action_is_single_worksheet(action)).toBe(false);
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
