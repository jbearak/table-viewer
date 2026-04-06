const MEBIBYTE = 1024 * 1024;

export const MAX_WORKBOOK_FILE_BYTES = 16 * MEBIBYTE;
export const MAX_WORKBOOK_SHEETS = 64;
export const MAX_SHEET_ROWS = 10_000;
export const MAX_SHEET_COLUMNS = 256;
export const MAX_SHEET_MERGES = 10_000;
export const MAX_WORKBOOK_CELLS = 250_000;

export interface WorkbookBudget {
    total_cells: number;
}

export function create_workbook_budget(): WorkbookBudget {
    return { total_cells: 0 };
}

export function assert_safe_file_size(size: number, max_mib?: number): void {
    const limit = max_mib !== undefined
        ? max_mib * MEBIBYTE
        : MAX_WORKBOOK_FILE_BYTES;
    if (size > limit) {
        throw new Error(
            `File is too large to open safely (max ${format_mebibytes(limit)} MiB)`
        );
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
