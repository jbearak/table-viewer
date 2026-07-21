import type { DataSource, RenderedCell } from './data-source/interface';
import { read_source_columns } from './data-source/interface';
import type {
    FilterEntry,
    SheetTransformState,
    SortDirection,
} from './types';
import { transform_is_active } from './types';

// Keep each synchronous source read bounded so cancellation can interrupt a
// transform inside the old 1,000-row scan interval.
const SCAN_ROWS_PER_CHECKPOINT = 128;
const FILTER_ROWS_PER_CHECKPOINT = 1000;
const SORT_KEY_BUILDS_PER_CHECKPOINT = 4096;
const SORT_CHUNK_ROWS = 2048;
const SORT_OPERATIONS_PER_CHECKPOINT = 4096;
const NUMERIC_KEY_INTERN_LIMIT = 1024;
const COLLATOR = new Intl.Collator(undefined, {
    sensitivity: 'variant',
    numeric: true,
});

export interface TransformResult {
    /** Display-row -> source-row. Undefined is the identity view. */
    indices: Uint32Array | undefined;
    rowCount: number;
}

export interface CachedTransformColumn {
    readonly values: readonly (string | null | undefined)[];
    readonly numeric: boolean;
    readonly foundValue: boolean;
}

export interface TransformColumnCache {
    get(sheet_index: number, column_index: number): CachedTransformColumn | undefined;
    set(
        sheet_index: number,
        column_index: number,
        column: CachedTransformColumn,
    ): void;
}

type TransformColumn = CachedTransformColumn;

interface MutableTransformColumn {
    values: (string | null | undefined)[];
    numeric: boolean;
    foundValue: boolean;
}

/** Optional cumulative counters for deterministic transform performance tests. */
export interface TransformSortInstrumentation {
    numericSortKeyBuilds: number;
    numericSortComparisons: number;
    /** Reused key objects and maximum entries retained by any one interner. */
    numericSortKeyReuses?: number;
    numericSortKeyInternPeakEntries?: number;
    /** Reference slots in request-local numeric-key arrays. */
    numericSortKeySlots?: number;
    peakNumericSortKeySlots?: number;
    /**
     * Reference slots visible through columns used by the active request.
     * This is not total cache ownership, object memory, or process RSS.
     */
    transformColumnValueSlots?: number;
    peakTransformColumnValueSlots?: number;
    /** Exact accounting for live request-local Uint32 index buffers. */
    indexBufferAllocations?: number;
    indexBufferReleases?: number;
    indexBufferCount?: number;
    indexBufferBytes?: number;
    peakIndexBufferCount?: number;
    peakIndexBufferBytes?: number;
    survivorMaskBytes?: number;
    peakSurvivorMaskBytes?: number;
}

export async function compute_transform(
    source: DataSource,
    sheet_index: number,
    state: SheetTransformState,
    is_cancelled: () => boolean = () => false,
    sort_instrumentation?: TransformSortInstrumentation,
    column_cache?: TransformColumnCache,
): Promise<TransformResult> {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) {
        throw new RangeError(`sheet index ${sheet_index} out of range`);
    }
    if (!transform_is_active(state)) {
        return { indices: undefined, rowCount: sheet.rowCount };
    }

    // Validate every referenced index before acquiring or publishing any column.
    needed_columns(state, sheet.columnCount);
    await cancellation_checkpoint(is_cancelled);
    let survivors: Uint32Array | undefined;
    let survivor_mask: Uint8Array | undefined;
    let returned_result = false;
    try {
        const filter_groups = group_enabled_filters(state.filters);
        let survivor_count = sheet.rowCount;
        if (filter_groups.size > 0) {
            await cancellation_checkpoint(is_cancelled);
            survivor_mask = allocate_survivor_mask(
                sheet.rowCount,
                sort_instrumentation,
            );
            survivor_count = 0;
            let first_group = true;
            for (const [column_index, filters] of filter_groups) {
                const column = await acquire_transform_column(
                    source,
                    sheet_index,
                    column_index,
                    sheet.rowCount,
                    column_cache,
                    is_cancelled,
                    sort_instrumentation,
                );
                try {
                    validate_filter_operands(filters, column);
                    let group_survivors = 0;
                    for (let row = 0; row < sheet.rowCount; row++) {
                        if (first_group || survivor_mask[row] === 1) {
                            let matches = true;
                            for (const filter of filters) {
                                if (!matches_filter_value(
                                    column.values[row] ?? null,
                                    filter,
                                    column.numeric && column.foundValue,
                                )) {
                                    matches = false;
                                    break;
                                }
                            }
                            survivor_mask[row] = matches ? 1 : 0;
                            if (matches) group_survivors += 1;
                        }
                        if ((row + 1) % FILTER_ROWS_PER_CHECKPOINT === 0) {
                            await cancellation_checkpoint(is_cancelled);
                        }
                    }
                    if (sheet.rowCount % FILTER_ROWS_PER_CHECKPOINT !== 0) {
                        await cancellation_checkpoint(is_cancelled);
                    }
                    survivor_count = group_survivors;
                    first_group = false;
                } finally {
                    release_transform_column(column, sort_instrumentation);
                }
            }
        }

        await cancellation_checkpoint(is_cancelled);
        survivors = allocate_index_buffer(survivor_count, sort_instrumentation);
        let survivor_position = 0;
        for (let row = 0; row < sheet.rowCount; row++) {
            if (!survivor_mask || survivor_mask[row] === 1) {
                survivors[survivor_position++] = row;
            }
            if ((row + 1) % FILTER_ROWS_PER_CHECKPOINT === 0) {
                await cancellation_checkpoint(is_cancelled);
            }
        }
        if (sheet.rowCount % FILTER_ROWS_PER_CHECKPOINT !== 0) {
            await cancellation_checkpoint(is_cancelled);
        }
        if (survivor_mask) {
            release_survivor_mask(survivor_mask, sort_instrumentation);
            survivor_mask = undefined;
        }
        if (survivors.length < 2) {
            returned_result = true;
            return { indices: survivors, rowCount: survivor_count };
        }

        // Stable passes run from least to most significant key. Because the
        // input starts in source-row order and equality returns zero, this is
        // equivalent to the former multi-key comparator including source ties.
        for (let key_index = state.sort.length - 1; key_index >= 0; key_index--) {
            const key = state.sort[key_index];
            const column = await acquire_transform_column(
                source,
                sheet_index,
                key.colIndex,
                sheet.rowCount,
                column_cache,
                is_cancelled,
                sort_instrumentation,
            );
            let numeric_keys: NumericColumnKeys | undefined;
            try {
                if (column.numeric && column.foundValue) {
                    numeric_keys = await prepare_numeric_column_keys(
                        column,
                        survivors,
                        sheet.rowCount,
                        is_cancelled,
                        sort_instrumentation,
                    );
                }
                const compare_rows = (a: number, b: number): number =>
                    numeric_keys
                        ? compare_precomputed_numeric_values(
                            column,
                            numeric_keys,
                            a,
                            b,
                            key.direction,
                            sort_instrumentation,
                        )
                        : compare_values(
                            column.values[a] ?? null,
                            column.values[b] ?? null,
                            key.direction,
                            false,
                        );
                survivors = await cooperative_stable_sort(
                    survivors,
                    compare_rows,
                    is_cancelled,
                    sort_instrumentation,
                );
            } finally {
                release_numeric_column_keys(numeric_keys, sort_instrumentation);
                release_transform_column(column, sort_instrumentation);
            }
        }

        returned_result = true;
        return { indices: survivors, rowCount: survivor_count };
    } finally {
        if (survivor_mask) {
            release_survivor_mask(survivor_mask, sort_instrumentation);
        }
        if (!returned_result && survivors) {
            release_index_buffer(survivors, sort_instrumentation);
        }
    }
}

function group_enabled_filters(
    filters: readonly FilterEntry[],
): Map<number, FilterEntry[]> {
    const groups = new Map<number, FilterEntry[]>();
    for (const filter of filters) {
        if (!filter.enabled) continue;
        const group = groups.get(filter.colIndex);
        if (group) group.push(filter);
        else groups.set(filter.colIndex, [filter]);
    }
    return groups;
}

async function acquire_transform_column(
    source: DataSource,
    sheet_index: number,
    column_index: number,
    row_count: number,
    column_cache: TransformColumnCache | undefined,
    is_cancelled: () => boolean,
    instrumentation?: TransformSortInstrumentation,
): Promise<TransformColumn> {
    const cached = column_cache?.get(sheet_index, column_index);
    if (cached) {
        const column = { ...cached };
        track_transform_column(column, instrumentation);
        return column;
    }

    await cancellation_checkpoint(is_cancelled);
    const mutable: MutableTransformColumn = {
        values: new Array(row_count),
        numeric: true,
        foundValue: false,
    };
    for (let start = 0; start < row_count; start += SCAN_ROWS_PER_CHECKPOINT) {
        const rows = read_source_columns(
            source,
            sheet_index,
            start,
            Math.min(SCAN_ROWS_PER_CHECKPOINT, row_count - start),
            [column_index],
        ).rows;
        for (let offset = 0; offset < rows.length; offset++) {
            const source_cell = rows[offset]?.[0] ?? null;
            const raw = raw_value(source_cell);
            mutable.values[start + offset] = raw;
            if (raw !== null) {
                mutable.foundValue = true;
                if (
                    source_cell?.rawType === 'boolean'
                    || (
                        source_cell?.rawType === 'number'
                        && !Number.isFinite(Number(raw))
                    )
                    || (
                        source_cell?.rawType !== 'number'
                        && !canonical_numeric_string(raw)
                    )
                ) mutable.numeric = false;
            }
        }
        await cancellation_checkpoint(is_cancelled);
    }

    // The request holds only this one active column. The cache deliberately
    // retains published columns across requests and owns its separate bound.
    const published: CachedTransformColumn = Object.freeze({
        values: Object.freeze(mutable.values),
        numeric: mutable.numeric,
        foundValue: mutable.foundValue,
    });
    column_cache?.set(sheet_index, column_index, published);
    const column = { ...published };
    track_transform_column(column, instrumentation);
    return column;
}

function track_transform_column(
    column: TransformColumn,
    instrumentation?: TransformSortInstrumentation,
): void {
    if (!instrumentation) return;
    instrumentation.transformColumnValueSlots =
        (instrumentation.transformColumnValueSlots ?? 0) + column.values.length;
    instrumentation.peakTransformColumnValueSlots = Math.max(
        instrumentation.peakTransformColumnValueSlots ?? 0,
        instrumentation.transformColumnValueSlots,
    );
}

function release_transform_column(
    column: TransformColumn,
    instrumentation?: TransformSortInstrumentation,
): void {
    if (!instrumentation) return;
    instrumentation.transformColumnValueSlots =
        (instrumentation.transformColumnValueSlots ?? 0) - column.values.length;
}

interface NumericColumnKeys {
    readonly keys: (NumericSortKey | undefined)[];
    readonly rowPositions?: Uint32Array;
    readonly interner: NumericSortKeyInterner;
}

async function prepare_numeric_column_keys(
    column: TransformColumn,
    survivors: Uint32Array,
    row_count: number,
    is_cancelled: () => boolean,
    instrumentation?: TransformSortInstrumentation,
): Promise<NumericColumnKeys> {
    // Exact all-unique inputs inherently retain one parsed key per survivor for
    // this pass. Processing sort columns sequentially bounds that peak to one
    // column; the bounded interner adds at most NUMERIC_KEY_INTERN_LIMIT refs.
    const compact = survivors.length > 0 && survivors.length <= row_count / 2;
    const state: NumericColumnKeys = {
        keys: new Array(compact ? survivors.length : row_count),
        rowPositions: compact
            ? allocate_index_buffer(row_count, instrumentation)
            : undefined,
        interner: new NumericSortKeyInterner(),
    };
    if (instrumentation) {
        instrumentation.numericSortKeySlots =
            (instrumentation.numericSortKeySlots ?? 0) + state.keys.length;
        instrumentation.peakNumericSortKeySlots = Math.max(
            instrumentation.peakNumericSortKeySlots ?? 0,
            instrumentation.numericSortKeySlots,
        );
    }
    try {
        let survivor_iterations = 0;
        for (let position = 0; position < survivors.length; position++) {
            const row = survivors[position];
            const raw = column.values[row];
            if (state.rowPositions) state.rowPositions[row] = position + 1;
            if (raw !== null && raw !== undefined) {
                state.keys[state.rowPositions ? position : row] =
                    state.interner.get(raw, instrumentation);
            }
            survivor_iterations += 1;
            if (survivor_iterations >= SORT_KEY_BUILDS_PER_CHECKPOINT) {
                survivor_iterations = 0;
                await cancellation_checkpoint(is_cancelled);
            }
        }
        if (survivor_iterations > 0 || survivors.length === 0) {
            await cancellation_checkpoint(is_cancelled);
        }
        return state;
    } catch (error) {
        release_numeric_column_keys(state, instrumentation);
        throw error;
    }
}

function release_numeric_column_keys(
    state: NumericColumnKeys | undefined,
    instrumentation?: TransformSortInstrumentation,
): void {
    if (!state) return;
    if (state.rowPositions) {
        release_index_buffer(state.rowPositions, instrumentation);
    }
    if (instrumentation) {
        instrumentation.numericSortKeySlots =
            (instrumentation.numericSortKeySlots ?? 0) - state.keys.length;
    }
}

export function compare_cells(
    a: RenderedCell | null,
    b: RenderedCell | null,
    direction: SortDirection,
    infer_numeric_strings = false,
): number {
    const a_raw = raw_value(a);
    const b_raw = raw_value(b);
    const numeric = infer_numeric_strings
        || (
            cell_can_be_numeric(a)
            && cell_can_be_numeric(b)
        );
    return compare_values(a_raw, b_raw, direction, numeric);
}

function compare_values(
    a: string | null,
    b: string | null,
    direction: SortDirection,
    numeric: boolean,
): number {
    const a_missing = a === null;
    const b_missing = b === null;
    if (a_missing && b_missing) return 0;
    if (a_missing) return 1;
    if (b_missing) return -1;

    const ascending = numeric
        ? compare_numeric_text(a, b)
        : COLLATOR.compare(a, b);
    return direction === 'asc' ? ascending : -ascending;
}

function compare_precomputed_numeric_values(
    column: TransformColumn,
    keys: NumericColumnKeys,
    a_row: number,
    b_row: number,
    direction: SortDirection,
    instrumentation?: TransformSortInstrumentation,
): number {
    const a = column.values[a_row] ?? null;
    const b = column.values[b_row] ?? null;
    const a_missing = a === null;
    const b_missing = b === null;
    if (a_missing && b_missing) return 0;
    if (a_missing) return 1;
    if (b_missing) return -1;

    if (instrumentation) instrumentation.numericSortComparisons += 1;
    const a_key_index = keys.rowPositions ? keys.rowPositions[a_row] - 1 : a_row;
    const b_key_index = keys.rowPositions ? keys.rowPositions[b_row] - 1 : b_row;
    const ascending = compare_numeric_sort_keys(
        keys.keys[a_key_index]!,
        keys.keys[b_key_index]!,
    );
    return direction === 'asc' ? ascending : -ascending;
}

export function matches_filter(
    cell: RenderedCell | null,
    entry: FilterEntry,
): boolean {
    const raw = raw_value(cell);
    return matches_filter_value(
        raw,
        entry,
        raw !== null && cell_can_be_numeric(cell),
    );
}

function matches_filter_value(
    raw: string | null,
    entry: FilterEntry,
    numeric_column: boolean,
): boolean {
    const missing = raw === null;
    if (entry.operator === 'isEmpty') return missing;
    // Sight's correction to Raven's stale include-missing bug.
    if (entry.operator === 'isNotEmpty') return !missing;
    if (missing) return false;

    const value = raw!;
    const lhs = entry.caseSensitive ? value : value.toLocaleLowerCase();
    const raw_rhs = entry.value ?? '';
    const rhs = entry.caseSensitive ? raw_rhs : raw_rhs.toLocaleLowerCase();

    switch (entry.operator) {
        case 'contains':
            return lhs.includes(rhs);
        case 'notContains':
            return !lhs.includes(rhs);
        case 'equals':
            if (numeric_column && Number.isFinite(Number(raw_rhs))) {
                return compare_numeric_text(value, raw_rhs) === 0;
            }
            return lhs === rhs;
        case 'notEquals':
            if (numeric_column && Number.isFinite(Number(raw_rhs))) {
                return compare_numeric_text(value, raw_rhs) !== 0;
            }
            return lhs !== rhs;
        case 'startsWith':
            return lhs.startsWith(rhs);
        case 'endsWith':
            return lhs.endsWith(rhs);
        case 'greaterThan':
            return compare_filter_values(value, raw_rhs, numeric_column) > 0;
        case 'greaterThanOrEqual':
            return compare_filter_values(value, raw_rhs, numeric_column) >= 0;
        case 'lessThan':
            return compare_filter_values(value, raw_rhs, numeric_column) < 0;
        case 'lessThanOrEqual':
            return compare_filter_values(value, raw_rhs, numeric_column) <= 0;
        case 'between': {
            const lo = compare_filter_values(value, raw_rhs, numeric_column);
            const hi = compare_filter_values(
                value,
                entry.secondValue ?? '',
                numeric_column,
            );
            return lo >= 0 && hi <= 0;
        }
        default: {
            const exhaustive: never = entry.operator;
            throw new Error(`Unhandled filter operator ${exhaustive}`);
        }
    }
}

export function transformed_window(
    source: DataSource,
    sheet_index: number,
    start_row: number,
    count: number,
    indices: Uint32Array | undefined,
): { startRow: number; rows: (RenderedCell | null)[][] } {
    if (!indices) return source.read_rows(sheet_index, start_row, count);
    const start = Math.max(0, Math.min(start_row, indices.length));
    const end = Math.min(start + Math.max(0, count), indices.length);
    const rows: (RenderedCell | null)[][] = [];
    let display_row = start;
    while (display_row < end) {
        const source_start = indices[display_row];
        let run_length = 1;
        while (
            display_row + run_length < end
            && indices[display_row + run_length]
                === source_start + run_length
        ) {
            run_length += 1;
        }
        const run = source.read_rows(
            sheet_index,
            source_start,
            run_length,
        ).rows;
        for (let offset = 0; offset < run_length; offset++) {
            rows.push(run[offset] ?? []);
        }
        display_row += run_length;
    }
    return { startRow: start, rows };
}

function needed_columns(
    state: SheetTransformState,
    column_count: number,
): number[] {
    const result = new Set<number>();
    for (const key of state.sort) {
        validate_column(key.colIndex, column_count);
        result.add(key.colIndex);
    }
    for (const entry of state.filters) {
        if (!entry.enabled) continue;
        validate_column(entry.colIndex, column_count);
        result.add(entry.colIndex);
    }
    return [...result];
}

function validate_column(col: number, count: number): void {
    if (!Number.isInteger(col) || col < 0 || col >= count) {
        throw new RangeError(`column index ${col} out of range`);
    }
}

function compare_filter_values(
    value: string,
    rhs: string,
    numeric_column: boolean,
): number {
    const rhs_number = Number(rhs);
    if (numeric_column && Number.isFinite(rhs_number)) {
        return compare_numeric_text(value, rhs);
    }
    return COLLATOR.compare(value, rhs);
}

function compare_numeric_text(a: string, b: string): number {
    const a_decimal = parse_canonical_decimal(a);
    const b_decimal = parse_canonical_decimal(b);
    if (a_decimal && b_decimal) {
        return compare_exact_decimals(a_decimal, b_decimal);
    }
    return Math.sign(Number(a) - Number(b));
}

interface ExactDecimal {
    readonly sign: -1 | 0 | 1;
    /** Significant decimal digits with leading and trailing zeroes removed. */
    readonly digits: string;
    /** Decimal digit count plus exponent, precomputed for hot comparisons. */
    readonly magnitude: bigint;
}

type NumericSortKey = ExactDecimal;

/**
 * Reuses exact keys for repeated raw values without retaining an entry for
 * every distinct value. The last-value fast path remains useful after the
 * bounded table fills, while all-unique inputs retain at most the fixed cap.
 */
class NumericSortKeyInterner {
    private readonly entries = new Map<string, NumericSortKey>();
    private lastRaw: string | undefined;
    private lastKey: NumericSortKey | undefined;

    get(
        raw: string,
        instrumentation?: TransformSortInstrumentation,
    ): NumericSortKey {
        if (raw === this.lastRaw) {
            if (instrumentation) {
                instrumentation.numericSortKeyReuses =
                    (instrumentation.numericSortKeyReuses ?? 0) + 1;
            }
            return this.lastKey!;
        }
        const existing = this.entries.get(raw);
        if (existing) {
            this.lastRaw = raw;
            this.lastKey = existing;
            if (instrumentation) {
                instrumentation.numericSortKeyReuses =
                    (instrumentation.numericSortKeyReuses ?? 0) + 1;
            }
            return existing;
        }

        const key = build_numeric_sort_key(raw);
        if (instrumentation) instrumentation.numericSortKeyBuilds += 1;
        if (this.entries.size < NUMERIC_KEY_INTERN_LIMIT) {
            this.entries.set(raw, key);
            if (instrumentation) {
                instrumentation.numericSortKeyInternPeakEntries = Math.max(
                    instrumentation.numericSortKeyInternPeakEntries ?? 0,
                    this.entries.size,
                );
            }
        }
        this.lastRaw = raw;
        this.lastKey = key;
        return key;
    }
}

function parse_canonical_decimal(value: string): ExactDecimal | undefined {
    const match = /^([+-]?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
    if (!match) return undefined;
    if (!Number.isFinite(Number(value))) return undefined;

    const fraction = match[3] ?? '';
    let digits = `${match[2]}${fraction}`.replace(/^0+/, '');
    if (digits === '') {
        return {
            sign: 0,
            digits: '',
            magnitude: 0n,
        };
    }

    const trailing_zeroes = digits.length - digits.replace(/0+$/, '').length;
    if (trailing_zeroes > 0) digits = digits.slice(0, -trailing_zeroes);
    const exponent = BigInt(match[4] ?? '0')
        - BigInt(fraction.length)
        + BigInt(trailing_zeroes);
    return {
        sign: match[1] === '-' ? -1 : 1,
        digits,
        magnitude: BigInt(digits.length) + exponent,
    };
}

function build_numeric_sort_key(value: string): NumericSortKey {
    const exact = parse_canonical_decimal(value);
    if (exact) return exact;

    // Finite rawType:number cells may use non-canonical text such as `1.` or
    // `.5`. Canonicalize their actual IEEE-754 value once so every key shares
    // the same exact, transitive comparison domain.
    return parse_canonical_decimal(String(Number(value)))!;
}

function compare_numeric_sort_keys(a: NumericSortKey, b: NumericSortKey): number {
    return compare_exact_decimals(a, b);
}

function compare_exact_decimals(a: ExactDecimal, b: ExactDecimal): number {
    if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
    if (a.sign === 0) return 0;

    const magnitude = compare_decimal_magnitudes(a, b);
    return a.sign === 1 ? magnitude : -magnitude;
}

function compare_decimal_magnitudes(a: ExactDecimal, b: ExactDecimal): number {
    if (a.magnitude !== b.magnitude) {
        return a.magnitude < b.magnitude ? -1 : 1;
    }

    const length = Math.max(a.digits.length, b.digits.length);
    for (let index = 0; index < length; index++) {
        const a_digit = a.digits.charCodeAt(index) || 48;
        const b_digit = b.digits.charCodeAt(index) || 48;
        if (a_digit !== b_digit) return a_digit < b_digit ? -1 : 1;
    }
    return 0;
}

function validate_filter_operands(
    filters: readonly FilterEntry[],
    column: TransformColumn,
): void {
    const numeric_operators = new Set<FilterEntry['operator']>([
        'equals',
        'notEquals',
        'greaterThan',
        'greaterThanOrEqual',
        'lessThan',
        'lessThanOrEqual',
        'between',
    ]);
    if (!column.numeric || !column.foundValue) return;
    for (const entry of filters) {
        if (!numeric_operators.has(entry.operator)) continue;
        if (!finite_number_text(entry.value)) {
            throw new Error('Numeric filter values must be finite numbers.');
        }
        if (
            entry.operator === 'between'
            && !finite_number_text(entry.secondValue)
        ) {
            throw new Error('Numeric filter values must be finite numbers.');
        }
    }
}

function finite_number_text(value: string | undefined): boolean {
    return value !== undefined
        && value.trim() !== ''
        && Number.isFinite(Number(value));
}

function raw_value(cell: RenderedCell | null | undefined): string | null {
    return !cell || cell.raw === null || cell.raw === '' ? null : cell.raw;
}

function cell_can_be_numeric(
    cell: RenderedCell | null | undefined,
): boolean {
    const raw = raw_value(cell);
    if (raw === null || cell?.rawType === 'boolean') return false;
    if (cell?.rawType === 'number') return Number.isFinite(Number(raw));
    if (cell?.rawType === 'string') return false;
    return canonical_numeric_string(raw);
}

function canonical_numeric_string(value: string): boolean {
    if (value.trim() !== value) return false;
    if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
        return false;
    }
    return Number.isFinite(Number(value));
}

async function cooperative_stable_sort(
    rows: Uint32Array,
    compare: (a: number, b: number) => number,
    is_cancelled: () => boolean,
    instrumentation?: TransformSortInstrumentation,
): Promise<Uint32Array> {
    if (rows.length < 2) {
        await cancellation_checkpoint(is_cancelled);
        return rows;
    }

    // Native sort remains useful for small bounded runs. Global ordering is then
    // produced by cooperative merge passes, avoiding one monolithic event-loop
    // block for a large sheet.
    for (let start = 0; start < rows.length; start += SORT_CHUNK_ROWS) {
        const end = Math.min(start + SORT_CHUNK_ROWS, rows.length);
        rows.subarray(start, end).sort(compare);
        await cancellation_checkpoint(is_cancelled);
    }

    if (rows.length <= SORT_CHUNK_ROWS) return rows;

    let source = rows;
    const scratch = allocate_index_buffer(rows.length, instrumentation);
    let target = scratch;
    let returned_buffer = false;
    try {
        for (
            let width = SORT_CHUNK_ROWS;
            width < rows.length;
            width *= 2
        ) {
            let operations = 0;
            for (let left = 0; left < rows.length; left += width * 2) {
                const middle = Math.min(left + width, rows.length);
                const right = Math.min(left + width * 2, rows.length);
                let a = left;
                let b = middle;
                let out = left;
                while (a < middle && b < right) {
                    target[out++] = compare(source[a], source[b]) <= 0
                        ? source[a++]
                        : source[b++];
                    operations += 1;
                    if (operations >= SORT_OPERATIONS_PER_CHECKPOINT) {
                        operations = 0;
                        await cancellation_checkpoint(is_cancelled);
                    }
                }
                while (a < middle) {
                    target[out++] = source[a++];
                    operations += 1;
                    if (operations >= SORT_OPERATIONS_PER_CHECKPOINT) {
                        operations = 0;
                        await cancellation_checkpoint(is_cancelled);
                    }
                }
                while (b < right) {
                    target[out++] = source[b++];
                    operations += 1;
                    if (operations >= SORT_OPERATIONS_PER_CHECKPOINT) {
                        operations = 0;
                        await cancellation_checkpoint(is_cancelled);
                    }
                }
            }
            if (operations > 0) await cancellation_checkpoint(is_cancelled);
            [source, target] = [target, source];
        }

        // The caller adopts the buffer containing the last merge pass. Logically
        // release the other buffer immediately; no final full-size copy is needed.
        release_index_buffer(target, instrumentation);
        returned_buffer = true;
        return source;
    } finally {
        if (!returned_buffer) {
            // On cancellation/comparator failure, the caller still owns `rows`.
            release_index_buffer(scratch, instrumentation);
        }
    }
}

function allocate_index_buffer(
    length: number,
    instrumentation?: TransformSortInstrumentation,
): Uint32Array {
    const result = new Uint32Array(length);
    if (instrumentation) {
        const bytes = result.byteLength;
        instrumentation.indexBufferAllocations =
            (instrumentation.indexBufferAllocations ?? 0) + 1;
        instrumentation.indexBufferCount =
            (instrumentation.indexBufferCount ?? 0) + 1;
        instrumentation.indexBufferBytes =
            (instrumentation.indexBufferBytes ?? 0) + bytes;
        instrumentation.peakIndexBufferCount = Math.max(
            instrumentation.peakIndexBufferCount ?? 0,
            instrumentation.indexBufferCount,
        );
        instrumentation.peakIndexBufferBytes = Math.max(
            instrumentation.peakIndexBufferBytes ?? 0,
            instrumentation.indexBufferBytes,
        );
    }
    return result;
}

function allocate_survivor_mask(
    length: number,
    instrumentation?: TransformSortInstrumentation,
): Uint8Array {
    const result = new Uint8Array(length);
    if (instrumentation) {
        instrumentation.survivorMaskBytes =
            (instrumentation.survivorMaskBytes ?? 0) + result.byteLength;
        instrumentation.peakSurvivorMaskBytes = Math.max(
            instrumentation.peakSurvivorMaskBytes ?? 0,
            instrumentation.survivorMaskBytes,
        );
    }
    return result;
}

function release_survivor_mask(
    mask: Uint8Array,
    instrumentation?: TransformSortInstrumentation,
): void {
    if (!instrumentation) return;
    instrumentation.survivorMaskBytes =
        (instrumentation.survivorMaskBytes ?? 0) - mask.byteLength;
}

function release_index_buffer(
    buffer: Uint32Array,
    instrumentation?: TransformSortInstrumentation,
): void {
    if (!instrumentation) return;
    instrumentation.indexBufferReleases =
        (instrumentation.indexBufferReleases ?? 0) + 1;
    instrumentation.indexBufferCount =
        (instrumentation.indexBufferCount ?? 0) - 1;
    instrumentation.indexBufferBytes =
        (instrumentation.indexBufferBytes ?? 0) - buffer.byteLength;
}

async function cancellation_checkpoint(
    is_cancelled: () => boolean,
): Promise<void> {
    if (is_cancelled()) throw cancelled_error();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (is_cancelled()) throw cancelled_error();
}

function cancelled_error(): Error {
    const error = new Error('Transform cancelled');
    error.name = 'AbortError';
    return error;
}
