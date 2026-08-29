import type { CellHighlightColor } from '../types';
import type { MenuItem } from './context-menu';
import { CELL_HIGHLIGHT_COLORS } from './highlight-theme';
import { hide_rows_menu_item } from './row-context-menu';
import { hide_columns_menu_item } from './column-context-menu';

export interface CellContextMenuModelProps {
    dirty: boolean;
    /** Number of connected dirty cells the discard action removes. */
    discard_edit_cell_count: number;
    has_distinct_copy_selection: boolean;
    preview_mode: boolean;
    can_hide_rows: boolean;
    selected_row_count: number;
    selected_column_count: number;
    can_clear_highlight: boolean;
    highlight_cell_count: number;
    /** Set when the cell carries a valid external hyperlink. */
    on_open_link?: () => void;
    /** Set alongside `on_open_link`: copy the link's URL to the clipboard. */
    on_copy_link?: () => void;
    /** Set when this cell's hyperlink is editable (Edit mode, resolved source
     *  identity, a sheet whose format carries links). Opens the dialog. */
    on_edit_hyperlink?: () => void;
    /** True when the cell already has a link, which only changes the wording:
     *  the dialog itself handles both adding and clearing. */
    has_hyperlink?: boolean;
    on_discard_edit: () => void;
    on_copy_cell: () => void;
    on_copy_selection: () => void;
    on_highlight: (color: CellHighlightColor) => void;
    on_clear_highlight: () => void;
    on_hide_rows: () => void;
    on_hide_columns: () => void;
    on_select_row: () => void;
    on_select_column: () => void;
    on_select_all: () => void;
}

interface CellSelectionRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface MergedCellBounds {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
}

/** Whether copying the selection differs from copying its active cell. */
export function has_distinct_copy_selection(
    range: CellSelectionRect | undefined,
    active_merge: MergedCellBounds | null,
): boolean {
    if (!range || range.width * range.height <= 1) return false;
    if (!active_merge) return true;
    return range.x !== active_merge.startCol
        || range.y !== active_merge.startRow
        || range.width !== active_merge.endCol - active_merge.startCol + 1
        || range.height !== active_merge.endRow - active_merge.startRow + 1;
}

export function cell_context_menu_items(props: CellContextMenuModelProps): MenuItem[] {
    const items: MenuItem[] = [];
    const { on_open_link, on_copy_link } = props;
    if (on_open_link) {
        items.push({ label: 'Open link', on_click: () => on_open_link() });
    }
    if (on_copy_link) {
        items.push({ label: 'Copy link', on_click: () => on_copy_link() });
    }
    if (props.dirty) {
        items.push({
            label: props.discard_edit_cell_count > 1
                ? 'Discard all pending edits in '
                    + props.discard_edit_cell_count
                    + ' related cells'
                : 'Discard edit',
            on_click: () => props.on_discard_edit(),
        });
    }
    if (!props.preview_mode) {
        if (items.length > 0) items.push({ kind: 'separator' });
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
    if (items.length > 0) items.push({ kind: 'separator' });
    items.push(props.has_distinct_copy_selection
        ? { label: 'Copy selection', on_click: () => props.on_copy_selection() }
        : { label: 'Copy cell', on_click: () => props.on_copy_cell() });

    const hide_items: MenuItem[] = [];
    if (props.can_hide_rows) {
        hide_items.push(hide_rows_menu_item(props.selected_row_count, props.on_hide_rows));
    }
    hide_items.push(
        hide_columns_menu_item(props.selected_column_count, props.on_hide_columns),
    );
    items.push(
        { kind: 'separator' },
        {
            kind: 'submenu',
            label: 'Select',
            items: [
                { label: 'Select row', on_click: () => props.on_select_row() },
                { label: 'Select column', on_click: () => props.on_select_column() },
                { label: 'Select all', on_click: () => props.on_select_all() },
            ],
        },
        { kind: 'submenu', label: 'Hide', items: hide_items },
    );
    if (props.on_edit_hyperlink) {
        const on_edit_hyperlink = props.on_edit_hyperlink;
        items.push(
            { kind: 'separator' },
            {
                label: props.has_hyperlink ? 'Edit hyperlink…' : 'Hyperlink…',
                on_click: () => on_edit_hyperlink(),
            },
        );
    }
    return items;
}
