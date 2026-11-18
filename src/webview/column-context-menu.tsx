import React from 'react';
import {
    ContextMenu,
    type ActionMenuItem,
    type MenuItem,
} from './context-menu';
import type { SortDirection } from '../types';
import type { SheetMeta } from '../data-source/interface';
import type { StructureMenuItems } from './structure-menu';

/** Merged children can inherit a displayed header but are not editable cells. */
export function header_column_can_be_renamed(sheet: SheetMeta, column: number): boolean {
    if (sheet.excelFirstRowHeader?.active !== true) return false;
    if (sheet.columnHeaderEditable !== undefined) {
        return sheet.columnHeaderEditable[column] === true;
    }
    const edit_text = sheet.columnHeaderEditTexts?.[column];
    const displayed_name = sheet.columnNames?.[column];
    return edit_text !== undefined && (edit_text !== '' || displayed_name === '');
}

function transform_item_state(props: {
    readonly transform_disabled: boolean;
    readonly transform_disabled_reason?: string;
}): { disabled: boolean; disabled_reason?: string } {
    return props.transform_disabled && props.transform_disabled_reason !== undefined
        ? { disabled: true, disabled_reason: props.transform_disabled_reason }
        : { disabled: props.transform_disabled };
}

export interface ColumnContextMenuProps {
    x: number;
    y: number;
    column_name: string;
    transform_sections: boolean;
    transform_disabled: boolean;
    /** Why the sort and filter items are disabled, shown as their description. */
    transform_disabled_reason?: string;
    active_direction: SortDirection | null;
    any_sorted: boolean;
    other_columns_sorted: boolean;
    has_filter: boolean;
    any_filtered: boolean;
    on_copy: () => void;
    on_hide: () => void;
    /** Why "Hide column" is disabled (a Pending Column cannot be hidden). */
    hide_disabled_reason?: string;
    on_rename?: () => void;
    rename_disabled?: boolean;
    /** Why "Rename column…" is disabled, shown as its description. */
    rename_disabled_reason?: string;
    /** Insert, Delete, Restore, and Move, where the worksheet's columns can be restructured. */
    structure?: StructureMenuItems;
    on_sort: (direction: SortDirection, append: boolean) => void;
    on_clear_column_sort: () => void;
    on_clear_all_sorts: () => void;
    on_edit_filter: () => void;
    on_clear_column_filter: () => void;
    on_clear_all_filters: () => void;
    on_dismiss: () => void;
    restore_focus: () => void;
}

/**
 * The structure section, last in the column menus so the everyday items lead:
 * a separator, then Insert and Move folded into submenus around Delete and
 * Restore, as in the row menu.
 */
function structure_section(structure: StructureMenuItems | undefined): MenuItem[] {
    if (structure === undefined) return [];
    const items: MenuItem[] = [];
    if (structure.insert.length > 0) {
        items.push({ kind: 'submenu', label: 'Insert', items: [...structure.insert] });
    }
    items.push(...structure.delete);
    if (structure.move.length > 0) {
        items.push({ kind: 'submenu', label: 'Move', items: [...structure.move] });
    }
    return items.length > 0 ? [{ kind: 'separator' }, ...items] : [];
}

/**
 * The column menu, most-used first: Copy, Hide, and Rename; then Sort and
 * Filter; then, past a separator, the structure items.
 */
export function column_context_menu_items(
    props: Omit<ColumnContextMenuProps, 'x' | 'y' | 'on_dismiss' | 'restore_focus'>,
): MenuItem[] {
    return [...column_menu_lead_and_transforms(props), ...structure_section(props.structure)];
}

function column_menu_lead_and_transforms(
    props: Omit<ColumnContextMenuProps, 'x' | 'y' | 'on_dismiss' | 'restore_focus'>,
): MenuItem[] {
    const items: MenuItem[] = [
        { label: 'Copy column', on_click: () => props.on_copy() },
        {
            label: 'Hide column',
            on_click: () => props.on_hide(),
            ...(props.hide_disabled_reason === undefined
                ? {}
                : { disabled: true, disabled_reason: props.hide_disabled_reason }),
        },
    ];
    if (props.on_rename) items.push({
        label: 'Rename column…',
        on_click: props.on_rename,
        disabled: props.rename_disabled,
        ...(props.rename_disabled && props.rename_disabled_reason !== undefined
            ? { disabled_reason: props.rename_disabled_reason }
            : {}),
    });
    if (!props.transform_sections) return items;
    items.push(
        { kind: 'separator' },
        {
            label: 'Sort ascending',
            checked: props.active_direction === 'asc',
            shortcut: 'Shift+Alt+A',
            ...transform_item_state(props),
            on_click: (event) => props.on_sort('asc', event.shiftKey),
        },
        {
            label: 'Sort descending',
            checked: props.active_direction === 'desc',
            shortcut: 'Shift+Alt+D',
            ...transform_item_state(props),
            on_click: (event) => props.on_sort('desc', event.shiftKey),
        },
    );
    if (props.other_columns_sorted && props.active_direction === null) {
        items.push(
            { kind: 'separator' },
            {
                label: 'Add ascending to sort',
                ...transform_item_state(props),
                on_click: () => props.on_sort('asc', true),
            },
            {
                label: 'Add descending to sort',
                ...transform_item_state(props),
                on_click: () => props.on_sort('desc', true),
            },
        );
    }
    if (props.active_direction !== null) {
        items.push({
            label: 'Clear sort on this column',
            ...transform_item_state(props),
            on_click: () => props.on_clear_column_sort(),
        });
    }
    if (props.any_sorted) {
        items.push({
            label: 'Clear all sorts',
            shortcut: 'Shift+Alt+0',
            ...transform_item_state(props),
            on_click: () => props.on_clear_all_sorts(),
        });
    }
    items.push(
        { kind: 'separator' },
        {
            label: props.has_filter ? 'Edit filter…' : 'Filter…',
            shortcut: 'Shift+Alt+F',
            ...transform_item_state(props),
            on_click: () => props.on_edit_filter(),
        },
    );
    if (props.has_filter) {
        items.push({
            label: 'Clear filter on this column',
            shortcut: 'Shift+Alt+X',
            ...transform_item_state(props),
            on_click: () => props.on_clear_column_filter(),
        });
    }
    if (props.any_filtered) {
        items.push({
            label: 'Clear all filters',
            shortcut: 'Shift+Alt+9',
            ...transform_item_state(props),
            on_click: () => props.on_clear_all_filters(),
        });
    }
    return items;
}

/** Shared hide-column(s) action so the cell and header menus can't drift apart. */
export function hide_columns_menu_item(
    selected_column_count: number,
    on_hide_columns: () => void,
): ActionMenuItem {
    const count = Math.max(1, selected_column_count);
    return {
        label: count === 1 ? 'Hide column' : `Hide ${count} columns`,
        on_click: () => on_hide_columns(),
    };
}

export interface MultiColumnContextMenuProps {
    x: number;
    y: number;
    column_count: number;
    transform_sections: boolean;
    transform_disabled: boolean;
    /** Why the sort items are disabled, shown as their description. */
    transform_disabled_reason?: string;
    on_copy: () => void;
    on_hide: () => void;
    /** Why "Hide N columns" is disabled (the selection holds a Pending Column). */
    hide_disabled_reason?: string;
    /** Insert, Delete, Restore, and Move, where the worksheet's columns can be restructured. */
    structure?: StructureMenuItems;
    on_sort: (direction: SortDirection) => void;
    on_dismiss: () => void;
    restore_focus: () => void;
}

export function multi_column_context_menu_items(
    props: Omit<MultiColumnContextMenuProps, 'x' | 'y' | 'on_dismiss' | 'restore_focus'>,
): MenuItem[] {
    const count = Math.max(2, props.column_count);
    const hide = hide_columns_menu_item(count, props.on_hide);
    const items: MenuItem[] = [
        { label: `Copy ${count} columns`, on_click: () => props.on_copy() },
        props.hide_disabled_reason === undefined
            ? hide
            : { ...hide, disabled: true, disabled_reason: props.hide_disabled_reason },
    ];
    if (props.transform_sections) {
        items.push(
            { kind: 'separator' },
            {
                label: 'Sort ascending',
                ...transform_item_state(props),
                on_click: () => props.on_sort('asc'),
            },
            {
                label: 'Sort descending',
                ...transform_item_state(props),
                on_click: () => props.on_sort('desc'),
            },
        );
    }
    items.push(...structure_section(props.structure));
    return items;
}

export function MultiColumnContextMenu(props: MultiColumnContextMenuProps): React.JSX.Element {
    return (
        <ContextMenu
            x={props.x}
            y={props.y}
            aria_label={`Column actions for ${Math.max(2, props.column_count)} selected columns`}
            items={multi_column_context_menu_items(props)}
            on_dismiss={props.on_dismiss}
            restore_focus={props.restore_focus}
        />
    );
}

export function ColumnContextMenu(props: ColumnContextMenuProps): React.JSX.Element {
    return (
        <ContextMenu
            x={props.x}
            y={props.y}
            aria_label={`Column actions for ${props.column_name}`}
            items={column_context_menu_items(props)}
            on_dismiss={props.on_dismiss}
            restore_focus={props.restore_focus}
        />
    );
}
