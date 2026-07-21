// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { FilterEntry, FilterOperator } from '../types';
import {
    append_sort,
    filter_draft_for_column,
    filter_summary,
    flip_sort,
    is_editable_target,
    move_sort_first,
    remove_sort,
    replace_sort,
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
            notBetween: 'Amount not 5–9',
            isEmpty: 'Amount is empty',
            isNotEmpty: 'Amount is not empty',
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
