import type { SheetColumnVisibilityState } from '../types';

export interface ColumnProjection {
    /** Display-column index to canonical source-column index. */
    visible_to_source: number[];
    /** Canonical source-column index to display-column index; hidden columns
     *  deliberately have no reverse mapping. */
    source_to_visible: (number | undefined)[];
}

export function sanitize_column_visibility_state(
    value: unknown,
    column_count = Number.MAX_SAFE_INTEGER,
    expected_schema?: string,
): SheetColumnVisibilityState | undefined {
    if (!value || typeof value !== 'object') return undefined;

    const candidate = value as {
        hiddenColumns?: unknown;
        schema?: unknown;
    };
    if (
        !Object.prototype.hasOwnProperty.call(candidate, 'hiddenColumns')
        || !Array.isArray(candidate.hiddenColumns)
    ) {
        return undefined;
    }

    const schema = Object.prototype.hasOwnProperty.call(candidate, 'schema')
        && typeof candidate.schema === 'string'
        ? candidate.schema
        : undefined;
    if (expected_schema !== undefined && schema !== expected_schema) {
        return undefined;
    }

    const hidden_columns = Array.from(new Set(
        candidate.hiddenColumns.filter((column): column is number => (
            typeof column === 'number'
            && Number.isInteger(column)
            && column >= 0
            && column < column_count
        )),
    )).sort((left, right) => left - right);

    // Persisted state only represents a non-identity projection. An empty hidden
    // list is normalized away so legacy and explicit "show all" states agree.
    if (hidden_columns.length === 0) return undefined;

    const result: SheetColumnVisibilityState = {
        hiddenColumns: hidden_columns,
    };
    if (schema !== undefined) result.schema = schema;
    return result;
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
    const hidden_columns = new Set(state?.hiddenColumns ?? []);
    const visible_to_source: number[] = [];
    const source_to_visible = new Array<number | undefined>(safe_column_count);

    for (let source_column = 0; source_column < safe_column_count; source_column++) {
        if (hidden_columns.has(source_column)) continue;
        source_to_visible[source_column] = visible_to_source.length;
        visible_to_source.push(source_column);
    }

    // These arrays are inverses only for visible columns. Every source column
    // still owns one reverse-lookup slot, including the all-hidden projection.
    return { visible_to_source, source_to_visible };
}

export function toggle_source_column(
    value: unknown,
    source_column: number,
    column_count: number,
    schema?: string,
): SheetColumnVisibilityState | undefined {
    const state = sanitize_column_visibility_state(
        value,
        column_count,
        schema,
    );
    if (
        !Number.isInteger(source_column)
        || source_column < 0
        || source_column >= column_count
    ) {
        return state;
    }

    const hidden_columns = new Set(state?.hiddenColumns ?? []);
    if (hidden_columns.has(source_column)) {
        hidden_columns.delete(source_column);
    } else {
        hidden_columns.add(source_column);
    }

    return visibility_state_from_hidden_columns(
        hidden_columns,
        column_count,
        schema ?? state?.schema,
    );
}

export function show_all_columns(): undefined {
    // Identity projections have no persisted descriptor.
    return undefined;
}

export function hide_all_columns(
    column_count: number,
    schema?: string,
): SheetColumnVisibilityState | undefined {
    const hidden_columns = Array.from(
        { length: Math.max(0, Number.isInteger(column_count) ? column_count : 0) },
        (_, column) => column,
    );
    return visibility_state_from_hidden_columns(hidden_columns, column_count, schema);
}

function visibility_state_from_hidden_columns(
    hidden_columns: Iterable<number>,
    column_count: number,
    schema?: string,
): SheetColumnVisibilityState | undefined {
    return sanitize_column_visibility_state({
        hiddenColumns: Array.from(hidden_columns),
        schema,
    }, column_count, schema);
}
