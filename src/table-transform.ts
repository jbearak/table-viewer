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
const SORT_CHUNK_ROWS = 2048;
const SORT_OPERATIONS_PER_CHECKPOINT = 4096;
const COMPACT_ROWS_PER_CHECKPOINT = 4096;
const COLLATOR = new Intl.Collator(undefined, {
    sensitivity: 'variant',
    numeric: true,
});

export interface TransformResult {
    /** Display-row -> source-row. Undefined is the identity view. */
    indices: Uint32Array | undefined;
    rowCount: number;
}

interface TransformColumn {
    values: (string | null | undefined)[];
    numeric: boolean;
    foundValue: boolean;
}

export async function compute_transform(
    source: DataSource,
    sheet_index: number,
    state: SheetTransformState,
    is_cancelled: () => boolean = () => false,
): Promise<TransformResult> {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) {
        throw new RangeError(`sheet index ${sheet_index} out of range`);
    }
    if (!transform_is_active(state)) {
        return { indices: undefined, rowCount: sheet.rowCount };
    }

    const columns = needed_columns(state, sheet.columnCount);
    await cancellation_checkpoint(is_cancelled);
    const values = new Map<number, TransformColumn>();
    for (const col of columns) {
        values.set(col, {
            // Sparse allocation avoids an eager, uncancellable O(rows × columns)
            // null-fill. Every source row is assigned during the scan below.
            values: new Array(sheet.rowCount),
            numeric: true,
            foundValue: false,
        });
    }
    await cancellation_checkpoint(is_cancelled);

    for (
        let start = 0;
        start < sheet.rowCount;
        start += SCAN_ROWS_PER_CHECKPOINT
    ) {
        const rows = read_source_columns(
            source,
            sheet_index,
            start,
            Math.min(SCAN_ROWS_PER_CHECKPOINT, sheet.rowCount - start),
            columns,
        ).rows;
        for (let offset = 0; offset < rows.length; offset++) {
            const source_row = start + offset;
            for (let selected = 0; selected < columns.length; selected++) {
                const col = columns[selected];
                const target = values.get(col)!;
                const source_cell = rows[offset]?.[selected] ?? null;
                const raw = raw_value(source_cell);
                target.values[source_row] = raw;
                if (raw !== null) {
                    target.foundValue = true;
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
                    ) {
                        target.numeric = false;
                    }
                }
            }
        }
        await cancellation_checkpoint(is_cancelled);
    }

    validate_filter_operands(state, values);
    const survivors: number[] = [];
    await cancellation_checkpoint(is_cancelled);
    for (let row = 0; row < sheet.rowCount; row++) {
        let matches = true;
        for (const filter of state.filters) {
            if (!filter.enabled) continue;
            const column = values.get(filter.colIndex);
            if (!matches_filter_value(
                column?.values[row] ?? null,
                filter,
                !!column?.numeric && column.foundValue,
            )) {
                matches = false;
                break;
            }
        }
        if (matches) survivors.push(row);
        if ((row + 1) % FILTER_ROWS_PER_CHECKPOINT === 0) {
            await cancellation_checkpoint(is_cancelled);
        }
    }
    if (sheet.rowCount % FILTER_ROWS_PER_CHECKPOINT !== 0) {
        await cancellation_checkpoint(is_cancelled);
    }

    if (state.sort.length > 0) {
        const compare_rows = (a: number, b: number): number => {
            for (const key of state.sort) {
                const column = values.get(key.colIndex)!;
                const result = compare_values(
                    column.values[a] ?? null,
                    column.values[b] ?? null,
                    key.direction,
                    column.numeric && column.foundValue,
                );
                if (result !== 0) return result;
            }
            return a - b;
        };
        await cooperative_stable_sort(
            survivors,
            compare_rows,
            is_cancelled,
        );
    }

    const indices = await compact_indices(survivors, is_cancelled);
    return {
        indices,
        rowCount: survivors.length,
    };
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
    sign: -1 | 0 | 1;
    /** Significant decimal digits with leading and trailing zeroes removed. */
    digits: string;
    /** Power of ten applied to `digits`. */
    exponent: bigint;
}

function parse_canonical_decimal(value: string): ExactDecimal | undefined {
    const match = /^([+-]?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
    if (!match || !Number.isFinite(Number(value))) return undefined;

    const fraction = match[3] ?? '';
    let digits = `${match[2]}${fraction}`.replace(/^0+/, '');
    if (digits === '') return { sign: 0, digits: '', exponent: 0n };

    const trailing_zeroes = digits.length - digits.replace(/0+$/, '').length;
    if (trailing_zeroes > 0) digits = digits.slice(0, -trailing_zeroes);
    const exponent = BigInt(match[4] ?? '0')
        - BigInt(fraction.length)
        + BigInt(trailing_zeroes);
    return {
        sign: match[1] === '-' ? -1 : 1,
        digits,
        exponent,
    };
}

function compare_exact_decimals(a: ExactDecimal, b: ExactDecimal): number {
    if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
    if (a.sign === 0) return 0;

    const magnitude = compare_decimal_magnitudes(a, b);
    return a.sign === 1 ? magnitude : -magnitude;
}

function compare_decimal_magnitudes(a: ExactDecimal, b: ExactDecimal): number {
    const a_magnitude = BigInt(a.digits.length) + a.exponent;
    const b_magnitude = BigInt(b.digits.length) + b.exponent;
    if (a_magnitude !== b_magnitude) {
        return a_magnitude < b_magnitude ? -1 : 1;
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
    state: SheetTransformState,
    columns: Map<number, TransformColumn>,
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
    for (const entry of state.filters) {
        if (!entry.enabled || !numeric_operators.has(entry.operator)) continue;
        const column = columns.get(entry.colIndex);
        if (!column || !column.numeric || !column.foundValue) continue;
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
    rows: number[],
    compare: (a: number, b: number) => number,
    is_cancelled: () => boolean,
): Promise<void> {
    if (rows.length < 2) {
        await cancellation_checkpoint(is_cancelled);
        return;
    }

    // Native sort remains useful for small bounded runs. Global ordering is then
    // produced by cooperative merge passes, avoiding one monolithic event-loop
    // block for a large sheet.
    for (let start = 0; start < rows.length; start += SORT_CHUNK_ROWS) {
        const end = Math.min(start + SORT_CHUNK_ROWS, rows.length);
        const sorted_chunk = rows.slice(start, end).sort(compare);
        for (let offset = 0; offset < sorted_chunk.length; offset++) {
            rows[start + offset] = sorted_chunk[offset];
        }
        await cancellation_checkpoint(is_cancelled);
    }

    if (rows.length <= SORT_CHUNK_ROWS) return;

    let source = rows;
    let target = new Array<number>(rows.length);
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

    if (source !== rows) {
        for (let start = 0; start < rows.length; start += COMPACT_ROWS_PER_CHECKPOINT) {
            const end = Math.min(start + COMPACT_ROWS_PER_CHECKPOINT, rows.length);
            for (let index = start; index < end; index++) {
                rows[index] = source[index];
            }
            await cancellation_checkpoint(is_cancelled);
        }
    }
}

async function compact_indices(
    rows: number[],
    is_cancelled: () => boolean,
): Promise<Uint32Array> {
    await cancellation_checkpoint(is_cancelled);
    const indices = new Uint32Array(rows.length);
    for (let start = 0; start < rows.length; start += COMPACT_ROWS_PER_CHECKPOINT) {
        const end = Math.min(start + COMPACT_ROWS_PER_CHECKPOINT, rows.length);
        for (let index = start; index < end; index++) {
            indices[index] = rows[index];
        }
        await cancellation_checkpoint(is_cancelled);
    }
    return indices;
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
