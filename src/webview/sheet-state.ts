import type {
    FilterEntry,
    PerFileState,
    ScrollPosition,
    SheetColumnVisibilityState,
    SheetTransformState,
    SortKey,
    StoredPerFileState,
    WorksheetIdentityInput,
} from '../types';
import {
    MAX_PERSISTED_HIDDEN_ROWS,
    is_range_filter_operator,
    reconcile_pending_edit_sheets,
    sheet_name_from_transform_schema,
    worksheet_identity,
} from '../types';
export { MAX_PERSISTED_HIDDEN_ROWS } from '../types';
import { sanitize_column_visibility_state } from './column-projection';

export function clamp_sheet_index(
    sheet_index: number | undefined,
    sheet_count: number
): number {
    if (sheet_count === 0) return 0;
    if (
        sheet_index === undefined
        || !Number.isInteger(sheet_index)
        || sheet_index < 0
    ) {
        return 0;
    }
    return Math.min(sheet_index, sheet_count - 1);
}

export function normalize_per_file_state(
    state: StoredPerFileState,
    sheets: readonly WorksheetIdentityInput[],
): PerFileState {
    const sheet_names = sheets.map((sheet) => worksheet_identity(sheet).name);
    const active_sheet_index = normalize_active_sheet_index(
        state,
        sheet_names,
    );

    return {
        activeSheetIndex: active_sheet_index,
        columnWidths: normalize_sheet_state_array<Record<number, number>>(
            state.columnWidths,
            sheet_names
        ),
        rowHeights: normalize_sheet_state_array<Record<number, number>>(
            state.rowHeights,
            sheet_names
        ),
        scrollPosition: normalize_sheet_state_array<ScrollPosition>(
            state.scrollPosition,
            sheet_names
        ),
        tabOrientation: state.tabOrientation ?? null,
        pendingEdits: normalize_pending_edits(
            'pendingEdits' in state ? (state as PerFileState).pendingEdits : undefined,
            sheets,
        ),
        transforms: normalize_transforms(
            'transforms' in state ? (state as PerFileState).transforms : undefined,
            sheet_names.length,
        ),
        columnVisibility: normalize_column_visibility(
            'columnVisibility' in state
                ? (state as PerFileState).columnVisibility
                : undefined,
            sheet_names.length,
        ),
        cellHighlights: 'cellHighlights' in state
            ? (state as PerFileState).cellHighlights
            : undefined,
        showFormatting: normalize_sheet_state_array<boolean>(
            'showFormatting' in state ? (state as PerFileState).showFormatting : undefined,
            sheet_names,
        ),
    };
}

export function sanitize_transform_state(
    value: unknown,
    column_count = Number.MAX_SAFE_INTEGER,
    expected_schema?: string,
    row_count = Number.MAX_SAFE_INTEGER,
): SheetTransformState | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as { sort?: unknown; filters?: unknown; hiddenRows?: unknown };
    if (!Array.isArray(candidate.sort) || !Array.isArray(candidate.filters)) {
        return undefined;
    }
    const schema = typeof (candidate as { schema?: unknown }).schema === 'string'
        ? (candidate as { schema: string }).schema
        : undefined;
    const hidden_rows: number[] = [];
    if (Array.isArray(candidate.hiddenRows)) {
        let unique: Set<number> | undefined;
        let previous = -1;
        for (const row of candidate.hiddenRows) {
            if (
                typeof row === 'number'
                && Number.isInteger(row)
                && row >= 0
                && row < row_count
            ) {
                if (!unique && row > previous) {
                    hidden_rows.push(row);
                    previous = row;
                } else {
                    unique ??= new Set(hidden_rows);
                    unique.add(row);
                }
            }
            if ((unique?.size ?? hidden_rows.length) === MAX_PERSISTED_HIDDEN_ROWS) break;
        }
        if (unique) {
            hidden_rows.length = 0;
            for (const row of unique) hidden_rows.push(row);
            hidden_rows.sort((a, b) => a - b);
        }
    }
    if (expected_schema !== undefined && schema !== expected_schema) {
        const same_sheet = sheet_name_from_transform_schema(schema)
            === sheet_name_from_transform_schema(expected_schema);
        return hidden_rows.length > 0 && same_sheet
            ? {
                sort: [],
                filters: [],
                hiddenRows: hidden_rows,
                schema: expected_schema,
            }
            : undefined;
    }

    const sort: SortKey[] = [];
    const seen_sort = new Set<number>();
    for (const item of candidate.sort) {
        if (!item || typeof item !== 'object') continue;
        const key = item as Record<string, unknown>;
        if (
            typeof key.colIndex !== 'number'
            || !Number.isInteger(key.colIndex)
            || key.colIndex < 0
            || key.colIndex >= column_count
            || (key.direction !== 'asc' && key.direction !== 'desc')
            || seen_sort.has(key.colIndex)
        ) {
            continue;
        }
        seen_sort.add(key.colIndex);
        sort.push({
            colIndex: key.colIndex,
            direction: key.direction,
        });
    }

    const filters: FilterEntry[] = [];
    const seen_filter_columns = new Set<number>();
    const seen_filter_ids = new Set<string>();
    const operators = new Set([
        'contains', 'notContains', 'equals', 'notEquals', 'startsWith',
        'endsWith', 'greaterThan', 'greaterThanOrEqual', 'lessThan',
        'lessThanOrEqual', 'between', 'notBetween', 'isEmpty', 'isNotEmpty',
        'isOneOf',
    ]);
    for (const item of candidate.filters) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as Record<string, unknown>;
        if (
            typeof entry.id !== 'string'
            || entry.id.length === 0
            || typeof entry.colIndex !== 'number'
            || !Number.isInteger(entry.colIndex)
            || entry.colIndex < 0
            || entry.colIndex >= column_count
            || typeof entry.operator !== 'string'
            || !operators.has(entry.operator)
            || typeof entry.caseSensitive !== 'boolean'
            || typeof entry.enabled !== 'boolean'
            || seen_filter_ids.has(entry.id)
            || seen_filter_columns.has(entry.colIndex)
        ) {
            continue;
        }
        const is_one_of = entry.operator === 'isOneOf';
        const needs_value = !is_one_of
            && entry.operator !== 'isEmpty'
            && entry.operator !== 'isNotEmpty';
        if (needs_value && typeof entry.value !== 'string') continue;
        if (
            typeof entry.operator === 'string'
            && is_range_filter_operator(entry.operator as FilterEntry['operator'])
            && typeof entry.secondValue !== 'string'
        ) {
            continue;
        }
        // A missing/malformed exclusion list is rejected rather than treated as
        // "exclude nothing": corrupt state must not silently become a no-op.
        const excluded_values = is_one_of
            ? sanitize_excluded_values(entry.excludedValues)
            : undefined;
        if (is_one_of && excluded_values === undefined) continue;
        seen_filter_ids.add(entry.id);
        seen_filter_columns.add(entry.colIndex);
        filters.push({
            id: entry.id,
            colIndex: entry.colIndex,
            operator: entry.operator as FilterEntry['operator'],
            value: !is_one_of && typeof entry.value === 'string'
                ? entry.value
                : undefined,
            secondValue: !is_one_of && typeof entry.secondValue === 'string'
                ? entry.secondValue
                : undefined,
            excludedValues: excluded_values,
            caseSensitive: is_one_of ? false : entry.caseSensitive,
            enabled: entry.enabled,
        });
    }

    if (sort.length === 0 && filters.length === 0 && hidden_rows.length === 0) {
        return undefined;
    }
    const result: SheetTransformState = { sort, filters };
    if (hidden_rows.length > 0) result.hiddenRows = hidden_rows;
    if (schema !== undefined) result.schema = schema;
    return result;
}

/** Allocation guard for corrupt/malicious persisted state. Stale exclusions
 *  can accumulate ~1,000 per file-content change, so a legitimate list is
 *  truncated to this bound (permissive: extra rows show) rather than having
 *  the whole filter rejected. */
const MAX_PERSISTED_EXCLUDED_VALUES = 100_000;

function sanitize_excluded_values(
    value: unknown,
): (string | null)[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const unique = new Set<string | null>();
    for (const item of value) {
        if (item === null || typeof item === 'string') unique.add(item);
        if (unique.size === MAX_PERSISTED_EXCLUDED_VALUES) break;
    }
    // A non-empty list where every entry is garbage is corrupt state, not an
    // "exclude nothing" filter — reject it rather than match everything.
    if (unique.size === 0 && value.length > 0) return undefined;
    return [...unique];
}

export function trim_sheet_state_array<T>(
    value: (T | undefined)[] | undefined,
    sheet_count: number
): (T | undefined)[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, sheet_count);
}

function normalize_active_sheet_index(
    state: StoredPerFileState,
    sheet_names: string[]
): number {
    if ('activeSheetIndex' in state) {
        return clamp_sheet_index(state.activeSheetIndex, sheet_names.length);
    }

    if ('activeSheet' in state && typeof state.activeSheet === 'string') {
        const legacy_index = sheet_names.indexOf(state.activeSheet);
        return clamp_sheet_index(
            legacy_index === -1 ? undefined : legacy_index,
            sheet_names.length
        );
    }

    return 0;
}

/**
 * Normalize the worksheet-scoped pending-edit leaf.
 *
 * Two jobs, in order. First the per-sheet cell maps are sanitized as before.
 * Then slots are reconciled against the workbook as loaded: a slot recording a
 * `sheetName` that no longer sits at its index describes a worksheet that moved,
 * and honouring it by position would apply one sheet's draft to another, keyed
 * to rows that mean something else there. Those slots are dropped — see
 * `reconcile_pending_edit_sheets`.
 */
function normalize_pending_edits(
    value: unknown,
    sheets: readonly WorksheetIdentityInput[],
): PerFileState['pendingEdits'] {
    // A legacy flat map reaching here (state that never passed through
    // `decode_stored_per_file_state`) is one CSV's edits: single-sheet by
    // construction, so it belongs in slot 0.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const cells = normalize_pending_edit_cells(value);
        return cells ? [{ cells }] : undefined;
    }
    if (!Array.isArray(value)) return undefined;

    const slots = value.map((slot) => {
        if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return undefined;
        const record = slot as {
            sheetName?: unknown;
            worksheetId?: unknown;
            cells?: unknown;
        };
        const cells = normalize_pending_edit_cells(record.cells);
        if (!cells) return undefined;
        return {
            ...(typeof record.sheetName === 'string'
                ? { sheetName: record.sheetName }
                : {}),
            ...(typeof record.worksheetId === 'string'
                ? { worksheetId: record.worksheetId }
                : {}),
            cells,
        };
    });
    while (slots.length > 0 && slots[slots.length - 1] === undefined) slots.pop();
    return reconcile_pending_edit_sheets(
        slots.length === 0 ? undefined : slots,
        sheets,
    );
}

function normalize_pending_edit_cells(
    value: unknown
): Record<string, string | { value: string; base: string }> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const result: Record<string, string | { value: string; base: string }> = {};
    for (const [key, val] of Object.entries(value)) {
        // Keys must be exactly "<row>:<col>" integers. A malformed key (corrupt
        // or old-format persisted state) would parse to NaN coordinates, leaving
        // a phantom dirty entry that is never flagged conflicted nor resolvable.
        if (!/^\d+:\d+$/.test(key)) {
            continue;
        }
        if (typeof val === 'string') {
            result[key] = val;
        } else if (
            typeof val === 'object' && val !== null &&
            'value' in val && typeof (val as Record<string, unknown>).value === 'string' &&
            'base' in val && typeof (val as Record<string, unknown>).base === 'string'
        ) {
            result[key] = { value: (val as { value: string; base: string }).value, base: (val as { value: string; base: string }).base };
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Index one per-sheet state map by sheet position, converting the legacy
 * keyed-by-sheet-name shape (`LegacyPerFileState`) on the way.
 *
 * Exported because the host needs this one conversion on its own, without the rest of
 * `normalize_per_file_state`: `viewer-controller`'s durable row-height latch has to hand
 * the core an index-addressable array on a path where sanitizing transforms and the whole
 * pending-edit map would be wasted work. Note that it shares the per-sheet values by
 * reference rather than copying them, which is what makes it cheap enough for that path
 * even when one of those values is an unbounded pre-migration height map.
 */
export function normalize_sheet_state_array<T>(
    value: ((T | undefined)[] | Record<string, T>) | undefined,
    sheet_names: string[]
): (T | undefined)[] {
    if (Array.isArray(value)) {
        return value.slice(0, sheet_names.length);
    }

    if (!value || typeof value !== 'object') {
        return [];
    }

    const result = new Array<T | undefined>(sheet_names.length);
    for (const [index, name] of sheet_names.entries()) {
        if (Object.prototype.hasOwnProperty.call(value, name)) {
            result[index] = value[name];
        }
    }
    return result;
}

function normalize_transforms(
    value: unknown,
    sheet_count: number,
): (SheetTransformState | undefined)[] {
    if (!Array.isArray(value)) return [];
    return value
        .slice(0, sheet_count)
        .map((item) => sanitize_transform_state(item));
}

function normalize_column_visibility(
    value: unknown,
    sheet_count: number,
): (SheetColumnVisibilityState | undefined)[] {
    if (!Array.isArray(value)) return [];
    return value
        .slice(0, sheet_count)
        .map((item) => sanitize_column_visibility_state(item));
}
