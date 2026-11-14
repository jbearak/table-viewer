import React from 'react';
import {
    ContextMenu,
    type ActionMenuItem,
    type MenuSeparator,
} from './context-menu';
import type { SortDirection } from '../types';
import type { SheetMeta } from '../data-source/interface';
import type { StructureMenuAction } from './row-context-menu';

/** Insert, Delete, Restore, and Move for a column selection, in an editable file. */
export interface ColumnStructureMenuActions {
    readonly insert_left: StructureMenuAction;
    readonly insert_right: StructureMenuAction;
    readonly delete: StructureMenuAction;
    /** Offered when the selection includes a Pending Column Removal. */
    readonly restore?: StructureMenuAction;
    readonly move_left: StructureMenuAction;
    readonly move_right: StructureMenuAction;
}

function column_structure_item(label: string, action: StructureMenuAction): ActionMenuItem {
    return {
        label,
        on_click: () => action.on_click?.(),
        ...(action.on_click === undefined
            ? {
                disabled: true,
                ...(action.disabled_reason === undefined ? {} : { disabled_reason: action.disabled_reason }),
            }
            : {}),
    };
}

function counted(verb: string, count: number, side?: string): string {
    const n = Math.max(1, count);
    const columns = n === 1 ? `${verb} column` : `${verb} ${n} columns`;
    return side === undefined ? columns : `${columns} ${side}`;
}

/** "Insert column left" and "Insert column right", labeled for the selection's count. */
export function column_insert_menu_items(actions: ColumnStructureMenuActions): ActionMenuItem[] {
    return [
        column_structure_item(counted('Insert', actions.insert_left.count, 'left'), actions.insert_left),
        column_structure_item(counted('Insert', actions.insert_right.count, 'right'), actions.insert_right),
    ];
}

/** "Delete column", and "Restore column" when the selection includes a removal. */
export function column_delete_menu_items(actions: ColumnStructureMenuActions): ActionMenuItem[] {
    return [
        column_structure_item(counted('Delete', actions.delete.count), actions.delete),
        ...(actions.restore === undefined
            ? []
            : [column_structure_item(counted('Restore', actions.restore.count), actions.restore)]),
    ];
}

/** The structure items, in menu order: Insert, Delete, Restore, Move. */
export function column_structure_menu_items(actions: ColumnStructureMenuActions): ActionMenuItem[] {
    return [
        ...column_insert_menu_items(actions),
        ...column_delete_menu_items(actions),
        column_structure_item('Move columns left', actions.move_left),
        column_structure_item('Move columns right', actions.move_right),
    ];
}

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
    /** Insert, Delete, Restore, and Move, in an editable file with structural editing on. */
    structure?: ColumnStructureMenuActions;
    on_sort: (direction: SortDirection, append: boolean) => void;
    on_clear_column_sort: () => void;
    on_clear_all_sorts: () => void;
    on_edit_filter: () => void;
    on_clear_column_filter: () => void;
    on_clear_all_filters: () => void;
    on_dismiss: () => void;
    restore_focus: () => void;
}

export function column_context_menu_items(
    props: Omit<ColumnContextMenuProps, 'x' | 'y' | 'on_dismiss' | 'restore_focus'>,
): (ActionMenuItem | MenuSeparator)[] {
    const items: (ActionMenuItem | MenuSeparator)[] = [
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
    if (props.structure !== undefined) {
        items.push({ kind: 'separator' }, ...column_structure_menu_items(props.structure));
    }
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
    /** Insert, Delete, Restore, and Move, in an editable file with structural editing on. */
    structure?: ColumnStructureMenuActions;
    on_sort: (direction: SortDirection) => void;
    on_dismiss: () => void;
    restore_focus: () => void;
}

export function multi_column_context_menu_items(
    props: Omit<MultiColumnContextMenuProps, 'x' | 'y' | 'on_dismiss' | 'restore_focus'>,
): (ActionMenuItem | MenuSeparator)[] {
    const count = Math.max(2, props.column_count);
    const hide = hide_columns_menu_item(count, props.on_hide);
    const items: (ActionMenuItem | MenuSeparator)[] = [
        { label: `Copy ${count} columns`, on_click: () => props.on_copy() },
        props.hide_disabled_reason === undefined
            ? hide
            : { ...hide, disabled: true, disabled_reason: props.hide_disabled_reason },
    ];
    if (props.structure !== undefined) {
        items.push({ kind: 'separator' }, ...column_structure_menu_items(props.structure));
    }
    if (!props.transform_sections) return items;
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
