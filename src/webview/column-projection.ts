import type { SheetColumnVisibilityState } from '../types';

export interface ColumnProjection {
    /** Display-column index to canonical source-column index. */
    visible_to_source: number[];
    /** Canonical source-column index to display-column index; hidden columns
     *  deliberately have no reverse mapping. Kept sparse so hide-all is O(1). */
    source_to_visible: (number | undefined)[];
    hidden_count: number;
}

export function sanitize_column_visibility_state(
    value: unknown,
    column_count = Number.MAX_SAFE_INTEGER,
    expected_schema?: string,
): SheetColumnVisibilityState | undefined {
    if (!value || typeof value !== 'object') return undefined;

    const candidate = value as {
        hiddenColumns?: unknown;
        visibleColumns?: unknown;
        schema?: unknown;
    };
    const has_hidden = Object.prototype.hasOwnProperty.call(candidate, 'hiddenColumns');
    const has_visible = Object.prototype.hasOwnProperty.call(candidate, 'visibleColumns');
    if (!has_hidden && !has_visible) return undefined;

    const schema = Object.prototype.hasOwnProperty.call(candidate, 'schema')
        && typeof candidate.schema === 'string'
        ? candidate.schema
        : undefined;
    if (expected_schema !== undefined && schema !== expected_schema) return undefined;

    const safe_count = Number.isInteger(column_count) && column_count > 0
        ? column_count
        : 0;
    const hidden_input = has_hidden && Array.isArray(candidate.hiddenColumns)
        ? sanitize_indexes(candidate.hiddenColumns, safe_count)
        : undefined;
    const visible_input = has_visible && Array.isArray(candidate.visibleColumns)
        ? sanitize_indexes(candidate.visibleColumns, safe_count)
        : undefined;
    if (!hidden_input && !visible_input) return undefined;

    // Legacy/both-side descriptors use hiddenColumns as the authoritative side
    // when it is well formed; otherwise a valid visibleColumns list is retained.
    return hidden_input
        ? canonical_visibility_from_hidden(hidden_input, safe_count, schema)
        : canonical_visibility_from_visible(visible_input ?? [], safe_count, schema);
}

export function create_column_projection(
    column_count: number,
    value?: unknown,
    expected_schema?: string,
): ColumnProjection {
    const safe_column_count = Number.isInteger(column_count) && column_count > 0
        ? column_count
        : 0;
    const state = sanitize_column_visibility_state(
        value,
        safe_column_count,
        expected_schema,
    );
    const source_to_visible: (number | undefined)[] = [];
    let visible_to_source: number[];

    if (state?.visibleColumns) {
        visible_to_source = [...state.visibleColumns];
        for (const [visible_column, source_column] of visible_to_source.entries()) {
            source_to_visible[source_column] = visible_column;
        }
    } else {
        const hidden_columns = new Set(state?.hiddenColumns ?? []);
        visible_to_source = [];
        for (let source_column = 0; source_column < safe_column_count; source_column++) {
            if (hidden_columns.has(source_column)) continue;
            source_to_visible[source_column] = visible_to_source.length;
            visible_to_source.push(source_column);
        }
    }

    return {
        visible_to_source,
        source_to_visible,
        hidden_count: safe_column_count - visible_to_source.length,
    };
}

export function toggle_source_column(
    value: unknown,
    source_column: number,
    column_count: number,
    schema?: string,
): SheetColumnVisibilityState | undefined {
    const state = sanitize_column_visibility_state(value, column_count, schema);
    if (
        !Number.isInteger(source_column)
        || source_column < 0
        || source_column >= column_count
    ) return state;

    if (state?.visibleColumns) {
        const visible = new Set(state.visibleColumns);
        if (visible.has(source_column)) visible.delete(source_column);
        else visible.add(source_column);
        return canonical_visibility_from_visible(
            visible,
            column_count,
            schema ?? state.schema,
        );
    }
    const hidden = new Set(state?.hiddenColumns ?? []);
    if (hidden.has(source_column)) hidden.delete(source_column);
    else hidden.add(source_column);
    return canonical_visibility_from_hidden(hidden, column_count, schema ?? state?.schema);
}

export function show_all_columns(): undefined {
    return undefined;
}

export function hide_all_columns(
    _column_count: number,
    schema?: string,
): SheetColumnVisibilityState {
    return schema === undefined ? { visibleColumns: [] } : { visibleColumns: [], schema };
}

function sanitize_indexes(value: readonly unknown[], column_count: number): number[] {
    return Array.from(new Set(value.filter((column): column is number => (
        typeof column === 'number'
        && Number.isInteger(column)
        && column >= 0
        && column < column_count
    )))).sort((left, right) => left - right);
}

function complement(indexes: Iterable<number>, column_count: number): number[] {
    const selected = new Set(indexes);
    const result: number[] = [];
    for (let column = 0; column < column_count; column++) {
        if (!selected.has(column)) result.push(column);
    }
    return result;
}

function canonical_visibility_from_hidden(
    hidden_columns: Iterable<number>,
    column_count: number,
    schema?: string,
): SheetColumnVisibilityState | undefined {
    const hidden = sanitize_indexes(Array.from(hidden_columns), column_count);
    if (hidden.length === 0) return undefined;
    const visible_count = column_count - hidden.length;
    if (visible_count < hidden.length) {
        const visible = complement(hidden, column_count);
        return schema === undefined
            ? { visibleColumns: visible }
            : { visibleColumns: visible, schema };
    }
    return schema === undefined
        ? { hiddenColumns: hidden }
        : { hiddenColumns: hidden, schema };
}

function canonical_visibility_from_visible(
    visible_columns: Iterable<number>,
    column_count: number,
    schema?: string,
): SheetColumnVisibilityState | undefined {
    const visible = sanitize_indexes(Array.from(visible_columns), column_count);
    if (visible.length === column_count) return undefined;
    if (visible.length <= column_count - visible.length) {
        return schema === undefined
            ? { visibleColumns: visible }
            : { visibleColumns: visible, schema };
    }
    return canonical_visibility_from_hidden(
        complement(visible, column_count),
        column_count,
        schema,
    );
}
