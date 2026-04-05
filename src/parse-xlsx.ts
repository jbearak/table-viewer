import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import type { WorkbookData, SheetData, CellData, MergeRange } from './types';

export async function parse_xlsx(buffer: Uint8Array): Promise<WorkbookData> {
    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);

    const sheets: SheetData[] = [];

    workbook.eachSheet((worksheet) => {
        const merges: MergeRange[] = [];
        const merged_cells = new Set<string>();

        // Collect merge ranges
        for (const [, model] of Object.entries(worksheet.model.merges ?? [])) {
            const range = parse_merge_range(model as string);
            if (!range) continue;
            merges.push(range);
            for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                    if (r === range.startRow && c === range.startCol) continue;
                    merged_cells.add(`${r}:${c}`);
                }
            }
        }

        const row_count = worksheet.rowCount;
        const col_count = worksheet.columnCount;
        const rows: (CellData | null)[][] = [];

        for (let r = 1; r <= row_count; r++) {
            const row_data: (CellData | null)[] = [];
            const ws_row = worksheet.getRow(r);

            for (let c = 1; c <= col_count; c++) {
                if (merged_cells.has(`${r - 1}:${c - 1}`)) {
                    row_data.push(null);
                    continue;
                }

                const cell = ws_row.getCell(c);
                row_data.push(extract_cell_data(cell));
            }

            rows.push(row_data);
        }

        sheets.push({
            name: worksheet.name,
            rows,
            merges,
            columnCount: col_count,
            rowCount: row_count,
        });
    });

    return { sheets };
}

function extract_cell_data(cell: ExcelJS.Cell): CellData {
    const font = cell.font ?? {};
    const bold = font.bold === true;
    const italic = font.italic === true;

    const raw = normalize_value(cell.value);
    const formatted = format_cell_value(cell);

    return { raw, formatted, bold, italic };
}

function normalize_value(value: ExcelJS.CellValue): string | number | boolean | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === 'object') {
        if ('richText' in value && Array.isArray(value.richText)) {
            return value.richText.map((seg: { text: string }) => seg.text).join('');
        }
        if ('result' in value) {
            return normalize_value(value.result as ExcelJS.CellValue);
        }
        if ('error' in value) {
            return String(value.error);
        }
        if ('sharedString' in value) {
            return String(value.sharedString);
        }
    }
    return String(value);
}

function format_cell_value(cell: ExcelJS.Cell): string {
    const raw = normalize_value(cell.value);
    if (raw === null) return '';

    // Apply Excel number format via SheetJS SSF
    const num_fmt = cell.numFmt;
    if (num_fmt && typeof raw === 'number') {
        try {
            return XLSX.SSF.format(num_fmt, raw);
        } catch {
            // Fall through to default
        }
    }

    // For non-numeric or unformatted cells, use ExcelJS text
    const text = cell.text;
    if (text !== undefined && text !== null && text !== '') {
        return text;
    }

    return String(raw);
}

function parse_merge_range(range_str: string): MergeRange | null {
    const match = range_str.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!match) return null;

    return {
        startCol: col_letter_to_index(match[1]),
        startRow: parseInt(match[2], 10) - 1,
        endCol: col_letter_to_index(match[3]),
        endRow: parseInt(match[4], 10) - 1,
    };
}

function col_letter_to_index(letters: string): number {
    let index = 0;
    for (let i = 0; i < letters.length; i++) {
        index = index * 26 + (letters.charCodeAt(i) - 64);
    }
    return index - 1;
}
