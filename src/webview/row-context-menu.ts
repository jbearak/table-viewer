import type { MenuItem } from './context-menu';

export interface RowContextMenuModelProps {
    selected_row_count: number;
    can_hide_rows: boolean;
    show_disabled_hide_rows?: boolean;
    can_promote_row_to_header: boolean;
    on_hide_rows: () => void;
    on_promote_row_to_header: () => void;
    on_copy_rows: () => void;
    pending_row_count?: number;
    on_remove_pending_rows?: () => void;
    show_disabled_remove_pending_rows?: boolean;
    on_cancel_row_removals?: () => void;
}

/** Shared hide-row(s) action so the cell and row menus can't drift apart. */
export function hide_rows_menu_item(
    selected_row_count: number,
    on_hide_rows: () => void,
    disabled = false,
): MenuItem {
    const count = Math.max(1, selected_row_count);
    return {
        label: count === 1 ? 'Hide row' : `Hide ${count} rows`,
        on_click: () => on_hide_rows(),
        ...(disabled ? { disabled: true } : {}),
    };
}

export function row_context_menu_items(props: RowContextMenuModelProps): MenuItem[] {
    const selected_row_count = Math.max(1, props.selected_row_count);
    const items: MenuItem[] = [];
    if (props.can_promote_row_to_header) {
        items.push({
            label: 'Use row as header',
            on_click: () => props.on_promote_row_to_header(),
        });
    }
    if (props.on_remove_pending_rows || props.show_disabled_remove_pending_rows) {
        const pending_row_count = Math.max(
            1,
            props.pending_row_count ?? selected_row_count,
        );
        items.push({
            label: pending_row_count === 1
                ? 'Remove pending row'
                : `Remove ${pending_row_count} pending rows`,
            on_click: () => props.on_remove_pending_rows?.(),
            ...(props.on_remove_pending_rows === undefined ? { disabled: true } : {}),
        });
    }
    if (props.on_cancel_row_removals) {
        items.push({
            label: selected_row_count === 1
                ? 'Cancel row removal'
                : `Cancel ${selected_row_count} row removals`,
            on_click: () => props.on_cancel_row_removals?.(),
        });
    }
    if (props.can_hide_rows || props.show_disabled_hide_rows) {
        items.push(hide_rows_menu_item(
            selected_row_count,
            props.on_hide_rows,
            !props.can_hide_rows,
        ));
    }
    items.push({
        label: selected_row_count === 1 ? 'Copy row' : `Copy ${selected_row_count} rows`,
        on_click: () => props.on_copy_rows(),
    });
    return items;
}
