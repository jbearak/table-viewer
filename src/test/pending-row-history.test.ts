import { describe, expect, it } from 'vitest';
import type {
    PendingAppendedRow,
    PendingStructuralChanges,
    PendingTailRemoval,
} from '../pending-changes';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    value_only_overlay,
} from '../webview/history-cell-state-model';
import {
    plan_pending_row_history_replay,
    tail_removals_after_cancellation,
} from '../webview/pending-row-history';
import {
    empty_history_stack,
    commit_history_move,
    peek_history,
    record_history_action,
    rekey_committed_tail_removal_history,
    rekey_saved_appended_row_history,
    retained_saved_append_authorities,
    type HistoryAction,
    type HistoryChange,
    type HistoryStackState,
} from '../webview/history-stack-model';

const worksheet: WorksheetTarget = {
    sheetIndex: 0,
    sheetName: 'Data',
    worksheetId: 'rId1',
};
const template = { id: 'plain', format: { kind: 'none' as const } };

function row(id: string, createdOrder: number, value = ''): PendingAppendedRow {
    return {
        id,
        cells: value === '' ? {} : { 0: { value, valueEditOrder: createdOrder } },
        formatTemplateId: template.id,
        createdOrder,
    };
}

function state(
    rows: readonly PendingAppendedRow[],
    removals: readonly PendingTailRemoval[] = [],
): PendingStructuralChanges {
    return {
        formatTemplates: rows.length === 0 ? [] : [template],
        appendedRows: rows,
        tailRemovals: removals,
        conflicts: [],
    };
}

function row_change(
    pendingRowId: string,
    before: PendingAppendedRow | null,
    after: PendingAppendedRow | null,
    beforeIndex: number | null,
    afterIndex: number | null,
): HistoryChange {
    return {
        kind: 'rowAppend',
        delta: {
            worksheet,
            pendingRowId,
            before,
            after,
            beforeIndex,
            afterIndex,
            formatTemplates: [template],
        },
    };
}

function replay(
    action: HistoryAction,
    direction: 'undo' | 'redo',
    current: PendingStructuralChanges,
): PendingStructuralChanges {
    const result = plan_pending_row_history_replay(action, direction, () => current);
    if (result.kind !== 'plan') throw new Error(`Expected a plan, got ${result.kind}`);
    expect(result.plans).toHaveLength(1);
    return result.plans[0].next;
}

function record_actions(actions: readonly HistoryAction[]): HistoryStackState {
    return actions.reduce((current, action) => {
        const outcome = record_history_action(current, action);
        if (outcome.kind !== 'recorded') throw new Error('Fixture action was not recorded');
        return outcome.state;
    }, empty_history_stack());
}

describe('pending-row history planning', () => {
    it('cascades cancellation through a selected later tail removal', () => {
        const removals: PendingTailRemoval[] = [8, 9, 10].map((sourceRow) => ({
            appendHistoryId: `saved-${sourceRow}`,
            sourceRow,
            savedFingerprint: `fingerprint-${sourceRow}`,
            savedRow: { cells: {}, format: template.format },
        }));
        expect(tail_removals_after_cancellation(removals, new Set(['saved-9'])))
            .toEqual([removals[2]]);
        expect(tail_removals_after_cancellation(removals, new Set(['saved-8'])))
            .toEqual([removals[1], removals[2]]);
    });
    it('undoes and redoes a multi-row append in stable index order', () => {
        const a = row('a', 1);
        const b = row('b', 2);
        const action: HistoryAction = {
            label: 'Paste 2 cells',
            changes: [
                row_change('a', null, a, null, 0),
                row_change('b', null, b, null, 1),
            ],
        };
        const undone = replay(action, 'undo', state([a, b]));
        expect(undone.appendedRows).toEqual([]);
        expect(undone.formatTemplates).toEqual([]);
        expect(replay(action, 'redo', undone).appendedRows).toEqual([a, b]);
    });

    it('restores the append basis with a structural redo', () => {
        const a = row('a', 1);
        const basis = {
            sourceRowCount: 3,
            provisionalStartRow: 3,
            provisionalRowCount: 1,
            columnCount: 2,
            schemaFingerprint: 'schema-v1',
        };
        const after = { ...state([a]), appendBasis: basis };
        const action: HistoryAction = {
            label: 'Append row',
            changes: [
                row_change('a', null, a, null, 0),
                {
                    kind: 'pendingRows',
                    delta: {
                        worksheet,
                        before: { ...after, appendBasis: undefined },
                        after,
                    },
                },
            ],
        };

        const undone = replay(action, 'undo', after);
        expect(undone.appendedRows).toEqual([]);
        expect(undone.appendBasis).toBeUndefined();
        const redone = replay(action, 'redo', undone);
        expect(redone.appendedRows).toEqual([a]);
        expect(redone.appendBasis).toEqual(basis);
    });

    it('restores rows removed together with their contents and positions', () => {
        const a = row('a', 1);
        const b = row('b', 2, 'B');
        const c = row('c', 3, 'C');
        const action: HistoryAction = {
            label: 'Remove pending rows',
            // Application order removes the high index first.
            changes: [
                row_change('c', c, null, 2, null),
                row_change('b', b, null, 1, null),
            ],
        };
        const restored = replay(action, 'undo', state([a]));
        expect(restored.appendedRows).toEqual([a, b, c]);
        expect(replay(action, 'redo', restored).appendedRows).toEqual([a]);
    });

    it('refuses without a partial plan when a pending row changed', () => {
        const recorded = row('a', 1, 'old');
        const current = row('a', 1, 'new');
        const result = plan_pending_row_history_replay({
            label: 'Edit cell',
            changes: [row_change('a', row('a', 1), recorded, 0, 0)],
        }, 'undo', () => state([current]));
        expect(result).toEqual({ kind: 'refused', reason: 'conflict' });
    });

    it('replays cancellation of a saved tail removal', () => {
        const removal: PendingTailRemoval = {
            appendHistoryId: 'history-a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: { kind: 'none' } },
        };
        const action: HistoryAction = {
            label: 'Cancel row removal',
            changes: [{
                kind: 'tailRemoval',
                delta: {
                    worksheet,
                    appendHistoryId: removal.appendHistoryId,
                    before: removal,
                    after: null,
                    beforeIndex: 0,
                    afterIndex: null,
                },
            }],
        };
        const undone = replay(action, 'undo', state([]));
        expect(undone.tailRemovals).toEqual([removal]);
        expect(replay(action, 'redo', undone).tailRemovals).toEqual([]);
    });

    it('plans the structural arm of a mixed gesture for coordinated replay', () => {
        const a = row('a', 1);
        const result = plan_pending_row_history_replay({
            label: 'Mixed',
            changes: [
                row_change('a', null, a, null, 0),
                { kind: 'highlight', delta: {
                    worksheet,
                    sourceRow: 0,
                    sourceColumn: 0,
                    before: null,
                    after: 'yellow',
                } },
            ],
        }, 'undo', () => state([a]));
        expect(result.kind).toBe('plan');
        if (result.kind === 'plan') {
            expect(result.plans[0].next.appendedRows).toEqual([]);
        }
    });

    it('rekeys an append and later row edit across a successful save', () => {
        const blank = row('a', 1);
        const filled = row('a', 1, 'saved');
        const history = record_actions([
            {
                label: 'Append row',
                changes: [row_change('a', null, blank, null, 0)],
            },
            {
                label: 'Edit cell',
                changes: [row_change('a', blank, filled, 0, 0)],
            },
        ]);
        const rekeyed = rekey_saved_appended_row_history(history, [{
            worksheet,
            pendingRowId: 'a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: filled.cells, format: template.format },
        }]);

        expect(rekeyed.undoStack.map((entry) => entry.action.label))
            .toEqual(['Append row', 'Edit cell']);
        expect(rekeyed.undoStack[1].action.changes).toHaveLength(1);
        expect(rekeyed.undoStack[1].action.changes[0]).toMatchObject({
            kind: 'cell',
            delta: {
                sourceRow: 8,
                sourceColumn: 0,
                beforeOverlay: { kind: 'present' },
                afterOverlay: { kind: 'absent' },
            },
        });
        expect(rekeyed.undoStack[0].action.changes[0]).toMatchObject({
            kind: 'tailRemoval',
            delta: {
                before: { sourceRow: 8, savedFingerprint: 'fingerprint' },
                after: null,
            },
        });
    });

    it('rekeys cut provenance through save, undo, save, redo, and save', () => {
        const appended = row('pending-a', 1, 'cut me');
        const destination = build_cell_history_delta({
            worksheet,
            sourceRow: 2,
            sourceColumn: 0,
            before: absent_overlay(),
            after: value_only_overlay(
                history_value('cut me'),
                history_value(''),
                false,
                undefined,
                undefined,
                true,
                {
                    row: 8,
                    col: 0,
                    order: 3,
                    rowIdentity: { kind: 'pending', pendingRowId: 'pending-a' },
                    previous: [{
                        sourceRow: 8,
                        sourceCol: 1,
                        destinationRow: 2,
                        destinationCol: 0,
                        order: 2,
                        sourceRowIdentity: {
                            kind: 'pending',
                            pendingRowId: 'pending-a',
                        },
                        destinationRowIdentity: {
                            kind: 'pending',
                            pendingRowId: 'pending-a',
                        },
                    }],
                },
            ),
            persistedValue: history_value(''),
            persistedHyperlink: null,
        });
        if (destination === undefined) throw new Error('Expected destination history');
        let history = record_actions([{
            label: 'Append row',
            changes: [row_change('pending-a', null, appended, null, 0)],
        }, {
            label: 'Cut cell',
            changes: [{ kind: 'cell', delta: destination }],
        }]);
        const saved = [{
            worksheet,
            pendingRowId: 'pending-a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: appended.cells, format: template.format },
        }];
        history = rekey_saved_appended_row_history(history, saved);
        const assert_rekeyed = (state: HistoryStackState) => {
            const actions = [...state.undoStack, ...state.redoStack]
                .filter((entry) => entry.action.label === 'Cut cell');
            expect(actions).toHaveLength(1);
            const change = actions[0].action.changes[0];
            if (change.kind !== 'cell') throw new Error('Expected cell history');
            const overlay = change.delta.afterOverlay;
            if (overlay.kind !== 'present' || overlay.value.kind !== 'present') {
                throw new Error('Expected moved destination overlay');
            }
            expect(overlay.value.movedFrom).toMatchObject({
                row: 8,
                rowIdentity: { kind: 'source', sourceRow: 8 },
                previous: [{
                    sourceRow: 8,
                    destinationRow: 8,
                    sourceRowIdentity: { kind: 'source', sourceRow: 8 },
                    destinationRowIdentity: { kind: 'source', sourceRow: 8 },
                }],
            });
        };
        assert_rekeyed(history);

        const undo = peek_history(history, 'undo');
        if (undo.kind !== 'available') throw new Error('Expected cut undo');
        const undone = commit_history_move(history, 'undo', undo.entry);
        if (undone.kind !== 'moved') throw new Error('Expected cut undo move');
        history = rekey_saved_appended_row_history(undone.state, saved);
        assert_rekeyed(history);

        const redo = peek_history(history, 'redo');
        if (redo.kind !== 'available') throw new Error('Expected cut redo');
        const redone = commit_history_move(history, 'redo', redo.entry);
        if (redone.kind !== 'moved') throw new Error('Expected cut redo move');
        history = rekey_saved_appended_row_history(redone.state, saved);
        assert_rekeyed(history);
    });

    it('rekeys a pending-row highlight edit onto the saved physical row', () => {
        const blank = row('a', 1);
        const highlighted = { ...blank, highlights: { 2: 'yellow' as const } };
        const history = record_actions([{
            label: 'Highlight cells',
            changes: [row_change('a', blank, highlighted, 0, 0)],
        }]);
        const rekeyed = rekey_saved_appended_row_history(history, [{
            worksheet,
            pendingRowId: 'a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: {
                cells: highlighted.cells,
                format: template.format,
                highlights: highlighted.highlights,
            },
        }]);

        expect(rekeyed.undoStack[0].action.changes).toEqual([{
            kind: 'highlight',
            delta: {
                worksheet,
                sourceRow: 8,
                sourceColumn: 2,
                before: null,
                after: 'yellow',
            },
        }]);
    });

    it('keeps saved cell and highlight changes in one mixed gesture', () => {
        const blank = row('a', 1);
        const mixed = {
            ...row('a', 1, 'saved'),
            highlights: { 0: 'green' as const },
        };
        const history = record_actions([{
            label: 'Mixed edit',
            changes: [row_change('a', blank, mixed, 0, 0)],
        }]);
        const rekeyed = rekey_saved_appended_row_history(history, [{
            worksheet,
            pendingRowId: 'a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: {
                cells: mixed.cells,
                format: template.format,
                highlights: mixed.highlights,
            },
        }]);

        expect(rekeyed.undoStack[0].action.changes.map((change) => change.kind))
            .toEqual(['cell', 'highlight']);
    });

    it('rekeys exact discard snapshots when their pending rows are saved', () => {
        const appended = row('a', 1, 'saved');
        const history = record_actions([{
            label: 'Discard changes',
            changes: [{
                kind: 'pendingRows',
                delta: {
                    worksheet,
                    before: state([appended]),
                    after: state([]),
                },
            }],
        }]);
        const rekeyed = rekey_saved_appended_row_history(history, [{
            worksheet,
            pendingRowId: 'a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: appended.cells, format: template.format },
        }]);
        expect(rekeyed.undoStack[0].action.changes).toEqual([
            expect.objectContaining({
                kind: 'tailRemoval',
                delta: expect.objectContaining({
                    appendHistoryId: 'a',
                    before: null,
                    after: expect.objectContaining({ sourceRow: 8 }),
                }),
            }),
        ]);
    });

    it('orders saved multi-row removal transitions from the high row down', () => {
        const a = row('a', 1);
        const b = row('b', 2);
        const history = record_actions([{
            label: 'Append 2 rows',
            changes: [
                row_change('a', null, a, null, 0),
                row_change('b', null, b, null, 1),
            ],
        }]);
        const rekeyed = rekey_saved_appended_row_history(history, [
            {
                worksheet,
                pendingRowId: 'a',
                sourceRow: 8,
                savedFingerprint: 'a-fingerprint',
                savedRow: { cells: {}, format: template.format },
            },
            {
                worksheet,
                pendingRowId: 'b',
                sourceRow: 9,
                savedFingerprint: 'b-fingerprint',
                savedRow: { cells: {}, format: template.format },
            },
        ]);
        expect(rekeyed.undoStack[0].action.changes.map((change) => (
            change.kind === 'tailRemoval' ? change.delta.before?.sourceRow : undefined
        ))).toEqual([9, 8]);
    });

    it('advances append history to an admitted restoration after saving its undo', () => {
        const appended = row('a', 1, 'saved');
        const recorded = record_actions([{
            label: 'Append row',
            changes: [row_change('a', null, appended, null, 0)],
        }]);
        const saved = rekey_saved_appended_row_history(recorded, [{
            worksheet,
            pendingRowId: 'a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: appended.cells, format: template.format },
        }]);
        const available = peek_history(saved, 'undo');
        if (available.kind !== 'available') throw new Error('Expected saved append history');
        const removal = replay(available.entry.action, 'undo', state([])).tailRemovals[0];
        const moved = commit_history_move(saved, 'undo', available.entry);
        if (moved.kind !== 'moved') throw new Error('Expected history move');
        const committed = rekey_committed_tail_removal_history(moved.state, [{
            worksheet,
            removal,
        }]);
        const redo = peek_history(committed, 'redo');
        if (redo.kind !== 'available') throw new Error('Expected restoration redo');
        expect(redo.entry.action.changes[0]).toMatchObject({
            kind: 'rowAppend',
            delta: {
                pendingRowId: 'a',
                before: null,
                after: { cells: appended.cells },
                restoredFromSavedRemoval: true,
            },
        });
        expect(replay(redo.entry.action, 'redo', state([])).appendedRows[0].cells)
            .toEqual(appended.cells);
    });

    it('advances a saved cancellation undo to the same restoration form', () => {
        const removal: PendingTailRemoval = {
            appendHistoryId: 'history-a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: { 0: { value: 'saved' } }, format: template.format },
        };
        const recorded = record_actions([{
            label: 'Cancel row removal',
            changes: [{
                kind: 'tailRemoval',
                delta: {
                    worksheet,
                    appendHistoryId: removal.appendHistoryId,
                    before: removal,
                    after: null,
                    beforeIndex: 0,
                    afterIndex: null,
                },
            }],
        }]);
        const available = peek_history(recorded, 'undo');
        if (available.kind !== 'available') throw new Error('Expected cancellation history');
        const moved = commit_history_move(recorded, 'undo', available.entry);
        if (moved.kind !== 'moved') throw new Error('Expected history move');
        const committed = rekey_committed_tail_removal_history(moved.state, [{
            worksheet,
            removal,
        }]);
        const redo = peek_history(committed, 'redo');
        if (redo.kind !== 'available') throw new Error('Expected cancellation redo');
        expect(replay(redo.entry.action, 'redo', state([])).appendedRows[0].cells)
            .toEqual(removal.savedRow.cells);
    });

    it('advances exact discard snapshots after their tail removal is committed', () => {
        const removal: PendingTailRemoval = {
            appendHistoryId: 'history-a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: { 0: { value: 'saved' } }, format: template.format },
        };
        const history = record_actions([{
            label: 'Discard changes',
            changes: [{
                kind: 'pendingRows',
                delta: {
                    worksheet,
                    before: state([], [removal]),
                    after: state([]),
                },
            }],
        }]);
        const committed = rekey_committed_tail_removal_history(history, [{
            worksheet,
            removal,
        }]);
        expect(committed.undoStack[0].action.changes).toEqual([
            expect.objectContaining({
                kind: 'rowAppend',
                delta: expect.objectContaining({
                    pendingRowId: 'history-a',
                    restoredFromSavedRemoval: true,
                }),
            }),
        ]);
    });

    it('replays every saved row edit after the physical row was removed', () => {
        const blank = row('a', 1);
        const with_a = { ...row('a', 1, 'A'), cells: { 0: { value: 'A', valueEditOrder: 2 } } };
        const with_ab = {
            ...with_a,
            cells: {
                ...with_a.cells,
                1: { value: 'B', valueEditOrder: 3 },
            },
        };
        let history = rekey_saved_appended_row_history(record_actions([
            { label: 'Append row', changes: [row_change('a', null, blank, null, 0)] },
            { label: 'Edit A', changes: [row_change('a', blank, with_a, 0, 0)] },
            { label: 'Edit B', changes: [row_change('a', with_a, with_ab, 0, 0)] },
        ]), [{
            worksheet,
            pendingRowId: 'a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: with_ab.cells, format: template.format },
        }]);
        let removal: PendingTailRemoval | undefined;
        for (let index = 0; index < 3; index += 1) {
            const available = peek_history(history, 'undo');
            if (available.kind !== 'available') throw new Error('Expected undo');
            if (available.entry.action.changes.some((change) => change.kind === 'tailRemoval')) {
                removal = replay(available.entry.action, 'undo', state([])).tailRemovals[0];
            }
            const moved = commit_history_move(history, 'undo', available.entry);
            if (moved.kind !== 'moved') throw new Error('Expected undo move');
            history = moved.state;
        }
        if (removal === undefined) throw new Error('Expected a saved tail removal');

        history = rekey_committed_tail_removal_history(history, [{ worksheet, removal }]);
        expect([...history.redoStack].flatMap((entry) => entry.action.changes)
            .some((change) => change.kind === 'cell' && change.delta.sourceRow === 8))
            .toBe(false);
        let structural = state([]);
        for (let index = 0; index < 3; index += 1) {
            const available = peek_history(history, 'redo');
            if (available.kind !== 'available') throw new Error('Expected redo');
            structural = replay(available.entry.action, 'redo', structural);
            const moved = commit_history_move(history, 'redo', available.entry);
            if (moved.kind !== 'moved') throw new Error('Expected redo move');
            history = moved.state;
        }
        expect(structural.appendedRows[0].cells).toEqual(with_ab.cells);
    });

    it('orders rows restored by separate actions from their creation order', () => {
        const later = row('later', 20, 'later');
        const earlier = row('earlier', 10, 'earlier');
        const restored_change = (value: PendingAppendedRow): HistoryChange => {
            const change = row_change(value.id, null, value, null, null);
            if (change.kind !== 'rowAppend') throw new Error('Expected row change');
            return {
                kind: 'rowAppend',
                delta: {
                    ...change.delta,
                restoredFromSavedRemoval: true,
                },
            };
        };
        let current = replay({ label: 'Restore later', changes: [restored_change(later)] }, 'redo', state([]));
        current = replay({ label: 'Restore earlier', changes: [restored_change(earlier)] }, 'redo', current);
        expect(current.appendedRows.map((candidate) => candidate.id)).toEqual(['earlier', 'later']);
    });

    it('retains saved-row authority while either history stack can reach it', () => {
        const removal: PendingTailRemoval = {
            appendHistoryId: 'saved-a',
            sourceRow: 8,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: template.format },
        };
        const outcome = record_history_action(empty_history_stack(), {
            label: 'Remove saved row',
            changes: [{
                kind: 'tailRemoval',
                delta: {
                    worksheet,
                    appendHistoryId: removal.appendHistoryId,
                    before: null,
                    after: removal,
                    beforeIndex: null,
                    afterIndex: 0,
                },
            }],
        });
        if (outcome.kind !== 'recorded') throw new Error('Expected history record');
        expect(retained_saved_append_authorities(outcome.state)).toEqual([{
            ...worksheet,
            appendHistoryIds: ['saved-a'],
        }]);
        const available = peek_history(outcome.state, 'undo');
        if (available.kind !== 'available') throw new Error('Expected undo');
        const moved = commit_history_move(outcome.state, 'undo', available.entry);
        if (moved.kind !== 'moved') throw new Error('Expected history move');
        expect(retained_saved_append_authorities(moved.state)[0].appendHistoryIds)
            .toEqual(['saved-a']);
    });
});
