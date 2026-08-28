/** Excel worksheet bounds used when translating relative A1 references. */
const MAX_COLUMN = 16_384;
const MAX_ROW = 1_048_576;

/** Display text when an XLSX formula has no trustworthy cached result. */
export const UNKNOWN_XLSX_FORMULA_RESULT = '??';

/** Whether text entered into an XLSX cell denotes a formula. */
export function is_xlsx_formula_text(value: string): boolean {
    return value.startsWith('=') && value.length > 1;
}

function column_index(letters: string): number {
    let index = 0;
    for (const char of letters.toUpperCase()) {
        index = index * 26 + char.charCodeAt(0) - 64;
    }
    return index;
}

function column_letters(index: number): string {
    let out = '';
    for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) {
        out = String.fromCharCode(65 + ((value - 1) % 26)) + out;
    }
    return out;
}

function translated_axis(
    absolute: string,
    value: number,
    delta: number,
    limit: number,
    render: (value: number) => string,
): string {
    const translated = absolute === '$' ? value : value + delta;
    return translated < 1 || translated > limit
        ? '#REF!'
        : `${absolute}${render(translated)}`;
}

function identifier_character(char: string | undefined): boolean {
    return char !== undefined && /[\p{L}\p{N}_.]/u.test(char);
}

export interface A1FormulaReference {
    /** Absent for an unqualified reference to the formula's own worksheet. */
    readonly sheetName?: string;
    readonly firstRow: number;
    readonly firstColumn: number;
    readonly lastRow: number;
    readonly lastColumn: number;
}

interface ParsedA1Cell {
    readonly row: number;
    readonly column: number;
    readonly length: number;
}

interface ParsedA1Range extends A1FormulaReference {
    readonly length: number;
}

export interface A1FormulaReferenceToken {
    readonly reference: A1FormulaReference;
    readonly length: number;
}

interface SheetPrefix {
    readonly name: string;
    readonly length: number;
}

interface SheetPrefixAttempt {
    readonly prefix?: SheetPrefix;
    /** First character that cannot belong to this prefix attempt. */
    readonly scannedEnd: number;
}

function sheet_prefix_at(value: string, offset: number): SheetPrefixAttempt {
    if (value[offset] === "'") {
        for (let index = offset + 1; index < value.length; index++) {
            if (value[index] !== "'") {
                continue;
            }
            if (value[index + 1] === "'") {
                index += 1;
                continue;
            }
            if (value[index + 1] !== '!') return { scannedEnd: index + 1 };
            return {
                prefix: {
                    name: value.slice(offset + 1, index).replace(/''/g, "'"),
                    length: index + 2 - offset,
                },
                scannedEnd: index + 2,
            };
        }
        return { scannedEnd: value.length };
    }

    if (!/[A-Za-z_\\]/.test(value[offset] ?? '')) return { scannedEnd: offset };
    let end = offset + 1;
    while (end < value.length) {
        const code_point = value.codePointAt(end);
        if (code_point === undefined) break;
        const char = String.fromCodePoint(code_point);
        if (char !== '\\' && !identifier_character(char)) break;
        end += char.length;
    }
    return value[end] === '!'
        ? {
            prefix: { name: value.slice(offset, end), length: end + 1 - offset },
            scannedEnd: end + 1,
        }
        : { scannedEnd: end };
}

interface ParsedA1Axis {
    readonly value: number;
    readonly end: number;
}

function parse_a1_column_at(value: string, offset: number): ParsedA1Axis | undefined {
    let end = value[offset] === '$' ? offset + 1 : offset;
    const letters_start = end;
    let column = 0;
    while (end < value.length && end - letters_start < 3) {
        const code = value.charCodeAt(end);
        const upper = code >= 97 && code <= 122 ? code - 32 : code;
        if (upper < 65 || upper > 90) break;
        column = column * 26 + upper - 64;
        end += 1;
    }
    if (end === letters_start || column > MAX_COLUMN) return undefined;
    return { value: column, end };
}

function parse_a1_row_at(value: string, offset: number): ParsedA1Axis | undefined {
    let end = value[offset] === '$' ? offset + 1 : offset;
    if (value.charCodeAt(end) < 49 || value.charCodeAt(end) > 57) return undefined;
    let row = 0;
    while (end < value.length) {
        const code = value.charCodeAt(end);
        if (code < 48 || code > 57) break;
        row = Math.min(MAX_ROW + 1, row * 10 + code - 48);
        end += 1;
    }
    return row <= MAX_ROW ? { value: row, end } : undefined;
}

function parse_a1_cell_at(value: string, offset: number): ParsedA1Cell | undefined {
    const column = parse_a1_column_at(value, offset);
    if (!column) return undefined;
    const row = parse_a1_row_at(value, column.end);
    if (!row || identifier_character(value[row.end]) || value[row.end] === '(') return undefined;
    return {
        row: row.value - 1,
        column: column.value - 1,
        length: row.end - offset,
    };
}

function parse_a1_axis_range_at(value: string, offset: number): ParsedA1Range | undefined {
    const first_column = parse_a1_column_at(value, offset);
    if (first_column && value[first_column.end] === ':') {
        const last_column = parse_a1_column_at(value, first_column.end + 1);
        if (last_column && !identifier_character(value[last_column.end])) {
            return {
                firstRow: 0,
                firstColumn: Math.min(first_column.value, last_column.value) - 1,
                lastRow: MAX_ROW - 1,
                lastColumn: Math.max(first_column.value, last_column.value) - 1,
                length: last_column.end - offset,
            };
        }
    }
    const first_row = parse_a1_row_at(value, offset);
    if (first_row && value[first_row.end] === ':') {
        const last_row = parse_a1_row_at(value, first_row.end + 1);
        if (last_row && !identifier_character(value[last_row.end])) {
            return {
                firstRow: Math.min(first_row.value, last_row.value) - 1,
                firstColumn: 0,
                lastRow: Math.max(first_row.value, last_row.value) - 1,
                lastColumn: MAX_COLUMN - 1,
                length: last_row.end - offset,
            };
        }
    }
    return undefined;
}

/**
 * Parse one A1 cell/range token at an exact formula offset. Unlike
 * {@link a1_formula_references}, this does not scan ahead. Formula evaluators
 * use it as a lexer primitive so dependency discovery and calculation accept
 * the same worksheet quoting and coordinate grammar.
 */
export function a1_formula_reference_at(
    formula: string,
    offset: number,
): A1FormulaReferenceToken | undefined {
    if (!Number.isInteger(offset) || offset < 0 || offset >= formula.length) return undefined;
    const prefix = sheet_prefix_at(formula, offset).prefix;
    const cell_start = offset + (prefix?.length ?? 0);
    const axis_range = parse_a1_axis_range_at(formula, cell_start);
    if (axis_range) {
        return {
            reference: {
                ...(prefix ? { sheetName: prefix.name } : {}),
                firstRow: axis_range.firstRow,
                firstColumn: axis_range.firstColumn,
                lastRow: axis_range.lastRow,
                lastColumn: axis_range.lastColumn,
            },
            length: (prefix?.length ?? 0) + axis_range.length,
        };
    }
    const first = parse_a1_cell_at(formula, cell_start);
    if (!first) return undefined;
    let end = cell_start + first.length;
    let last = first;
    if (formula[end] === ':') {
        const range_end = parse_a1_cell_at(formula, end + 1);
        if (range_end) {
            last = range_end;
            end += 1 + range_end.length;
        }
    }
    return {
        reference: {
            ...(prefix ? { sheetName: prefix.name } : {}),
            firstRow: Math.min(first.row, last.row),
            firstColumn: Math.min(first.column, last.column),
            lastRow: Math.max(first.row, last.row),
            lastColumn: Math.max(first.column, last.column),
        },
        length: end - offset,
    };
}

/**
 * Find direct A1 references and retain an optional worksheet qualifier for
 * workbook-level resolution. Strings, structured references, external books,
 * and unsupported 3D references are ignored.
 */
export function a1_formula_references(formula: string): A1FormulaReference[] {
    const references: A1FormulaReference[] = [];
    const seen = new Set<string>();
    const record = (reference: A1FormulaReference) => {
        const key = `${reference.sheetName ?? ''}:`
            + `${reference.firstRow}:${reference.firstColumn}:`
            + `${reference.lastRow}:${reference.lastColumn}`;
        if (seen.has(key)) return;
        seen.add(key);
        references.push(reference);
    };
    let index = formula.startsWith('=') ? 1 : 0;
    let bracket_depth = 0;

    while (index < formula.length) {
        const char = formula[index];
        if (char === '"') {
            index += 1;
            while (index < formula.length) {
                if (formula[index] !== '"') {
                    index += 1;
                    continue;
                }
                if (formula[index + 1] === '"') {
                    index += 2;
                    continue;
                }
                index += 1;
                break;
            }
            continue;
        }
        if (char === '[') {
            bracket_depth += 1;
            index += 1;
            continue;
        }
        if (char === ']' && bracket_depth > 0) {
            bracket_depth -= 1;
            index += 1;
            continue;
        }
        if (
            bracket_depth > 0
            || identifier_character(formula[index - 1])
            || formula[index - 1] === '!'
            || formula[index - 1] === ']'
            || formula[index - 1] === ':'
        ) {
            index += 1;
            continue;
        }

        const token = a1_formula_reference_at(formula, index);
        if (!token) {
            // A failed sheet-prefix candidate may have consumed a long quoted
            // or identifier span. Nothing inside that span can begin a free A1
            // token, so skip it once instead of rescanning every apostrophe or
            // backslash as another possible prefix.
            index = Math.max(index + 1, sheet_prefix_at(formula, index).scannedEnd);
            continue;
        }
        record(token.reference);
        index += token.length;
    }
    return references;
}

/** Backward-compatible projection used by worksheet-only callers and tests. */
export function local_a1_formula_references(
    formula: string,
    sheet_name: string,
): A1FormulaReference[] {
    return a1_formula_references(formula).flatMap((reference) => {
        if (
            reference.sheetName !== undefined
            && reference.sheetName.localeCompare(sheet_name, undefined, {
                sensitivity: 'accent',
            }) !== 0
        ) return [];
        return [{
            firstRow: reference.firstRow,
            firstColumn: reference.firstColumn,
            lastRow: reference.lastRow,
            lastColumn: reference.lastColumn,
        }];
    });
}

export interface WorkbookA1FormulaReference {
    readonly sourceSheetIndex: number;
    readonly firstRow: number;
    readonly firstColumn: number;
    readonly lastRow: number;
    readonly lastColumn: number;
}

/** Resolve supported A1 qualifiers once against the workbook's sheet slots. */
export function workbook_a1_formula_references(
    formula: string,
    formula_sheet_index: number,
    sheet_names: readonly string[],
): WorkbookA1FormulaReference[] {
    return a1_formula_references(formula).flatMap((reference) => {
        const source_sheet_index = reference.sheetName === undefined
            ? formula_sheet_index
            : sheet_names.findIndex((name) => name.localeCompare(
                reference.sheetName!,
                undefined,
                { sensitivity: 'accent' },
            ) === 0);
        if (source_sheet_index < 0 || source_sheet_index >= sheet_names.length) return [];
        return [{
            sourceSheetIndex: source_sheet_index,
            firstRow: reference.firstRow,
            firstColumn: reference.firstColumn,
            lastRow: reference.lastRow,
            lastColumn: reference.lastColumn,
        }];
    });
}

/**
 * Translate the relative parts of A1 references as Excel does for a shared
 * formula follower. String literals, quoted sheet names, and structured or
 * external-reference brackets are left alone.
 */
export function translate_a1_formula(
    formula: string,
    row_delta: number,
    column_delta: number,
): string {
    if (row_delta === 0 && column_delta === 0) return formula;
    let out = '';
    let index = 0;
    let quote: '"' | "'" | null = null;
    let bracket_depth = 0;

    while (index < formula.length) {
        const char = formula[index];
        if (quote !== null) {
            out += char;
            if (char === quote) {
                if (formula[index + 1] === quote) {
                    out += quote;
                    index += 2;
                    continue;
                }
                quote = null;
            }
            index += 1;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            out += char;
            index += 1;
            continue;
        }
        if (char === '[') {
            bracket_depth += 1;
            out += char;
            index += 1;
            continue;
        }
        if (char === ']' && bracket_depth > 0) {
            bracket_depth -= 1;
            out += char;
            index += 1;
            continue;
        }
        if (bracket_depth > 0 || identifier_character(formula[index - 1])) {
            out += char;
            index += 1;
            continue;
        }

        const column_range = formula.slice(index).match(
            /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/,
        );
        if (column_range && !identifier_character(formula[index + column_range[0].length])) {
            const first = column_index(column_range[2]);
            const last = column_index(column_range[4]);
            if (first <= MAX_COLUMN && last <= MAX_COLUMN) {
                out += translated_axis(
                    column_range[1], first, column_delta, MAX_COLUMN, column_letters,
                );
                out += ':';
                out += translated_axis(
                    column_range[3], last, column_delta, MAX_COLUMN, column_letters,
                );
                index += column_range[0].length;
                continue;
            }
        }

        const row_range = formula.slice(index).match(
            /^(\$?)([1-9]\d*):(\$?)([1-9]\d*)/,
        );
        if (row_range && !identifier_character(formula[index + row_range[0].length])) {
            const first = Number(row_range[2]);
            const last = Number(row_range[4]);
            if (first <= MAX_ROW && last <= MAX_ROW) {
                out += translated_axis(
                    row_range[1], first, row_delta, MAX_ROW, String,
                );
                out += ':';
                out += translated_axis(
                    row_range[3], last, row_delta, MAX_ROW, String,
                );
                index += row_range[0].length;
                continue;
            }
        }

        const match = formula.slice(index).match(/^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)/);
        if (!match) {
            out += char;
            index += 1;
            continue;
        }
        const next = formula[index + match[0].length];
        const source_column = column_index(match[2]);
        const source_row = Number(match[4]);
        if (
            source_column < 1
            || source_column > MAX_COLUMN
            || source_row > MAX_ROW
            || identifier_character(next)
            || next === '('
        ) {
            out += char;
            index += 1;
            continue;
        }

        const target_column = match[1] === '$'
            ? source_column
            : source_column + column_delta;
        const target_row = match[3] === '$'
            ? source_row
            : source_row + row_delta;
        if (target_column < 1 || target_column > MAX_COLUMN || target_row < 1 || target_row > MAX_ROW) {
            out += '#REF!';
        } else {
            out += `${match[1]}${column_letters(target_column)}${match[3]}${target_row}`;
        }
        index += match[0].length;
    }
    return out;
}
