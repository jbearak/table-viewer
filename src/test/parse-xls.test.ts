import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse_xls } from '../parse-xls';
import type { WorkbookData } from '../types';

const FIXTURES = path.join(__dirname, 'fixtures');

function read_fixture(name: string): Buffer {
    return fs.readFileSync(path.join(FIXTURES, name));
}

/** Extract WorkbookData from either old (WorkbookData) or new ({ data, warnings }) return type */
function get_data(result: WorkbookData | { data: WorkbookData; warnings: string[] }): WorkbookData {
    return 'data' in result && 'warnings' in result ? result.data : result as WorkbookData;
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
