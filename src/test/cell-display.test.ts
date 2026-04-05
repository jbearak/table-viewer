import { describe, it, expect } from 'vitest';
import { get_raw_cell_text, workbook_has_formatting } from '../cell-display';
import type { CellData, SheetData } from '../types';

function cell(raw: CellData['raw'], formatted: string): CellData {
    return { raw, formatted, bold: false, italic: false };
}

function sheet(rows: (CellData | null)[][]): SheetData {
    return {
        name: 'Sheet1',
        rows,
        merges: [],
        columnCount: rows[0]?.length ?? 0,
        rowCount: rows.length,
    };
}

describe('get_raw_cell_text', () => {
    it('matches the raw display text for boolean cells', () => {
        expect(get_raw_cell_text(true)).toBe('true');
        expect(get_raw_cell_text(false)).toBe('false');
    });
});

describe('workbook_has_formatting', () => {
    it('treats uppercase formatted booleans as formatting differences', () => {
        const sheets = [sheet([[cell(true, 'TRUE'), cell(false, 'FALSE')]])];
        expect(workbook_has_formatting(sheets)).toBe(true);
    });

    it('ignores cells whose formatted values already match raw display text', () => {
        const sheets = [sheet([[cell(true, 'true'), cell(42, '42')]])];
        expect(workbook_has_formatting(sheets)).toBe(false);
    });
});
