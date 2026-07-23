import { describe, expect, it, vi } from 'vitest';
import { cell_context_menu_items } from '../webview/cell-context-menu';
import type { MenuItem } from '../webview/context-menu';

function base() {
    return {
        dirty: false,
        is_multi_cell: false,
        preview_mode: false,
        can_hide_rows: true,
        selected_row_count: 1,
        selected_column_count: 1,
        can_clear_highlight: false,
        highlight_cell_count: 0,
        on_discard_edit: vi.fn(),
        on_copy_cell: vi.fn(),
        on_copy_selection: vi.fn(),
        on_highlight: vi.fn(),
        on_clear_highlight: vi.fn(),
        on_hide_rows: vi.fn(),
        on_hide_columns: vi.fn(),
        on_select_row: vi.fn(),
        on_select_column: vi.fn(),
        on_select_all: vi.fn(),
    };
}

function submenu(items: MenuItem[], label: string) {
    const item = items.find((candidate) => candidate.kind === 'submenu' && candidate.label === label);
    if (!item || item.kind !== 'submenu') throw new Error(`missing ${label} submenu`);
    return item.items;
}

function action(items: MenuItem[], label: string) {
    const item = items.find((candidate) => candidate.kind !== 'separator'
        && candidate.kind !== 'submenu' && candidate.label === label);
    if (!item || item.kind === 'separator' || item.kind === 'submenu') {
        throw new Error(`missing ${label} action`);
    }
    return item;
}

describe('cell context menu model', () => {
    it('preserves root actions and groups hide/select actions into submenus', () => {
        const items = cell_context_menu_items({
            ...base(),
            dirty: true,
            is_multi_cell: true,
            can_clear_highlight: true,
            highlight_cell_count: 1,
            selected_row_count: 3,
        });
        expect(items.filter((item) => item.kind !== 'separator').map((item) => item.label))
            .toEqual([
                'Discard edit', 'Copy cell', 'Copy selection',
                'Highlight yellow', 'Highlight green', 'Highlight blue', 'Highlight pink',
                'Clear highlight', 'Hide', 'Select',
            ]);
        expect(submenu(items, 'Hide').map((item) => item.kind === 'separator' ? '' : item.label))
            .toEqual(['Hide 3 rows', 'Hide column']);
        expect(submenu(items, 'Select').map((item) => item.kind === 'separator' ? '' : item.label))
            .toEqual(['Select row', 'Select column', 'Select all']);
    });

    it('shows a count-aware Hide n columns for multi-column selections', () => {
        const items = cell_context_menu_items({
            ...base(),
            selected_row_count: 2,
            selected_column_count: 4,
        });
        expect(submenu(items, 'Hide').map((item) => item.kind === 'separator' ? '' : item.label))
            .toEqual(['Hide 2 rows', 'Hide 4 columns']);
    });

    it('gates row hiding and highlights while always retaining Hide column', () => {
        const items = cell_context_menu_items({
            ...base(),
            preview_mode: true,
            can_hide_rows: false,
        });
        expect(items.some((item) => item.kind !== 'separator'
            && item.label.startsWith('Highlight '))).toBe(false);
        expect(submenu(items, 'Hide').map((item) => item.kind === 'separator' ? '' : item.label))
            .toEqual(['Hide column']);
    });

    it('wires submenu callbacks', () => {
        const props = { ...base() };
        const items = cell_context_menu_items(props);
        action(submenu(items, 'Hide'), 'Hide row').on_click({} as never);
        action(submenu(items, 'Hide'), 'Hide column').on_click({} as never);
        action(submenu(items, 'Select'), 'Select all').on_click({} as never);
        expect(props.on_hide_rows).toHaveBeenCalledOnce();
        expect(props.on_hide_columns).toHaveBeenCalledOnce();
        expect(props.on_select_all).toHaveBeenCalledOnce();
    });
});
