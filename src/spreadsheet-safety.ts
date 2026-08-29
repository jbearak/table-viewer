const MEBIBYTE = 1024 * 1024;

export const MAX_WORKBOOK_FILE_BYTES = 256 * MEBIBYTE;
export const MAX_WORKBOOK_SHEETS = 64;
export const MAX_SHEET_ROWS = 1_000_000;
export const MAX_SHEET_COLUMNS = 256;
export const MAX_SHEET_MERGES = 10_000;
export const MAX_WORKBOOK_CELLS = 50_000_000;
export const MAX_WORKBOOK_FORMULAS = 100_000;
export const MAX_WORKBOOK_FORMULA_REFERENCES = 1_000_000;
export const MAX_WORKBOOK_FORMULA_RANGES = 100_000;
/** Excel formula body limit, excluding the normalized leading equals sign. */
export const MAX_XLSX_FORMULA_CHARACTERS = 8_192;
// Covers UTF-8 plus the standard/numeric XML entity spellings with margin,
// while bounding allocation before worksheet formula text is decoded.
export const MAX_XLSX_FORMULA_XML_BYTES = MAX_XLSX_FORMULA_CHARACTERS * 8;
export const MAX_CSV_ROWS = 1_000_000;

export interface WorkbookBudget {
    total_cells: number;
    total_formulas: number;
    total_formula_references: number;
    total_formula_ranges: number;
}

export class FileSizeLimitExceededError extends Error {
    constructor(
        readonly actualBytes: number,
        readonly limitBytes: number,
    ) {
        super(
            `File size exceeds the configured ${format_mebibytes(limitBytes)} MiB threshold.`
        );
        this.name = 'FileSizeLimitExceededError';
    }
}

export function create_workbook_budget(): WorkbookBudget {
    return {
        total_cells: 0,
        total_formulas: 0,
        total_formula_references: 0,
        total_formula_ranges: 0,
    };
}

export function assert_safe_formula_cells(
    budget: WorkbookBudget,
    added: number,
): void {
    if (
        !Number.isSafeInteger(added)
        || added < 0
        || budget.total_formulas + added > MAX_WORKBOOK_FORMULAS
    ) {
        throw new Error(
            'Workbook has too many formulas to calculate safely '
            + `(max ${MAX_WORKBOOK_FORMULAS.toLocaleString()})`,
        );
    }
    budget.total_formulas += added;
}

export function assert_safe_formula_references(
    budget: WorkbookBudget,
    added: number,
): void {
    if (
        !Number.isSafeInteger(added)
        || added < 0
        || budget.total_formula_references + added > MAX_WORKBOOK_FORMULA_REFERENCES
    ) {
        throw new Error(
            'Workbook has too many formula references to open safely '
            + `(max ${MAX_WORKBOOK_FORMULA_REFERENCES.toLocaleString()})`,
        );
    }
    budget.total_formula_references += added;
}

export function assert_safe_formula_ranges(
    budget: WorkbookBudget,
    added: number,
): void {
    if (
        !Number.isSafeInteger(added)
        || added < 0
        || budget.total_formula_ranges + added > MAX_WORKBOOK_FORMULA_RANGES
    ) {
        throw new Error(
            'Workbook has too many formula ranges to index safely '
            + `(max ${MAX_WORKBOOK_FORMULA_RANGES.toLocaleString()})`,
        );
    }
    budget.total_formula_ranges += added;
}

/** Reject formula text that Excel cannot represent before dependency parsing. */
export function assert_safe_xlsx_formula_text(value: string): void {
    const body_length = value.startsWith('=') ? value.length - 1 : value.length;
    if (body_length > MAX_XLSX_FORMULA_CHARACTERS) {
        throw new Error(
            'Formula exceeds Excel\'s maximum length '
            + `(${MAX_XLSX_FORMULA_CHARACTERS.toLocaleString()} characters)`,
        );
    }
}

/** Bound hostile entity-heavy formula markup before UTF-8/XML expansion. */
export function assert_safe_xlsx_formula_xml_bytes(byte_length: number): void {
    if (
        !Number.isSafeInteger(byte_length)
        || byte_length < 0
        || byte_length > MAX_XLSX_FORMULA_XML_BYTES
    ) {
        throw new Error('Formula XML encoding exceeds the safe length limit');
    }
}

export function assert_safe_file_size(size: number, max_mib?: number): void {
    const limit = max_mib !== undefined
        ? max_mib * MEBIBYTE
        : MAX_WORKBOOK_FILE_BYTES;
    if (size > limit) {
        throw new FileSizeLimitExceededError(size, limit);
    }
}

export function assert_safe_sheet_count(sheet_count: number): void {
    if (sheet_count > MAX_WORKBOOK_SHEETS) {
        throw new Error(
            `Workbook has too many sheets to open safely (max ${MAX_WORKBOOK_SHEETS})`
        );
    }
}

export function assert_safe_sheet_shape(
    budget: WorkbookBudget,
    row_count: number,
    col_count: number,
    merge_count: number
): void {
    if (row_count > MAX_SHEET_ROWS) {
        throw new Error(
            `Worksheet has too many rows to open safely (max ${MAX_SHEET_ROWS})`
        );
    }

    if (col_count > MAX_SHEET_COLUMNS) {
        throw new Error(
            `Worksheet has too many columns to open safely (max ${MAX_SHEET_COLUMNS})`
        );
    }

    if (merge_count > MAX_SHEET_MERGES) {
        throw new Error(
            `Worksheet has too many merged ranges to open safely (max ${MAX_SHEET_MERGES})`
        );
    }

    const sheet_cells = row_count * col_count;
    if (budget.total_cells + sheet_cells > MAX_WORKBOOK_CELLS) {
        throw new Error(
            `Workbook is too large to render safely (max ${MAX_WORKBOOK_CELLS.toLocaleString()} cells)`
        );
    }

    budget.total_cells += sheet_cells;
}

function format_mebibytes(bytes: number): string {
    const mebibytes = bytes / MEBIBYTE;
    return String(Math.round(mebibytes * 10) / 10);
}
