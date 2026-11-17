/**
 * A view action: the person's sort, filter, and Unhide all choices on one sheet
 * since that sheet's last install, and the requests sent for them. Pure; App
 * keeps at most one (plan I1) and feeds it the host's answers.
 *
 * The action holds two sets of rules and what the person changed. `baseline` is
 * what was installed when its first choice was made, or what a change from
 * elsewhere installed since (I3). `requested` is what the newest choice asked
 * for. `delta` is every change the person made in the action, slice by slice
 * (I6), merged choice by choice so the newest wins in each slice; a moved
 * baseline gets that delta composed onto it. It is kept, not derived from the
 * baseline and `requested`: a change made elsewhere can equal one of the
 * person's, and the difference would then lose it.
 *
 * It ends when the host has settled every request it sent (I3), and its step
 * runs from the baseline to what is then installed (I2). An install written by
 * another panel moves the baseline instead, so it is never recorded as this
 * action's.
 */

import {
    is_range_filter_operator,
    transform_has_entries,
    type FilterEntry,
    type SheetTransformState,
    type SortKey,
} from '../types';
import { upsert_filter } from './transform-ui-model';

export function transforms_semantically_equal(
    left: SheetTransformState | undefined,
    right: SheetTransformState | undefined,
): boolean {
    if (!transform_has_entries(left) && !transform_has_entries(right)) return true;
    if (!left || !right) return false;
    // Session state, but a semantic difference like any other: without this a
    // toggle of "only changed rows" over an existing sort compared equal to the
    // sort alone, and handle_transform_change dropped the request as a no-op.
    if ((left.onlyChangedRows === true) !== (right.onlyChangedRows === true)) return false;
    if (JSON.stringify(left.sort) !== JSON.stringify(right.sort)) return false;
    const left_hidden = [...(left.hiddenRows ?? [])].sort((a, b) => a - b);
    const right_hidden = [...(right.hiddenRows ?? [])].sort((a, b) => a - b);
    if (JSON.stringify(left_hidden) !== JSON.stringify(right_hidden)) return false;
    const semantic_filters = (filters: readonly FilterEntry[]) => filters
        .map((entry) => {
            const base = {
                colIndex: entry.colIndex,
                operator: entry.operator,
                enabled: entry.enabled,
            };
            if (entry.operator === 'isEmpty' || entry.operator === 'isNotEmpty') {
                return base;
            }
            if (entry.operator === 'isOneOf') {
                return {
                    ...base,
                    // Total order with null first and code-unit string compare, so
                    // equal exclusion sets always serialize identically (locale
                    // collation can tie distinct strings, e.g. '' vs null or
                    // composed vs decomposed Unicode).
                    excludedValues: [...(entry.excludedValues ?? [])].sort(
                        (a, b) => {
                            if (a === b) return 0;
                            if (a === null) return -1;
                            if (b === null) return 1;
                            return a < b ? -1 : 1;
                        },
                    ),
                };
            }
            return {
                ...base,
                value: entry.value ?? '',
                secondValue: is_range_filter_operator(entry.operator)
                    ? entry.secondValue ?? ''
                    : undefined,
                caseSensitive: entry.caseSensitive,
            };
        })
        .sort((a, b) => a.colIndex - b.colIndex);
    return JSON.stringify(semantic_filters(left.filters))
        === JSON.stringify(semantic_filters(right.filters));
}

/** What the person changed, from one set of rules to another, slice by slice. */
export interface ViewActionDelta {
    /** The new sort, when it changed. Sort replaces sort. */
    readonly sort?: readonly SortKey[];
    /** Filters added or changed; each replaces the filter with its id or on its column. */
    readonly upserts: readonly FilterEntry[];
    /** Filter ids removed. */
    readonly removals: readonly string[];
    readonly hidden: readonly number[];
    readonly shown: readonly number[];
    /** The compare toggle, when it changed. */
    readonly onlyChangedRows?: boolean;
}

const EMPTY_RULES: SheetTransformState = { sort: [], filters: [] };

function rules_or_empty(rules: SheetTransformState | undefined): SheetTransformState {
    return rules ?? EMPTY_RULES;
}

export function view_action_delta(
    from: SheetTransformState | undefined,
    to: SheetTransformState,
): ViewActionDelta {
    const before = rules_or_empty(from);
    const sort = JSON.stringify(before.sort) === JSON.stringify(to.sort) ? undefined : to.sort;
    const before_filters = new Map(before.filters.map((filter) => [filter.id, filter]));
    const upserts = to.filters.filter((filter) => (
        JSON.stringify(before_filters.get(filter.id)) !== JSON.stringify(filter)
    ));
    const after_ids = new Set(to.filters.map((filter) => filter.id));
    const removals = before.filters
        .filter((filter) => !after_ids.has(filter.id))
        .map((filter) => filter.id);
    const before_hidden = new Set(before.hiddenRows ?? []);
    const after_hidden = new Set(to.hiddenRows ?? []);
    const hidden = [...after_hidden].filter((row) => !before_hidden.has(row));
    const shown = [...before_hidden].filter((row) => !after_hidden.has(row));
    const only_changed = (to.onlyChangedRows === true) !== (before.onlyChangedRows === true)
        ? to.onlyChangedRows === true
        : undefined;
    return {
        ...(sort === undefined ? {} : { sort }),
        upserts,
        removals,
        hidden,
        shown,
        ...(only_changed === undefined ? {} : { onlyChangedRows: only_changed }),
    };
}

const EMPTY_DELTA: ViewActionDelta = { upserts: [], removals: [], hidden: [], shown: [] };

/** `next` made after `earlier`: the newest wins in each slice, and hidden rows combine. */
export function merge_view_action_delta(
    earlier: ViewActionDelta,
    next: ViewActionDelta,
): ViewActionDelta {
    const replaced = (filter: FilterEntry) => next.removals.includes(filter.id)
        || next.upserts.some((entry) => entry.id === filter.id || entry.colIndex === filter.colIndex);
    const upserts = [...earlier.upserts.filter((filter) => !replaced(filter)), ...next.upserts];
    const removals = [
        ...earlier.removals.filter((id) => (
            !next.removals.includes(id) && !next.upserts.some((entry) => entry.id === id)
        )),
        ...next.removals,
    ];
    const hidden = [
        ...earlier.hidden.filter((row) => !next.shown.includes(row) && !next.hidden.includes(row)),
        ...next.hidden,
    ];
    const shown = [
        ...earlier.shown.filter((row) => !next.hidden.includes(row) && !next.shown.includes(row)),
        ...next.shown,
    ];
    const sort = next.sort ?? earlier.sort;
    const only_changed = next.onlyChangedRows ?? earlier.onlyChangedRows;
    return {
        ...(sort === undefined ? {} : { sort }),
        upserts,
        removals,
        hidden,
        shown,
        ...(only_changed === undefined ? {} : { onlyChangedRows: only_changed }),
    };
}

export function apply_view_action_delta(
    delta: ViewActionDelta,
    onto: SheetTransformState | undefined,
    schema: string | undefined,
): SheetTransformState {
    const base = rules_or_empty(onto);
    let filters = base.filters.filter((filter) => !delta.removals.includes(filter.id));
    for (const filter of delta.upserts) filters = upsert_filter(filters, filter);
    const hidden = new Set(base.hiddenRows ?? []);
    for (const row of delta.hidden) hidden.add(row);
    for (const row of delta.shown) hidden.delete(row);
    const hidden_rows = [...hidden].sort((a, b) => a - b);
    const only_changed = delta.onlyChangedRows ?? base.onlyChangedRows === true;
    return {
        sort: [...(delta.sort ?? base.sort)],
        filters,
        ...(hidden_rows.length === 0 ? {} : { hiddenRows: hidden_rows }),
        ...(schema === undefined ? {} : { schema }),
        ...(only_changed ? { onlyChangedRows: true as const } : {}),
    };
}

export interface ViewActionRequest {
    readonly requestId: string;
    readonly target: SheetTransformState;
    readonly settled: boolean;
}

export interface ViewAction {
    readonly sheetIndex: number;
    readonly schema: string | undefined;
    readonly baseline: SheetTransformState | undefined;
    readonly requested: SheetTransformState;
    /** Every change the person made in the action, merged; empty after a cancel. */
    readonly delta: ViewActionDelta;
    /** The newest request is a cancel back to the baseline. */
    readonly cancelled: boolean;
    readonly requests: readonly ViewActionRequest[];
}

export function begin_view_action(
    sheet_index: number,
    schema: string | undefined,
    installed: SheetTransformState | undefined,
): ViewAction {
    return {
        sheetIndex: sheet_index,
        schema,
        baseline: installed,
        requested: rules_or_empty(installed),
        delta: EMPTY_DELTA,
        cancelled: false,
        requests: [],
    };
}

/** The newest choice asks for `requested`, sent as `request_id`. */
export function choose_in_view_action(
    action: ViewAction,
    requested: SheetTransformState,
    request_id: string,
): ViewAction {
    return {
        ...action,
        requested,
        delta: merge_view_action_delta(
            action.cancelled ? EMPTY_DELTA : action.delta,
            view_action_delta(action.requested, requested),
        ),
        cancelled: false,
        requests: [...action.requests, { requestId: request_id, target: requested, settled: false }],
    };
}

/**
 * What a cancel asks for: the baseline, keeping the compare toggle as asked
 * (I4). It is not a choice and records nothing.
 */
export function view_action_cancel_target(action: ViewAction): SheetTransformState {
    const baseline = rules_or_empty(action.baseline);
    const { onlyChangedRows: _baseline_toggle, ...rest } = baseline;
    return {
        ...rest,
        ...(action.schema === undefined ? {} : { schema: action.schema }),
        ...(action.requested.onlyChangedRows === true ? { onlyChangedRows: true as const } : {}),
    };
}

export function cancel_view_action(action: ViewAction, request_id: string): ViewAction {
    const target = view_action_cancel_target(action);
    return {
        ...action,
        requested: target,
        delta: EMPTY_DELTA,
        cancelled: true,
        requests: [...action.requests, { requestId: request_id, target, settled: false }],
    };
}

/** The same request again, onto a moved baseline: it supersedes the one in flight. */
export function resend_in_view_action(action: ViewAction, request_id: string): ViewAction {
    return {
        ...action,
        requests: [
            ...action.requests,
            { requestId: request_id, target: action.requested, settled: false },
        ],
    };
}

export function view_action_owns(action: ViewAction, request_id: string): boolean {
    return action.requests.some((request) => request.requestId === request_id);
}

/** The newest request is still out: the host has not settled it. */
export function view_action_in_flight(action: ViewAction): boolean {
    const newest = action.requests.at(-1);
    return newest !== undefined && !newest.settled;
}

/**
 * Rules installed by someone else (I3): when they differ from the baseline, the
 * baseline moves to them and, while the newest request is out, the request is
 * composed again onto them. Returns the action and whether to send again.
 */
function adopt_from_elsewhere(
    action: ViewAction,
    rules: SheetTransformState | undefined,
): { readonly action: ViewAction; readonly resend: boolean } {
    if (transforms_semantically_equal(rules, action.baseline)) return { action, resend: false };
    const moved: ViewAction = { ...action, baseline: rules };
    if (!view_action_in_flight(action)) return { action: moved, resend: false };
    const requested = action.cancelled
        ? view_action_cancel_target(moved)
        : apply_view_action_delta(action.delta, rules, action.schema);
    const newest = action.requests.at(-1)!;
    return {
        action: { ...moved, requested },
        resend: !transforms_semantically_equal(requested, newest.target),
    };
}

function committed_by_action(action: ViewAction, committed_by: string | undefined): boolean {
    return committed_by !== undefined && view_action_owns(action, committed_by);
}

/** A refresh showed the sheet's rules, with the request of this window that committed them. */
export function refresh_view_action(
    action: ViewAction,
    rules: SheetTransformState | undefined,
    committed_by: string | undefined,
): { readonly action: ViewAction; readonly resend: boolean } {
    if (committed_by_action(action, committed_by)) return { action, resend: false };
    return adopt_from_elsewhere(action, rules);
}

export type ViewActionSettlement =
    | { readonly kind: 'pending'; readonly action: ViewAction; readonly resend: boolean }
    | {
        readonly kind: 'ended';
        readonly baseline: SheetTransformState | undefined;
        readonly installed: SheetTransformState | undefined;
    };

/**
 * The host settled one of the action's requests, and the sheet now has `rules`
 * installed, committed by `committed_by`. The action ends when every request it
 * sent is settled and nothing is to be sent again.
 */
export function settle_view_action(
    action: ViewAction,
    request_id: string,
    rules: SheetTransformState | undefined,
    committed_by: string | undefined,
): ViewActionSettlement {
    // Once per request id (I3): a settlement already taken changes nothing.
    if (
        !view_action_owns(action, request_id)
        || action.requests.some((request) => request.requestId === request_id && request.settled)
    ) return { kind: 'pending', action, resend: false };
    const marked: ViewAction = {
        ...action,
        requests: action.requests.map((request) => (
            request.requestId === request_id ? { ...request, settled: true } : request
        )),
    };
    const adopted = committed_by_action(marked, committed_by)
        ? { action: marked, resend: false }
        : adopt_from_elsewhere(marked, rules);
    if (adopted.resend || marked.requests.some((request) => !request.settled)) {
        return { kind: 'pending', action: adopted.action, resend: adopted.resend };
    }
    return {
        kind: 'ended',
        baseline: adopted.action.baseline,
        installed: transform_has_entries(rules) ? rules : undefined,
    };
}
