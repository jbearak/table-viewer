/**
 * The row-gutter menu model: which items a row selection offers, enabled or
 * disabled with the reason. Pure, so the menu's rules are testable apart
 * from the grid that opens it.
 */

import type { MenuItem } from './context-menu';
import type { StructureMenuItems } from './structure-menu';

export interface RowContextMenuModelProps {
    selected_row_count: number;
    can_hide_rows: boolean;
    show_disabled_hide_rows?: boolean;
    /** Why "Hide row(s)" is disabled, when it is shown disabled. */
    hide_rows_disabled_reason?: string;
    can_promote_row_to_header: boolean;
    /** Shown but not yet admitted: the session the menu acquires is on its way. */
    promote_row_disabled?: boolean;
    on_hide_rows: () => void;
    /**
     * Remove the custom height of the saved rows the menu acts on. Present
     * when at least one of them shows a custom height.
     */
    on_reset_row_heights?: () => void;
    /** How many of those rows show a custom height: the rows the reset changes. */
    reset_row_count?: number;
    /**
     * Fit the menu's rows to their content, as a double-click on a row border
     * does. Present when at least one of them can be fitted.
     */
    on_auto_fit_rows?: () => void;
    on_promote_row_to_header: () => void;
    on_copy_rows: () => void;
    pending_row_count?: number;
    on_remove_pending_rows?: () => void;
    show_disabled_remove_pending_rows?: boolean;
    on_cancel_row_removals?: () => void;
    /**
     * Insert, Delete, Restore, and Move, offered where the worksheet's rows
     * can be restructured. They replace "Remove pending row(s)", whose props
     * are then ignored.
     */
    structure?: StructureMenuItems;
}

/** Shared hide-row(s) action so the cell and row menus can't drift apart. */
export function hide_rows_menu_item(
    selected_row_count: number,
    on_hide_rows: () => void,
    disabled = false,
    disabled_reason?: string,
): MenuItem {
    const count = Math.max(1, selected_row_count);
    return {
        label: count === 1 ? 'Hide row' : `Hide ${count} rows`,
        on_click: () => on_hide_rows(),
        ...(disabled
            ? { disabled: true, ...(disabled_reason === undefined ? {} : { disabled_reason }) }
            : {}),
    };
}

/**
 * The row menu, most-used first: "Use row as header", Hide, Reset height, and
 * Copy; then, past a separator, the structure items, with Insert and Move
 * folded into submenus so the menu stays short.
 */
export function row_context_menu_items(props: RowContextMenuModelProps): MenuItem[] {
    const selected_row_count = Math.max(1, props.selected_row_count);
    const items: MenuItem[] = [];
    if (props.can_promote_row_to_header) {
        items.push({
            label: 'Use row as header',
            on_click: () => props.on_promote_row_to_header(),
            ...(props.promote_row_disabled ? { disabled: true } : {}),
        });
    }
    if (props.can_hide_rows || props.show_disabled_hide_rows) {
        items.push(hide_rows_menu_item(
            selected_row_count,
            props.on_hide_rows,
            !props.can_hide_rows,
            props.hide_rows_disabled_reason,
        ));
    }
    if (props.on_reset_row_heights !== undefined) {
        const reset_row_count = Math.max(1, props.reset_row_count ?? selected_row_count);
        items.push({
            label: reset_row_count === 1
                ? 'Reset row height'
                : `Reset ${reset_row_count} row heights`,
            on_click: () => props.on_reset_row_heights?.(),
        });
    }
    if (props.on_auto_fit_rows !== undefined) {
        items.push({
            label: selected_row_count === 1
                ? 'Auto-fit row height'
                : `Auto-fit ${selected_row_count} row heights`,
            on_click: () => props.on_auto_fit_rows?.(),
        });
    }
    items.push({
        label: selected_row_count === 1 ? 'Copy row' : `Copy ${selected_row_count} rows`,
        on_click: () => props.on_copy_rows(),
    });

    const edits: MenuItem[] = [];
    const { structure } = props;
    if (structure !== undefined) {
        if (structure.insert.length > 0) {
            edits.push({ kind: 'submenu', label: 'Insert', items: [...structure.insert] });
        }
        edits.push(...structure.delete);
        if (structure.move.length > 0) {
            edits.push({ kind: 'submenu', label: 'Move', items: [...structure.move] });
        }
    } else if (props.on_remove_pending_rows || props.show_disabled_remove_pending_rows) {
        const pending_row_count = Math.max(
            1,
            props.pending_row_count ?? selected_row_count,
        );
        edits.push({
            label: pending_row_count === 1
                ? 'Remove pending row'
                : `Remove ${pending_row_count} pending rows`,
            on_click: () => props.on_remove_pending_rows?.(),
            ...(props.on_remove_pending_rows === undefined ? { disabled: true } : {}),
        });
    }
    if (props.on_cancel_row_removals) {
        edits.push({
            label: selected_row_count === 1
                ? 'Cancel row removal'
                : `Cancel ${selected_row_count} row removals`,
            on_click: () => props.on_cancel_row_removals?.(),
        });
    }
    if (edits.length > 0) items.push({ kind: 'separator' }, ...edits);
    return items;
}
