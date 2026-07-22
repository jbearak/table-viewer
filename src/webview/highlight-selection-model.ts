import type { GridSelection, Rectangle } from '@glideapps/glide-data-grid';
import type {
    CellHighlightSelection,
    DisplayRowInterval,
    MergeRange,
} from '../types';
import type { ColumnProjection } from './column-projection';
import { expand_glide_selection } from './selection-glide';

export interface HighlightSelectionResult {
    selection: CellHighlightSelection;
    /** Saturates at Number.MAX_SAFE_INTEGER. Host validation remains authoritative. */
    estimatedCellCount: number;
}

interface DisplayRegion {
    rows: DisplayRowInterval;
    firstColumn: number;
    lastColumn: number;
}

function clamp_interval(start: number, end: number, count: number): DisplayRowInterval | null {
    if (count <= 0 || !Number.isFinite(start) || !Number.isFinite(end)) return null;
    const first = Math.max(0, Math.min(count - 1, Math.floor(Math.min(start, end))));
    const last = Math.max(0, Math.min(count - 1, Math.floor(Math.max(start, end))));
    return first <= last ? { start: first, end: last } : null;
}

export function merge_display_row_intervals(
    intervals: readonly DisplayRowInterval[],
): DisplayRowInterval[] {
    const sorted = intervals
        .filter((value) => value.start <= value.end)
        .map((value) => ({ start: value.start, end: value.end }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const out: DisplayRowInterval[] = [];
    for (const interval of sorted) {
        const previous = out[out.length - 1];
        if (!previous || interval.start > previous.end + 1) out.push(interval);
        else previous.end = Math.max(previous.end, interval.end);
    }
    return out;
}

function compact_contains(selection: GridSelection['rows'], index: number): boolean {
    if (typeof selection.hasIndex === 'function') return selection.hasIndex(index);
    if (typeof selection.toArray === 'function') return selection.toArray().includes(index);
    return false;
}

function rect_contains(rect: Rectangle, column: number, row: number): boolean {
    return column >= rect.x
        && column < rect.x + rect.width
        && row >= rect.y
        && row < rect.y + rect.height;
}

/** Whether a cell belongs to any current cell, row, or column selection. */
export function grid_selection_contains_cell(
    selection: GridSelection,
    column: number,
    row: number,
): boolean {
    if (compact_contains(selection.rows, row) || compact_contains(selection.columns, column)) {
        return true;
    }
    const current = selection.current;
    return !!current && (
        rect_contains(current.range, column, row)
        || current.rangeStack.some((range) => rect_contains(range, column, row))
    );
}

function compact_indices(selection: GridSelection['rows'], limit: number): number[] {
    if (selection.length === 0 || limit <= 0) return [];
    let values: number[];
    if (typeof selection.toArray === 'function') {
        values = selection.toArray();
    } else if (Symbol.iterator in Object(selection)) {
        values = Array.from(selection as Iterable<number>);
    } else {
        // Compatibility for reduced test doubles. Real CompactSelection exposes
        // toArray and an iterator, so production work scales with selection size.
        const first = typeof selection.first === 'function' ? selection.first() : undefined;
        const last = typeof selection.last === 'function' ? selection.last() : undefined;
        if (first === undefined || last === undefined || typeof selection.hasIndex !== 'function') {
            return [];
        }
        values = [];
        for (let index = first; index <= last; index++) {
            if (selection.hasIndex(index)) values.push(index);
        }
    }
    return [...new Set(values
        .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < limit))]
        .sort((a, b) => a - b);
}

function coalesce_indices(indices: readonly number[]): DisplayRowInterval[] {
    const intervals: DisplayRowInterval[] = [];
    for (const index of indices) {
        const previous = intervals[intervals.length - 1];
        if (previous && index === previous.end + 1) previous.end = index;
        else intervals.push({ start: index, end: index });
    }
    return intervals;
}

function project_merges_to_display(
    merges: readonly MergeRange[],
    column_projection: ColumnProjection,
): MergeRange[] {
    const projected: MergeRange[] = [];
    for (const merge of merges) {
        let first_visible = Number.POSITIVE_INFINITY;
        let last_visible = Number.NEGATIVE_INFINITY;
        for (let source_column = merge.startCol; source_column <= merge.endCol; source_column++) {
            const display_column = column_projection.source_to_visible[source_column];
            if (display_column === undefined) continue;
            first_visible = Math.min(first_visible, display_column);
            last_visible = Math.max(last_visible, display_column);
        }
        if (!Number.isFinite(first_visible)) continue;
        projected.push({
            ...merge,
            startCol: first_visible,
            endCol: last_visible,
        });
    }
    return projected;
}

function add_rect(
    rect: Rectangle,
    anchor: readonly [number, number],
    row_count: number,
    display_column_count: number,
    merges: MergeRange[],
    regions: DisplayRegion[],
): void {
    if (rect.width <= 0 || rect.height <= 0 || row_count <= 0 || display_column_count <= 0) return;
    const expanded = expand_glide_selection(anchor, rect, merges).range;
    const rows = clamp_interval(expanded.y, expanded.y + expanded.height - 1, row_count);
    const columns = clamp_interval(
        expanded.x,
        expanded.x + expanded.width - 1,
        display_column_count,
    );
    if (rows && columns) {
        regions.push({ rows, firstColumn: columns.start, lastColumn: columns.end });
    }
}

function region_union_area(regions: readonly DisplayRegion[]): bigint {
    const row_boundaries = [...new Set(regions.flatMap((region) => [
        region.rows.start,
        region.rows.end + 1,
    ]))].sort((a, b) => a - b);
    const column_boundaries = [...new Set(regions.flatMap((region) => [
        region.firstColumn,
        region.lastColumn + 1,
    ]))].sort((a, b) => a - b);
    let area = 0n;
    for (let row_index = 0; row_index + 1 < row_boundaries.length; row_index++) {
        const row = row_boundaries[row_index];
        const row_height = row_boundaries[row_index + 1] - row;
        for (
            let column_index = 0;
            column_index + 1 < column_boundaries.length;
            column_index++
        ) {
            const column = column_boundaries[column_index];
            if (!regions.some((region) =>
                row >= region.rows.start
                && row <= region.rows.end
                && column >= region.firstColumn
                && column <= region.lastColumn)) continue;
            area += BigInt(row_height)
                * BigInt(column_boundaries[column_index + 1] - column);
        }
    }
    return area;
}

/** Convert Glide's controlled selection into the compact host command shape. */
export function highlight_selection_from_grid(
    grid_selection: GridSelection,
    row_count: number,
    column_projection: ColumnProjection,
    merges: MergeRange[],
): HighlightSelectionResult | null {
    const display_column_count = column_projection.visible_to_source.length;
    if (row_count <= 0 || display_column_count <= 0) return null;

    const display_merges = project_merges_to_display(merges, column_projection);
    const regions: DisplayRegion[] = [];
    for (const rows of coalesce_indices(compact_indices(grid_selection.rows, row_count))) {
        add_rect(
            {
                x: 0,
                y: rows.start,
                width: display_column_count,
                height: rows.end - rows.start + 1,
            },
            [0, rows.start],
            row_count,
            display_column_count,
            display_merges,
            regions,
        );
    }
    for (const columns of coalesce_indices(
        compact_indices(grid_selection.columns, display_column_count),
    )) {
        add_rect(
            {
                x: columns.start,
                y: 0,
                width: columns.end - columns.start + 1,
                height: row_count,
            },
            [columns.start, 0],
            row_count,
            display_column_count,
            display_merges,
            regions,
        );
    }

    const current = grid_selection.current;
    if (current) {
        add_rect(
            current.range,
            current.cell,
            row_count,
            display_column_count,
            display_merges,
            regions,
        );
        for (const range of current.rangeStack) {
            add_rect(
                range,
                [range.x, range.y],
                row_count,
                display_column_count,
                display_merges,
                regions,
            );
        }
    }
    if (regions.length === 0) return null;

    const display_rows = merge_display_row_intervals(regions.map((region) => region.rows));
    const display_column_intervals = merge_display_row_intervals(regions.map((region) => ({
        start: region.firstColumn,
        end: region.lastColumn,
    })));
    const selected_display_columns = display_column_intervals.flatMap((interval) =>
        Array.from(
            { length: interval.end - interval.start + 1 },
            (_, offset) => interval.start + offset,
        ));

    let selected_row_count = 0n;
    for (const interval of display_rows) {
        selected_row_count += BigInt(interval.end - interval.start + 1);
    }
    const cartesian_area = selected_row_count * BigInt(selected_display_columns.length);
    // The wire shape is rows × columns. Refuse disjoint/cross-shaped selections
    // that it cannot represent exactly rather than silently highlighting extra cells.
    if (region_union_area(regions) !== cartesian_area) return null;

    const source_columns = selected_display_columns
        .map((column) => column_projection.visible_to_source[column])
        .filter((column): column is number => Number.isSafeInteger(column) && column >= 0)
        .sort((a, b) => a - b)
        .filter((column, index, values) => index === 0 || column !== values[index - 1]);
    if (display_rows.length === 0 || source_columns.length === 0) return null;

    const count = selected_row_count * BigInt(source_columns.length);
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return {
        selection: { displayRows: display_rows, sourceColumns: source_columns },
        estimatedCellCount: Number(count > max ? max : count),
    };
}
