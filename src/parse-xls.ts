import XLSX from 'xlsx';
import type { WorkbookData, SheetData, CellData, MergeRange } from './types';

export function parse_xls(buffer: Buffer): WorkbookData {
    const workbook = XLSX.read(buffer, {
        type: 'buffer',
        cellStyles: true,
        cellDates: true,
        cellNF: true,
    });

    const sheets: SheetData[] = [];

    for (const sheet_name of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheet_name];
        if (!worksheet) continue;

        const ref = worksheet['!ref'];
        if (!ref) {
            sheets.push({
                name: sheet_name,
                rows: [],
                merges: [],
                columnCount: 0,
                rowCount: 0,
            });
            continue;
        }

        const range = XLSX.utils.decode_range(ref);
        const row_count = range.e.r - range.s.r + 1;
        const col_count = range.e.c - range.s.c + 1;

        const merges: MergeRange[] = [];
        const merged_cells = new Set<string>();

        for (const merge of worksheet['!merges'] ?? []) {
            const m: MergeRange = {
                startRow: merge.s.r - range.s.r,
                startCol: merge.s.c - range.s.c,
                endRow: merge.e.r - range.s.r,
                endCol: merge.e.c - range.s.c,
            };
            merges.push(m);
            for (let r = m.startRow; r <= m.endRow; r++) {
                for (let c = m.startCol; c <= m.endCol; c++) {
                    if (r === m.startRow && c === m.startCol) continue;
                    merged_cells.add(`${r}:${c}`);
                }
            }
        }

        const rows: (CellData | null)[][] = [];

        for (let r = 0; r < row_count; r++) {
            const row_data: (CellData | null)[] = [];
            for (let c = 0; c < col_count; c++) {
                if (merged_cells.has(`${r}:${c}`)) {
                    row_data.push(null);
                    continue;
                }

                const cell_addr = XLSX.utils.encode_cell({
                    r: r + range.s.r,
                    c: c + range.s.c,
                });
                const cell = worksheet[cell_addr];
                row_data.push(extract_cell_data(cell));
            }
            rows.push(row_data);
        }

        sheets.push({
            name: sheet_name,
            rows,
            merges,
            columnCount: col_count,
            rowCount: row_count,
        });
    }

    return { sheets };
}

function extract_cell_data(cell: XLSX.CellObject | undefined): CellData {
    if (!cell) {
        return { raw: null, formatted: '', bold: false, italic: false };
    }

    const raw = normalize_value(cell);
    const formatted = cell.w ?? (raw !== null ? String(raw) : '');

    const style = cell.s as { font?: { bold?: boolean; italic?: boolean } } | undefined;
    const bold = style?.font?.bold === true;
    const italic = style?.font?.italic === true;

    return { raw, formatted, bold, italic };
}

function normalize_value(cell: XLSX.CellObject): string | number | boolean | null {
    if (cell.v === null || cell.v === undefined) return null;
    if (cell.t === 'n') return cell.v as number;
    if (cell.t === 'b') return cell.v as boolean;
    if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString();
    if (cell.t === 'e') return String(cell.w ?? cell.v);
    return String(cell.v);
}
