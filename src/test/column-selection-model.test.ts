import { describe, expect, it, vi } from 'vitest';
import { CompactSelection, type GridSelection } from '@glideapps/glide-data-grid';
import {
    grid_selection_contains_column,
    header_drag_columns,
    header_drag_state_for_selection,
    selected_display_columns,
    selected_source_columns,
} from '../webview/column-selection-model';
import {
    multi_column_context_menu_items,
} from '../webview/column-context-menu';

function selection_of(columns: CompactSelection): GridSelection {
    return { columns, rows: CompactSelection.empty() };
}

describe('header_drag_columns', () => {
    it('unions the anchor→hover range onto the base selection', () => {
        const drag = { anchor: 2, base: CompactSelection.fromSingleSelection(2) };
        expect(header_drag_columns(drag, 5, 10).toArray()).toEqual([2, 3, 4, 5]);
        expect(header_drag_columns(drag, 0, 10).toArray()).toEqual([0, 1, 2]);
    });

    it('shrinking the sweep drops columns only covered by the wider sweep', () => {
        const drag = { anchor: 2, base: CompactSelection.fromSingleSelection(2) };
        header_drag_columns(drag, 6, 10);
        expect(header_drag_columns(drag, 3, 10).toArray()).toEqual([2, 3]);
    });

    it('keeps pre-existing cmd-click columns in the base selection', () => {
        const base = CompactSelection.fromSingleSelection(0).add(4);
        const drag = { anchor: 4, base };
        expect(header_drag_columns(drag, 6, 10).toArray()).toEqual([0, 4, 5, 6]);
    });

    it('clamps the hovered column to the display range', () => {
        const drag = { anchor: 8, base: CompactSelection.fromSingleSelection(8) };
        expect(header_drag_columns(drag, 42, 10).toArray()).toEqual([8, 9]);
        expect(header_drag_columns(drag, -3, 10).toArray())
            .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });
});

describe('header_drag_state_for_selection', () => {
    it('anchors on the newly added column after a plain click', () => {
        const state = header_drag_state_for_selection(
            CompactSelection.empty(),
            CompactSelection.fromSingleSelection(3),
        );
        expect(state?.anchor).toBe(3);
    });

    it('anchors on the toggled-in column after a cmd/ctrl-click', () => {
        const previous = CompactSelection.fromSingleSelection(1);
        const next = previous.add(4);
        const state = header_drag_state_for_selection(previous, next);
        expect(state?.anchor).toBe(4);
        expect(state?.base.toArray()).toEqual([1, 4]);
    });

    it('falls back to the sole selected column when a re-click adds nothing', () => {
        const only = CompactSelection.fromSingleSelection(2);
        expect(header_drag_state_for_selection(only, only)?.anchor).toBe(2);
    });

    it('returns null when a shift-click adds a multi-column range', () => {
        const state = header_drag_state_for_selection(
            CompactSelection.fromSingleSelection(1),
            CompactSelection.fromSingleSelection([1, 5]),
        );
        expect(state).toBeNull();
    });

    it('returns null when a cmd/ctrl-click toggles a column off', () => {
        const previous = CompactSelection.fromSingleSelection(1).add(4).add(7);
        const state = header_drag_state_for_selection(previous, previous.remove(4));
        expect(state).toBeNull();
    });
});

describe('grid_selection_contains_column', () => {
    it('reports membership of the explicit column selection', () => {
        const selection = selection_of(CompactSelection.fromSingleSelection([2, 5]));
        expect(grid_selection_contains_column(selection, 3)).toBe(true);
        expect(grid_selection_contains_column(selection, 5)).toBe(false);
    });
});

describe('selected_display_columns', () => {
    it('prefers the explicit header selection', () => {
        const selection = selection_of(
            CompactSelection.fromSingleSelection([1, 3]).add(6),
        );
        expect(selected_display_columns(selection, 10)).toEqual([1, 2, 6]);
    });

    it('falls back to the current cell range plus range stack', () => {
        const selection: GridSelection = {
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
            current: {
                cell: [2, 0],
                range: { x: 2, y: 0, width: 2, height: 5 },
                rangeStack: [{ x: 6, y: 1, width: 1, height: 1 }],
            },
        };
        expect(selected_display_columns(selection, 10)).toEqual([2, 3, 6]);
    });

    it('clamps ranges to the display column count', () => {
        const selection: GridSelection = {
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
            current: {
                cell: [3, 0],
                range: { x: 3, y: 0, width: 99, height: 1 },
                rangeStack: [],
            },
        };
        expect(selected_display_columns(selection, 5)).toEqual([3, 4]);
    });

    it('returns empty with no columns or current range', () => {
        expect(selected_display_columns(selection_of(CompactSelection.empty()), 5))
            .toEqual([]);
    });
});

describe('selected_source_columns', () => {
    it('maps display columns to source columns in display order', () => {
        const selection = selection_of(
            CompactSelection.fromSingleSelection(0).add([3, 5]),
        );
        const map = [10, 11, 12, 13, 14];
        const result = selected_source_columns(selection, (d) => map[d]);
        expect(result.display_cols).toEqual([0, 3, 4]);
        expect(result.source_cols).toEqual([10, 13, 14]);
    });

    it('drops display columns without a source mapping', () => {
        const selection = selection_of(CompactSelection.fromSingleSelection([0, 3]));
        const result = selected_source_columns(
            selection,
            (d) => (d === 1 ? undefined : d + 20),
        );
        expect(result.display_cols).toEqual([0, 2]);
        expect(result.source_cols).toEqual([20, 22]);
    });
});

describe('multi column context menu model', () => {
    function base() {
        return {
            column_count: 3,
            transform_sections: true,
            transform_disabled: false,
            on_copy: vi.fn(),
            on_hide: vi.fn(),
            on_sort: vi.fn(),
        };
    }

    function labels(items: ReturnType<typeof multi_column_context_menu_items>): string[] {
        return items.flatMap((item) => item.kind === 'separator' ? [] : [item.label]);
    }

    it('shows count-aware copy/hide plus sort actions', () => {
        const items = multi_column_context_menu_items(base());
        expect(labels(items)).toEqual([
            'Copy 3 columns',
            'Hide 3 columns',
            'Sort ascending',
            'Sort descending',
        ]);
    });

    it('omits sort actions when transform sections are unavailable', () => {
        const items = multi_column_context_menu_items({
            ...base(),
            transform_sections: false,
        });
        expect(labels(items)).toEqual(['Copy 3 columns', 'Hide 3 columns']);
    });

    it('disables sort actions while a transform is pending', () => {
        const items = multi_column_context_menu_items({
            ...base(),
            transform_disabled: true,
        });
        const sort_items = items.filter((item) =>
            item.kind !== 'separator' && item.label.startsWith('Sort'));
        expect(sort_items.every((item) =>
            item.kind !== 'separator' && item.disabled === true)).toBe(true);
    });

    it('routes actions to the matching callbacks', () => {
        const props = base();
        const items = multi_column_context_menu_items(props);
        const click = (label: string) => {
            const item = items.find((entry) =>
                entry.kind !== 'separator' && entry.label === label);
            if (item && item.kind !== 'separator') {
                item.on_click({} as React.MouseEvent<HTMLButtonElement>);
            }
        };
        click('Copy 3 columns');
        expect(props.on_copy).toHaveBeenCalledTimes(1);
        click('Hide 3 columns');
        expect(props.on_hide).toHaveBeenCalledTimes(1);
        click('Sort ascending');
        expect(props.on_sort).toHaveBeenCalledWith('asc');
        click('Sort descending');
        expect(props.on_sort).toHaveBeenCalledWith('desc');
    });
});
