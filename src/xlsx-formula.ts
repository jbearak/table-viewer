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

function identifier_character(char: string | undefined): boolean {
    return char !== undefined && /[\p{L}\p{N}_.]/u.test(char);
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
