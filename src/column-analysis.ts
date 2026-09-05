import { Buffer } from 'node:buffer';
import type { DataSource, RawCell } from './data-source/interface';
import { read_source_raw_columns_async } from './data-source/interface';
import type { FilterColumnKind } from './types';
import {
    FILTER_DISTINCT_VALUE_BYTE_LIMIT,
    FILTER_DISTINCT_VALUE_LIMIT,
} from './types';
import {
    cell_can_be_numeric,
    peek_filter_value,
    raw_value,
    resolve_filter_value,
} from './transform-values';

const SCAN_ROWS_PER_CHECKPOINT = 128;
const ARRAY_OVERHEAD_BYTES = 64;
const OBJECT_OVERHEAD_BYTES = 64;
const REFERENCE_BYTES = 8;

export interface ColumnAnalysisDistinctEntry {
    readonly value: string | null;
    readonly rawValue: string | null;
}

export type ColumnAnalysisDistinct =
    | {
        readonly exceeded: false;
        readonly entries: readonly ColumnAnalysisDistinctEntry[];
        readonly serializedByteCount: number;
    }
    | { readonly exceeded: true };

export interface ColumnAnalysis {
    readonly values: readonly (string | null | undefined)[];
    /** Present only when exact row identities differ from their raw previews. */
    readonly filterValues?: readonly (string | null | undefined)[];
    /** Whether `filterValues ?? values` is safe for exact categorical matching. */
    readonly filterIdentityComplete: boolean;
    readonly columnKind: FilterColumnKind;
    readonly numericSummary?: {
        readonly min: number;
        readonly max: number;
        readonly count: number;
    };
    readonly distinct: ColumnAnalysisDistinct;
    /** Row-aligned reference slots retained by transform analysis. */
    readonly retainedSlots: number;
    /** Conservative cache-admission charge, not a process-RSS measurement. */
    readonly estimatedBytes: number;
}

export type ColumnIdentityRequirement = 'bounded' | 'complete';

export interface ColumnAnalysisCache {
    get(
        sheet_index: number,
        column_index: number,
        identity_requirement: ColumnIdentityRequirement,
    ): ColumnAnalysis | undefined;
    set(sheet_index: number, column_index: number, analysis: ColumnAnalysis): void;
}

interface MutableDistinctValues {
    readonly entries: Map<string | null, string | null>;
    serializedByteCount: number;
    identityResolutionCount: number;
    identityResolutionRawBytes: number;
}

function utf8_bytes(value: string): number {
    return Buffer.byteLength(value, 'utf8');
}

function raw_storage_bytes(
    cell: RawCell | null | undefined,
    raw: string | null,
): number {
    if (raw === null) return 0;
    return cell?.rawByteLength ?? utf8_bytes(raw);
}

function serialized_option_bytes(
    identity: string | null,
    raw: string | null,
): number {
    if (identity === null) return 0;
    return utf8_bytes(identity) + (
        raw !== null && raw !== identity ? utf8_bytes(raw) : 0
    );
}

function retain_distinct_value(
    distinct: MutableDistinctValues,
    identity: string | null,
    raw: string | null,
): boolean {
    if (distinct.entries.has(identity)) return true;
    if (distinct.entries.size === FILTER_DISTINCT_VALUE_LIMIT) return false;
    const option_bytes = serialized_option_bytes(identity, raw);
    if (
        distinct.serializedByteCount + option_bytes
        > FILTER_DISTINCT_VALUE_BYTE_LIMIT
    ) return false;
    distinct.entries.set(identity, raw);
    distinct.serializedByteCount += option_bytes;
    return true;
}

function iso_date_string(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-][0-2]\d:?[0-5]\d)?)?$/.test(value)) {
        return false;
    }
    return Number.isFinite(Date.parse(value));
}

type ClassifiedValue =
    | { kind: 'numeric'; numericValue?: number; unsafeInteger?: boolean }
    | { kind: 'orderedText' | 'text' }
    | undefined;

function classify_value(
    cell: RawCell | null | undefined,
    raw: string | null,
): ClassifiedValue {
    if (raw === null) return undefined;
    if (cell?.rawType === 'date' || iso_date_string(raw)) {
        return { kind: 'orderedText' };
    }
    if (cell_can_be_numeric(cell)) {
        const numericValue = Number(raw);
        if (/^[+-]?\d+$/.test(raw.trim()) && !Number.isSafeInteger(numericValue)) {
            return { kind: 'numeric', unsafeInteger: true };
        }
        return Number.isFinite(numericValue)
            ? { kind: 'numeric', numericValue }
            : { kind: 'numeric' };
    }
    return { kind: 'text' };
}

function combine_kind(
    current: FilterColumnKind,
    next: 'numeric' | 'orderedText' | 'text',
): FilterColumnKind {
    if (current === 'unknown') return next;
    return current === next ? current : 'text';
}

function capture_filter_identity(
    values: readonly (string | null | undefined)[],
    filter_values: (string | null | undefined)[] | undefined,
    row: number,
    identity: string | null,
    raw: string | null,
): (string | null | undefined)[] | undefined {
    if (identity !== raw) {
        const result = filter_values ?? values.slice();
        result[row] = identity;
        return result;
    }
    if (filter_values !== undefined) filter_values[row] = raw;
    return filter_values;
}

function retained_string_bytes(value: string | null | undefined): number {
    return typeof value === 'string'
        ? OBJECT_OVERHEAD_BYTES + value.length * 2
        : 0;
}

function estimate_analysis_bytes(
    values: readonly (string | null | undefined)[],
    filter_values: readonly (string | null | undefined)[] | undefined,
    numeric_summary: ColumnAnalysis['numericSummary'],
    distinct: ColumnAnalysisDistinct,
): number {
    let bytes = OBJECT_OVERHEAD_BYTES
        + ARRAY_OVERHEAD_BYTES
        + values.length * REFERENCE_BYTES;
    for (const value of values) bytes += retained_string_bytes(value);
    if (filter_values !== undefined) {
        bytes += ARRAY_OVERHEAD_BYTES + filter_values.length * REFERENCE_BYTES;
        for (const value of filter_values) bytes += retained_string_bytes(value);
    }
    if (numeric_summary !== undefined) bytes += OBJECT_OVERHEAD_BYTES;
    bytes += OBJECT_OVERHEAD_BYTES;
    if (!distinct.exceeded) {
        bytes += ARRAY_OVERHEAD_BYTES + distinct.entries.length * REFERENCE_BYTES;
        for (const entry of distinct.entries) {
            bytes += OBJECT_OVERHEAD_BYTES + 2 * REFERENCE_BYTES;
            bytes += retained_string_bytes(entry.value);
            bytes += retained_string_bytes(entry.rawValue);
        }
    }
    return bytes;
}

function abort_error(): Error {
    const error = new Error('Column analysis was cancelled.');
    error.name = 'AbortError';
    return error;
}

function throw_if_cancelled(is_cancelled: () => boolean): void {
    if (is_cancelled()) throw abort_error();
}

async function cancellation_checkpoint(
    is_cancelled: () => boolean,
): Promise<void> {
    throw_if_cancelled(is_cancelled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    throw_if_cancelled(is_cancelled);
}

export async function acquire_column_analysis(
    source: DataSource,
    sheet_index: number,
    column_index: number,
    row_count: number,
    identity_requirement: ColumnIdentityRequirement,
    cache: ColumnAnalysisCache | undefined,
    is_cancelled: () => boolean,
): Promise<ColumnAnalysis> {
    const cached = cache?.get(
        sheet_index,
        column_index,
        identity_requirement,
    );
    if (
        cached !== undefined
        && (
            identity_requirement === 'bounded'
            || cached.filterIdentityComplete
        )
    ) return cached;

    await cancellation_checkpoint(is_cancelled);
    const values = new Array<string | null | undefined>(row_count);
    let filter_values: (string | null | undefined)[] | undefined;
    let filter_identity_complete = true;
    let column_kind: FilterColumnKind = 'unknown';
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let numeric_count = 0;
    let has_unsafe_integer = false;
    let distinct: MutableDistinctValues | undefined = {
        entries: new Map(),
        serializedByteCount: 0,
        identityResolutionCount: 0,
        identityResolutionRawBytes: 0,
    };

    for (let start = 0; start < row_count; start += SCAN_ROWS_PER_CHECKPOINT) {
        const rows = (await read_source_raw_columns_async(
            source,
            sheet_index,
            start,
            Math.min(SCAN_ROWS_PER_CHECKPOINT, row_count - start),
            [column_index],
            is_cancelled,
        )).rows;

        for (let offset = 0; offset < rows.length; offset += 1) {
            const row = start + offset;
            const source_cell = rows[offset]?.[0] ?? null;
            const raw = raw_value(source_cell);
            values[row] = raw;

            let identity = peek_filter_value(source_cell, raw);
            if (identity === undefined) {
                const raw_bytes = raw_storage_bytes(source_cell, raw);
                let distinct_work_allowed = distinct !== undefined;
                if (distinct !== undefined) {
                    if (
                        raw_bytes > FILTER_DISTINCT_VALUE_BYTE_LIMIT
                        || distinct.identityResolutionCount
                            === FILTER_DISTINCT_VALUE_LIMIT
                        || distinct.identityResolutionRawBytes + raw_bytes
                            > FILTER_DISTINCT_VALUE_BYTE_LIMIT
                    ) {
                        distinct = undefined;
                        distinct_work_allowed = false;
                    } else {
                        distinct.identityResolutionCount += 1;
                        distinct.identityResolutionRawBytes += raw_bytes;
                    }
                }
                if (
                    identity_requirement === 'complete'
                    || distinct_work_allowed
                ) {
                    const resolved = resolve_filter_value(
                        source_cell,
                        is_cancelled,
                        raw,
                    );
                    identity = typeof resolved === 'object' && resolved !== null
                        ? await resolved
                        : resolved;
                    throw_if_cancelled(is_cancelled);
                } else {
                    filter_identity_complete = false;
                    filter_values = undefined;
                }
            } else if (
                distinct !== undefined
                && raw_storage_bytes(source_cell, raw)
                    > FILTER_DISTINCT_VALUE_BYTE_LIMIT
            ) {
                distinct = undefined;
            }

            if (identity !== undefined) {
                if (filter_identity_complete) {
                    filter_values = capture_filter_identity(
                        values,
                        filter_values,
                        row,
                        identity,
                        raw,
                    );
                }
                if (
                    distinct !== undefined
                    && !retain_distinct_value(distinct, identity, raw)
                ) distinct = undefined;
            }

            const classified = classify_value(source_cell, raw);
            if (classified === undefined) continue;
            column_kind = combine_kind(column_kind, classified.kind);
            if (classified.kind === 'numeric' && classified.unsafeInteger) {
                has_unsafe_integer = true;
            }
            if (
                classified.kind === 'numeric'
                && classified.numericValue !== undefined
            ) {
                min = Math.min(min, classified.numericValue);
                max = Math.max(max, classified.numericValue);
                numeric_count += 1;
            }
        }
        await cancellation_checkpoint(is_cancelled);
    }

    throw_if_cancelled(is_cancelled);
    const published_distinct: ColumnAnalysisDistinct = distinct === undefined
        ? Object.freeze({ exceeded: true as const })
        : Object.freeze({
            exceeded: false as const,
            entries: Object.freeze([...distinct.entries].map(([value, rawValue]) =>
                Object.freeze({ value, rawValue }))),
            serializedByteCount: distinct.serializedByteCount,
        });
    // A partial summary would hide unsafe integers and produce misleading bins.
    const numeric_summary = numeric_count === 0 || has_unsafe_integer
        ? undefined
        : Object.freeze({ min, max, count: numeric_count });
    const frozen_values = Object.freeze(values);
    const frozen_filter_values = filter_identity_complete
        && filter_values !== undefined
        ? Object.freeze(filter_values)
        : undefined;
    const retained_slots = frozen_values.length
        + (frozen_filter_values?.length ?? 0);
    const estimated_bytes = estimate_analysis_bytes(
        frozen_values,
        frozen_filter_values,
        numeric_summary,
        published_distinct,
    );
    const analysis: ColumnAnalysis = Object.freeze({
        values: frozen_values,
        ...(frozen_filter_values === undefined
            ? {}
            : { filterValues: frozen_filter_values }),
        filterIdentityComplete: filter_identity_complete,
        columnKind: column_kind,
        ...(numeric_summary === undefined
            ? {}
            : { numericSummary: numeric_summary }),
        distinct: published_distinct,
        retainedSlots: retained_slots,
        estimatedBytes: estimated_bytes,
    });
    throw_if_cancelled(is_cancelled);
    cache?.set(sheet_index, column_index, analysis);
    return analysis;
}
