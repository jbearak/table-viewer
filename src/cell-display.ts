import type { CellData, SheetData } from './types';

export function get_raw_cell_text(raw: CellData['raw']): string {
    return raw !== null ? String(raw) : '';
}

export function workbook_has_formatting(sheets: SheetData[]): boolean {
    for (const sheet of sheets) {
        for (const row of sheet.rows) {
            for (const cell of row) {
                if (!cell || cell.raw === null) continue;
                if (cell.formatted !== get_raw_cell_text(cell.raw)) return true;
            }
        }
    }
    return false;
}
