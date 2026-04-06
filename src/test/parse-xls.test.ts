import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse_xls, parse_sheet_records, type BiffRecord } from '../parse-xls';
import { create_workbook_budget } from '../spreadsheet-safety';
import type { WorkbookData } from '../types';

const FIXTURES = path.join(__dirname, 'fixtures');

function read_fixture(name: string): Buffer {
    return fs.readFileSync(path.join(FIXTURES, name));
}

/** Extract WorkbookData from either old (WorkbookData) or new ({ data, warnings }) return type */
function get_data(result: WorkbookData | { data: WorkbookData; warnings: string[] }): WorkbookData {
    return 'data' in result && 'warnings' in result ? result.data : result as WorkbookData;
}

const RT_DIMENSION = 0x0200;
const RT_NUMBER = 0x0203;
const RT_RK = 0x027E;
const RT_MULRK = 0x00BD;
const RT_FORMULA = 0x0006;
const OUT_OF_RANGE_DATE_SERIAL = 200000000;
const DATE_XFS = [{ font_index: 0, format_index: 14 }];
const DEFAULT_FONTS = [{ bold: false, italic: false }];

function build_record(type: number, data: Buffer): BiffRecord {
    return { type, data, offset: 0 };
}

function build_dimension_record(row_count: number, col_count: number): BiffRecord {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(row_count, 4);
    data.writeUInt16LE(col_count, 10);
    return build_record(RT_DIMENSION, data);
}

function build_number_record(value: number): BiffRecord {
    const data = Buffer.alloc(14);
    data.writeUInt16LE(0, 0);
    data.writeUInt16LE(0, 2);
    data.writeUInt16LE(0, 4);
    data.writeDoubleLE(value, 6);
    return build_record(RT_NUMBER, data);
}

function encode_integer_rk(value: number): number {
    return (value << 2) | 0x02;
}

function build_rk_record(value: number): BiffRecord {
    const data = Buffer.alloc(10);
    data.writeUInt16LE(0, 0);
    data.writeUInt16LE(0, 2);
    data.writeUInt16LE(0, 4);
    data.writeInt32LE(encode_integer_rk(value), 6);
    return build_record(RT_RK, data);
}

function build_mulrk_record(value: number): BiffRecord {
    const data = Buffer.alloc(12);
    data.writeUInt16LE(0, 0);
    data.writeUInt16LE(0, 2);
    data.writeUInt16LE(0, 4);
    data.writeInt32LE(encode_integer_rk(value), 6);
    data.writeUInt16LE(0, 10);
    return build_record(RT_MULRK, data);
}

function build_formula_record(value: number): BiffRecord {
    const data = Buffer.alloc(20);
    data.writeUInt16LE(0, 0);
    data.writeUInt16LE(0, 2);
    data.writeUInt16LE(0, 4);
    data.writeDoubleLE(value, 6);
    return build_record(RT_FORMULA, data);
}

function parse_single_cell_sheet(record: BiffRecord) {
    return parse_sheet_records(
        [build_dimension_record(1, 1), record],
        [],
        DATE_XFS,
        DEFAULT_FONTS,
        new Map(),
        0,
        create_workbook_budget()
    );
}

describe('parse_xls', () => {
    describe('basic.xls', () => {
        it('parses two sheets with correct names', () => {
            const result = parse_xls(read_fixture('basic.xls'));
            const data = get_data(result);
            expect(data.sheets).toHaveLength(2);
            expect(data.sheets[0].name).toBe('People');
            expect(data.sheets[1].name).toBe('Inventory');
        });

        it('parses string, number, and boolean cell values', () => {
            const result = parse_xls(read_fixture('basic.xls'));
            const data = get_data(result);
            const people = data.sheets[0];

            // Header row
            expect(people.rows[0][0]?.raw).toBe('Name');
            expect(people.rows[0][1]?.raw).toBe('Age');

            // Data row — string
            expect(people.rows[1][0]?.raw).toBe('Alice');
            // Data row — number
            expect(people.rows[1][1]?.raw).toBe(30);
            // Data row — boolean
            expect(people.rows[1][2]?.raw).toBe(true);
        });

        it('returns correct row and column counts', () => {
            const result = parse_xls(read_fixture('basic.xls'));
            const data = get_data(result);
            const people = data.sheets[0];
            expect(people.rowCount).toBe(3);
            expect(people.columnCount).toBe(4);
        });
    });

    describe('merged.xls', () => {
        it('detects merge ranges', () => {
            const result = parse_xls(read_fixture('merged.xls'));
            const data = get_data(result);
            const sheet = data.sheets[0];
            expect(sheet.merges).toHaveLength(2);

            // Horizontal merge: A1:C1
            expect(sheet.merges).toContainEqual({
                startRow: 0, startCol: 0, endRow: 0, endCol: 2,
            });
            // Vertical merge: A3:A4
            expect(sheet.merges).toContainEqual({
                startRow: 2, startCol: 0, endRow: 3, endCol: 0,
            });
        });

        it('returns null for non-anchor merged cells', () => {
            const result = parse_xls(read_fixture('merged.xls'));
            const data = get_data(result);
            const sheet = data.sheets[0];

            // A1 is the anchor — should have content
            expect(sheet.rows[0][0]?.raw).toBe('Merged Header');
            // B1, C1 are merged into A1 — should be null
            expect(sheet.rows[0][1]).toBeNull();
            expect(sheet.rows[0][2]).toBeNull();
        });
    });

    describe('empty-sheet.xls', () => {
        it('handles empty sheets', () => {
            const result = parse_xls(read_fixture('empty-sheet.xls'));
            const data = get_data(result);
            expect(data.sheets).toHaveLength(2);

            const empty = data.sheets.find(s => s.name === 'EmptySheet');
            expect(empty).toBeDefined();
            // The fixture's EmptySheet has ref A1 (ghost cell), so the parser
            // produces 1 row × 1 column with a null-valued cell.
            expect(empty!.rowCount).toBe(1);
            expect(empty!.columnCount).toBe(1);
            expect(empty!.rows[0][0]?.raw).toBeNull();
        });
    });

    describe('large-range.xls', () => {
        it('handles sparse data across a wide range', () => {
            const result = parse_xls(read_fixture('large-range.xls'));
            const data = get_data(result);
            const sheet = data.sheets[0];
            expect(sheet.rowCount).toBe(50);
            expect(sheet.columnCount).toBe(26); // A through Z

            expect(sheet.rows[0][0]?.raw).toBe('Top-left');
            expect(sheet.rows[49][25]?.raw).toBe(12345);
        });
    });
});

describe('parse_xls error handling', () => {
    it('throws for invalid buffer', () => {
        expect(() => parse_xls(Buffer.from('not an xls file'))).toThrow(
            'Not a valid .xls file'
        );
    });

    it('throws for empty buffer', () => {
        expect(() => parse_xls(Buffer.alloc(0))).toThrow();
    });
});

describe('parse_xls warnings', () => {
    it('returns empty warnings for valid files', () => {
        const result = parse_xls(read_fixture('basic.xls'));
        const warnings = 'warnings' in result ? result.warnings : [];
        expect(warnings).toHaveLength(0);
    });
});

describe('parse_sheet_records date guards', () => {
    it('keeps out-of-range NUMBER date serials as numbers', () => {
        const sheet = parse_single_cell_sheet(build_number_record(OUT_OF_RANGE_DATE_SERIAL));
        expect(sheet.rows[0][0]?.raw).toBe(OUT_OF_RANGE_DATE_SERIAL);
    });

    it('keeps out-of-range RK date serials as numbers', () => {
        const sheet = parse_single_cell_sheet(build_rk_record(OUT_OF_RANGE_DATE_SERIAL));
        expect(sheet.rows[0][0]?.raw).toBe(OUT_OF_RANGE_DATE_SERIAL);
    });

    it('keeps out-of-range MULRK date serials as numbers', () => {
        const sheet = parse_single_cell_sheet(build_mulrk_record(OUT_OF_RANGE_DATE_SERIAL));
        expect(sheet.rows[0][0]?.raw).toBe(OUT_OF_RANGE_DATE_SERIAL);
    });

    it('keeps out-of-range FORMULA date serials as numbers', () => {
        const sheet = parse_single_cell_sheet(build_formula_record(OUT_OF_RANGE_DATE_SERIAL));
        expect(sheet.rows[0][0]?.raw).toBe(OUT_OF_RANGE_DATE_SERIAL);
    });
});
