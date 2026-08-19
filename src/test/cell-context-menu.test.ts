import { describe, expect, it, vi } from 'vitest';
import {
    cell_context_menu_items,
    has_distinct_copy_selection,
} from '../webview/cell-context-menu';
import type { MenuItem } from '../webview/context-menu';

function base() {
    return {
        dirty: false,
        has_distinct_copy_selection: false,
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
            has_distinct_copy_selection: true,
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

describe('copy selection visibility', () => {
    const merged_cell = { startRow: 2, startCol: 3, endRow: 3, endCol: 5 };

    it('omits Copy selection when the expanded range is one merged cell', () => {
        const distinct = has_distinct_copy_selection(
            { x: 3, y: 2, width: 3, height: 2 },
            merged_cell,
        );
        const items = cell_context_menu_items({
            ...base(),
            has_distinct_copy_selection: distinct,
        });
        expect(items.some((item) => item.kind === undefined
            && item.label === 'Copy selection')).toBe(false);
    });

    it('retains Copy selection when a range extends beyond the active merged cell', () => {
        expect(has_distinct_copy_selection(
            { x: 3, y: 2, width: 4, height: 2 },
            merged_cell,
        )).toBe(true);
    });
});

describe('Open link', () => {
    it('is absent without a link callback', () => {
        const items = cell_context_menu_items(base());
        expect(items.some((item) => item.kind !== 'separator' && item.label === 'Open link'))
            .toBe(false);
    });

    it('leads the menu and fires the callback on a linked cell', () => {
        const on_open_link = vi.fn();
        const items = cell_context_menu_items({ ...base(), on_open_link });
        const first = items[0];
        expect(first.kind).toBeUndefined();
        expect(first.kind !== 'separator' && first.kind !== 'submenu' && first.label)
            .toBe('Open link');
        action(items, 'Open link').on_click({} as never);
        expect(on_open_link).toHaveBeenCalledTimes(1);
    });

    it('offers Copy link directly below Open link and fires its callback', () => {
        const on_open_link = vi.fn();
        const on_copy_link = vi.fn();
        const items = cell_context_menu_items({ ...base(), on_open_link, on_copy_link });
        const labels = items
            .filter((item) => item.kind === undefined)
            .map((item) => (item as { label: string }).label);
        expect(labels.indexOf('Copy link')).toBe(labels.indexOf('Open link') + 1);
        action(items, 'Copy link').on_click({} as never);
        expect(on_copy_link).toHaveBeenCalledTimes(1);
        expect(on_open_link).not.toHaveBeenCalled();
    });
});

describe('Hyperlink…', () => {
    it('is absent without the edit callback', () => {
        const items = cell_context_menu_items(base());
        expect(items.some((item) => item.kind === undefined
            && item.label.startsWith('Hyperlink'))).toBe(false);
    });

    it('offers "Hyperlink…" on a linkless cell and fires the callback', () => {
        const on_edit_hyperlink = vi.fn();
        const items = cell_context_menu_items({ ...base(), on_edit_hyperlink });
        action(items, 'Hyperlink…').on_click({} as never);
        expect(on_edit_hyperlink).toHaveBeenCalledTimes(1);
    });

    it('reads "Edit hyperlink…" when the cell already has a link, below Copy link', () => {
        const items = cell_context_menu_items({
            ...base(),
            on_open_link: vi.fn(),
            on_copy_link: vi.fn(),
            on_edit_hyperlink: vi.fn(),
            has_hyperlink: true,
        });
        const labels = items
            .filter((item) => item.kind === undefined)
            .map((item) => (item as { label: string }).label);
        expect(labels.slice(0, 3)).toEqual(['Open link', 'Copy link', 'Edit hyperlink…']);
    });
});
