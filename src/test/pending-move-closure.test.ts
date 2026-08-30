import { describe, expect, it } from 'vitest';
import type { PendingStructuralChanges } from '../pending-changes';
import {
    pending_changes_after_move_discard,
    plan_pending_move_discard,
} from '../webview/pending-move-closure';

const source = (sourceRow: number) => ({ kind: 'source' as const, sourceRow });
const pending = (pendingRowId: string) => ({ kind: 'pending' as const, pendingRowId });
const empty = (rows: PendingStructuralChanges['appendedRows']): PendingStructuralChanges => ({
    formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
    appendedRows: rows,
    tailRemovals: [],
    conflicts: [],
});

describe('cross-store pending move closure', () => {
    it('connects a source clear to its pending destination', () => {
        const structural = empty([{
            id: 'p1', formatTemplateId: 'plain', createdOrder: 1,
            cells: { 1: { value: 'A', movedFrom: {
                row: 0, col: 0, order: 4, rowIdentity: source(0),
            } } },
        }]);
        const plan = plan_pending_move_discard(
            [['0:0', { value: '', base: 'A', valueEditOrder: 4 }]],
            structural,
            [{ rowIdentity: pending('p1'), sourceColumn: 1 }],
        );
        expect([...plan.sourceKeys]).toEqual(['0:0']);
        expect(plan.pendingCells).toEqual([{ pendingRowId: 'p1', sourceColumn: 1 }]);
        expect(plan.count).toBe(2);
        expect(plan_pending_move_discard(
            [['0:0', { value: '', base: 'A', valueEditOrder: 4 }]],
            structural,
            [{ rowIdentity: source(0), sourceColumn: 0 }],
        ).count).toBe(2);
    });

    it('connects a pending clear to its source destination', () => {
        const structural = empty([{
            id: 'p1', formatTemplateId: 'plain', createdOrder: 1,
            cells: { 0: { value: '', valueEditOrder: 5 } },
        }]);
        const plan = plan_pending_move_discard([['1:1', {
            value: 'A', base: '', movedFrom: {
                row: 10, col: 0, order: 5, rowIdentity: pending('p1'),
            },
        }]], structural, [{ rowIdentity: source(1), sourceColumn: 1 }]);
        expect([...plan.sourceKeys]).toEqual(['1:1']);
        expect(plan.pendingCells).toEqual([{ pendingRowId: 'p1', sourceColumn: 0 }]);
    });

    it('connects pending source and destination cells', () => {
        const structural = empty([{
            id: 'p1', formatTemplateId: 'plain', createdOrder: 1,
            cells: { 0: { value: '', valueEditOrder: 6 } },
        }, {
            id: 'p2', formatTemplateId: 'plain', createdOrder: 2,
            cells: { 2: { value: 'A', movedFrom: {
                row: 10, col: 0, order: 6, rowIdentity: pending('p1'),
            } } },
        }]);
        const plan = plan_pending_move_discard([], structural, [{
            rowIdentity: pending('p1'), sourceColumn: 0,
        }]);
        expect(plan.pendingCells).toEqual([
            { pendingRowId: 'p1', sourceColumn: 0 },
            { pendingRowId: 'p2', sourceColumn: 2 },
        ]);
    });

    it('clears formula conflicts for every removed closure cell', () => {
        const structural: PendingStructuralChanges = {
            ...empty([]),
            conflicts: [{
                reason: 'ambiguousPendingFormula',
                pendingRowIds: [],
                tailRemovalIds: [],
                formulaCells: [{ rowIdentity: source(1), sourceColumn: 1 }],
            }],
        };
        const plan = plan_pending_move_discard([['1:1', { value: '=A1', base: '' }]], structural, [{
            rowIdentity: source(1), sourceColumn: 1,
        }]);
        expect(pending_changes_after_move_discard(structural, plan).conflicts).toEqual([]);
    });
});
