/**
 * The row-gutter menu model: which items a row selection offers, enabled or
 * disabled with the reason. Pure, so the menu's rules are testable apart
 * from the grid that opens it.
 */

import type { MenuItem } from './context-menu';

/** One structure item: the rows it names, and its action or why it is disabled. */
export interface StructureMenuAction {
    /** N in "Delete N rows". */
    readonly count: number;
    /** Absent when the item is disabled. */
    readonly on_click?: () => void;
    /** Shown as the disabled item's accessible description and tooltip. */
    readonly disabled_reason?: string;
}

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
    /**
     * Delete row(s), offered in Edit mode when structural editing is on. It
     * replaces "Remove pending row(s)", whose props are then ignored.
     */
    delete_rows?: StructureMenuAction;
    /** Restore row(s), offered when the selection includes Pending Row Removals. */
    restore_rows?: StructureMenuAction;
}

function structure_item(verb: 'Delete' | 'Restore', action: StructureMenuAction): MenuItem {
    const count = Math.max(1, action.count);
    return {
        label: count === 1 ? `${verb} row` : `${verb} ${count} rows`,
        on_click: () => action.on_click?.(),
        ...(action.on_click === undefined
            ? {
                disabled: true,
                ...(action.disabled_reason === undefined
                    ? {}
                    : { disabled_reason: action.disabled_reason }),
            }
            : {}),
    };
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
    if (props.delete_rows !== undefined) {
        items.push(structure_item('Delete', props.delete_rows));
        if (props.restore_rows !== undefined) {
            items.push(structure_item('Restore', props.restore_rows));
        }
    } else if (props.on_remove_pending_rows || props.show_disabled_remove_pending_rows) {
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
