import { describe, expect, it, vi } from 'vitest';
import {
    column_context_menu_items,
    header_column_can_be_renamed,
    multi_column_context_menu_items,
} from '../webview/column-context-menu';
import { column_rename_error } from '../webview/rename-column-dialog';
import { committed_column_name } from '../column-name';
import type { ActionMenuItem, MenuItem } from '../webview/context-menu';

function is_action(item: MenuItem): item is ActionMenuItem {
    return item.kind !== 'separator' && item.kind !== 'submenu';
}

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
        const rename = items.filter(is_action).find((item) => item.label === 'Rename column…');
        expect(rename?.disabled).toBe(true);
    });

    it('offers a column rename only when the caller admits it', () => {
        const on_rename = vi.fn();
        const items = column_context_menu_items({
            ...base(),
            transform_sections: false,
            on_rename,
        });
        expect(labels(items)).toEqual(['Copy column', 'Hide column', 'Rename column…']);
        const rename = items.filter(is_action).find((item) => item.label === 'Rename column…');
        if (!rename) throw new Error('missing rename action');
        rename.on_click({} as never);
        expect(on_rename).toHaveBeenCalledOnce();
    });

    it('validates renamed headers with the same normalized uniqueness rule', () => {
        expect(column_rename_error('', ['Revenue', 'Units'], 0)).toBe('Enter a column name.');
        expect(column_rename_error('  UNITS  ', ['Revenue', 'Units'], 0))
            .toBe('Another column already has that name.');
        expect(column_rename_error('Net Revenue', ['Revenue', 'Units'], 0)).toBeUndefined();
        expect(committed_column_name('  Net\t  Revenue  ')).toBe('Net Revenue');
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
        expect(items.filter(is_action).some((item) => item.shortcut === 'Shift+Alt+A')).toBe(true);
    });

    it('plain sort replaces while Shift-click and explicit Add append', () => {
        const props = { ...base(), any_sorted: true, other_columns_sorted: true };
        const items = column_context_menu_items(props);
        const ascending = items.filter(is_action).find((item) => item.label === 'Sort ascending');
        const add = items.filter(is_action).find((item) => item.label === 'Add descending to sort');
        if (!ascending || !add) {
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

describe('column structure items', () => {
    const item = (label: string) => ({ label, on_click: vi.fn() });
    const structure = {
        insert: [item('Insert 2 columns left'), item('Insert 2 columns right')],
        delete: [item('Delete 2 columns'), item('Restore column')],
        move: [item('Move columns left'), item('Move columns right')],
    };

    const shape = (items: MenuItem[]) => items.map((entry) => entry.kind === 'separator'
        ? '|'
        : entry.kind === 'submenu'
            ? `${entry.label} > ${entry.items.map((sub) => sub.kind === 'separator' ? '|' : sub.label).join(', ')}`
            : entry.label);

    it('puts the structure items last, with Insert and Move in submenus, in both header menus', () => {
        const single = column_context_menu_items({
            ...base(),
            hide_disabled_reason: 'Save the new column to hide it.',
            structure,
        });
        expect(shape(single)).toEqual([
            'Copy column', 'Hide column', '|', 'Sort ascending', 'Sort descending', '|', 'Filter…',
            '|', 'Insert > Insert 2 columns left, Insert 2 columns right',
            'Delete 2 columns', 'Restore column',
            'Move > Move columns left, Move columns right',
        ]);
        expect(single[1]).toMatchObject({ disabled: true, disabled_reason: 'Save the new column to hide it.' });
        const multi = multi_column_context_menu_items({
            column_count: 2,
            transform_sections: true,
            transform_disabled: false,
            on_copy: vi.fn(),
            on_hide: vi.fn(),
            structure,
            on_sort: vi.fn(),
        });
        expect(shape(multi)).toEqual([
            'Copy 2 columns', 'Hide 2 columns', '|', 'Sort ascending', 'Sort descending',
            '|', 'Insert > Insert 2 columns left, Insert 2 columns right',
            'Delete 2 columns', 'Restore column',
            'Move > Move columns left, Move columns right',
        ]);
        const insert = multi.at(-4);
        expect(insert?.kind === 'submenu' ? insert.items : undefined).toEqual(structure.insert);
    });

    it('keeps the structure items where the sort and filter sections are left out', () => {
        const props = { ...base(), transform_sections: false, structure };
        expect(shape(column_context_menu_items(props))).toEqual([
            'Copy column', 'Hide column',
            '|', 'Insert > Insert 2 columns left, Insert 2 columns right',
            'Delete 2 columns', 'Restore column',
            'Move > Move columns left, Move columns right',
        ]);
        expect(shape(multi_column_context_menu_items({
            column_count: 2,
            transform_sections: false,
            transform_disabled: false,
            on_copy: vi.fn(),
            on_hide: vi.fn(),
            structure,
            on_sort: vi.fn(),
        })).slice(2)).toEqual(shape(column_context_menu_items(props)).slice(2));
    });

    it('leaves out an empty Insert or Move submenu', () => {
        const items = column_context_menu_items({
            ...base(),
            transform_sections: false,
            structure: { insert: [], delete: structure.delete, move: [] },
        });
        expect(shape(items)).toEqual([
            'Copy column', 'Hide column', '|', 'Delete 2 columns', 'Restore column',
        ]);
    });
});
