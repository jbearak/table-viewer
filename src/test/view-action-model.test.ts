import { describe, expect, it } from 'vitest';
import type { FilterEntry, SheetTransformState } from '../types';
import {
    apply_view_action_delta,
    merge_view_action_delta,
    begin_view_action,
    cancel_view_action,
    choose_in_view_action,
    refresh_view_action,
    resend_in_view_action,
    settle_view_action,
    view_action_delta,
    view_action_in_flight,
    view_action_owns,
    resolve_in_view_action,
    take_resolution,
    drop_resolutions,
    view_action_idle,
    view_action_resolving_rows,
    refuse_in_view_action,
} from '../webview/view-action-model';
import { transform_view_step } from '../webview/view-history-model';

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

describe('merging deltas', () => {
    it('keeps the newest per slice and combines hidden rows', () => {
        const earlier = view_action_delta(rules({}), rules({
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [filter('f1', 1, 'a')],
            hiddenRows: [1, 2],
        }));
        const next = view_action_delta(
            rules({ sort: [{ colIndex: 0, direction: 'asc' }], filters: [filter('f1', 1, 'a')], hiddenRows: [1, 2] }),
            rules({ sort: [], filters: [filter('f2', 1, 'b')], hiddenRows: [2, 3] }),
        );
        expect(apply_view_action_delta(merge_view_action_delta(earlier, next), rules({}), schema)).toEqual(rules({
            sort: [],
            filters: [filter('f2', 1, 'b')],
            hiddenRows: [2, 3],
        }));
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

    it('takes the compare toggle back when it cancels an action that changed nothing else', () => {
        let action = begin_view_action(0, schema, by_a);
        action = choose_in_view_action(action, { ...by_a, onlyChangedRows: true }, 'T');
        action = cancel_view_action(action, 'C', false);
        expect(action.requested).toEqual(by_a);
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

    it('keeps the person\'s choice when a change made elsewhere equals it, then another changes the sheet', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        const equal = refresh_view_action(action, by_a, undefined);
        expect(equal.resend).toBe(false);
        const other = refresh_view_action(equal.action, filtered, undefined);
        expect(other.action.requested).toEqual(rules({
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [filter('f1', 2, 'x')],
        }));
        expect(other.resend).toBe(true);
    });

    it('takes each settlement once', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = choose_in_view_action(action, by_b, 'B');
        const first = settle_view_action(action, 'A', undefined, undefined);
        if (first.kind !== 'pending') throw new Error('unreachable');
        // The same settlement again, with a stale projection, moves nothing.
        expect(settle_view_action(first.action, 'A', filtered, undefined)).toEqual({
            kind: 'pending', action: first.action, resend: false,
        });
    });

    it('keeps the compare toggle a cancel kept when a choice replaces the cancel and the sheet changes elsewhere', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, { ...by_a, onlyChangedRows: true }, 'A');
        action = cancel_view_action(action, 'C');
        action = choose_in_view_action(action, { ...by_b, onlyChangedRows: true }, 'B');
        const refreshed = refresh_view_action(action, filtered, undefined);
        expect(refreshed.resend).toBe(true);
        expect(refreshed.action.requested).toEqual({
            ...by_b, filters: filtered.filters, onlyChangedRows: true,
        });
    });

    it('starts the delta again after a cancel', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = cancel_view_action(action, 'C');
        action = choose_in_view_action(action, filtered, 'F');
        const moved = refresh_view_action(action, by_b, undefined);
        expect(moved.action.requested).toEqual(rules({
            sort: [{ colIndex: 1, direction: 'desc' }],
            filters: [filter('f1', 2, 'x')],
        }));
    });

    it('takes rules only meaning the same as its baseline, written elsewhere, for a change made elsewhere', () => {
        // Its sort fails; another window wrote f1's meaning under another id.
        let action = begin_view_action(0, schema, filtered);
        action = choose_in_view_action(action, { ...by_a, filters: filtered.filters }, 'A');
        const foreign = rules({ filters: [filter('f9', 2, 'x')] });
        expect(settle_view_action(action, 'A', foreign, undefined)).toEqual({
            kind: 'ended', baseline: foreign, installed: foreign,
        });
    });

    it('sends again onto a filter rewritten elsewhere under another id, and records the sort alone', () => {
        let action = begin_view_action(0, schema, filtered);
        const sorted = { ...by_a, filters: filtered.filters };
        action = choose_in_view_action(action, sorted, 'A');
        const foreign = rules({ filters: [filter('f9', 2, 'x')] });
        const refreshed = refresh_view_action(action, foreign, undefined);
        expect(refreshed.resend).toBe(true);
        expect(refreshed.action.requested).toEqual({ ...by_a, filters: foreign.filters });
        action = resend_in_view_action(refreshed.action, 'A2');
        let outcome = settle_view_action(action, 'A', foreign, undefined);
        if (outcome.kind !== 'pending') throw new Error('unreachable');
        outcome = settle_view_action(outcome.action, 'A2', refreshed.action.requested, 'A2');
        if (outcome.kind !== 'ended') throw new Error('unreachable');
        const sheet = { sheetIndex: 0, sheetName: 'Sheet1' };
        expect(transform_view_step(sheet, schema, outcome.baseline, outcome.installed)?.label).toBe('Sort');
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

describe('a hide resolving in a view action', () => {
    it('keeps the action from ending until it is answered, though its other request settled', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = resolve_in_view_action(action, 'H', 2);
        const settled = settle_view_action(action, 'A', by_a, 'A');
        expect(settled).toMatchObject({ kind: 'pending', resend: false });
        if (settled.kind !== 'pending') throw new Error('unreachable');
        expect(view_action_idle(settled.action)).toBe(false);
        expect(view_action_resolving_rows(settled.action)).toBe(2);
        const answered = take_resolution(settled.action, 'H')!;
        expect(view_action_idle(answered)).toBe(true);
    });

    it('answers only a hide the action still holds', () => {
        let action = begin_view_action(0, schema, undefined);
        action = resolve_in_view_action(action, 'H', 1);
        expect(take_resolution(action, 'other')).toBeUndefined();
        expect(take_resolution(drop_resolutions(action), 'H')).toBeUndefined();
        expect(take_resolution(cancel_view_action(action, 'C'), 'H')).toBeUndefined();
    });

    it('keeps the toggle a cancel kept when a hide made after it meets a change made elsewhere', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, { ...by_a, onlyChangedRows: true }, 'A');
        action = cancel_view_action(action, 'C');
        action = resolve_in_view_action(action, 'H', 1);
        const moved = refresh_view_action(action, filtered, undefined);
        expect(moved.action.requested).toEqual({ ...filtered, onlyChangedRows: true });
    });

    it('is a choice after a cancel: the action is no longer cancelled', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = cancel_view_action(action, 'C');
        action = resolve_in_view_action(action, 'H', 1);
        expect(action.cancelled).toBe(false);
        expect(action.requested).toEqual(rules({}));
    });

    it('composes its answer onto what is installed, not onto a sort the host refused', () => {
        let action = begin_view_action(0, schema, filtered);
        action = resolve_in_view_action(action, 'H', 1);
        action = choose_in_view_action(action, { ...filtered, sort: by_a.sort }, 'S');
        action = refuse_in_view_action(action, 'S', filtered);
        expect(action.requested).toEqual(filtered);
        const answered = take_resolution(action, 'H')!;
        expect(apply_view_action_delta(answered.delta, filtered, schema)).toEqual(filtered);
    });

    it('composes its answer onto an older request still out when the newer is refused', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = resolve_in_view_action(action, 'H', 1);
        action = choose_in_view_action(action, by_b, 'B');
        action = refuse_in_view_action(action, 'B', undefined);
        expect(action.requested).toEqual(by_a);
    });

    it('falls back past an older request the host refuses after the newer one', () => {
        // A is out, H resolves, B is refused (back to A), then A is refused.
        let action = begin_view_action(0, schema, filtered);
        action = choose_in_view_action(action, { ...filtered, sort: by_a.sort }, 'A');
        action = resolve_in_view_action(action, 'H', 1);
        action = choose_in_view_action(action, { ...filtered, sort: by_b.sort }, 'B');
        action = refuse_in_view_action(action, 'B', filtered);
        expect(action.requested.sort).toEqual(by_a.sort);
        action = refuse_in_view_action(action, 'A', filtered);
        expect(action.requested).toEqual(filtered);
        expect(apply_view_action_delta(take_resolution(action, 'H')!.delta, filtered, schema)).toEqual(filtered);
    });

    it('falls back to what is installed when the older request is refused first, then the newer', () => {
        let action = begin_view_action(0, schema, filtered);
        action = choose_in_view_action(action, { ...filtered, sort: by_a.sort }, 'A');
        action = resolve_in_view_action(action, 'H', 1);
        action = choose_in_view_action(action, { ...filtered, sort: by_b.sort }, 'B');
        action = refuse_in_view_action(action, 'A', filtered);
        expect(action.requested.sort).toEqual(by_b.sort);
        action = refuse_in_view_action(action, 'B', filtered);
        expect(action.requested).toEqual(filtered);
    });

    it('keeps what it asks for when a request it no longer asks for is refused', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = choose_in_view_action(action, by_b, 'B');
        expect(refuse_in_view_action(action, 'A', undefined).requested).toEqual(by_b);
    });

    it('keeps a refused cancel\'s rules, which Cancel sends again', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, { ...by_a, onlyChangedRows: true }, 'A');
        action = cancel_view_action(action, 'C');
        const refused = refuse_in_view_action(action, 'C', undefined);
        expect(refused.requested).toEqual(action.requested);
        expect(refused.cancelled).toBe(true);
    });

    it('recomposes what it asks for onto a change made elsewhere while only a hide resolves', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        const settled = settle_view_action(resolve_in_view_action(action, 'H', 1), 'A', by_a, 'A');
        if (settled.kind !== 'pending') throw new Error('unreachable');
        // Its sort has settled; another window adds a filter.
        const moved = refresh_view_action(settled.action, { ...by_a, filters: filtered.filters }, undefined);
        expect(moved.resend).toBe(false);
        expect(moved.action.requested).toEqual({ ...by_a, filters: filtered.filters });
        // A hide alone, before anything was sent.
        const alone = refresh_view_action(resolve_in_view_action(begin_view_action(0, schema, undefined), 'H', 1), filtered, undefined);
        expect(alone).toMatchObject({ resend: false, action: { requested: filtered } });
    });

    it('composes its answer as a choice that replaces the request in flight', () => {
        let action = begin_view_action(0, schema, undefined);
        action = choose_in_view_action(action, by_a, 'A');
        action = resolve_in_view_action(action, 'H', 1);
        const answered = take_resolution(action, 'H')!;
        action = choose_in_view_action(answered, { ...answered.requested, hiddenRows: [4] }, 'A+H');
        // A is settled when A+H takes the sheet, before it installed.
        let outcome = settle_view_action(action, 'A', undefined, undefined);
        if (outcome.kind !== 'pending') throw new Error('unreachable');
        outcome = settle_view_action(outcome.action, 'A+H', { ...by_a, hiddenRows: [4] }, 'A+H');
        expect(outcome).toEqual({ kind: 'ended', baseline: undefined, installed: { ...by_a, hiddenRows: [4] } });
    });
});
