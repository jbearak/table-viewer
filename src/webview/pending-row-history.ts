/** Pure compare-and-swap planning for session-owned structural history. */

import {
    own_pending_structural_changes,
    type PendingAppendedRow,
    type PendingStructuralChanges,
    type PendingTailRemoval,
} from '../pending-changes';
import { worksheet_target_key, type WorksheetTarget } from '../types';
import type { HistoryDirection } from './history-cell-state-model';
import {
    action_replay_changes,
    type HistoryAction,
    type HistoryChange,
} from './history-stack-model';

export interface PendingRowHistoryPlan {
    readonly worksheet: WorksheetTarget;
    readonly expected: PendingStructuralChanges;
    readonly next: PendingStructuralChanges;
}

export type PendingRowHistoryPlanResult =
    | { readonly kind: 'plan'; readonly plans: readonly PendingRowHistoryPlan[] }
    | { readonly kind: 'not-structural' }
    | { readonly kind: 'refused'; readonly reason: 'unavailable' | 'conflict' };

/** Cancel selected removals while preserving the invariant that the rest is a suffix. */
export function tail_removals_after_cancellation(
    removals: readonly PendingTailRemoval[],
    selected_ids: ReadonlySet<string>,
): readonly PendingTailRemoval[] | undefined {
    const selected = removals.filter((removal) => selected_ids.has(removal.appendHistoryId));
    if (selected.length === 0) return undefined;
    const restore_through = Math.max(...selected.map((removal) => removal.sourceRow));
    return removals.filter((removal) => removal.sourceRow > restore_through);
}

function equal(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function structural(change: HistoryChange): change is Extract<
    HistoryChange,
    { kind: 'rowAppend' | 'tailRemoval' | 'pendingRows' }
> {
    return change.kind === 'rowAppend'
        || change.kind === 'tailRemoval'
        || change.kind === 'pendingRows';
}

function with_row(
    changes: PendingStructuralChanges,
    row: PendingAppendedRow | null,
    pending_row_id: string,
    index: number | null,
    templates: Extract<HistoryChange, { kind: 'rowAppend' }>['delta']['formatTemplates'],
): PendingStructuralChanges | undefined {
    const rows = [...changes.appendedRows];
    const current_index = rows.findIndex((candidate) => candidate.id === pending_row_id);
    if (current_index >= 0) rows.splice(current_index, 1);
    if (row !== null) {
        const resolved_index = index ?? (() => {
            const next = rows.findIndex(
                (candidate) => candidate.createdOrder > row.createdOrder,
            );
            return next < 0 ? rows.length : next;
        })();
        if (resolved_index < 0 || resolved_index > rows.length) return undefined;
        rows.splice(resolved_index, 0, row);
    }
    const template_by_id = new Map(changes.formatTemplates.map((template) => [
        template.id,
        template,
    ]));
    for (const template of templates) template_by_id.set(template.id, template);
    const used = new Set(rows.map((candidate) => candidate.formatTemplateId));
    return own_pending_structural_changes({
        ...changes,
        appendedRows: rows,
        formatTemplates: [...template_by_id.values()].filter((template) => used.has(template.id)),
    });
}

function with_removal(
    changes: PendingStructuralChanges,
    removal: PendingTailRemoval | null,
    append_history_id: string,
    index: number | null,
): PendingStructuralChanges | undefined {
    const removals = [...changes.tailRemovals];
    const current_index = removals.findIndex(
        (candidate) => candidate.appendHistoryId === append_history_id,
    );
    if (current_index >= 0) removals.splice(current_index, 1);
    if (removal !== null) {
        const resolved_index = index ?? (() => {
            const next = removals.findIndex(
                (candidate) => candidate.sourceRow > removal.sourceRow,
            );
            return next < 0 ? removals.length : next;
        })();
        if (resolved_index < 0 || resolved_index > removals.length) return undefined;
        removals.splice(resolved_index, 0, removal);
    }
    return own_pending_structural_changes({ ...changes, tailRemovals: removals });
}

/** Plan the structural arm of an action without mutating any worksheet store. */
export function plan_pending_row_history_replay(
    action: HistoryAction,
    direction: HistoryDirection,
    read: (worksheet: WorksheetTarget) => PendingStructuralChanges | undefined,
): PendingRowHistoryPlanResult {
    if (!action.changes.some(structural)) {
        return { kind: 'not-structural' };
    }
    const states = new Map<string, {
        worksheet: WorksheetTarget;
        expected: PendingStructuralChanges;
        current: PendingStructuralChanges;
    }>();
    for (const change of action_replay_changes(action, direction)) {
        if (!structural(change)) continue;
        const key = worksheet_target_key(change.delta.worksheet);
        let state = states.get(key);
        if (state === undefined) {
            const current = read(change.delta.worksheet);
            if (current === undefined) return { kind: 'refused', reason: 'unavailable' };
            state = { worksheet: change.delta.worksheet, expected: current, current };
            states.set(key, state);
        }
        if (change.kind === 'rowAppend') {
            const expected = direction === 'undo' ? change.delta.after : change.delta.before;
            const desired = direction === 'undo' ? change.delta.before : change.delta.after;
            const expected_index = direction === 'undo'
                ? change.delta.afterIndex
                : change.delta.beforeIndex;
            const desired_index = direction === 'undo'
                ? change.delta.beforeIndex
                : change.delta.afterIndex;
            const index = state.current.appendedRows.findIndex(
                (row) => row.id === change.delta.pendingRowId,
            );
            const current = index < 0 ? null : state.current.appendedRows[index];
            if (
                !equal(current, expected)
                || (expected_index !== null && (index < 0 ? null : index) !== expected_index)
            ) {
                return { kind: 'refused', reason: 'conflict' };
            }
            const next = with_row(
                state.current,
                desired,
                change.delta.pendingRowId,
                desired_index,
                change.delta.formatTemplates,
            );
            if (next === undefined) return { kind: 'refused', reason: 'conflict' };
            state.current = next;
            continue;
        }
        if (change.kind === 'pendingRows') {
            const expected = direction === 'undo' ? change.delta.after : change.delta.before;
            const desired = direction === 'undo' ? change.delta.before : change.delta.after;
            if (!equal(state.current, expected)) {
                return { kind: 'refused', reason: 'conflict' };
            }
            state.current = desired;
            continue;
        }
        const expected = direction === 'undo' ? change.delta.after : change.delta.before;
        const desired = direction === 'undo' ? change.delta.before : change.delta.after;
        const expected_index = direction === 'undo'
            ? change.delta.afterIndex
            : change.delta.beforeIndex;
        const desired_index = direction === 'undo'
            ? change.delta.beforeIndex
            : change.delta.afterIndex;
        const index = state.current.tailRemovals.findIndex(
            (removal) => removal.appendHistoryId === change.delta.appendHistoryId,
        );
        const current = index < 0 ? null : state.current.tailRemovals[index];
        if (
            !equal(current, expected)
            || (
                expected !== null
                && expected_index !== null
                && (index < 0 ? null : index) !== expected_index
            )
        ) {
            return { kind: 'refused', reason: 'conflict' };
        }
        const next = with_removal(
            state.current,
            desired,
            change.delta.appendHistoryId,
            desired_index,
        );
        if (next === undefined) return { kind: 'refused', reason: 'conflict' };
        state.current = next;
    }
    return {
        kind: 'plan',
        plans: [...states.values()].map(({ worksheet, expected, current }) => ({
            worksheet,
            expected,
            next: current,
        })),
    };
}
