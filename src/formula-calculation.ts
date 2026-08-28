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

const MAX_RANGE_CELLS_PER_READ = 8_192;
const MAX_RANGE_COLUMNS_PER_READ = 256;

export interface FormulaCalculationAddress {
    readonly sheetIndex: number;
    readonly row: number;
    readonly column: number;
}

export interface FormulaCalculationEdit extends FormulaCalculationAddress {
    readonly value: string;
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

type Scalar =
    | { readonly kind: 'number'; readonly value: number }
    | { readonly kind: 'boolean'; readonly value: 0 | 1 }
    | { readonly kind: 'blank' }
    | { readonly kind: 'text' }
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
const TEXT: Scalar = Object.freeze({ kind: 'text' });

function address_key(address: FormulaCalculationAddress): string {
    return `${address.sheetIndex}:${address.row}:${address.column}`;
}

function finite_number(value: number): Scalar {
    return Number.isFinite(value) ? { kind: 'number', value } : NUMERIC_ERROR;
}

function numeric_text(value: string): number | undefined {
    const trimmed = value.trim();
    if (!/^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
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
        const value = Number(cell.raw);
        return finite_number(value);
    }
    if (cell.rawType === 'boolean') {
        if (cell.raw === '1' || cell.raw.toUpperCase() === 'TRUE') {
            return { kind: 'boolean', value: 1 };
        }
        if (cell.raw === '0' || cell.raw.toUpperCase() === 'FALSE') {
            return { kind: 'boolean', value: 0 };
        }
        return NUMERIC_ERROR;
    }
    return TEXT;
}

function scalar_from_edit(value: string, cell: RenderedCell | null | undefined): Scalar {
    if (value === '') return BLANK;
    if (cell?.rawType === 'boolean') {
        const upper = value.trim().toUpperCase();
        if (upper === 'TRUE') return { kind: 'boolean', value: 1 };
        if (upper === 'FALSE') return { kind: 'boolean', value: 0 };
    }
    const number = numeric_text(value);
    return number === undefined ? TEXT : finite_number(number);
}

function arithmetic_number(value: FormulaValue): number | Scalar {
    if (value.kind === 'number') return value.value;
    if (value.kind === 'boolean') return value.value;
    if (value.kind === 'blank') return 0;
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
 * behind this seam. Memory is O(targets + direct point references + edits +
 * one 8K-cell range chunk), not O(workbook size).
 */
export function calculate_workbook_formulas(
    source: DataSource,
    request: FormulaCalculationRequest,
): readonly FormulaCalculationResult[] {
    const sheets = source.meta().sheets;
    const sheet_names = sheets.map((sheet) => sheet.name);
    const sheet_lookup = new Map(sheet_names.map((name, index) => [name.toUpperCase(), index]));
    const edits = new Map(request.edits.map((edit) => [address_key(edit), edit.value]));
    const targets = new Set(request.targets.map(address_key));
    const memo = new Map<string, Scalar>();
    const visiting = new Set<string>();

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
    ) => Scalar;

    class Parser {
        private offset = 1;

        constructor(
            private readonly formula: string,
            private readonly formula_sheet_index: number,
        ) {}

        parse(): Scalar {
            if (!is_xlsx_formula_text(this.formula)) return PARSE_ERROR;
            const value = this.additive();
            this.whitespace();
            if (this.offset !== this.formula.length || value.kind === 'range') {
                return value.kind === 'unknown' && value.error === 'unsupported function'
                    ? value
                    : PARSE_ERROR;
            }
            return value;
        }

        private whitespace(): void {
            while (/\s/.test(this.formula[this.offset] ?? '')) this.offset += 1;
        }

        private additive(): FormulaValue {
            let left = this.multiplicative();
            while (true) {
                this.whitespace();
                const operator = this.formula[this.offset];
                if (operator !== '+' && operator !== '-') return left;
                this.offset += 1;
                const right = this.multiplicative();
                const a = arithmetic_number(left);
                const b = arithmetic_number(right);
                left = arithmetic_error(a) ?? arithmetic_error(b)
                    ?? finite_number(operator === '+' ? (a as number) + (b as number)
                        : (a as number) - (b as number));
            }
        }

        private multiplicative(): FormulaValue {
            let left = this.power();
            while (true) {
                this.whitespace();
                const operator = this.formula[this.offset];
                if (operator !== '*' && operator !== '/') return left;
                this.offset += 1;
                const right = this.power();
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

        private power(): FormulaValue {
            let left = this.unary();
            this.whitespace();
            if (this.formula[this.offset] !== '^') return left;
            this.offset += 1;
            const right = this.power();
            const a = arithmetic_number(left);
            const b = arithmetic_number(right);
            left = arithmetic_error(a) ?? arithmetic_error(b)
                ?? finite_number((a as number) ** (b as number));
            return left;
        }

        private unary(): FormulaValue {
            this.whitespace();
            const operator = this.formula[this.offset];
            if (operator === '+' || operator === '-') {
                this.offset += 1;
                const value = arithmetic_number(this.unary());
                return arithmetic_error(value)
                    ?? finite_number(operator === '-' ? -(value as number) : value as number);
            }
            let value = this.primary();
            this.whitespace();
            while (this.formula[this.offset] === '%') {
                const number = arithmetic_number(value);
                value = arithmetic_error(number) ?? finite_number((number as number) / 100);
                this.offset += 1;
                this.whitespace();
            }
            return value;
        }

        private primary(): FormulaValue {
            this.whitespace();
            if (this.formula[this.offset] === '(') {
                this.offset += 1;
                const value = this.additive();
                this.whitespace();
                if (this.formula[this.offset] !== ')') return PARSE_ERROR;
                this.offset += 1;
                return value;
            }

            const number = this.formula.slice(this.offset).match(
                /^(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/,
            );
            if (number) {
                this.offset += number[0].length;
                return finite_number(Number(number[0]));
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
                    return evaluate_cell({
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

            const identifier = this.formula.slice(this.offset).match(/^([A-Za-z_][A-Za-z0-9_.]*)/);
            if (!identifier) return PARSE_ERROR;
            this.offset += identifier[0].length;
            this.whitespace();
            if (this.formula[this.offset] !== '(') return PARSE_ERROR;
            this.offset += 1;
            return this.call(identifier[1].toUpperCase());
        }

        private call(name: string): FormulaValue {
            if (name !== 'SUM' && name !== 'AVERAGE') {
                // Consume nothing else. The outer full-input check will reject
                // this formula without accidentally recognizing references
                // inside an unsupported function as a partial calculation.
                return UNSUPPORTED_FUNCTION;
            }
            let total = 0;
            let count = 0;
            this.whitespace();
            if (this.formula[this.offset] === ')') {
                this.offset += 1;
                return name === 'SUM' ? finite_number(0) : NUMERIC_ERROR;
            }
            while (true) {
                const argument = this.additive();
                const error = argument.kind === 'range'
                    ? this.aggregate_range(argument, (number) => {
                        total += number;
                        count += 1;
                    })
                    : argument.kind === 'number'
                    ? (total += argument.value, count += 1, undefined)
                    : argument.kind === 'unknown' ? argument : undefined;
                if (error) return error;
                if (!Number.isFinite(total)) return NUMERIC_ERROR;
                this.whitespace();
                if (this.formula[this.offset] === ')') {
                    this.offset += 1;
                    break;
                }
                if (this.formula[this.offset] !== ',') return PARSE_ERROR;
                this.offset += 1;
            }
            return name === 'AVERAGE'
                ? count === 0 ? NUMERIC_ERROR : finite_number(total / count)
                : finite_number(total);
        }

        private aggregate_range(
            range: RangeValue,
            accept: (number: number) => void,
        ): Scalar | undefined {
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
                            const scalar = evaluate_cell(address, rows[row_offset]?.[column_offset] ?? null);
                            if (scalar.kind === 'unknown') return scalar;
                            if (scalar.kind === 'number') accept(scalar.value);
                        }
                    }
                }
            }
            return undefined;
        }
    }

    evaluate_cell = (address, supplied) => {
        if (!valid_address(address)) return PARSE_ERROR;
        const key = address_key(address);
        const cached = memo.get(key);
        if (cached) return cached;
        if (visiting.has(key)) return CYCLE;

        const edit = edits.get(key);
        const cell = supplied === undefined ? read_cell(address) : supplied;
        const formula = edit !== undefined && is_xlsx_formula_text(edit)
            ? edit
            : edit === undefined ? cell?.formula : undefined;
        if (
            formula !== undefined
            && (edit !== undefined || targets.has(key) || cell?.formulaResultPending === true)
        ) {
            visiting.add(key);
            const value = new Parser(formula, address.sheetIndex).parse();
            visiting.delete(key);
            memo.set(key, value);
            return value;
        }
        const value = edit === undefined ? scalar_from_cell(cell) : scalar_from_edit(edit, cell);
        // A streamed range supplies its current chunk's cell. Do not retain
        // ordinary literals from that path, or SUM over a million cells would
        // quietly turn the memo into a second copy of the range. Point reads,
        // edits, targets, and formulas are bounded by the dependency topology
        // and do benefit from reuse.
        if (
            supplied === undefined
            || edit !== undefined
            || targets.has(key)
            || cell?.formula !== undefined
        ) memo.set(key, value);
        return value;
    };

    return request.targets.map((target): FormulaCalculationResult => {
        const calculated = evaluate_cell(target);
        return calculated.kind === 'number'
            ? { ...target, value: result_text(calculated.value) }
            : { ...target, error: calculated.kind === 'unknown'
                ? calculated.error
                : 'numeric error' };
    });
}

/** Wire/UI spelling for a missing calculation. */
export function displayed_formula_result(result: FormulaCalculationResult): string {
    return result.value
        ?? `${UNKNOWN_XLSX_FORMULA_RESULT} (${result.error})`;
}
