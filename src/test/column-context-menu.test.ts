import { describe, expect, it, vi } from 'vitest';
import {
    column_context_menu_items,
    header_column_can_be_renamed,
} from '../webview/column-context-menu';
import { column_rename_error } from '../webview/rename-column-dialog';

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
    it('does not rename a header inherited from a merged anchor', () => {
        const sheet = {
            name: 'Sheet1', rowCount: 2, sourceRowCount: 3, columnCount: 2,
            merges: [], hasFormatting: false,
            columnNames: ['Group', 'Direct'],
            columnHeaderEditTexts: ['', 'Direct'],
            columnHeaderEditable: [false, true],
            excelFirstRowHeader: {
                mode: 'on' as const, detected: false, active: true, available: true, sourceRow: 1,
            },
        };
        expect(header_column_can_be_renamed(sheet, 0)).toBe(false);
        expect(header_column_can_be_renamed(sheet, 1)).toBe(true);
        expect(header_column_can_be_renamed({
            ...sheet,
            columnNames: ['', 'Direct'],
            columnHeaderEditable: [false, true],
        }, 0)).toBe(false);

        const items = column_context_menu_items({
            ...base(),
            on_rename: vi.fn(),
            rename_disabled: !header_column_can_be_renamed(sheet, 0),
        });
        const rename = items.find((item) => item.kind !== 'separator'
            && item.label === 'Rename column…');
        expect(rename && rename.kind !== 'separator' ? rename.disabled : undefined).toBe(true);
    });

    it('offers a column rename only when the caller admits it', () => {
        const on_rename = vi.fn();
        const items = column_context_menu_items({
            ...base(),
            transform_sections: false,
            on_rename,
        });
        expect(labels(items)).toEqual(['Copy column', 'Hide column', 'Rename column…']);
        const rename = items.find((item) => item.kind !== 'separator'
            && item.label === 'Rename column…');
        if (!rename || rename.kind === 'separator') throw new Error('missing rename action');
        rename.on_click({} as never);
        expect(on_rename).toHaveBeenCalledOnce();
    });

    it('validates renamed headers with the same normalized uniqueness rule', () => {
        expect(column_rename_error('', ['Revenue', 'Units'], 0)).toBe('Enter a column name.');
        expect(column_rename_error('  UNITS  ', ['Revenue', 'Units'], 0))
            .toBe('Another column already has that name.');
        expect(column_rename_error('Net Revenue', ['Revenue', 'Units'], 0)).toBeUndefined();
    });

    it('keeps Copy column and Hide column in preview/edit while omitting transforms', () => {
        const props = { ...base(), transform_sections: false };
        expect(labels(column_context_menu_items(props))).toEqual(['Copy column', 'Hide column']);
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
            'Copy column',
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
