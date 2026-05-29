import { describe, it, expect } from 'vitest';
import { CsvDataSource } from '../data-source/csv-source';

const enc = (s: string) => new TextEncoder().encode(s);

describe('CsvDataSource', () => {
    it('reports rowCount and columnCount in meta', () => {
        const ds = new CsvDataSource(enc('a,b,c\n1,2,3\n4,5,6\n'), ',', 10000);
        const m = ds.meta();
        expect(m.sheets[0].rowCount).toBe(3);
        expect(m.sheets[0].columnCount).toBe(3);
        expect(m.sheets[0].merges).toEqual([]);
    });
    it('read_rows returns an absolute-addressed window', () => {
        const ds = new CsvDataSource(enc('a,b\n1,2\n3,4\n5,6\n'), ',', 10000);
        const w = ds.read_rows(0, 1, 2);
        expect(w.startRow).toBe(1);
        expect(w.rows[0][0]?.raw).toBe('1');
        expect(w.rows[1][1]?.raw).toBe('4');
    });
    it('pads short rows to columnCount with null', () => {
        const ds = new CsvDataSource(enc('a,b,c\n1\n'), ',', 10000);
        const w = ds.read_rows(0, 1, 1);
        expect(w.rows[0].length).toBe(3);
        expect(w.rows[0][1]).toBeNull();
        expect(w.rows[0][2]).toBeNull();
    });
    it('empty fields become null cells', () => {
        const ds = new CsvDataSource(enc('a,,c\n'), ',', 10000);
        const w = ds.read_rows(0, 0, 1);
        expect(w.rows[0][1]).toBeNull();
        expect(w.rows[0][0]?.raw).toBe('a');
    });
    it('handles a window crossing a quoted multiline field', () => {
        const ds = new CsvDataSource(enc('h1,h2\n"x\ny",z\np,q\n'), ',', 10000);
        const w = ds.read_rows(0, 1, 1);
        expect(w.rows[0][0]?.raw).toBe('x\ny');
        expect(w.rows[0][1]?.raw).toBe('z');
    });
    it('respects max_rows truncation in meta', () => {
        const ds = new CsvDataSource(enc('1\n2\n3\n4\n'), ',', 2);
        expect(ds.meta().sheets[0].rowCount).toBe(2);
        expect(ds.truncationMessage).toMatch(/2 of 4/);
    });
    it('read_all_rows returns the full sheet', () => {
        const ds = new CsvDataSource(enc('a\nb\nc\n'), ',', 10000);
        expect(ds.read_all_rows(0).length).toBe(3);
    });
    it('supports TSV delimiter', () => {
        const ds = new CsvDataSource(enc('a\tb\n1\t2\n'), '\t', 10000);
        expect(ds.read_rows(0, 1, 1).rows[0][1]?.raw).toBe('2');
    });
    it('correctly windows after multibyte characters', () => {
        // 'café' is 4 UTF-16 chars but 5 UTF-8 bytes (é = 0xC3 0xA9).
        // Row 0 starts at byte 0, row 1 starts at byte 8 (5 + comma + x + newline = 8).
        // String-slice with byte offsets would start at char 7 instead of 8, giving wrong result.
        const ds = new CsvDataSource(enc('café,x\n1,2\n3,4\n'), ',', 10000);
        const w = ds.read_rows(0, 1, 1);
        expect(w.rows[0][0]?.raw).toBe('1');
    });
});
