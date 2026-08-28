import {
    read_source_columns,
    type DataSource,
    type RenderedCell,
} from './data-source/interface';
import {
    UNKNOWN_XLSX_FORMULA_RESULT,
    a1_formula_reference_at,
    is_xlsx_formula_text,
} from './xlsx-formula';
import { number_format_is_date } from './spreadsheet-format';
import {
    classify_xlsx_cell_value,
    iso_to_serial,
    xlsx_runs_require_inline_string,
} from './xlsx-cell-value';
import type { RichTextRun } from './cell-content';
import { cell_whole_style } from './cell-edit-model';

const MAX_RANGE_CELLS_PER_READ = 8_192;
const MAX_RANGE_COLUMNS_PER_READ = 256;
const PARSER_WORK_PER_CHECKPOINT = 1_024;
// Excel's documented formula-text limit, plus the editor's leading '='.
const MAX_CALCULATED_FORMULA_LENGTH = 8_193;
// A save runs on the extension host. Keep its cache-refresh fallback below one
// broad event-loop stall; formulas left unfinished have their stale caches
// removed and Excel recalculates them when the saved workbook opens.
const MAX_SYNCHRONOUS_CALCULATION_WORK = 262_144;
const CALCULATION_WORK_EXHAUSTED = Symbol('calculation-work-exhausted');

export interface FormulaCalculationAddress {
    readonly sheetIndex: number;
    readonly row: number;
    readonly column: number;
}

export interface FormulaCalculationEdit extends FormulaCalculationAddress {
    readonly value: string;
    /** Exact classification chosen by the eventual XLSX writer. */
    readonly writesFormula: boolean;
    readonly runs?: readonly RichTextRun[];
}

export type FormulaCalculationError =
    | 'unsupported function'
    | 'parse error'
    | 'cycle'
    | 'numeric error';

/** A calculation always settles as either a numeric value or a specific failure. */
export type FormulaCalculationResult = FormulaCalculationAddress & (
    | { readonly value: string; readonly error?: never }
    | { readonly value?: never; readonly error: FormulaCalculationError }
);

export interface FormulaCalculationRequest {
    readonly edits: readonly FormulaCalculationEdit[];
    readonly targets: readonly FormulaCalculationAddress[];
}

export interface FormulaCalculationSchedule {
    /** Stop before doing more source reads when this request has become stale. */
    readonly isCancelled: () => boolean;
    /** Scheduling seam used by the host and deterministic unit tests. */
    readonly yieldControl?: () => Promise<void>;
    /** Maximum wall-clock work between scheduling points. */
    readonly workSliceMs?: number;
}

type CalculationSteps<T> = Generator<void, T, void>;

type Scalar =
    | { readonly kind: 'number'; readonly value: number }
    | { readonly kind: 'boolean'; readonly value: 0 | 1 }
    | { readonly kind: 'blank' }
    | { readonly kind: 'text'; readonly value: string }
    | { readonly kind: 'unknown'; readonly error: FormulaCalculationError };

interface RangeValue {
    readonly kind: 'range';
    readonly sheetIndex: number;
    readonly firstRow: number;
    readonly firstColumn: number;
    readonly lastRow: number;
    readonly lastColumn: number;
}

type FormulaValue = Scalar | RangeValue;

const PARSE_ERROR: Scalar = Object.freeze({ kind: 'unknown', error: 'parse error' });
const UNSUPPORTED_FUNCTION: Scalar = Object.freeze({
    kind: 'unknown', error: 'unsupported function',
});
const CYCLE: Scalar = Object.freeze({ kind: 'unknown', error: 'cycle' });
const NUMERIC_ERROR: Scalar = Object.freeze({ kind: 'unknown', error: 'numeric error' });
const BLANK: Scalar = Object.freeze({ kind: 'blank' });

function address_key(address: FormulaCalculationAddress): string {
    return `${address.sheetIndex}:${address.row}:${address.column}`;
}

function finite_number(value: number): Scalar {
    return Number.isFinite(value) ? { kind: 'number', value } : NUMERIC_ERROR;
}

function numeric_text(value: string): number | undefined {
    const trimmed = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        return undefined;
    }
    const number = Number(trimmed);
    const mantissa = trimmed.replace(/[eE][+-]?\d+$/, '').replace(/[+-]/, '').replace('.', '');
    const significant_digits = mantissa.replace(/^0+/, '').length;
    const underflowed = number === 0
        && /[1-9]/.test(trimmed.replace(/[eE][+-]?\d+$/, ''));
    return Number.isFinite(number) && !underflowed && significant_digits <= 15
        ? number
        : undefined;
}

function scalar_from_cell(cell: RenderedCell | null | undefined): Scalar {
    if (!cell || cell.raw === null || cell.raw === '' || cell.rawType === 'empty') return BLANK;
    if (cell.rawType === 'number' || cell.rawType === 'date') {
        const value = cell.numericRaw ?? Number(cell.raw);
        return finite_number(value);
    }
    if (cell.rawType === 'error') return NUMERIC_ERROR;
    if (cell.rawType === 'boolean') {
        if (cell.raw === '1' || cell.raw.toUpperCase() === 'TRUE') {
            return { kind: 'boolean', value: 1 };
        }
        if (cell.raw === '0' || cell.raw.toUpperCase() === 'FALSE') {
            return { kind: 'boolean', value: 0 };
        }
        return NUMERIC_ERROR;
    }
    return { kind: 'text', value: cell.raw };
}

function scalar_from_edit(
    edit: FormulaCalculationEdit,
    cell: RenderedCell | null | undefined,
): Scalar {
    const { value } = edit;
    if (
        edit.runs !== undefined
        && edit.runs.length > 0
        && xlsx_runs_require_inline_string(
            edit.runs,
            cell ? cell_whole_style(cell) : undefined,
        )
    ) return { kind: 'text', value };
    let date_mode: 0 | 1 = cell?.numberFormat?.date1904 ? 1 : 0;
    if (
        date_mode === 0
        && cell?.xlsxIsoDate === true
        && cell.numericRaw !== undefined
        && typeof cell.raw === 'string'
    ) {
        const serial_1904 = iso_to_serial(cell.raw, 1);
        if (
            serial_1904 !== null
            && Math.abs(serial_1904 - cell.numericRaw) < 1e-9
        ) date_mode = 1;
    }
    const classified = classify_xlsx_cell_value(value, {
        datemode: date_mode,
        was_boolean: cell?.rawType === 'boolean',
        was_iso_date: cell?.xlsxIsoDate === true,
        is_date_style: (serial) => cell?.numberFormat !== undefined
            && number_format_is_date(cell.numberFormat, serial),
    });
    if (classified.kind === 'empty') return BLANK;
    if (classified.kind === 'boolean') {
        return { kind: 'boolean', value: classified.text === '1' ? 1 : 0 };
    }
    if (classified.kind === 'number') return finite_number(Number(classified.text));
    if (classified.kind === 'iso-date') {
        const serial = iso_to_serial(classified.text, date_mode);
        return serial === null ? { kind: 'text', value } : finite_number(serial);
    }
    return { kind: 'text', value: classified.text };
}

function arithmetic_number(value: FormulaValue): number | Scalar {
    if (value.kind === 'number') return value.value;
    if (value.kind === 'boolean') return value.value;
    if (value.kind === 'blank') return 0;
    if (value.kind === 'text') {
        const number = numeric_text(value.value);
        return number === undefined ? NUMERIC_ERROR : number;
    }
    if (value.kind === 'unknown') return value;
    return NUMERIC_ERROR;
}

function arithmetic_error(value: number | Scalar): Scalar | undefined {
    return typeof value === 'number' ? undefined : value;
}

function result_text(value: number): string {
    // Excel stores at most 15 significant decimal digits. Trimming at the same
    // point also keeps ordinary expressions such as 0.1+0.2 out of the UI as a
    // JavaScript implementation detail.
    return String(Number(value.toPrecision(15)));
}

/**
 * Calculate selected formulas against canonical workbook coordinates.
 *
 * The interface names only edits and targets. Formula parsing, recursion,
 * cross-sheet lookup, range streaming, memoization, and error containment stay
 * behind this seam. Memory is O(targets + edits + one 8K-cell range chunk),
 * not O(the workbook or the request's point-reference count).
 */
function* calculate_workbook_formula_steps(
    source: DataSource,
    request: FormulaCalculationRequest,
    max_work?: number,
): CalculationSteps<readonly FormulaCalculationResult[]> {
    const sheets = source.meta().sheets;
    const sheet_names = sheets.map((sheet) => sheet.name);
    const sheet_lookup = new Map(sheet_names.map((name, index) => [name.toUpperCase(), index]));
    const edits = new Map(request.edits.map((edit) => [address_key(edit), edit]));
    const targets = new Set(request.targets.map(address_key));
    const memo = new Map<string, Scalar>();
    const visiting = new Set<string>();
    let parser_work = 0;
    let work_remaining = max_work;

    const consume_work = (units: number): void => {
        if (work_remaining === undefined) return;
        if (units > work_remaining) throw CALCULATION_WORK_EXHAUSTED;
        work_remaining -= units;
    };

    const parser_checkpoint = function* (): CalculationSteps<void> {
        parser_work += 1;
        if (parser_work >= PARSER_WORK_PER_CHECKPOINT) {
            parser_work = 0;
            yield;
        }
    };

    const valid_address = (address: FormulaCalculationAddress): boolean => {
        const sheet = sheets[address.sheetIndex];
        return sheet !== undefined
            && Number.isInteger(address.row)
            && address.row >= 0
            && address.row < sheet.sourceRowCount
            && Number.isInteger(address.column)
            && address.column >= 0
            && address.column < sheet.columnCount;
    };

    const read_cells = (
        sheet_index: number,
        start_row: number,
        count: number,
        columns: readonly number[],
    ): (RenderedCell | null)[][] => {
        consume_work(count * columns.length);
        const canonical = source.read_canonical_columns?.(
            sheet_index, start_row, count, columns,
        );
        return (canonical ?? read_source_columns(
            source, sheet_index, start_row, count, columns,
        )).rows;
    };

    const read_cell = (address: FormulaCalculationAddress): RenderedCell | null | undefined => (
        read_cells(address.sheetIndex, address.row, 1, [address.column])[0]?.[0]
    );

    let evaluate_cell!: (
        address: FormulaCalculationAddress,
        supplied?: RenderedCell | null,
    ) => CalculationSteps<Scalar>;

    class Parser {
        private offset = 1;

        constructor(
            private readonly formula: string,
            private readonly formula_sheet_index: number,
        ) {}

        *parse(): CalculationSteps<Scalar> {
            if (
                !is_xlsx_formula_text(this.formula)
                || this.formula.length > MAX_CALCULATED_FORMULA_LENGTH
            ) return PARSE_ERROR;
            consume_work(this.formula.length);
            const value = yield* this.additive();
            yield* this.whitespace();
            if (this.offset !== this.formula.length || value.kind === 'range') {
                return value.kind === 'unknown' && value.error === 'unsupported function'
                    ? value
                    : PARSE_ERROR;
            }
            return value;
        }

        private *whitespace(): CalculationSteps<void> {
            let scanned = 0;
            while (/\s/.test(this.formula[this.offset] ?? '')) {
                this.offset += 1;
                scanned += 1;
                if (scanned >= PARSER_WORK_PER_CHECKPOINT) {
                    scanned = 0;
                    yield;
                }
            }
        }

        private *additive(): CalculationSteps<FormulaValue> {
            let left = yield* this.multiplicative();
            while (true) {
                yield* this.whitespace();
                const operator = this.formula[this.offset];
                if (operator !== '+' && operator !== '-') return left;
                this.offset += 1;
                const right = yield* this.multiplicative();
                const a = arithmetic_number(left);
                const b = arithmetic_number(right);
                left = arithmetic_error(a) ?? arithmetic_error(b)
                    ?? finite_number(operator === '+' ? (a as number) + (b as number)
                        : (a as number) - (b as number));
            }
        }

        private *multiplicative(): CalculationSteps<FormulaValue> {
            let left = yield* this.power();
            while (true) {
                yield* this.whitespace();
                const operator = this.formula[this.offset];
                if (operator !== '*' && operator !== '/') return left;
                this.offset += 1;
                const right = yield* this.power();
                const a = arithmetic_number(left);
                const b = arithmetic_number(right);
                left = arithmetic_error(a) ?? arithmetic_error(b)
                    ?? (operator === '/' && b === 0
                        ? NUMERIC_ERROR
                        : finite_number(operator === '*'
                            ? (a as number) * (b as number)
                            : (a as number) / (b as number)));
            }
        }

        private *power(): CalculationSteps<FormulaValue> {
            let left = yield* this.unary();
            yield* this.whitespace();
            if (this.formula[this.offset] !== '^') return left;
            this.offset += 1;
            const right = yield* this.power();
            const a = arithmetic_number(left);
            const b = arithmetic_number(right);
            left = arithmetic_error(a) ?? arithmetic_error(b)
                ?? finite_number((a as number) ** (b as number));
            return left;
        }

        private *unary(): CalculationSteps<FormulaValue> {
            yield* this.whitespace();
            const operator = this.formula[this.offset];
            if (operator === '+' || operator === '-') {
                this.offset += 1;
                const value = arithmetic_number(yield* this.unary());
                return arithmetic_error(value)
                    ?? finite_number(operator === '-' ? -(value as number) : value as number);
            }
            let value = yield* this.primary();
            yield* this.whitespace();
            while (this.formula[this.offset] === '%') {
                const number = arithmetic_number(value);
                value = arithmetic_error(number) ?? finite_number((number as number) / 100);
                this.offset += 1;
                yield* parser_checkpoint();
                yield* this.whitespace();
            }
            return value;
        }

        private *primary(): CalculationSteps<FormulaValue> {
            yield* parser_checkpoint();
            yield* this.whitespace();
            if (this.formula[this.offset] === '(') {
                this.offset += 1;
                const value = yield* this.additive();
                yield* this.whitespace();
                if (this.formula[this.offset] !== ')') return PARSE_ERROR;
                this.offset += 1;
                return value;
            }

            const reference = a1_formula_reference_at(this.formula, this.offset);
            if (reference) {
                this.offset += reference.length;
                const ref = reference.reference;
                const source_sheet = ref.sheetName === undefined
                    ? this.formula_sheet_index
                    : sheet_lookup.get(ref.sheetName.toUpperCase());
                if (source_sheet === undefined) return PARSE_ERROR;
                const sheet = sheets[source_sheet];
                if (!sheet) return PARSE_ERROR;
                const first_row = Math.max(0, ref.firstRow);
                const first_column = Math.max(0, ref.firstColumn);
                const last_row = Math.min(ref.lastRow, sheet.sourceRowCount - 1);
                const last_column = Math.min(ref.lastColumn, sheet.columnCount - 1);
                const single_cell = ref.firstRow === ref.lastRow
                    && ref.firstColumn === ref.lastColumn;
                if (single_cell && (first_row > last_row || first_column > last_column)) {
                    return BLANK;
                }
                if (single_cell) {
                    return yield* evaluate_cell({
                        sheetIndex: source_sheet,
                        row: first_row,
                        column: first_column,
                    });
                }
                return {
                    kind: 'range',
                    sheetIndex: source_sheet,
                    firstRow: first_row,
                    firstColumn: first_column,
                    lastRow: last_row,
                    lastColumn: last_column,
                };
            }

            const number = this.formula.slice(this.offset).match(
                /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/,
            );
            if (number) {
                this.offset += number[0].length;
                return finite_number(Number(number[0]));
            }

            const identifier = this.formula.slice(this.offset).match(/^([A-Za-z_][A-Za-z0-9_.]*)/);
            if (!identifier) return PARSE_ERROR;
            this.offset += identifier[0].length;
            yield* this.whitespace();
            if (this.formula[this.offset] !== '(') return PARSE_ERROR;
            this.offset += 1;
            return yield* this.call(identifier[1].toUpperCase());
        }

        private *call(name: string): CalculationSteps<FormulaValue> {
            if (name !== 'SUM' && name !== 'AVERAGE') {
                // Consume nothing else. The outer full-input check will reject
                // this formula without accidentally recognizing references
                // inside an unsupported function as a partial calculation.
                return UNSUPPORTED_FUNCTION;
            }
            let total = 0;
            let count = 0;
            let calculation_error: Scalar | undefined;
            yield* this.whitespace();
            if (this.formula[this.offset] === ')') {
                this.offset += 1;
                return name === 'SUM' ? finite_number(0) : NUMERIC_ERROR;
            }
            while (true) {
                const argument = yield* this.additive();
                const error = argument.kind === 'range'
                    ? yield* this.aggregate_range(argument, (number) => {
                        total += number;
                        count += 1;
                    })
                    : argument.kind === 'number'
                    ? (total += argument.value, count += 1, undefined)
                    : argument.kind === 'unknown' ? argument : undefined;
                calculation_error ??= error;
                if (!Number.isFinite(total)) return NUMERIC_ERROR;
                yield* this.whitespace();
                if (this.formula[this.offset] === ')') {
                    this.offset += 1;
                    break;
                }
                if (this.formula[this.offset] !== ',') return PARSE_ERROR;
                this.offset += 1;
            }
            if (calculation_error) return calculation_error;
            return name === 'AVERAGE'
                ? count === 0 ? NUMERIC_ERROR : finite_number(total / count)
                : finite_number(total);
        }

        private *aggregate_range(
            range: RangeValue,
            accept: (number: number) => void,
        ): CalculationSteps<Scalar | undefined> {
            for (
                let column_start = range.firstColumn;
                column_start <= range.lastColumn;
                column_start += MAX_RANGE_COLUMNS_PER_READ
            ) {
                const column_count = Math.min(
                    MAX_RANGE_COLUMNS_PER_READ,
                    range.lastColumn - column_start + 1,
                );
                const columns = Array.from({ length: column_count }, (_, i) => column_start + i);
                const rows_per_read = Math.max(1, Math.floor(MAX_RANGE_CELLS_PER_READ / column_count));
                for (
                    let row_start = range.firstRow;
                    row_start <= range.lastRow;
                    row_start += rows_per_read
                ) {
                    const row_count = Math.min(rows_per_read, range.lastRow - row_start + 1);
                    const rows = read_cells(range.sheetIndex, row_start, row_count, columns);
                    for (let row_offset = 0; row_offset < row_count; row_offset += 1) {
                        for (let column_offset = 0; column_offset < columns.length; column_offset += 1) {
                            const address = {
                                sheetIndex: range.sheetIndex,
                                row: row_start + row_offset,
                                column: columns[column_offset],
                            };
                            const scalar = yield* evaluate_cell(
                                address,
                                rows[row_offset]?.[column_offset] ?? null,
                            );
                            if (scalar.kind === 'unknown') return scalar;
                            if (scalar.kind === 'number') accept(scalar.value);
                        }
                    }
                    yield;
                }
            }
            return undefined;
        }
    }

    evaluate_cell = function* (address, supplied): CalculationSteps<Scalar> {
        if (!valid_address(address)) return PARSE_ERROR;
        const key = address_key(address);
        const cached = memo.get(key);
        if (cached) return cached;
        if (visiting.has(key)) return CYCLE;

        const edit = edits.get(key);
        const cell = supplied === undefined ? read_cell(address) : supplied;
        const formula = edit?.writesFormula === true
            ? edit.value
            : edit === undefined ? cell?.formula : undefined;
        // Some OOXML formula producers (notably what-if data tables) expose a
        // dependency target but no evaluable formula text. A requested target
        // without source text is opaque, not the cached literal currently in
        // its `<v>`; returning that literal would preserve the stale cache.
        if (edit === undefined && targets.has(key) && formula === undefined) {
            memo.set(key, UNSUPPORTED_FUNCTION);
            return UNSUPPORTED_FUNCTION;
        }
        const evaluates_formula = formula !== undefined
            && (edit !== undefined || targets.has(key) || cell?.formulaResultPending === true);
        if (evaluates_formula) {
            visiting.add(key);
            const value = yield* new Parser(formula, address.sheetIndex).parse();
            visiting.delete(key);
            memo.set(key, value);
            return value;
        }
        const value = edit === undefined ? scalar_from_cell(cell) : scalar_from_edit(edit, cell);
        // Retain request-owned edits and targets, but not ordinary source
        // literals. A legal request can contain a million distinct point
        // references; memoizing those values would turn calculation into a
        // second in-memory copy of that part of the workbook. Formula values
        // were handled above and remain memoized for recursive dependents.
        if (edit !== undefined || targets.has(key)) memo.set(key, value);
        return value;
    };

    const results: FormulaCalculationResult[] = [];
    for (const target of request.targets) {
        let calculated: Scalar;
        try {
            calculated = yield* evaluate_cell(target);
        } catch (error) {
            if (error === CALCULATION_WORK_EXHAUSTED) return results;
            throw error;
        }
        results.push(calculated.kind === 'number'
            ? { ...target, value: result_text(calculated.value) }
            : { ...target, error: calculated.kind === 'unknown'
                ? calculated.error
                : 'numeric error' });
        yield;
    }
    return results;
}

/** Calculate synchronously for save planning and focused callers. */
export function calculate_workbook_formulas(
    source: DataSource,
    request: FormulaCalculationRequest,
): readonly FormulaCalculationResult[] {
    const steps = calculate_workbook_formula_steps(source, request);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
}

/**
 * Calculate as much trustworthy cache data as a synchronous save can afford.
 * Missing results intentionally mean "invalidate only" to the XLSX write-plan
 * factory, so work beyond the budget is delegated to Excel after reopen.
 */
export function calculate_workbook_formulas_bounded(
    source: DataSource,
    request: FormulaCalculationRequest,
): readonly FormulaCalculationResult[] {
    const steps = calculate_workbook_formula_steps(
        source,
        request,
        MAX_SYNCHRONOUS_CALCULATION_WORK,
    );
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
}

/**
 * Calculate without monopolizing the host event loop. Range reads stay bounded,
 * and stale live requests stop between chunks instead of finishing discarded work.
 */
export async function calculate_workbook_formulas_cooperatively(
    source: DataSource,
    request: FormulaCalculationRequest,
    schedule: FormulaCalculationSchedule,
): Promise<readonly FormulaCalculationResult[] | undefined> {
    const steps = calculate_workbook_formula_steps(source, request);
    const work_slice_ms = Math.max(0, schedule.workSliceMs ?? 8);
    const yield_control = schedule.yieldControl ?? (() => new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0);
    }));
    if (schedule.isCancelled()) return undefined;
    let slice_started = performance.now();
    let step = steps.next();
    while (!step.done) {
        if (schedule.isCancelled()) return undefined;
        if (performance.now() - slice_started >= work_slice_ms) {
            await yield_control();
            if (schedule.isCancelled()) return undefined;
            slice_started = performance.now();
        }
        step = steps.next();
    }
    return schedule.isCancelled() ? undefined : step.value;
}

/** Wire/UI spelling for a missing calculation. */
export function displayed_formula_result(result: FormulaCalculationResult): string {
    return result.value
        ?? `${UNKNOWN_XLSX_FORMULA_RESULT} (${result.error})`;
}
