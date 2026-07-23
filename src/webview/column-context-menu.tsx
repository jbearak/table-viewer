import React from 'react';
import {
    ContextMenu,
    type ActionMenuItem,
    type MenuSeparator,
} from './context-menu';
import type { SortDirection } from '../types';

export interface ColumnContextMenuProps {
    x: number;
    y: number;
    column_name: string;
    transform_sections: boolean;
    transform_disabled: boolean;
    active_direction: SortDirection | null;
    any_sorted: boolean;
    other_columns_sorted: boolean;
    has_filter: boolean;
    any_filtered: boolean;
    on_copy: () => void;
    on_hide: () => void;
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
        { label: 'Hide column', on_click: () => props.on_hide() },
    ];
    if (!props.transform_sections) return items;
    items.push(
        { kind: 'separator' },
        {
            label: 'Sort ascending',
            checked: props.active_direction === 'asc',
            shortcut: 'Shift+Alt+A',
            disabled: props.transform_disabled,
            on_click: (event) => props.on_sort('asc', event.shiftKey),
        },
        {
            label: 'Sort descending',
            checked: props.active_direction === 'desc',
            shortcut: 'Shift+Alt+D',
            disabled: props.transform_disabled,
            on_click: (event) => props.on_sort('desc', event.shiftKey),
        },
    );
    if (props.other_columns_sorted && props.active_direction === null) {
        items.push(
            { kind: 'separator' },
            {
                label: 'Add ascending to sort',
                disabled: props.transform_disabled,
                on_click: () => props.on_sort('asc', true),
            },
            {
                label: 'Add descending to sort',
                disabled: props.transform_disabled,
                on_click: () => props.on_sort('desc', true),
            },
        );
    }
    if (props.active_direction !== null) {
        items.push({
            label: 'Clear sort on this column',
            disabled: props.transform_disabled,
            on_click: () => props.on_clear_column_sort(),
        });
    }
    if (props.any_sorted) {
        items.push({
            label: 'Clear all sorts',
            shortcut: 'Shift+Alt+0',
            disabled: props.transform_disabled,
            on_click: () => props.on_clear_all_sorts(),
        });
    }
    items.push(
        { kind: 'separator' },
        {
            label: props.has_filter ? 'Edit filter…' : 'Filter…',
            shortcut: 'Shift+Alt+F',
            disabled: props.transform_disabled,
            on_click: () => props.on_edit_filter(),
        },
    );
    if (props.has_filter) {
        items.push({
            label: 'Clear filter on this column',
            shortcut: 'Shift+Alt+X',
            disabled: props.transform_disabled,
            on_click: () => props.on_clear_column_filter(),
        });
    }
    if (props.any_filtered) {
        items.push({
            label: 'Clear all filters',
            shortcut: 'Shift+Alt+9',
            disabled: props.transform_disabled,
            on_click: () => props.on_clear_all_filters(),
        });
    }
    return items;
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
