import { describe, expect, it } from 'vitest';
import type { FilterEntry, SheetTransformState } from '../types';
import {
    apply_view_action_delta,
    begin_view_action,
    cancel_view_action,
    choose_in_view_action,
    refresh_view_action,
    resend_in_view_action,
    settle_view_action,
    view_action_delta,
    view_action_in_flight,
    view_action_owns,
} from '../webview/view-action-model';

const schema = '["Sheet1",3,["a","b","c"]]';
const filter = (id: string, colIndex: number, value: string): FilterEntry => ({
    id, colIndex, operator: 'contains', value, caseSensitive: false, enabled: true,
});
const rules = (partial: Partial<SheetTransformState>): SheetTransformState => ({
    sort: [], filters: [], schema, ...partial,
});
const by_a: SheetTransformState = rules({ sort: [{ colIndex: 0, direction: 'asc' }] });
const by_b: SheetTransformState = rules({ sort: [{ colIndex: 1, direction: 'desc' }] });
const filtered: SheetTransformState = rules({ filters: [filter('f1', 2, 'x')] });

describe('view action deltas', () => {
    it('replaces the sort, upserts filters by id or column, and combines hidden rows', () => {
        const delta = view_action_delta(
            rules({ hiddenRows: [1, 2], filters: [filter('f1', 0, 'a')] }),
            rules({
                sort: [{ colIndex: 1, direction: 'asc' }],
                hiddenRows: [2, 5],
                filters: [filter('f1', 0, 'b'), filter('f2', 1, 'c')],
            }),
        );
        const onto = rules({
            sort: [{ colIndex: 2, direction: 'desc' }],
            hiddenRows: [1, 9],
            // Another filter on column 1: the person's newer f2 replaces it.
            filters: [filter('other', 1, 'z'), filter('f1', 0, 'a')],
        });
        expect(apply_view_action_delta(delta, onto, schema)).toEqual(rules({
            sort: [{ colIndex: 1, direction: 'asc' }],
            hiddenRows: [5, 9],
            filters: [filter('f1', 0, 'b'), filter('f2', 1, 'c')],
        }));
    });

    it('re-adds a filter the rules no longer have, with its edited value', () => {
        const delta = view_action_delta(filtered, rules({ filters: [filter('f1', 2, 'y')] }));
        expect(apply_view_action_delta(delta, rules({}), schema).filters).toEqual([filter('f1', 2, 'y')]);
    });

    it('removes a filter by id and carries the compare toggle', () => {
        const delta = view_action_delta(filtered, rules({ onlyChangedRows: true }));
        expect(apply_view_action_delta(delta, filtered, schema)).toEqual(rules({ onlyChangedRows: true }));
    });
});

describe('a view action', () => {
    it('ends when its one request settles, with a step from the baseline to what installed', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        expect(view_action_in_flight(action)).toBe(true);
        expect(settle_view_action(action, 'A', by_a, 'A')).toEqual({
            kind: 'ended', baseline: undefined, installed: by_a,
        });
    });

    it('waits for every request: a replaced one settled first does not end it', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = choose_in_view_action(action, by_b, 'B');
        const first = settle_view_action(action, 'A', undefined, undefined);
        expect(first).toMatchObject({ kind: 'pending', resend: false });
        if (first.kind !== 'pending') throw new Error('unreachable');
        expect(settle_view_action(first.action, 'B', by_b, 'B')).toEqual({
            kind: 'ended', baseline: undefined, installed: by_b,
        });
    });

    it('records what an earlier request installed when the newer one is refused', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = choose_in_view_action(action, by_b, 'B');
        // B was refused before it took the sheet, so A still computes and installs.
        const refused = settle_view_action(action, 'B', undefined, undefined);
        expect(refused.kind).toBe('pending');
        if (refused.kind !== 'pending') throw new Error('unreachable');
        expect(settle_view_action(refused.action, 'A', by_a, 'A')).toEqual({
            kind: 'ended', baseline: undefined, installed: by_a,
        });
    });

    it('ends with no step when its cancel installs the baseline', () => {
        let action = begin_view_action(0, schema, by_a);
        action = choose_in_view_action(action, by_b, 'B');
        action = cancel_view_action(action, 'C');
        expect(action.requested).toEqual(by_a);
        let outcome = settle_view_action(action, 'B', by_a, undefined);
        if (outcome.kind !== 'pending') throw new Error('unreachable');
        outcome = settle_view_action(outcome.action, 'C', by_a, undefined);
        expect(outcome).toEqual({ kind: 'ended', baseline: by_a, installed: by_a });
    });

    it('keeps the compare toggle asked for when it cancels', () => {
        let action = begin_view_action(0, schema, by_a);
        action = choose_in_view_action(action, { ...by_b, onlyChangedRows: true }, 'B');
        action = cancel_view_action(action, 'C');
        expect(action.requested).toEqual({ ...by_a, onlyChangedRows: true });
    });

    it('composes again onto rules another window installed, and sends again', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        const refreshed = refresh_view_action(action, filtered, undefined);
        expect(refreshed.resend).toBe(true);
        expect(refreshed.action.baseline).toEqual(filtered);
        expect(refreshed.action.requested).toEqual(rules({
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [filter('f1', 2, 'x')],
        }));
        action = resend_in_view_action(refreshed.action, 'A2');
        let outcome = settle_view_action(action, 'A', filtered, undefined);
        if (outcome.kind !== 'pending') throw new Error('unreachable');
        outcome = settle_view_action(outcome.action, 'A2', refreshed.action.requested, 'A2');
        expect(outcome).toEqual({
            kind: 'ended', baseline: filtered, installed: refreshed.action.requested,
        });
    });

    it('sends its cancel again for rules another window installed while it was out', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = cancel_view_action(action, 'C');
        const refreshed = refresh_view_action(action, filtered, undefined);
        expect(refreshed).toMatchObject({ resend: true, action: { requested: filtered, cancelled: true } });
    });

    it('does not move for a refresh showing its own commit', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        expect(refresh_view_action(action, by_a, 'A')).toEqual({ action, resend: false });
    });

    it('takes rules equal to its target, written by another window, for theirs', () => {
        // From O, A is asked for, B supersedes it before A commits; another window
        // writes rules equal to A; B fails and the reconciliation installs them.
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = choose_in_view_action(action, by_b, 'B');
        let outcome = settle_view_action(action, 'A', undefined, undefined);
        if (outcome.kind !== 'pending') throw new Error('unreachable');
        outcome = settle_view_action(outcome.action, 'B', by_a, undefined);
        expect(outcome).toEqual({ kind: 'ended', baseline: by_a, installed: by_a });
    });

    it('records its own request reconciled after a failed cancel', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = cancel_view_action(action, 'C');
        let outcome = settle_view_action(action, 'A', undefined, undefined);
        if (outcome.kind !== 'pending') throw new Error('unreachable');
        outcome = settle_view_action(outcome.action, 'C', by_a, 'A');
        expect(outcome).toEqual({ kind: 'ended', baseline: undefined, installed: by_a });
    });

    it('does not send again once its newest request is settled', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        expect(settle_view_action(action, 'A', filtered, undefined)).toEqual({
            kind: 'ended', baseline: filtered, installed: filtered,
        });
    });

    it('ignores answers that are not its own', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        expect(view_action_owns(action, 'restore')).toBe(false);
        expect(settle_view_action(action, 'restore', by_b, undefined)).toEqual({
            kind: 'pending', action, resend: false,
        });
    });
});
