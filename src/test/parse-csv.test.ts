import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse_csv } from '../parse-csv';

const FIXTURES = path.join(__dirname, 'fixtures');

function read_fixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

describe('parse_csv', () => {
    it('parses a basic CSV file into WorkbookData', () => {
        const src = read_fixture('basic.csv');
        const result = parse_csv(src, ',', 10_000);

        expect(result.data.hasFormatting).toBe(false);
        expect(result.data.sheets).toHaveLength(1);

        const sheet = result.data.sheets[0];
        expect(sheet.name).toBe('Sheet1');
        expect(sheet.merges).toEqual([]);
        expect(sheet.rowCount).toBe(4);
        expect(sheet.columnCount).toBe(3);

        expect(sheet.rows[0][0]).toEqual({
            raw: 'Name', formatted: 'Name', bold: false, italic: false,
        });
        expect(sheet.rows[1][1]).toEqual({
            raw: '30', formatted: '30', bold: false, italic: false,
        });
    });

    it('parses a basic TSV file', () => {
        const src = read_fixture('basic.tsv');
        const result = parse_csv(src, '\t', 10_000);

        const sheet = result.data.sheets[0];
        expect(sheet.rowCount).toBe(4);
        expect(sheet.columnCount).toBe(3);
        expect(sheet.rows[0][0]?.raw).toBe('Name');
        expect(sheet.rows[2][2]?.raw).toBe('London');
    });

    it('produces correct line_map for simple files', () => {
        const src = read_fixture('basic.csv');
        const result = parse_csv(src, ',', 10_000);

        expect(result.line_map).toEqual([0, 1, 2, 3]);
    });

    it('produces correct line_map for multi-line quoted fields', () => {
        const src = read_fixture('quoted-multiline.csv');
        const result = parse_csv(src, ',', 10_000);

        const sheet = result.data.sheets[0];
        expect(sheet.rowCount).toBe(3);
        expect(result.line_map).toEqual([0, 1, 3]);
    });

    it('handles empty input', () => {
        const result = parse_csv('', ',', 10_000);
        expect(result.data.sheets[0].rowCount).toBe(0);
        expect(result.data.sheets[0].rows).toEqual([]);
        expect(result.line_map).toEqual([]);
        expect(result.truncationMessage).toBeUndefined();
    });

    it('truncates rows beyond max_rows and reports truncation', () => {
        const rows = ['a,b'];
        for (let i = 0; i < 20; i++) {
            rows.push(`${i},${i}`);
        }
        const src = rows.join('\n');
        const result = parse_csv(src, ',', 10);

        expect(result.data.sheets[0].rowCount).toBe(10);
        expect(result.data.sheets[0].rows).toHaveLength(10);
        expect(result.line_map).toHaveLength(10);
        expect(result.truncationMessage).toBe('Showing 10 of 21 rows');
    });

    it('does not truncate when rows exactly equal max_rows', () => {
        const rows = ['a,b', '1,2', '3,4'];
        const src = rows.join('\n');
        const result = parse_csv(src, ',', 3);

        expect(result.data.sheets[0].rowCount).toBe(3);
        expect(result.truncationMessage).toBeUndefined();
    });

    it('handles rows with varying column counts by padding with nulls', () => {
        const src = 'a,b,c\n1\n2,3';
        const result = parse_csv(src, ',', 10_000);

        const sheet = result.data.sheets[0];
        expect(sheet.columnCount).toBe(3);
        expect(sheet.rows[1][0]?.raw).toBe('1');
        expect(sheet.rows[1][1]).toBeNull();
        expect(sheet.rows[1][2]).toBeNull();
    });
});
