import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { XlsxDataSource } from '../data-source/xlsx-source';
import { ExcelHeaderDataSource } from '../data-source/excel-header-source';
import { parse_xlsx } from '../parse-xlsx';
import type { RenderedCell } from '../data-source/interface';
import { transformed_window } from '../table-transform';

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
    it('read_columns matches full-row raw types and formatting', async () => {
        const ds = await XlsxDataSource.create(load('basic.xlsx'));
        const full = ds.read_rows(0, 0, 3).rows;
        const selected = ds.read_columns(0, 0, 3, [3, 0]).rows;
        expect(selected).toEqual(full.map((row) => [row[3] ?? null, row[0] ?? null]));
    });
    it('read_rows_indexed preserves full-row values, order, and duplicates', async () => {
        const ds = await XlsxDataSource.create(load('basic.xlsx'));
        const full = ds.read_rows(0, 0, 3).rows;
        expect(ds.read_rows_indexed(0, Uint32Array.from([2, 0, 2])).rows)
            .toEqual([full[2], full[0], full[2]]);
        expect(ds.read_rows_indexed(0, []).rows).toEqual([]);
        expect(() => ds.read_rows_indexed(0, [3])).toThrow(RangeError);
        expect(() => ds.read_rows_indexed(0.5, [])).toThrow(RangeError);
        expect(() => ds.read_rows_indexed(Number.NaN, [])).toThrow(RangeError);

        const indices = Uint32Array.from(
            { length: 100 },
            (_, position) => [2, 0, 1, 2, 1][position % 5],
        );
        const indexed = vi.spyOn(ds, 'read_rows_indexed');
        const sequential = vi.spyOn(ds, 'read_rows');
        expect(transformed_window(ds, 0, 0, 100, indices).rows)
            .toEqual(Array.from(indices, (row) => full[row]));
        expect(indexed).toHaveBeenCalledTimes(1);
        expect(sequential).not.toHaveBeenCalled();
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
        expect(ds.read_columns(0, 0, 1, [3, 0]).rows[0].map((value) => value?.raw))
            .toEqual([ds.read_rows(0, 0, 1).rows[0][3]?.raw, 'Alice']);

        ds.set_override('People', 'off');
        expect(ds.meta().sheets[0].rowCount).toBe(3);
        expect(ds.read_rows(0, 0, 1).rows[0][0]?.raw).toBe('Name');
    });
});
