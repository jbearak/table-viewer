import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { XlsxDataSource } from '../data-source/xlsx-source';
import { parse_xlsx } from '../parse-xlsx';

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
        const anyStyled = w.rows.flat().some((c) => c && (c.bold || c.italic));
        expect(anyStyled).toBe(true);
    });
});
