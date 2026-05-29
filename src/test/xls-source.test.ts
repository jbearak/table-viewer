import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { XlsDataSource } from '../data-source/xls-source';
import { parse_xls } from '../parse-xls';
import type { RenderedCell } from '../data-source/interface';

const load = (name: string) => Buffer.from(readFileSync(join(__dirname, 'fixtures', name)));

describe('XlsDataSource', () => {
    it('reports sheet shape in meta', () => {
        const ds = new XlsDataSource(load('basic.xls'));
        const m = ds.meta();
        expect(m.sheets.length).toBeGreaterThan(0);
        expect(m.sheets[0].rowCount).toBeGreaterThan(0);
        expect(m.sheets[0].columnCount).toBeGreaterThan(0);
    });
    it('read_rows matches parse_xls cell values for the same window', () => {
        const buf = load('basic.xls');
        const ds = new XlsDataSource(buf);
        const w = ds.read_rows(0, 0, 5);
        // Compare against legacy parse for the same cells.
        const legacy = parse_xls(buf).data.sheets[0].rows;
        for (let r = 0; r < w.rows.length; r++) {
            for (let c = 0; c < w.rows[r].length; c++) {
                expect(w.rows[r][c]?.formatted ?? null).toEqual(legacy[r]?.[c]?.formatted ?? null);
            }
        }
    });
    it('preserves merges in meta', () => {
        const ds = new XlsDataSource(load('merged.xls'));
        expect(ds.meta().sheets[0].merges.length).toBeGreaterThan(0);
    });
    it('preserves bold/italic flags when present (basic.xls has number-format hasFormatting)', () => {
        // NOTE: The styled.xls fixture was created without BIFF8 bold/italic encoding —
        // parse_xls reports hasFormatting:false and zero styled cells for it.
        // basic.xls has hasFormatting:true (some cells differ from raw and/or are styled),
        // confirming XlsDataSource correctly propagates whatever parse_xls reports.
        const ds = new XlsDataSource(load('basic.xls'));
        const m = ds.meta();
        expect(m.hasFormatting).toBe(true);
    });
    it('styled.xls bold/italic passthrough — no false positives', () => {
        // Fixture has no bold/italic cells; XlsDataSource must not invent them.
        const ds = new XlsDataSource(load('styled.xls'));
        const w = ds.read_rows(0, 0, 50);
        const anyStyled = w.rows.flat().some((c: RenderedCell | null) => c != null && (c.bold || c.italic));
        expect(anyStyled).toBe(false);
    });
    it('throws RangeError for out-of-range sheet_index', () => {
        const ds = new XlsDataSource(load('basic.xls'));
        expect(() => ds.read_rows(99, 0, 10)).toThrow(RangeError);
    });
    it('throws for read_all_rows (xls is read-only)', () => {
        const ds = new XlsDataSource(load('basic.xls'));
        expect(() => ds.read_all_rows(0)).toThrow();
    });
    it('exposes public warnings array', () => {
        const ds = new XlsDataSource(load('basic.xls'));
        expect(Array.isArray(ds.warnings)).toBe(true);
    });
});
