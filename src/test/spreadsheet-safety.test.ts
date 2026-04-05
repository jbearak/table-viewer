import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parse_xlsx } from '../parse-xlsx';
import {
    assert_safe_file_size,
    assert_safe_sheet_shape,
    create_workbook_budget,
    MAX_WORKBOOK_FILE_BYTES,
    MAX_SHEET_COLUMNS,
    MAX_SHEET_MERGES,
    MAX_SHEET_ROWS,
    MAX_WORKBOOK_SHEETS,
    assert_safe_sheet_count,
} from '../spreadsheet-safety';

describe('spreadsheet safety limits', () => {
    it('rejects oversized files before parsing', () => {
        expect(() =>
            assert_safe_file_size(MAX_WORKBOOK_FILE_BYTES + 1)
        ).toThrow('File is too large to open safely');
    });

    it('rejects excessive sheet counts', () => {
        expect(() =>
            assert_safe_sheet_count(MAX_WORKBOOK_SHEETS + 1)
        ).toThrow('Workbook has too many sheets to open safely');
    });

    it('rejects excessive row counts', () => {
        expect(() =>
            assert_safe_sheet_shape(
                create_workbook_budget(),
                MAX_SHEET_ROWS + 1,
                1,
                0
            )
        ).toThrow('Worksheet has too many rows to open safely');
    });

    it('rejects excessive column counts', () => {
        expect(() =>
            assert_safe_sheet_shape(
                create_workbook_budget(),
                1,
                MAX_SHEET_COLUMNS + 1,
                0
            )
        ).toThrow('Worksheet has too many columns to open safely');
    });

    it('rejects excessive merge counts', () => {
        expect(() =>
            assert_safe_sheet_shape(
                create_workbook_budget(),
                1,
                1,
                MAX_SHEET_MERGES + 1
            )
        ).toThrow('Worksheet has too many merged ranges to open safely');
    });

    it('rejects excessive total cell counts across a workbook', () => {
        const budget = create_workbook_budget();
        assert_safe_sheet_shape(budget, 1000, 250, 0);
        expect(() =>
            assert_safe_sheet_shape(budget, 1, 1, 0)
        ).toThrow('Workbook is too large to render safely');
    });
});

describe('parse_xlsx safety', () => {
    it('rejects workbooks whose row count exceeds the safe limit', async () => {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('__proto__');
        sheet.getCell(`A${MAX_SHEET_ROWS + 1}`).value = 'hostile';

        const buffer = await workbook.xlsx.writeBuffer();

        await expect(
            parse_xlsx(new Uint8Array(buffer))
        ).rejects.toThrow('Worksheet has too many rows to open safely');
    });
});
