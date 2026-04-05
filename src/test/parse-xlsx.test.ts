import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse_xlsx } from '../parse-xlsx';

const FIXTURES = path.join(__dirname, 'fixtures');

function read_fixture(name: string): Uint8Array {
    return fs.readFileSync(path.join(FIXTURES, name));
}

describe('parse_xlsx', () => {
    describe('basic.xlsx', () => {
        it('parses two sheets with correct names', async () => {
            const { data, warnings } = await parse_xlsx(read_fixture('basic.xlsx'));
            expect(data.sheets).toHaveLength(2);
            expect(data.sheets[0].name).toBe('People');
            expect(data.sheets[1].name).toBe('Inventory');
            expect(warnings).toHaveLength(0);
        });

        it('parses string, number, and boolean cell values', async () => {
            const { data } = await parse_xlsx(read_fixture('basic.xlsx'));
            const people = data.sheets[0];

            // Header row
            expect(people.rows[0][0]?.raw).toBe('Name');
            expect(people.rows[0][1]?.raw).toBe('Age');
            // Data row
            expect(people.rows[1][0]?.raw).toBe('Alice');
            expect(people.rows[1][1]?.raw).toBe(30);
            expect(people.rows[1][2]?.raw).toBe(true);
        });

        it('parses date values as ISO strings', async () => {
            const { data } = await parse_xlsx(read_fixture('basic.xlsx'));
            const people = data.sheets[0];
            // Dates should be ISO strings
            const joined = people.rows[1][3]?.raw;
            expect(typeof joined).toBe('string');
            expect(String(joined)).toContain('2024-01-15');
        });

        it('returns correct row and column counts', async () => {
            const { data } = await parse_xlsx(read_fixture('basic.xlsx'));
            const people = data.sheets[0];
            expect(people.rowCount).toBe(3);
            expect(people.columnCount).toBe(4);
        });

        it('parses the second sheet correctly', async () => {
            const { data } = await parse_xlsx(read_fixture('basic.xlsx'));
            const inv = data.sheets[1];
            expect(inv.rows[0][0]?.raw).toBe('Product');
            expect(inv.rows[1][0]?.raw).toBe('Widget');
            expect(inv.rows[1][1]?.raw).toBe(9.99);
            expect(inv.rows[1][2]?.raw).toBe(100);
        });
    });

    describe('merged.xlsx', () => {
        it('detects merge ranges', async () => {
            const { data } = await parse_xlsx(read_fixture('merged.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.merges).toHaveLength(2);
            expect(sheet.merges).toContainEqual({
                startRow: 0, startCol: 0, endRow: 0, endCol: 2,
            });
            expect(sheet.merges).toContainEqual({
                startRow: 2, startCol: 0, endRow: 3, endCol: 0,
            });
        });

        it('returns null for non-anchor merged cells', async () => {
            const { data } = await parse_xlsx(read_fixture('merged.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][0]?.raw).toBe('Merged Header');
            expect(sheet.rows[0][1]).toBeNull();
            expect(sheet.rows[0][2]).toBeNull();
        });

        it('returns correct data in non-merged cells', async () => {
            const { data } = await parse_xlsx(read_fixture('merged.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[1][0]?.raw).toBe('A');
            expect(sheet.rows[1][1]?.raw).toBe('B');
            expect(sheet.rows[1][2]?.raw).toBe('C');
            expect(sheet.rows[2][0]?.raw).toBe('Tall');
            expect(sheet.rows[2][1]?.raw).toBe('D');
            expect(sheet.rows[2][2]?.raw).toBe('E');
        });

        it('returns null for vertically merged non-anchor cell', async () => {
            const { data } = await parse_xlsx(read_fixture('merged.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[3][0]).toBeNull();
            expect(sheet.rows[3][1]?.raw).toBe('F');
            expect(sheet.rows[3][2]?.raw).toBe('G');
        });
    });

    describe('styled.xlsx', () => {
        it('detects bold cells', async () => {
            const { data } = await parse_xlsx(read_fixture('styled.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][1]?.bold).toBe(true);
            expect(sheet.rows[1][1]?.bold).toBe(true);
            expect(sheet.rows[0][0]?.bold).toBe(false);
        });

        it('detects italic cells', async () => {
            const { data } = await parse_xlsx(read_fixture('styled.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][2]?.italic).toBe(true);
            expect(sheet.rows[1][2]?.italic).toBe(true);
        });

        it('detects bold+italic cells', async () => {
            const { data } = await parse_xlsx(read_fixture('styled.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][3]?.bold).toBe(true);
            expect(sheet.rows[0][3]?.italic).toBe(true);
        });

        it('marks normal cells as not bold and not italic', async () => {
            const { data } = await parse_xlsx(read_fixture('styled.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][0]?.bold).toBe(false);
            expect(sheet.rows[0][0]?.italic).toBe(false);
        });
    });

    describe('empty-sheet.xlsx', () => {
        it('handles empty sheets', async () => {
            const { data } = await parse_xlsx(read_fixture('empty-sheet.xlsx'));
            expect(data.sheets).toHaveLength(2);
            const empty = data.sheets.find(s => s.name === 'EmptySheet');
            expect(empty).toBeDefined();
            expect(empty!.rowCount).toBe(0);
            expect(empty!.columnCount).toBe(0);
        });

        it('parses filled sheet alongside empty sheet', async () => {
            const { data } = await parse_xlsx(read_fixture('empty-sheet.xlsx'));
            const filled = data.sheets.find(s => s.name === 'FilledSheet');
            expect(filled).toBeDefined();
            expect(filled!.rows[0][0]?.raw).toBe('Hello');
        });
    });

    describe('formatted.xlsx', () => {
        it('preserves raw numeric values', async () => {
            const { data } = await parse_xlsx(read_fixture('formatted.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][0]?.raw).toBe(1234.56);
            expect(sheet.rows[0][1]?.raw).toBe(0.75);
        });

        it('applies number formatting via SSF', async () => {
            const { data } = await parse_xlsx(read_fixture('formatted.xlsx'));
            const sheet = data.sheets[0];
            // Currency format
            const currency = sheet.rows[0][0]?.formatted;
            expect(currency).toContain('1,234.56');
            // Percentage format
            const pct = sheet.rows[0][1]?.formatted;
            expect(pct).toContain('75');
            expect(pct).toContain('%');
        });
    });
});
