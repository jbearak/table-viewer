import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { XlsxDataSource } from '../data-source/xlsx-source';
import { ExcelHeaderDataSource } from '../data-source/excel-header-source';
import { parse_xlsx } from '../parse-xlsx';
import type { RenderedCell } from '../data-source/interface';

const load = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

describe('XlsxDataSource', () => {
    it('reports sheet shape in meta', async () => {
        const ds = await XlsxDataSource.create(load('basic.xlsx'));
        const m = ds.meta();
        expect(m.sheets.length).toBeGreaterThan(0);
        expect(m.sheets[0].rowCount).toBeGreaterThan(0);
        expect(m.sheets[0].columnCount).toBeGreaterThan(0);
    });
    it('read_rows matches parse_xlsx cell values for the same window', async () => {
        const buf = load('basic.xlsx');
        const ds = await XlsxDataSource.create(buf);
        const w = ds.read_rows(0, 0, 5);
        // Compare against legacy parse for the same cells.
        const legacy = (await parse_xlsx(buf)).data.sheets[0].rows;
        for (let r = 0; r < w.rows.length; r++) {
            for (let c = 0; c < w.rows[r].length; c++) {
                expect(w.rows[r][c]?.formatted ?? null).toEqual(legacy[r]?.[c]?.formatted ?? null);
            }
        }
    });
    it('preserves merges in meta', async () => {
        const ds = await XlsxDataSource.create(load('merged.xlsx'));
        expect(ds.meta().sheets[0].merges.length).toBeGreaterThan(0);
    });
    it('preserves bold/italic flags', async () => {
        const ds = await XlsxDataSource.create(load('styled.xlsx'));
        const w = ds.read_rows(0, 0, 50);
        const anyStyled = w.rows.flat().some((c: RenderedCell | null) => c != null && (c.bold || c.italic));
        expect(anyStyled).toBe(true);
    });
    it('auto-promotes the basic workbook headers through the shared decorator', async () => {
        const physical = await XlsxDataSource.create(load('basic.xlsx'));
        const ds = new ExcelHeaderDataSource(physical);
        const people = ds.meta().sheets[0];
        const inventory = ds.meta().sheets[1];
        expect(people.columnNames).toEqual(['Name', 'Age', 'Active', 'Joined']);
        expect(people.rowCount).toBe(2);
        expect(inventory.columnNames).toEqual(['Product', 'Price', 'Quantity']);
        expect(ds.read_rows(0, 0, 1).rows[0][0]?.raw).toBe('Alice');
        expect(ds.read_rows(0, 0, 1).rows[0][3]?.rawType).toBe('date');

        ds.set_override('People', 'off');
        expect(ds.meta().sheets[0].rowCount).toBe(3);
        expect(ds.read_rows(0, 0, 1).rows[0][0]?.raw).toBe('Name');
    });
});
