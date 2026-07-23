import type { CellHighlightColor } from '../types';
import type { MenuItem } from './context-menu';
import { CELL_HIGHLIGHT_COLORS } from './highlight-theme';
import { hide_rows_menu_item } from './row-context-menu';

export interface CellContextMenuModelProps {
    dirty: boolean;
    is_multi_cell: boolean;
    preview_mode: boolean;
    can_hide_rows: boolean;
    selected_row_count: number;
    can_clear_highlight: boolean;
    highlight_cell_count: number;
    on_discard_edit: () => void;
    on_copy_cell: () => void;
    on_copy_selection: () => void;
    on_highlight: (color: CellHighlightColor) => void;
    on_clear_highlight: () => void;
    on_hide_rows: () => void;
    on_hide_column: () => void;
    on_select_row: () => void;
    on_select_column: () => void;
    on_select_all: () => void;
}

export function cell_context_menu_items(props: CellContextMenuModelProps): MenuItem[] {
    const items: MenuItem[] = [];
    if (props.dirty) {
        items.push({ label: 'Discard edit', on_click: () => props.on_discard_edit() });
    }
    items.push({ label: 'Copy cell', on_click: () => props.on_copy_cell() });
    if (props.is_multi_cell) {
        items.push({ label: 'Copy selection', on_click: () => props.on_copy_selection() });
    }
    if (!props.preview_mode) {
        items.push({ kind: 'separator' });
        for (const color of CELL_HIGHLIGHT_COLORS) {
            items.push({
                label: `Highlight ${color}`,
                on_click: () => props.on_highlight(color),
            });
        }
        if (props.can_clear_highlight) {
            items.push({
                label: props.highlight_cell_count === 1
                    ? 'Clear highlight'
                    : 'Clear highlights',
                on_click: () => props.on_clear_highlight(),
            });
        }
    }
    const hide_items: MenuItem[] = [];
    if (props.can_hide_rows) {
        hide_items.push(hide_rows_menu_item(props.selected_row_count, props.on_hide_rows));
    }
    hide_items.push({ label: 'Hide column', on_click: () => props.on_hide_column() });
    items.push(
        { kind: 'separator' },
        { kind: 'submenu', label: 'Hide', items: hide_items },
        {
            kind: 'submenu',
            label: 'Select',
            items: [
                { label: 'Select row', on_click: () => props.on_select_row() },
                { label: 'Select column', on_click: () => props.on_select_column() },
                { label: 'Select all', on_click: () => props.on_select_all() },
            ],
        },
    );
    return items;
}
