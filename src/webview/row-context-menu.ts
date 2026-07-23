import type { MenuItem } from './context-menu';

export interface RowContextMenuModelProps {
    selected_row_count: number;
    can_hide_rows: boolean;
    on_hide_rows: () => void;
    on_copy_rows: () => void;
}

export function row_context_menu_items(props: RowContextMenuModelProps): MenuItem[] {
    const selected_row_count = Math.max(1, props.selected_row_count);
    const items: MenuItem[] = [];
    if (props.can_hide_rows) {
        items.push({
            label: selected_row_count === 1 ? 'Hide row' : `Hide ${selected_row_count} rows`,
            on_click: () => props.on_hide_rows(),
        });
    }
    items.push({
        label: selected_row_count === 1 ? 'Copy row' : `Copy ${selected_row_count} rows`,
        on_click: () => props.on_copy_rows(),
    });
    return items;
}
