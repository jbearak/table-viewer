import { describe, expect, it, vi } from 'vitest';
import { column_context_menu_items } from '../webview/column-context-menu';

function labels(items: ReturnType<typeof column_context_menu_items>): string[] {
    return items.flatMap((item) => item.kind === 'separator' ? [] : [item.label]);
}

function base() {
    return {
        column_name: 'Source C',
        transform_sections: true,
        transform_disabled: false,
        active_direction: null,
        any_sorted: false,
        other_columns_sorted: false,
        has_filter: false,
        any_filtered: false,
        on_copy: vi.fn(),
        on_hide: vi.fn(),
        on_sort: vi.fn(),
        on_clear_column_sort: vi.fn(),
        on_clear_all_sorts: vi.fn(),
        on_edit_filter: vi.fn(),
        on_clear_column_filter: vi.fn(),
        on_clear_all_filters: vi.fn(),
    };
}

describe('column context menu model', () => {
    it('keeps Copy Column and Hide column in preview/edit while omitting transforms', () => {
        const props = { ...base(), transform_sections: false };
        expect(labels(column_context_menu_items(props))).toEqual(['Copy Column', 'Hide column']);
    });

    it('shows replace, append, clear, and filter actions with textual shortcuts', () => {
        const props = {
            ...base(),
            any_sorted: true,
            other_columns_sorted: true,
            any_filtered: true,
        };
        const items = column_context_menu_items(props);
        expect(labels(items)).toEqual([
            'Copy Column',
            'Hide column',
            'Sort ascending',
            'Sort descending',
            'Add ascending to sort',
            'Add descending to sort',
            'Clear all sorts',
            'Filter…',
            'Clear all filters',
        ]);
        expect(items.some((item) => item.kind !== 'separator'
            && item.shortcut === 'Shift+Alt+A')).toBe(true);
    });

    it('plain sort replaces while Shift-click and explicit Add append', () => {
        const props = { ...base(), any_sorted: true, other_columns_sorted: true };
        const items = column_context_menu_items(props);
        const ascending = items.find((item) => item.kind !== 'separator'
            && item.label === 'Sort ascending');
        const add = items.find((item) => item.kind !== 'separator'
            && item.label === 'Add descending to sort');
        if (!ascending || ascending.kind === 'separator' || !add || add.kind === 'separator') {
            throw new Error('missing sort actions');
        }
        ascending.on_click({ shiftKey: false } as never);
        ascending.on_click({ shiftKey: true } as never);
        add.on_click({ shiftKey: false } as never);
        expect(props.on_sort.mock.calls).toEqual([
            ['asc', false],
            ['asc', true],
            ['desc', true],
        ]);
    });

    it('marks all transform actions disabled while pending but leaves copy/hide enabled', () => {
        const items = column_context_menu_items({
            ...base(),
            transform_disabled: true,
            any_sorted: true,
            has_filter: true,
            any_filtered: true,
            active_direction: 'asc',
        });
        const actionable = items.filter((item) => item.kind !== 'separator');
        expect(actionable.slice(0, 2).every((item) => !item.disabled)).toBe(true);
        expect(actionable.slice(2).every((item) => item.disabled)).toBe(true);
        expect(labels(items)).toContain('Edit filter…');
        expect(labels(items)).toContain('Clear filter on this column');
    });
});
