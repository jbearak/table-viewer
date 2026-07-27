// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { FilterEntry, FilterOperator, SheetTransformState } from '../types';
import {
    append_sort,
    filter_column_kind_from_histogram,
    filter_draft_for_column,
    filter_options_for_draft,
    filter_options_for_kind,
    filter_summary,
    flip_sort,
    is_editable_target,
    move_sort_first,
    operator_supports_case_sensitive,
    remove_sort,
    replace_sort,
    order_relevant_dirty_keys,
    stale_view_signature,
    transform_progress_label,
    transform_shortcut,
    upsert_filter,
} from '../webview/transform-ui-model';

function entry(operator: FilterOperator, value = '5', secondValue = '9'): FilterEntry {
    return {
        id: operator,
        colIndex: 0,
        operator,
        value,
        secondValue,
        caseSensitive: true,
        enabled: false,
    };
}

describe('transform UI model', () => {
    it('returns kind-specific filter operator lists', () => {
        expect(filter_options_for_kind('numeric').map((option) => option.value)).toEqual([
            'equals',
            'notEquals',
            'greaterThan',
            'greaterThanOrEqual',
            'lessThan',
            'lessThanOrEqual',
            'between',
            'notBetween',
            'isEmpty',
            'isNotEmpty',
        ]);
        expect(filter_options_for_kind('text').map((option) => option.value)).toEqual([
            'contains',
            'notContains',
            'equals',
            'notEquals',
            'startsWith',
            'endsWith',
            'isEmpty',
            'isNotEmpty',
        ]);
        expect(filter_options_for_kind('orderedText').map((option) => option.value)).toEqual([
            'contains',
            'notContains',
            'equals',
            'notEquals',
            'startsWith',
            'endsWith',
            'greaterThan',
            'greaterThanOrEqual',
            'lessThan',
            'lessThanOrEqual',
            'between',
            'notBetween',
            'isEmpty',
            'isNotEmpty',
        ]);
        expect(filter_options_for_kind('unknown').map((option) => option.value)).toEqual([
            'contains',
            'notContains',
            'equals',
            'notEquals',
            'startsWith',
            'endsWith',
            'greaterThan',
            'greaterThanOrEqual',
            'lessThan',
            'lessThanOrEqual',
            'between',
            'notBetween',
            'isEmpty',
            'isNotEmpty',
        ]);
        expect(filter_options_for_draft('numeric', 'contains').map((option) => option.value))
            .toEqual([
                'equals',
                'notEquals',
                'greaterThan',
                'greaterThanOrEqual',
                'lessThan',
                'lessThanOrEqual',
                'between',
                'notBetween',
                'isEmpty',
                'isNotEmpty',
                'contains',
            ]);
        expect(operator_supports_case_sensitive('contains')).toBe(true);
        expect(operator_supports_case_sensitive('equals', 'text')).toBe(true);
        expect(operator_supports_case_sensitive('equals', 'numeric')).toBe(false);
        expect(operator_supports_case_sensitive('contains', 'numeric')).toBe(true);
        expect(operator_supports_case_sensitive('notEquals', 'numeric')).toBe(false);
        expect(operator_supports_case_sensitive('equals', 'orderedText')).toBe(true);
        expect(operator_supports_case_sensitive('equals', 'unknown')).toBe(true);
        expect(operator_supports_case_sensitive('between')).toBe(false);
        expect(operator_supports_case_sensitive('isEmpty')).toBe(false);
        expect(filter_column_kind_from_histogram({ status: 'loading' })).toBe('unknown');
        expect(filter_column_kind_from_histogram({
            status: 'error', message: 'scan failed',
        })).toBe('unknown');
        expect(filter_column_kind_from_histogram({ status: 'ready', bins: [] })).toBe('text');
        expect(filter_column_kind_from_histogram({
            status: 'ready', bins: [], columnKind: 'orderedText',
        })).toBe('orderedText');
        expect(filter_column_kind_from_histogram({
            status: 'ready', bins: [{ lo: 0, hi: 1, count: 1 }], columnKind: 'text',
        })).toBe('text');
        expect(filter_column_kind_from_histogram({
            status: 'ready', bins: [{ lo: 0, hi: 1, count: 1 }],
        })).toBe('numeric');
    });

    it('summarizes all existing operators compactly', () => {
        const expected: Record<FilterOperator, string> = {
            contains: 'Amount contains “5”',
            notContains: 'Amount does not contain “5”',
            equals: 'Amount = “5”',
            notEquals: 'Amount ≠ “5”',
            startsWith: 'Amount starts with “5”',
            endsWith: 'Amount ends with “5”',
            greaterThan: 'Amount > 5',
            greaterThanOrEqual: 'Amount ≥ 5',
            lessThan: 'Amount < 5',
            lessThanOrEqual: 'Amount ≤ 5',
            between: 'Amount 5–9',
            notBetween: 'Amount not in 5–9',
            isEmpty: 'Amount is empty',
            isNotEmpty: 'Amount is not empty',
            isOneOf: 'Amount includes all values',
        };
        for (const operator of Object.keys(expected) as FilterOperator[]) {
            expect(filter_summary(entry(operator), ['Amount'])).toBe(expected[operator]);
        }
    });

    it('hydrates an existing draft without losing identity, state, or zero values', () => {
        const existing: FilterEntry = {
            id: 'stable',
            colIndex: 2,
            operator: 'between',
            value: '0',
            secondValue: '0',
            caseSensitive: true,
            enabled: false,
        };
        expect(filter_draft_for_column(2, [existing])).toEqual(existing);
    });

    it('seeds preferred operator for new drafts', () => {
        const draft = filter_draft_for_column(4, [], 'between');
        expect(draft).toMatchObject({
            colIndex: 4,
            operator: 'between',
            value: '',
            secondValue: '',
            caseSensitive: false,
            enabled: true,
        });
    });

    it('enforces one filter per source column while preserving edited identity', () => {
        const old = { ...entry('contains'), id: 'old', colIndex: 1 };
        const other = { ...entry('equals'), id: 'other', colIndex: 2 };
        const edited = { ...old, operator: 'endsWith' as const, value: 'x' };
        expect(upsert_filter([old, other], edited)).toEqual([other, edited]);
    });

    it('implements replace, append, flip, remove, and move-first sort actions', () => {
        const initial = [
            { colIndex: 1, direction: 'asc' as const },
            { colIndex: 3, direction: 'desc' as const },
        ];
        expect(replace_sort(2, 'desc')).toEqual([{ colIndex: 2, direction: 'desc' }]);
        expect(append_sort(initial, 2, 'asc')).toEqual([...initial, { colIndex: 2, direction: 'asc' }]);
        expect(append_sort(initial, 3, 'asc')).toEqual([
            initial[0],
            { colIndex: 3, direction: 'asc' },
        ]);
        expect(flip_sort(initial, 0)[0].direction).toBe('desc');
        expect(remove_sort(initial, 0)).toEqual([initial[1]]);
        expect(move_sort_first(initial, 1)).toEqual([initial[1], initial[0]]);
    });

    it('infers Raven progress wording without changing protocol state', () => {
        const empty = { sort: [], filters: [] };
        const sorted = { sort: [{ colIndex: 0, direction: 'asc' as const }], filters: [] };
        const filtered = { sort: [], filters: [entry('contains')] };
        expect(transform_progress_label(empty, sorted, 'user')).toBe('Sorting…');
        expect(transform_progress_label(empty, filtered, 'user')).toBe('Filtering…');
        expect(transform_progress_label(sorted, { ...sorted, filters: filtered.filters }, 'user'))
            .toBe('Filtering…');
        expect(transform_progress_label(empty, sorted, 'restore')).toBe('Applying saved…');
    });

    it('maps the complete Shift+Alt shortcut namespace', () => {
        const event = (key: string, code: string) => ({
            shiftKey: true,
            altKey: true,
            metaKey: false,
            ctrlKey: false,
            key,
            code,
        });
        expect(transform_shortcut(event('A', 'KeyA'))).toEqual({ kind: 'sort', direction: 'asc' });
        expect(transform_shortcut(event('D', 'KeyD'))).toEqual({ kind: 'sort', direction: 'desc' });
        expect(transform_shortcut(event('0', 'Digit0'))).toEqual({ kind: 'clearSorts' });
        expect(transform_shortcut(event('F', 'KeyF'))).toEqual({ kind: 'editFilter' });
        expect(transform_shortcut(event('X', 'KeyX'))).toEqual({ kind: 'clearFilter' });
        expect(transform_shortcut(event('9', 'Digit9'))).toEqual({ kind: 'clearFilters' });
        expect(transform_shortcut({ ...event('A', 'KeyA'), ctrlKey: true })).toBeNull();
    });

    it('guards every editable target required by the shortcut contract', () => {
        expect(is_editable_target(document.createElement('input'))).toBe(true);
        expect(is_editable_target(document.createElement('textarea'))).toBe(true);
        expect(is_editable_target(document.createElement('select'))).toBe(true);
        const editable = document.createElement('div');
        editable.contentEditable = 'true';
        Object.defineProperty(editable, 'isContentEditable', { value: true });
        expect(is_editable_target(editable)).toBe(true);
        expect(is_editable_target(document.createElement('button'))).toBe(false);
    });
});

describe('stale_view_signature', () => {
    const enabled_filter = (colIndex: number, value = '5'): FilterEntry => ({
        ...entry('equals', value),
        id: `filter-${colIndex}-${value}`,
        colIndex,
        enabled: true,
    });
    const sort_on_2: SheetTransformState = {
        sort: [{ colIndex: 2, direction: 'asc' }],
        filters: [],
    };

    it('says nothing without an installed transform', () => {
        expect(stale_view_signature(undefined, ['5:2'], [])).toBeUndefined();
        expect(stale_view_signature({ sort: [], filters: [] }, ['5:2'], []))
            .toBeUndefined();
    });

    it('is defined for a dirty cell in a sorted column', () => {
        expect(stale_view_signature(sort_on_2, ['5:2'], [])).toBeDefined();
    });

    it('says nothing for a dirty cell in a column the order does not read', () => {
        expect(stale_view_signature(sort_on_2, ['5:3'], [])).toBeUndefined();
    });

    it('says nothing for a disabled filter on the dirty column', () => {
        expect(stale_view_signature(
            { sort: [], filters: [{ ...enabled_filter(2), enabled: false }] },
            ['5:2'],
            [],
        )).toBeUndefined();
        // Same state, filter enabled: the column is now read, so it does speak.
        expect(stale_view_signature(
            { sort: [], filters: [enabled_filter(2)] },
            ['5:2'],
            [],
        )).toBeDefined();
    });

    it('changes when the installed rules change for the same dirty cells', () => {
        // Folding the rules in is what stops an acknowledgement of one view being
        // honoured against a different one.
        const ascending = stale_view_signature(sort_on_2, ['5:2'], []);
        const descending = stale_view_signature(
            { sort: [{ colIndex: 2, direction: 'desc' }], filters: [] },
            ['5:2'],
            [],
        );
        expect(descending).not.toBe(ascending);
        // Including a filter's operand, not just which column it names.
        expect(stale_view_signature({ sort: [], filters: [enabled_filter(2, '5')] }, ['5:2'], []))
            .not.toBe(
                stale_view_signature({ sort: [], filters: [enabled_filter(2, '6')] }, ['5:2'], []),
            );
    });

    it('ignores malformed keys', () => {
        // `Number('')` is 0, so a key with no column tail must not be read as a
        // dirty cell in column 0.
        expect(stale_view_signature(
            { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
            ['5:', ':', 'nonsense', '5'],
            [],
        )).toBeUndefined();
    });

    it('does not depend on the order dirty keys arrive in', () => {
        expect(stale_view_signature(sort_on_2, ['5:2', '1:2'], []))
            .toBe(stale_view_signature(sort_on_2, ['1:2', '5:2'], []));
    });

    it('speaks for a hidden edited cell in a column no rule reads', () => {
        // Hidden-ness is a property of the row, so the column test cannot stand in
        // for it: this is the reopen shape — a filter on column 2 excluding a row
        // whose only unsaved edit is in column 3.
        const filtered: SheetTransformState = {
            sort: [],
            filters: [enabled_filter(2)],
        };
        expect(stale_view_signature(filtered, ['5:3'], [])).toBeUndefined();
        expect(stale_view_signature(filtered, ['5:3'], ['5:3'])).toBeDefined();
    });

    it('speaks for hidden rows alone, which read no column at all', () => {
        // `hiddenRows` contributes no read columns by construction
        // (`transform_read_columns`), so without the hidden cells folded in this view
        // could never say anything, however many edits it is keeping out of sight.
        const hidden_only: SheetTransformState = {
            sort: [],
            filters: [],
            hiddenRows: [5],
        };
        expect(stale_view_signature(hidden_only, ['5:3'], [])).toBeUndefined();
        expect(stale_view_signature(hidden_only, ['5:3'], ['5:3'])).toBeDefined();
    });

    it('changes when only the number of hidden cells changes', () => {
        // What makes a dismissal expire when the number the user acknowledged does.
        expect(stale_view_signature(sort_on_2, ['5:2'], ['5:2']))
            .not.toBe(stale_view_signature(sort_on_2, ['5:2'], ['5:2', '5:3']));
        expect(stale_view_signature(sort_on_2, ['5:2'], []))
            .not.toBe(stale_view_signature(sort_on_2, ['5:2'], ['5:2']));
    });

    it('changes when different cells are hidden and the count does not move', () => {
        // Why the parameter is keys and not a count. Hide one dirty row, dismiss,
        // unhide it and hide a *different* dirty row: same count, same dirty map, and —
        // because `hiddenRows` is deliberately not in the rules serialization — the
        // same rules half. Only the keys distinguish the two, and they must, because
        // it is different unsaved work that has gone out of sight.
        const hiding = (row: number): SheetTransformState => ({
            sort: [],
            filters: [],
            hiddenRows: [row],
        });
        const dirty = ['5:0', '7:0'];
        expect(stale_view_signature(hiding(5), dirty, ['5:0']))
            .not.toBe(stale_view_signature(hiding(7), dirty, ['7:0']));
    });

    it('is unchanged by an echo of the same hidden cells in another order', () => {
        // The other direction, and what keeps Dismiss sticking under a hiding filter:
        // the host's key order follows `Object.keys` on the durable map, which is not
        // a promise about anything.
        expect(stale_view_signature(sort_on_2, ['5:2'], ['9:1', '3:4']))
            .toBe(stale_view_signature(sort_on_2, ['5:2'], ['3:4', '9:1']));
    });

    it('changes when another dirty cell lands in a read column', () => {
        // Probing for holes found this one: the hidden half was pinned in both
        // directions here and the *order* half was pinned nowhere in this file — dropping
        // `affected` from the signature entirely failed only two app-level tests.
        // Both halves have to be folded in, because either alone is enough to make the
        // notice speak and a dismissal covers only what it was pressed over.
        expect(stale_view_signature(sort_on_2, ['5:2'], []))
            .not.toBe(stale_view_signature(sort_on_2, ['5:2', '7:2'], []));
    });
});

describe('order_relevant_dirty_keys', () => {
    const sorted_on_0: SheetTransformState = {
        sort: [{ colIndex: 0, direction: 'asc' }],
        filters: [],
    };
    const enabled_filter = (colIndex: number): FilterEntry => ({
        ...entry('equals', '5'),
        id: `filter-${colIndex}`,
        colIndex,
        enabled: true,
    });

    it('names the dirty cells in a sorted column and no others', () => {
        expect(order_relevant_dirty_keys(sorted_on_0, ['5:0', '5:1'])).toEqual(['5:0']);
    });

    it('names none for a view that only hides rows', () => {
        // The condition on the notice's first sentence, which claims that sorting and
        // filters do not update mid-edit. A view permuted by `hiddenRows` alone has
        // neither, so there is no such claim to make however many rows it drops.
        expect(order_relevant_dirty_keys(
            { sort: [], filters: [], hiddenRows: [5] },
            ['5:0', '5:1'],
        )).toEqual([]);
    });

    it('names none for a disabled filter on the dirty column', () => {
        expect(order_relevant_dirty_keys(
            {
                sort: [],
                filters: [{ ...enabled_filter(0), enabled: false }],
            },
            ['5:0'],
        )).toEqual([]);
        expect(order_relevant_dirty_keys(
            { sort: [], filters: [enabled_filter(0)] },
            ['5:0'],
        )).toEqual(['5:0']);
    });

    it('names none without an installed transform', () => {
        expect(order_relevant_dirty_keys(undefined, ['5:0'])).toEqual([]);
    });

    it('does not read a malformed key as column 0', () => {
        // `Number('')` is 0, which would make every tail-less key an edit in the first
        // sorted column.
        expect(order_relevant_dirty_keys(sorted_on_0, ['5:', ':', 'nonsense', '5']))
            .toEqual([]);
    });
});
