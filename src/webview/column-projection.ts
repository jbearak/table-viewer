// Display columns: which columns the grid shows, in which order. Without a
// column layout, the source columns minus hidden ones (`create_column_projection`).
// With one, the layout's columns in prospective order minus hidden source
// columns and discarded Pending Column tombstones, each with its identity key
// (`s:<n>` or `p:<id>`) for the Glide column id and its display state
// (`create_layout_column_projection`).
import type { SheetColumnVisibilityState } from '../types';
import {
    column_identity_key,
    index_column_layout,
    moved_source_columns,
    source_column_layout,
    type ColumnIdentity,
    type ColumnLayout,
} from '../worksheet-layout';

/** The display columns of a worksheet with no column layout: source columns only. */
export interface SourceColumnProjection {
    /** Display-column index to canonical source-column index. */
    visible_to_source: number[];
    /** Canonical source-column index to display-column index; hidden columns
     *  deliberately have no reverse mapping. Kept sparse so hide-all is O(1). */
    source_to_visible: (number | undefined)[];
    hidden_count: number;
}

/**
 * The display columns the grid shows. With a column layout a display column
 * may be a Pending Column, which has no source column, so
 * `visible_to_source` holds undefined there; `columns` names every display
 * column's identity, Glide id key (`s:<n>` or `p:<id>`), and state.
 */
export interface ColumnProjection {
    readonly visible_to_source: readonly (number | undefined)[];
    readonly source_to_visible: readonly (number | undefined)[];
    readonly hidden_count: number;
    readonly columns?: readonly ProjectedColumn[];
}

/** Structural equality for projections recreated from an equivalent snapshot. */
export function column_projections_equal(
    left: ColumnProjection,
    right: ColumnProjection,
): boolean {
    return left.hidden_count === right.hidden_count
        && left.visible_to_source.length === right.visible_to_source.length
        && left.visible_to_source.every(
            (source, display) => source === right.visible_to_source[display],
        )
        && left.source_to_visible.length === right.source_to_visible.length
        && left.source_to_visible.every(
            (display, source) => display === right.source_to_visible[source],
        )
        && (left.columns?.length ?? 0) === (right.columns?.length ?? 0)
        && (left.columns ?? []).every((column, display) => {
            const other = right.columns?.[display];
            return other !== undefined && other.key === column.key && other.state === column.state;
        });
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
): SourceColumnProjection {
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

/** Hide every listed source column in one visibility update. */
export function hide_source_columns(
    value: unknown,
    source_columns: readonly number[],
    column_count: number,
    schema?: string,
): SheetColumnVisibilityState | undefined {
    const state = sanitize_column_visibility_state(value, column_count, schema);
    const to_hide = source_columns.filter((source_column) => (
        Number.isInteger(source_column)
        && source_column >= 0
        && source_column < column_count
    ));
    if (to_hide.length === 0) return state;

    if (state?.visibleColumns) {
        const visible = new Set(state.visibleColumns);
        for (const source_column of to_hide) visible.delete(source_column);
        return canonical_visibility_from_visible(
            visible,
            column_count,
            schema ?? state.schema,
        );
    }
    const hidden = new Set(state?.hiddenColumns ?? []);
    for (const source_column of to_hide) hidden.add(source_column);
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
    if (visible.length < column_count - visible.length) {
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

/** A source column, a Pending Column, a Pending Column Removal, or a Moved Column. */
export type ProjectedColumnState = 'source' | 'inserted' | 'removed' | 'moved';

export interface ProjectedColumn {
    readonly identity: ColumnIdentity;
    /** The Glide column id: `s:<sourceColumn>` or `p:<pendingColumnId>`. */
    readonly key: string;
    readonly state: ProjectedColumnState;
}

export interface ColumnLayoutProjection extends ColumnProjection {
    /** Display columns in order. */
    readonly columns: readonly ProjectedColumn[];
    /** Source column to display column; hidden and absent columns have none. */
    readonly source_to_visible: readonly (number | undefined)[];
    /** Hidden source columns, as `create_column_projection` counts them. */
    readonly hidden_count: number;
    display_column_for_identity(identity: ColumnIdentity): number | undefined;
    display_column_for_key(key: string): number | undefined;
}

/**
 * Display columns for a worksheet whose columns may have a layout. Hidden
 * columns are source columns from the visibility state; Pending Columns are
 * never hidden. Pending Column Removals stay in place, classified `removed`.
 * Without a layout the order and hidden set equal `create_column_projection`'s.
 */
export function create_layout_column_projection(
    column_count: number,
    layout: ColumnLayout | undefined,
    visibility?: unknown,
    expected_schema?: string,
): ColumnLayoutProjection {
    const safe_column_count = Number.isInteger(column_count) && column_count > 0 ? column_count : 0;
    const hidden = new Set<number>();
    const visible_projection = create_column_projection(safe_column_count, visibility, expected_schema);
    for (let source_column = 0; source_column < safe_column_count; source_column++) {
        if (visible_projection.source_to_visible[source_column] === undefined) hidden.add(source_column);
    }
    const effective = layout ?? source_column_layout(safe_column_count);
    const index = index_column_layout(effective);
    const moved = new Set<number>();
    for (const interval of moved_source_columns(effective)) {
        for (let offset = 0; offset < interval.count; offset++) moved.add(interval.start + offset);
    }
    const columns: ProjectedColumn[] = [];
    const source_to_visible: (number | undefined)[] = [];
    const visible_to_source: (number | undefined)[] = [];
    const by_key = new Map<string, number>();
    for (const identity of index.display_identities()) {
        if (identity.kind === 'source' && hidden.has(identity.sourceColumn)) continue;
        const state: ProjectedColumnState = identity.kind === 'pending'
            ? 'inserted'
            : index.status_of(identity) === 'removed'
                ? 'removed'
                : moved.has(identity.sourceColumn) ? 'moved' : 'source';
        const key = column_identity_key(identity);
        if (identity.kind === 'source') source_to_visible[identity.sourceColumn] = columns.length;
        visible_to_source.push(identity.kind === 'source' ? identity.sourceColumn : undefined);
        by_key.set(key, columns.length);
        columns.push(Object.freeze({ identity, key, state }));
    }
    return Object.freeze({
        columns: Object.freeze(columns),
        visible_to_source: Object.freeze(visible_to_source),
        source_to_visible,
        hidden_count: hidden.size,
        display_column_for_identity: (identity: ColumnIdentity) => by_key.get(column_identity_key(identity)),
        display_column_for_key: (key: string) => by_key.get(key),
    });
}

/**
 * The grid's display columns for a worksheet: `base`, the visibility
 * projection over source columns, with `layout` applied. Hidden columns are
 * the source columns `base` hides.
 */
export function with_column_layout(
    base: ColumnProjection,
    column_count: number,
    layout: ColumnLayout | undefined,
): ColumnLayoutProjection {
    if (layout === undefined) {
        // No layout: the base projection's own order, every column a source column.
        const columns: ProjectedColumn[] = base.visible_to_source.flatMap((source_column) => source_column === undefined
            ? []
            : [Object.freeze({
                identity: Object.freeze({ kind: 'source' as const, sourceColumn: source_column }),
                key: `s:${source_column}`,
                state: 'source' as const,
            })]);
        const by_key = new Map<string, number>(columns.map((column, display) => [column.key, display]));
        return Object.freeze({
            columns: Object.freeze(columns),
            visible_to_source: base.visible_to_source,
            source_to_visible: base.source_to_visible,
            hidden_count: base.hidden_count,
            display_column_for_identity: (identity: ColumnIdentity) => by_key.get(column_identity_key(identity)),
            display_column_for_key: (key: string) => by_key.get(key),
        });
    }
    const hidden: number[] = [];
    for (let source_column = 0; source_column < column_count; source_column++) {
        if (base.source_to_visible[source_column] === undefined) hidden.push(source_column);
    }
    return create_layout_column_projection(
        column_count,
        layout,
        hidden.length === 0 ? undefined : { hiddenColumns: hidden },
    );
}
