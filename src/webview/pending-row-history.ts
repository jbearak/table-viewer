/**
 * Pure compare-and-swap planning for session-owned structural history: the
 * append arms (`rowAppend`, `tailRemoval`, `pendingRows`) and the layout arms
 * (`rowLayout`, `columnLayout`). Each arm checks that the worksheet's
 * structural store still holds what the recorded side expects, then plans the
 * other side; nothing here mutates a store.
 */

import {
    own_pending_structural_changes,
    type PendingAppendedRow,
    type PendingColumn,
    type PendingStructuralChanges,
    type PendingTailRemoval,
    pending_rows,
} from '../pending-changes';
import { worksheet_target_key, type WorksheetTarget } from '../types';
import {
    canonical_column_layout,
    canonical_row_layout,
    type ColumnLayout,
    type RowLayout,
} from '../worksheet-layout';
import type { HistoryDirection } from './history-cell-state-model';
import {
    action_replay_changes,
    is_structural_history_change,
    type HistoryAction,
    type HistoryChange,
    type LayoutHistoryChange,
    type PendingEntryTransition,
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

const structural = is_structural_history_change;

function layout_json(layout: RowLayout | ColumnLayout | null | undefined, axis: 'rows' | 'columns'): string {
    if (layout === null || layout === undefined) return 'null';
    return JSON.stringify(axis === 'rows'
        ? canonical_row_layout(layout as RowLayout)
        : canonical_column_layout(layout as ColumnLayout));
}

/**
 * Swap entries by ID: every transition's expected side must be what `current`
 * holds now (absent for null), and its desired side replaces it. Untouched
 * entries keep their place; new ones are placed by `createdOrder`, which is the
 * stored order of Pending Rows.
 */
function swap_entries<T extends { readonly id: string; readonly createdOrder: number }>(
    current: readonly T[],
    transitions: readonly PendingEntryTransition<T>[],
    direction: HistoryDirection,
): T[] | undefined {
    const by_id = new Map(current.map((entry, index) => [entry.id, index]));
    const replaced = new Map<string, T | null>();
    for (const transition of transitions) {
        const expected = direction === 'undo' ? transition.after : transition.before;
        const index = by_id.get(transition.id);
        const now = index === undefined ? null : current[index];
        if (!equal(now, expected)) return undefined;
        replaced.set(transition.id, direction === 'undo' ? transition.before : transition.after);
    }
    const out: T[] = [];
    for (const entry of current) {
        if (!replaced.has(entry.id)) {
            out.push(entry);
            continue;
        }
        const desired = replaced.get(entry.id)!;
        if (desired !== null) out.push(desired);
        replaced.delete(entry.id);
    }
    for (const desired of replaced.values()) {
        if (desired === null) continue;
        const at = out.findIndex((entry) => entry.createdOrder > desired.createdOrder);
        out.splice(at < 0 ? out.length : at, 0, desired);
    }
    return out;
}

/** Plan one layout arm against `current`, or undefined on a compare-and-swap conflict. */
function with_layout_change(
    current: PendingStructuralChanges,
    change: LayoutHistoryChange,
    direction: HistoryDirection,
): PendingStructuralChanges | undefined {
    const { delta } = change;
    const axis = change.kind === 'rowLayout' ? 'rows' : 'columns';
    const expected_layout = direction === 'undo' ? delta.after : delta.before;
    const desired_layout = direction === 'undo' ? delta.before : delta.after;
    const current_layout = axis === 'rows' ? current.rowLayout : current.columnLayout;
    if (layout_json(current_layout, axis) !== layout_json(expected_layout, axis)) return undefined;
    const rows = swap_entries(pending_rows(current), delta.pendingRows, direction);
    const columns = swap_entries<PendingColumn>(current.pendingColumns ?? [], delta.pendingColumns, direction);
    if (rows === undefined || columns === undefined) return undefined;
    const basis = <T>(
        transition: { readonly before: T | null; readonly after: T | null } | undefined,
        now: T | undefined,
    ): { ok: true; value: T | undefined } | { ok: false } => {
        if (transition === undefined) return { ok: true, value: now };
        const expected = direction === 'undo' ? transition.after : transition.before;
        if (!equal(now ?? null, expected)) return { ok: false };
        const desired = direction === 'undo' ? transition.before : transition.after;
        return { ok: true, value: desired ?? undefined };
    };
    const append_basis = basis(delta.appendBasis, current.appendBasis);
    const structural_basis = basis(delta.structuralBasis, current.structuralBasis);
    if (!append_basis.ok || !structural_basis.ok) return undefined;
    const templates = new Map(current.formatTemplates.map((template) => [template.id, template]));
    for (const template of delta.formatTemplates) {
        if (!templates.has(template.id)) templates.set(template.id, template);
    }
    const used = new Set(rows.map((row) => row.formatTemplateId));
    const row_ids = new Set(rows.map((row) => row.id));
    // Conflicts name live rows only; the host derives them afresh after replay.
    const conflicts = current.conflicts.flatMap((conflict) => {
        const pendingRowIds = conflict.pendingRowIds.filter((id) => row_ids.has(id));
        const formulaCells = conflict.formulaCells?.filter((cell) =>
            cell.rowIdentity.kind !== 'pending' || row_ids.has(cell.rowIdentity.pendingRowId));
        if (pendingRowIds.length === conflict.pendingRowIds.length
            && formulaCells?.length === conflict.formulaCells?.length) return [conflict];
        if (pendingRowIds.length === 0 && conflict.tailRemovalIds.length === 0
            && (formulaCells?.length ?? 0) === 0) return [];
        return [{ ...conflict, pendingRowIds, ...(formulaCells === undefined ? {} : { formulaCells }) }];
    });
    const { rowLayout: _rows, columnLayout: _columns, pendingColumns: _pending, structuralBasis: _basis,
        appendBasis: _append, ...rest } = current;
    try {
        return own_pending_structural_changes({
            ...rest,
            formatTemplates: [...templates.values()].filter((template) => used.has(template.id)),
            appendedRows: rows,
            conflicts,
            ...(append_basis.value === undefined ? {} : { appendBasis: append_basis.value }),
            ...(axis === 'rows'
                ? {
                    ...(desired_layout === null ? {} : { rowLayout: desired_layout }),
                    ...(current.columnLayout === undefined ? {} : { columnLayout: current.columnLayout }),
                }
                : {
                    ...(current.rowLayout === undefined ? {} : { rowLayout: current.rowLayout }),
                    ...(desired_layout === null ? {} : { columnLayout: desired_layout }),
                }),
            ...(columns.length === 0 ? {} : { pendingColumns: columns }),
            ...(structural_basis.value === undefined ? {} : { structuralBasis: structural_basis.value }),
        });
    } catch {
        return undefined;
    }
}

function with_row(
    changes: PendingStructuralChanges,
    row: PendingAppendedRow | null,
    pending_row_id: string,
    index: number | null,
    templates: Extract<HistoryChange, { kind: 'rowAppend' }>['delta']['formatTemplates'],
): PendingStructuralChanges | undefined {
    const rows = [...pending_rows(changes)];
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
    try {
        return own_pending_structural_changes({
            ...changes,
            appendedRows: rows,
            formatTemplates: [...template_by_id.values()].filter(
                (template) => used.has(template.id),
            ),
        });
    } catch {
        return undefined;
    }
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
    try {
        return own_pending_structural_changes({ ...changes, tailRemovals: removals });
    } catch {
        return undefined;
    }
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
            const index = pending_rows(state.current).findIndex(
                (row) => row.id === change.delta.pendingRowId,
            );
            const current = index < 0 ? null : pending_rows(state.current)[index];
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
        if (change.kind === 'rowLayout' || change.kind === 'columnLayout') {
            const next = with_layout_change(state.current, change, direction);
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
