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

/** Letters of a 1-based A1 column number (1 → A, 27 → AA). */
export function a1_column_letters(column: number): string {
    return column_letters(column);
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

export interface StructuredFormulaReference {
    /** Absent for an unqualified reference to the formula's own worksheet. */
    readonly sheetName?: string;
    readonly columnName: string;
    readonly intersection: boolean;
}

export interface StructuredFormulaReferenceToken {
    readonly reference: StructuredFormulaReference;
    readonly length: number;
}

export interface StructuredFormulaColumnRename {
    readonly sheetIndex: number;
    readonly oldName: string;
    readonly newName: string;
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

/** Parse one Header Row column reference at an exact formula offset. */
export function structured_formula_reference_at(
    formula: string,
    offset: number,
): StructuredFormulaReferenceToken | undefined {
    if (!Number.isInteger(offset) || offset < 0 || offset >= formula.length) return undefined;
    const prefix = sheet_prefix_at(formula, offset).prefix;
    let index = offset + (prefix?.length ?? 0);
    if (formula[index] !== '[') return undefined;
    index += 1;
    const intersection = formula[index] === '@';
    if (intersection) index += 1;
    let name = '';
    while (index < formula.length) {
        const char = formula[index];
        if (char === ']') {
            if (name.length === 0) return undefined;
            index += 1;
            return {
                reference: {
                    ...(prefix ? { sheetName: prefix.name } : {}),
                    columnName: name,
                    intersection,
                },
                length: index - offset,
            };
        }
        if (char === "'" && /[\[\]#'@]/.test(formula[index + 1] ?? '')) {
            name += formula[index + 1];
            index += 2;
            continue;
        }
        if (char === '[' || char === '\r' || char === '\n') return undefined;
        name += char;
        index += 1;
    }
    return undefined;
}

/** Find Header Row column references outside formula string literals. */
export function structured_formula_references(formula: string): StructuredFormulaReference[] {
    const references: StructuredFormulaReference[] = [];
    let index = formula.startsWith('=') ? 1 : 0;
    let bracket_depth = 0;
    while (index < formula.length) {
        if (formula[index] === '"') {
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
        if (bracket_depth > 0) {
            if (formula[index] === '[') bracket_depth += 1;
            if (formula[index] === ']') bracket_depth -= 1;
            index += 1;
            continue;
        }
        if (identifier_character(formula[index - 1]) || formula[index - 1] === ']') {
            if (formula[index] === '[') bracket_depth = 1;
            index += 1;
            continue;
        }
        const external_end = external_workbook_reference_end_at(formula, index);
        if (external_end !== undefined) {
            index = external_end;
            continue;
        }
        const parsed = structured_formula_reference_at(formula, index);
        if (!parsed) {
            if (formula[index] === '[') {
                bracket_depth = 1;
                index += 1;
                continue;
            }
            index = Math.max(index + 1, sheet_prefix_at(formula, index).scannedEnd);
            continue;
        }
        references.push(parsed.reference);
        index += parsed.length;
    }
    return references;
}

/** End of an external-book token such as `[Book.xlsx]Sheet1![Revenue]`. */
function external_workbook_reference_end_at(
    formula: string,
    offset: number,
): number | undefined {
    if (formula[offset] !== '[') return undefined;
    const book_end = formula.indexOf(']', offset + 1);
    if (book_end < 0 || book_end === offset + 1) return undefined;
    let index = book_end + 1;
    const sheet_start = index;
    while (index < formula.length && formula[index] !== '!') {
        const char = formula[index];
        if (char === '[' || char === ']' || char === '"' || /[+*/(),=<>\s]/.test(char)) {
            return undefined;
        }
        index += 1;
    }
    if (index === sheet_start || formula[index] !== '!') return undefined;
    index += 1;
    const structured = structured_formula_reference_at(formula, index);
    return structured === undefined ? index : index + structured.length;
}

function escaped_structured_column_name(name: string): string {
    return name.replace(/[\[\]#'@]/g, (char) => `'${char}`);
}

/** Rewrite references to columns renamed through an active Header Row. */
export function retarget_renamed_structured_formula(
    formula: string,
    formula_sheet_index: number,
    sheet_names: readonly string[],
    renames: readonly StructuredFormulaColumnRename[],
): string {
    if (renames.length === 0) return formula;
    let out = '';
    let index = 0;
    let bracket_depth = 0;
    while (index < formula.length) {
        if (formula[index] === '"') {
            const start = index++;
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
            out += formula.slice(start, index);
            continue;
        }
        if (bracket_depth > 0) {
            const char = formula[index];
            if (char === '[') bracket_depth += 1;
            if (char === ']') bracket_depth -= 1;
            out += char;
            index += 1;
            continue;
        }
        if (identifier_character(formula[index - 1]) || formula[index - 1] === ']') {
            if (formula[index] === '[') bracket_depth = 1;
            out += formula[index];
            index += 1;
            continue;
        }
        const external_end = external_workbook_reference_end_at(formula, index);
        if (external_end !== undefined) {
            out += formula.slice(index, external_end);
            index = external_end;
            continue;
        }
        const parsed = structured_formula_reference_at(formula, index);
        if (!parsed) {
            if (formula[index] === '[') {
                bracket_depth = 1;
                out += formula[index];
                index += 1;
                continue;
            }
            const end = Math.max(index + 1, sheet_prefix_at(formula, index).scannedEnd);
            out += formula.slice(index, end);
            index = end;
            continue;
        }
        const ref = parsed.reference;
        const source_sheet = ref.sheetName === undefined
            ? formula_sheet_index
            : sheet_names.findIndex((name) => name.localeCompare(
                ref.sheetName!, undefined, { sensitivity: 'accent' },
            ) === 0);
        const rename = renames.find((candidate) => candidate.sheetIndex === source_sheet
            && candidate.oldName.localeCompare(
                ref.columnName, undefined, { sensitivity: 'accent' },
            ) === 0);
        if (!rename) {
            out += formula.slice(index, index + parsed.length);
            index += parsed.length;
            continue;
        }
        const token = formula.slice(index, index + parsed.length);
        const prefix_length = sheet_prefix_at(formula, index).prefix?.length ?? 0;
        out += token.slice(0, prefix_length + 1)
            + `${ref.intersection ? '@' : ''}${escaped_structured_column_name(rename.newName)}]`;
        index += parsed.length;
    }
    return out;
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
    if (end >= value.length) return undefined;
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
    if (
        !row
        || identifier_character(value[row.end])
        || value[row.end] === '('
        || value[row.end] === '$'
    ) return undefined;
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
        if (
            last_column
            && !identifier_character(value[last_column.end])
            && value[last_column.end] !== '$'
        ) {
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
        if (
            last_row
            && !identifier_character(value[last_row.end])
            && value[last_row.end] !== '$'
        ) {
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

/** One axis of a reference corner, as the author wrote it. */
export interface FormulaReferenceAxis {
    /** 1-based worksheet row number, or 1-based column number (A = 1). */
    readonly value: number;
    readonly absolute: boolean;
    /** UTF-16 span of the coordinate characters, after any `$`. */
    readonly start: number;
    readonly end: number;
}

/** A worksheet qualifier such as `Sheet1!` or `'Sales Q1'!`. */
export interface FormulaReferenceSheet {
    /** Unescaped worksheet name. */
    readonly name: string;
    readonly quoted: boolean;
    /** UTF-16 span of the qualifier, including any quotes and the `!`. */
    readonly start: number;
    readonly end: number;
}

export interface FormulaReferenceCorner {
    /** UTF-16 span of the corner, including its own sheet qualifier. */
    readonly start: number;
    readonly end: number;
    readonly sheet?: FormulaReferenceSheet;
    /** Absent for whole-column references. */
    readonly row?: FormulaReferenceAxis;
    /** Absent for whole-row references. */
    readonly column?: FormulaReferenceAxis;
}

export type FormulaReferenceKind = 'cell' | 'range' | 'rows' | 'columns';

/** One direct A1 reference with each corner kept as written. */
export interface FormulaReferenceToken {
    readonly kind: FormulaReferenceKind;
    /** UTF-16 span of the whole reference, qualifiers included. */
    readonly start: number;
    readonly end: number;
    /** The qualified worksheet; absent for the formula's own worksheet. */
    readonly sheetName?: string;
    /** In the order the author wrote them; one corner for a single cell. */
    readonly corners: readonly FormulaReferenceCorner[];
}

/**
 * A construct the tokenizer will not turn into a reference token, because a
 * structural change could not adjust it without guessing:
 *
 * - `rangeOperand`: a range operator with an operand that is not a direct
 *   reference, such as `INDEX(A:A,1):B5`, or a chain such as `A1:B2:C3`;
 * - `mixedSheets`: a range whose corners name different worksheets, such as
 *   `A1:Sheet2!B2`;
 * - `threeDimensional`: a reference across worksheets, such as
 *   `Sheet1:Sheet3!A1`;
 * - `spill`: a spilled-range reference, such as `A1#`;
 * - `r1c1`: R1C1 reference text, such as `R1C1` or `R[1]C`.
 */
export type FormulaReferenceIssueKind =
    | 'rangeOperand'
    | 'mixedSheets'
    | 'threeDimensional'
    | 'spill'
    | 'r1c1';

export interface FormulaReferenceIssue {
    readonly kind: FormulaReferenceIssueKind;
    /** UTF-16 span of the construct, for messages. */
    readonly start: number;
    readonly end: number;
    /**
     * Worksheets the construct names: a qualifier's unescaped name, or
     * `undefined` for the formula's own worksheet. A 3D reference lists its
     * first and last worksheet. Empty when the construct names a worksheet
     * the tokenizer cannot identify, such as through a defined name or a
     * table; callers treat that as naming every worksheet.
     */
    readonly worksheets: readonly (string | undefined)[];
}

export interface FormulaReferenceLex {
    readonly references: readonly FormulaReferenceToken[];
    readonly issues: readonly FormulaReferenceIssue[];
}

/**
 * End of the opaque span that starts at `offset`, or `undefined` when none
 * does. An opaque span holds text that can look like a reference but is not
 * one:
 *
 * - a string literal, `"…"`, with `""` for a quote;
 * - a quoted sheet name, `'…'`, with `''` for an apostrophe;
 * - a bracketed span, nested brackets included: a structured reference,
 *   where `'` escapes the next `[`, `]`, `#`, `@`, or `'`, or an
 *   external-workbook prefix such as `[1]`. A `"` or `'` inside brackets is
 *   a literal character, so brackets are read before strings.
 *
 * An unterminated span runs to the end of the formula. Every scan in the
 * reference tokenizer, forward or backward, skips spans through this one
 * function, so none of them counts a parenthesis, bracket, or colon inside
 * a span.
 */
function opaque_span_end_at(formula: string, offset: number): number | undefined {
    const char = formula[offset];
    if (char === '"' || char === "'") {
        let index = offset + 1;
        while (index < formula.length) {
            if (formula[index] !== char) {
                index += 1;
            } else if (formula[index + 1] === char) {
                index += 2;
            } else {
                return index + 1;
            }
        }
        return index;
    }
    if (char !== '[') return undefined;
    let depth = 0;
    let index = offset;
    while (index < formula.length) {
        const current = formula[index];
        if (current === "'" && /[\[\]#'@]/.test(formula[index + 1] ?? '')) {
            index += 2;
            continue;
        }
        if (current === '[') depth += 1;
        if (current === ']' && --depth === 0) return index + 1;
        index += 1;
    }
    return index;
}

/**
 * Start of each opaque span, keyed by its end, from one forward pass of
 * {@link opaque_span_end_at}. Backward scans use it to step over a span
 * whole.
 */
function opaque_span_starts_by_end(formula: string): ReadonlyMap<number, number> {
    const starts = new Map<number, number>();
    let index = 0;
    while (index < formula.length) {
        const end = opaque_span_end_at(formula, index);
        if (end === undefined) {
            index += 1;
            continue;
        }
        starts.set(end, index);
        index = end;
    }
    return starts;
}

/**
 * End of an external-workbook reference whose `[book]` prefix is the
 * bracket span ending at `span_end`: the book, its unquoted sheet qualifier,
 * and the reference or structured reference after it, which all belong to
 * the other workbook. Excel quotes a qualifier that needs quoting together
 * with its book (`'[Book.xlsx]Sales Q1'!A1`), so that form is a quoted sheet
 * name, not this one.
 */
function external_reference_end_at(formula: string, span_end: number): number | undefined {
    const sheet = sheet_qualifier_at(formula, span_end);
    if (sheet === undefined || sheet.quoted) return undefined;
    const tail = lexed_reference_at(formula, sheet.end);
    if (tail !== undefined) return tail.corners[tail.corners.length - 1].end;
    return formula[sheet.end] === '[' ? opaque_span_end_at(formula, sheet.end) : sheet.end;
}

function sheet_qualifier_at(formula: string, offset: number): FormulaReferenceSheet | undefined {
    const prefix = sheet_prefix_at(formula, offset).prefix;
    return prefix === undefined ? undefined : {
        name: prefix.name,
        quoted: formula[offset] === "'",
        start: offset,
        end: offset + prefix.length,
    };
}

function reference_axis_at(
    formula: string,
    offset: number,
    parse: (value: string, offset: number) => ParsedA1Axis | undefined,
): FormulaReferenceAxis | undefined {
    const parsed = parse(formula, offset);
    if (parsed === undefined) return undefined;
    const absolute = formula[offset] === '$';
    return {
        value: parsed.value,
        absolute,
        start: absolute ? offset + 1 : offset,
        end: parsed.end,
    };
}

/** A corner after a range colon, optionally with its own sheet qualifier. */
function second_corner_at(
    formula: string,
    offset: number,
    kind: 'cell' | 'rows' | 'columns',
): FormulaReferenceCorner | undefined {
    const sheet = sheet_qualifier_at(formula, offset);
    const start = sheet?.end ?? offset;
    if (kind === 'cell') {
        const cell = parse_a1_cell_at(formula, start);
        if (cell === undefined) return undefined;
        const column = reference_axis_at(formula, start, parse_a1_column_at)!;
        const row = reference_axis_at(formula, column.end, parse_a1_row_at)!;
        return { start: offset, end: row.end, ...(sheet ? { sheet } : {}), row, column };
    }
    const axis = reference_axis_at(
        formula,
        start,
        kind === 'rows' ? parse_a1_row_at : parse_a1_column_at,
    );
    if (
        axis === undefined
        || identifier_character(formula[axis.end])
        || formula[axis.end] === '$'
    ) return undefined;
    return {
        start: offset,
        end: axis.end,
        ...(sheet ? { sheet } : {}),
        ...(kind === 'rows' ? { row: axis } : { column: axis }),
    };
}

function formula_space(char: string | undefined): boolean {
    return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

/** Offset of a range colon at or after `offset`, past any whitespace. */
function range_colon_at(formula: string, offset: number): number | undefined {
    let index = offset;
    while (formula_space(formula[index])) index += 1;
    return formula[index] === ':' ? index : undefined;
}

/** First offset at or after `offset` that is not whitespace. */
function past_space(formula: string, offset: number): number {
    let index = offset;
    while (formula_space(formula[index])) index += 1;
    return index;
}

interface LexedReference {
    readonly kind: FormulaReferenceKind;
    readonly corners: readonly FormulaReferenceCorner[];
}

/**
 * Decompose the direct reference at `offset` into corners. The grammar is
 * {@link a1_formula_reference_at}'s, extended by a sheet qualifier on the
 * second corner (`Sheet1!A1:Sheet1!B2`) and by whitespace around the range
 * colon (`A2 : A5`). Each corner keeps its own span, so rendering keeps the
 * spacing as written.
 */
function lexed_reference_at(formula: string, offset: number): LexedReference | undefined {
    const sheet = sheet_qualifier_at(formula, offset);
    const start = sheet?.end ?? offset;
    const first_corner = (axes: Pick<FormulaReferenceCorner, 'row' | 'column'>, end: number) => ({
        start: offset,
        end,
        ...(sheet ? { sheet } : {}),
        ...axes,
    });
    const base = a1_formula_reference_at(formula, offset);
    if (base === undefined) {
        // Only a per-corner qualifier or a spaced colon can make a whole-row
        // or whole-column range unreadable to the base grammar:
        // `Sheet1!1:Sheet1!3`, `A : C`.
        for (const kind of ['columns', 'rows'] as const) {
            const axis = reference_axis_at(
                formula,
                start,
                kind === 'rows' ? parse_a1_row_at : parse_a1_column_at,
            );
            if (axis === undefined) continue;
            const colon = range_colon_at(formula, axis.end);
            if (colon === undefined) continue;
            const second = second_corner_at(formula, past_space(formula, colon + 1), kind);
            if (second === undefined) continue;
            return {
                kind,
                corners: [
                    first_corner(kind === 'rows' ? { row: axis } : { column: axis }, axis.end),
                    second,
                ],
            };
        }
        return undefined;
    }
    const end = offset + base.length;
    const axis_range = parse_a1_axis_range_at(formula, start);
    if (axis_range !== undefined && start + axis_range.length === end) {
        const first_column = reference_axis_at(formula, start, parse_a1_column_at);
        if (first_column !== undefined && formula[first_column.end] === ':') {
            const last = reference_axis_at(formula, first_column.end + 1, parse_a1_column_at);
            if (last !== undefined && last.end === end) {
                return {
                    kind: 'columns',
                    corners: [
                        first_corner({ column: first_column }, first_column.end),
                        { start: first_column.end + 1, end, column: last },
                    ],
                };
            }
        }
        const first_row = reference_axis_at(formula, start, parse_a1_row_at)!;
        const last_row = reference_axis_at(formula, first_row.end + 1, parse_a1_row_at)!;
        return {
            kind: 'rows',
            corners: [
                first_corner({ row: first_row }, first_row.end),
                { start: first_row.end + 1, end, row: last_row },
            ],
        };
    }
    const column = reference_axis_at(formula, start, parse_a1_column_at)!;
    const row = reference_axis_at(formula, column.end, parse_a1_row_at)!;
    const first = first_corner({ row, column }, row.end);
    if (row.end < end) {
        const last_column = reference_axis_at(formula, row.end + 1, parse_a1_column_at)!;
        const last_row = reference_axis_at(formula, last_column.end, parse_a1_row_at)!;
        return {
            kind: 'range',
            corners: [first, { start: row.end + 1, end, row: last_row, column: last_column }],
        };
    }
    // The base grammar reads `A1:B2` itself, so a second corner found here
    // has its own qualifier or whitespace around the colon.
    const colon = range_colon_at(formula, end);
    if (colon !== undefined) {
        const second = second_corner_at(formula, past_space(formula, colon + 1), 'cell');
        if (second !== undefined) return { kind: 'range', corners: [first, second] };
    }
    return { kind: 'cell', corners: [first] };
}

function same_sheet_name(left: string, right: string): boolean {
    return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

/** Start of the range-operator operand that ends just before `colon`. */
function operand_start_before(
    formula: string,
    colon: number,
    span_starts: ReadonlyMap<number, number>,
): number {
    let index = colon;
    while (index > 0 && formula_space(formula[index - 1])) index -= 1;
    if (formula[index - 1] === ')') {
        let depth = 0;
        while (index > 0) {
            const span_start = span_starts.get(index);
            if (span_start !== undefined) {
                index = span_start;
                continue;
            }
            index -= 1;
            if (formula[index] === ')') depth += 1;
            if (formula[index] === '(' && --depth === 0) break;
        }
    }
    // The function name, sheet qualifier, or table name before it.
    while (index > 0) {
        const span_start = span_starts.get(index);
        if (span_start !== undefined && formula[span_start] !== '"') {
            index = span_start;
            continue;
        }
        if (!identifier_character(formula[index - 1]) && !/[$!\\]/.test(formula[index - 1])) break;
        index -= 1;
    }
    return index;
}

/** End of the range-operator operand that starts just after `colon`. */
function operand_end_after(formula: string, colon: number): number {
    const start = past_space(formula, colon + 1);
    const reference = lexed_reference_at(formula, start);
    if (reference !== undefined) return reference.corners[reference.corners.length - 1].end;
    let index = start;
    let depth = 0;
    while (index < formula.length) {
        const span_end = opaque_span_end_at(formula, index);
        if (span_end !== undefined) {
            index = span_end;
            continue;
        }
        const char = formula[index];
        if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            if (depth === 0) return index;
            if (--depth === 0) return index + 1;
        } else if (depth === 0 && !identifier_character(char) && !/[$!\\]/.test(char)) {
            return index;
        }
        index += 1;
    }
    return index;
}

/**
 * Worksheets a range-operator construct names: every sheet qualifier in it,
 * and the formula's own worksheet (`undefined`) for an unqualified reference
 * or column reference. A function operand's result lies on the sheets its own
 * references name, as in `INDEX(Data!A:A,1):B5`. External-workbook
 * references name none of this workbook's sheets. A defined name or a table
 * could lie on any sheet, so a construct with one returns `[]`: unknown.
 */
function construct_worksheets(formula: string, start: number, end: number): (string | undefined)[] {
    const sheets = new Set<string | undefined>();
    let unknown = false;
    const add = (name: string | undefined) => {
        if (name === undefined) {
            sheets.add(undefined);
        } else if (!name.includes('[')) {
            for (const part of name.split(':')) sheets.add(part);
        }
    };
    let index = start;
    while (index < end) {
        const char = formula[index];
        const span_end = opaque_span_end_at(formula, index);
        const previous = formula[index - 1];
        if (char === '[') {
            const external_end = external_reference_end_at(formula, span_end!);
            if (external_end !== undefined) {
                index = external_end;
                continue;
            }
            // `Data![Col]` adds Data with its qualifier; `[Col]` names this
            // sheet; `Table1[Col]` names a table on any sheet.
            if (identifier_character(previous)) unknown = true;
            else if (previous !== '!') sheets.add(undefined);
            index = span_end!;
            continue;
        }
        if (identifier_character(previous) || previous === '!' || previous === ']' || previous === '#') {
            index = span_end ?? index + 1;
            continue;
        }
        const lexed = lexed_reference_at(formula, index);
        if (lexed !== undefined) {
            add(lexed.corners[0].sheet?.name);
            if (lexed.corners[1]?.sheet !== undefined) add(lexed.corners[1].sheet.name);
            index = lexed.corners[lexed.corners.length - 1].end;
            continue;
        }
        const qualifier = sheet_qualifier_at(formula, index);
        if (qualifier !== undefined) {
            add(qualifier.name);
            // Not a reference, so a structured reference on that sheet, or a
            // sheet-scoped defined name, which may point at any sheet.
            if (/[\p{L}_\\]/u.test(formula[qualifier.end] ?? '')) unknown = true;
            index = qualifier.end;
            continue;
        }
        if (/[\p{L}_\\]/u.test(char)) {
            let name_end = index + 1;
            while (identifier_character(formula[name_end]) || formula[name_end] === '\\') name_end += 1;
            const name = formula.slice(index, name_end);
            // A function name or a table name is not itself a reference.
            if (formula[name_end] !== '(' && formula[name_end] !== '[' && !/^(?:TRUE|FALSE)$/i.test(name)) {
                unknown = true;
            }
            index = name_end;
            continue;
        }
        index = span_end ?? index + 1;
    }
    return unknown ? [] : [...sheets];
}

const R1C1_REFERENCE = /^(?:[Rr](?:\[-?\d+\]|\d+)?[Cc](?:\[-?\d+\]|\d+)?|[Rr]\[-?\d+\]|[Cc]\[-?\d+\])/;

/** End of R1C1 reference text at `offset`, after any sheet qualifier. */
function r1c1_reference_end_at(formula: string, offset: number): number | undefined {
    const start = sheet_qualifier_at(formula, offset)?.end ?? offset;
    const match = formula.slice(start, start + 24).match(R1C1_REFERENCE);
    if (match === null) return undefined;
    const end = start + match[0].length;
    return identifier_character(formula[end]) || formula[end] === '(' || formula[end] === '['
        ? undefined
        : end;
}

/** An unquoted 3D prefix such as `Sheet1:Sheet3!`, returned with both names. */
function unquoted_3d_prefix_at(
    formula: string,
    offset: number,
): { readonly first: string; readonly last: string; readonly end: number } | undefined {
    if (!/[A-Za-z_\\]/.test(formula[offset] ?? '')) return undefined;
    let index = offset + 1;
    while (index < formula.length && (identifier_character(formula[index]) || formula[index] === '\\')) {
        index += 1;
    }
    if (formula[index] !== ':') return undefined;
    const last = sheet_qualifier_at(formula, index + 1);
    if (last === undefined || last.quoted) return undefined;
    return { first: formula.slice(offset, index), last: last.name, end: last.end };
}

/**
 * Lex every direct A1 reference with its corners as written, and report
 * every construct that a structural change could not adjust. Strings,
 * external-workbook references, and structured references are skipped, not
 * reported. Formula Anchors, the structural support scan, and the writer
 * share this one reading of a formula.
 */
export function formula_reference_tokens(formula: string): FormulaReferenceLex {
    const references: FormulaReferenceToken[] = [];
    const issues: FormulaReferenceIssue[] = [];
    let index = formula.startsWith('=') ? 1 : 0;
    let span_starts: ReadonlyMap<number, number> | undefined;
    const report = (
        kind: FormulaReferenceIssueKind,
        start: number,
        end: number,
        worksheets: readonly (string | undefined)[],
    ) => {
        issues.push({ kind, start, end, worksheets });
        index = Math.max(end, index + 1);
    };
    const range_operand = (colon: number, first_operand_start: number) => {
        span_starts ??= opaque_span_starts_by_end(formula);
        const issue_start = Math.min(
            first_operand_start,
            operand_start_before(formula, colon, span_starts),
        );
        let issue_end = colon + 1;
        for (
            let next: number | undefined = colon;
            next !== undefined;
            next = range_colon_at(formula, issue_end)
        ) {
            issue_end = Math.max(next + 1, operand_end_after(formula, next));
        }
        report(
            'rangeOperand',
            issue_start,
            issue_end,
            construct_worksheets(formula, issue_start, issue_end),
        );
    };
    const tail_end = (offset: number) => {
        const tail = lexed_reference_at(formula, offset);
        return tail === undefined ? offset : tail.corners[tail.corners.length - 1].end;
    };
    while (index < formula.length) {
        const char = formula[index];
        const span_end = opaque_span_end_at(formula, index);
        if (char === '"') {
            index = span_end!;
            continue;
        }
        if (char === '[') {
            // `[1]Sheet1!A1:B2`: the reference after the book belongs to it.
            index = external_reference_end_at(formula, span_end!) ?? span_end!;
            continue;
        }
        if (char === ':') {
            // A range operator outside every reference token, such as
            // `INDEX(A:A,1):INDEX(B:B,2)` or `Total:B5`.
            range_operand(index, index);
            continue;
        }
        const previous = formula[index - 1];
        if (identifier_character(previous) || previous === ']' || previous === '!') {
            index = span_end ?? index + 1;
            continue;
        }
        // A quote here opens a sheet qualifier, so it is lexed as one.
        const lexed = lexed_reference_at(formula, index);
        if (lexed === undefined) {
            const three_d = unquoted_3d_prefix_at(formula, index);
            if (three_d !== undefined) {
                report('threeDimensional', index, tail_end(three_d.end), [three_d.first, three_d.last]);
                continue;
            }
            const r1c1_end = r1c1_reference_end_at(formula, index);
            if (r1c1_end !== undefined) {
                report('r1c1', index, r1c1_end, [sheet_qualifier_at(formula, index)?.name]);
                continue;
            }
            index = span_end ?? index + 1;
            continue;
        }
        const start = index;
        const end = lexed.corners[lexed.corners.length - 1].end;
        const [first, second] = lexed.corners;
        const first_sheet = first.sheet?.name;
        if (first_sheet !== undefined && first_sheet.includes('[')) {
            // A quoted external-workbook reference: `'[Book.xlsx]Sheet1'!A1`.
            // Worksheet names cannot contain brackets.
            index = end;
            continue;
        }
        if (
            second?.sheet !== undefined
            && (first_sheet === undefined || !same_sheet_name(first_sheet, second.sheet.name))
        ) {
            // `S1:Sheet3!A1` may also be a 3D reference from a sheet named S1.
            const first_text = first_sheet === undefined
                ? [formula.slice(first.start, first.end)]
                : [];
            report('mixedSheets', start, end, [first_sheet, ...first_text, second.sheet.name]);
            continue;
        }
        if (first_sheet !== undefined && first_sheet.includes(':')) {
            report('threeDimensional', start, end, first_sheet.split(':'));
            continue;
        }
        if (formula[end] === '!') {
            // A cell- or column-shaped 3D prefix such as `S1:S3!A1` names its
            // bounding sheets with its corners' text. Any other shape is
            // unknown, so it names every sheet.
            const bounds = first.sheet === undefined && second !== undefined
                ? [formula.slice(first.start, first.end), formula.slice(second.start, second.end)]
                : [];
            report('threeDimensional', start, tail_end(end + 1), bounds);
            continue;
        }
        if (formula[end] === '#') {
            report('spill', start, end + 1, [first_sheet]);
            continue;
        }
        const colon = range_colon_at(formula, end);
        if (colon !== undefined) {
            // `B5:INDEX(A:A,2)` or `A1:B2:C3`.
            range_operand(colon, start);
            continue;
        }
        references.push({
            kind: lexed.kind,
            start,
            end,
            ...(first_sheet !== undefined ? { sheetName: first_sheet } : {}),
            corners: lexed.corners,
        });
        index = end;
    }
    return { references, issues };
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

/** One same-worksheet cell move, in zero-based workbook coordinates. */
export interface XlsxFormulaCellMove {
    /** Moves are applied in gesture order. */
    readonly order?: number;
    readonly sheetIndex: number;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly destinationRow: number;
    readonly destinationColumn: number;
}

interface XlsxFormulaMoveRectangle {
    readonly sheetIndex: number;
    readonly firstRow: number;
    readonly lastRow: number;
    readonly firstColumn: number;
    readonly lastColumn: number;
    readonly rowDelta: number;
    readonly columnDelta: number;
}

function move_rectangles(moves: readonly XlsxFormulaCellMove[]): readonly XlsxFormulaMoveRectangle[] {
    const by_delta = new Map<string, XlsxFormulaCellMove[]>();
    for (const move of moves) {
        const key = `${move.sheetIndex}:${move.destinationRow - move.sourceRow}:${move.destinationColumn - move.sourceColumn}`;
        const group = by_delta.get(key) ?? [];
        group.push(move);
        by_delta.set(key, group);
    }
    const rectangles: XlsxFormulaMoveRectangle[] = [];
    for (const group of by_delta.values()) {
        let firstRow = group[0].sourceRow;
        let lastRow = firstRow;
        let firstColumn = group[0].sourceColumn;
        let lastColumn = firstColumn;
        for (const move of group) {
            firstRow = Math.min(firstRow, move.sourceRow);
            lastRow = Math.max(lastRow, move.sourceRow);
            firstColumn = Math.min(firstColumn, move.sourceColumn);
            lastColumn = Math.max(lastColumn, move.sourceColumn);
        }
        const rectangular = (lastRow - firstRow + 1) * (lastColumn - firstColumn + 1) === group.length;
        if (!rectangular) {
            for (const move of group) {
                rectangles.push({
                    sheetIndex: move.sheetIndex,
                    firstRow: move.sourceRow,
                    lastRow: move.sourceRow,
                    firstColumn: move.sourceColumn,
                    lastColumn: move.sourceColumn,
                    rowDelta: move.destinationRow - move.sourceRow,
                    columnDelta: move.destinationColumn - move.sourceColumn,
                });
            }
            continue;
        }
        const first = group[0];
        rectangles.push({
            sheetIndex: first.sheetIndex,
            firstRow,
            lastRow,
            firstColumn,
            lastColumn,
            rowDelta: first.destinationRow - first.sourceRow,
            columnDelta: first.destinationColumn - first.sourceColumn,
        });
    }
    return rectangles;
}

function moved_reference_token(
    token: string,
    reference: A1FormulaReference,
    source_sheet_index: number,
    rectangles: readonly XlsxFormulaMoveRectangle[],
): string | undefined {
    // Whole-row and whole-column references cannot be wholly contained by a
    // finite cell move, so they do not follow it.
    const prefix_length = sheet_prefix_at(token, 0).prefix?.length ?? 0;
    const coordinates = token.slice(prefix_length).match(
        /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)(?::(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*))?$/,
    );
    if (!coordinates) return undefined;

    const rectangle = rectangles.find((move) => move.sheetIndex === source_sheet_index
        && reference.firstRow >= move.firstRow
        && reference.lastRow <= move.lastRow
        && reference.firstColumn >= move.firstColumn
        && reference.lastColumn <= move.lastColumn);
    if (rectangle === undefined) return undefined;
    const final_row_delta = rectangle.rowDelta;
    const final_column_delta = rectangle.columnDelta;

    const shifted = (
        column_absolute: string,
        column: string,
        row_absolute: string,
        row: string,
    ): string => `${column_absolute}${column_letters(column_index(column) + final_column_delta)}`
        + `${row_absolute}${Number(row) + final_row_delta}`;
    const first = shifted(coordinates[1], coordinates[2], coordinates[3], coordinates[4]);
    const last = coordinates[5] === undefined
        ? ''
        : `:${shifted(coordinates[5], coordinates[6], coordinates[7], coordinates[8])}`;
    return token.slice(0, prefix_length) + first + last;
}

/**
 * Retarget references whose entire referenced cell or range moved.
 *
 * Unlike copy translation, `$` markers do not pin a reference during a move:
 * Excel keeps the markers but changes the address so the reference continues
 * to identify the moved cells.
 */
function retarget_moved_a1_formula_with_map(
    formula: string,
    formula_sheet_index: number,
    sheet_names: readonly string[],
    rectangles: readonly XlsxFormulaMoveRectangle[],
): string {
    if (rectangles.length === 0) return formula;
    let out = '';
    let index = 0;
    let bracket_depth = 0;
    while (index < formula.length) {
        const char = formula[index];
        if (char === '"') {
            const start = index++;
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
            out += formula.slice(start, index);
            continue;
        }
        if (char === '[') bracket_depth += 1;
        if (char === ']' && bracket_depth > 0) bracket_depth -= 1;
        if (
            bracket_depth > 0
            || identifier_character(formula[index - 1])
            || formula[index - 1] === '!'
            || formula[index - 1] === ']'
            || formula[index - 1] === ':'
        ) {
            out += char;
            index += 1;
            continue;
        }
        const parsed = a1_formula_reference_at(formula, index);
        if (!parsed) {
            const end = Math.max(index + 1, sheet_prefix_at(formula, index).scannedEnd);
            out += formula.slice(index, end);
            index = end;
            continue;
        }
        const source_sheet_index = parsed.reference.sheetName === undefined
            ? formula_sheet_index
            : sheet_names.findIndex((name) => name.localeCompare(
                parsed.reference.sheetName!,
                undefined,
                { sensitivity: 'accent' },
            ) === 0);
        const token = formula.slice(index, index + parsed.length);
        out += source_sheet_index < 0
            ? token
            : moved_reference_token(token, parsed.reference, source_sheet_index, rectangles) ?? token;
        index += parsed.length;
    }
    return out;
}

/** Compile a move set once for retargeting every formula in a workbook. */
export function compile_a1_formula_move_retargeter(
    sheet_names: readonly string[],
    cell_moves: readonly XlsxFormulaCellMove[],
): (
    formula: string,
    formula_sheet_index: number,
    after_order?: number,
    through_order?: number,
) => string {
    const operations = new Map<number, XlsxFormulaCellMove[]>();
    for (const move of cell_moves) {
        const order = move.order ?? 0;
        const operation = operations.get(order) ?? [];
        operation.push(move);
        operations.set(order, operation);
    }
    const ordered_with_order = [...operations.entries()]
        .sort(([left], [right]) => left - right)
        .map(([order, operation]) => ({ order, rectangles: move_rectangles(operation) }));
    return (
        formula,
        formula_sheet_index,
        after_order = Number.NEGATIVE_INFINITY,
        through_order = Number.POSITIVE_INFINITY,
    ) => ordered_with_order.reduce(
        (current, operation) => operation.order <= after_order || operation.order > through_order
            ? current : retarget_moved_a1_formula_with_map(
            current,
            formula_sheet_index,
            sheet_names,
            operation.rectangles,
        ),
        formula,
    );
}

export function retarget_moved_a1_formula(
    formula: string,
    formula_sheet_index: number,
    sheet_names: readonly string[],
    cell_moves: readonly XlsxFormulaCellMove[],
): string {
    return compile_a1_formula_move_retargeter(sheet_names, cell_moves)(
        formula,
        formula_sheet_index,
    );
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
        if (
            column_range
            && !identifier_character(formula[index + column_range[0].length])
            && formula[index + column_range[0].length] !== '$'
        ) {
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
        if (
            row_range
            && !identifier_character(formula[index + row_range[0].length])
            && formula[index + row_range[0].length] !== '$'
        ) {
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
            || next === '$'
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
