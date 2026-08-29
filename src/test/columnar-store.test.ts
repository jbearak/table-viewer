import { describe, it, expect } from 'vitest';
import { ColumnarStore } from '../data-source/columnar-store';

describe('ColumnarStore', () => {
    it('builds via builder and reads a window', () => {
        const b = new ColumnarStore.Builder(2, 2);  // rows, cols
        b.set(0, 0, { raw: 'a', formatted: 'A', bold: true, italic: false });
        b.set(0, 1, { raw: '1', formatted: '1', bold: false, italic: false });
        b.set(1, 0, null);
        b.set(1, 1, { raw: 'b', formatted: 'b', bold: false, italic: true });
        const store = b.build();

        const w = store.read_window(0, 2);
        expect(w[0][0]).toEqual({ raw: 'a', formatted: 'A', bold: true, italic: false });
        expect(w[0][1]?.raw).toBe('1');
        expect(w[1][0]).toBeNull();
        expect(w[1][1]?.italic).toBe(true);
    });
    it('deduplicates repeated strings in the pool', () => {
        const b = new ColumnarStore.Builder(3, 1);
        b.set(0, 0, { raw: 'x', formatted: 'x', bold: false, italic: false });
        b.set(1, 0, { raw: 'x', formatted: 'x', bold: false, italic: false });
        b.set(2, 0, { raw: 'x', formatted: 'x', bold: false, italic: false });
        const store = b.build();
        expect(store.poolSize).toBe(2); // "" sentinel + "x"
    });
    it('window past end returns only existing rows', () => {
        const b = new ColumnarStore.Builder(2, 1);
        b.set(0, 0, { raw: 'a', formatted: 'a', bold: false, italic: false });
        b.set(1, 0, { raw: 'b', formatted: 'b', bold: false, italic: false });
        const store = b.build();
        expect(store.read_window(1, 10).length).toBe(1);
    });
    it('start entirely past end returns empty array', () => {
        const b = new ColumnarStore.Builder(2, 1);
        b.set(0, 0, { raw: 'a', formatted: 'a', bold: false, italic: false });
        b.set(1, 0, { raw: 'b', formatted: 'b', bold: false, italic: false });
        const store = b.build();
        expect(store.read_window(99, 5).length).toBe(0);
    });
    it('distinguishes null cell from empty-string cell', () => {
        const b = new ColumnarStore.Builder(2, 1);
        b.set(0, 0, null);
        b.set(1, 0, { raw: '', formatted: '', bold: false, italic: false });
        const store = b.build();
        const w = store.read_window(0, 2);
        expect(w[0][0]).toBeNull();
        expect(w[1][0]).toEqual({ raw: '', formatted: '', bold: false, italic: false });
    });

    it('round-trips underline/strikethrough flags and sparse extras', () => {
        const rich = { runs: [{ text: 'a' }, { text: 'b', style: { bold: true as const } }] };
        const link = { kind: 'external' as const, target: 'https://example.com/' };
        const b = new ColumnarStore.Builder(1, 3);
        b.set(0, 0, {
            raw: 'ab', formatted: 'ab', bold: false, italic: false,
            underline: true, strikethrough: true, richText: rich, hyperlink: link,
            rawType: 'string',
        });
        b.set(0, 1, { raw: 'x', formatted: 'x', bold: true, italic: false, rawType: 'string' });
        const store = b.build();
        const [row] = store.read_window(0, 1);
        expect(row[0]?.underline).toBe(true);
        expect(row[0]?.strikethrough).toBe(true);
        // Extras are stored and returned by reference, not cloned.
        expect(row[0]?.richText).toBe(rich);
        expect(row[0]?.hyperlink).toBe(link);
        // Plain cells carry none of the optional fields.
        expect(row[0] && 'raw' in row[0]).toBe(true);
        expect(row[1]).toEqual({ raw: 'x', formatted: 'x', bold: true, italic: false, rawType: 'string' });
        expect(row[2]).toBeNull();
    });
    it('overwriting a cell with a plain value clears its extras', () => {
        const b = new ColumnarStore.Builder(1, 1);
        b.set(0, 0, {
            raw: 'a', formatted: 'a', bold: false, italic: false,
            hyperlink: { kind: 'internal', location: 'Sheet1!A1' }, rawType: 'string',
        });
        b.set(0, 0, { raw: 'a', formatted: 'a', bold: false, italic: false, rawType: 'string' });
        const store = b.build();
        expect(store.read_window(0, 1)[0][0]?.hyperlink).toBeUndefined();
    });
    it('round-trips compact XLSX number-format metadata', () => {
        const b = new ColumnarStore.Builder(1, 3);
        b.set(0, 0, {
            raw: '1', formatted: '1.00', bold: false, italic: false, rawType: 'number',
            numberFormat: { code: '0.00' },
        });
        b.set(0, 1, {
            raw: '2024-01-15T00:00:00Z', formatted: '2024-01-15T00:00:00Z',
            bold: false, italic: false, rawType: 'date',
            numericRaw: 45_306,
            numberFormat: { code: 'm/d/yyyy', date1904: true },
            xlsxIsoDate: true,
        });
        b.set(0, 2, {
            raw: 'plain', formatted: 'plain', bold: false, italic: false, rawType: 'string',
        });
        const [row] = b.build().read_window(0, 1);
        expect(row[0]?.numberFormat).toEqual({ code: '0.00' });
        expect(row[1]?.numberFormat).toEqual({ code: 'm/d/yyyy', date1904: true });
        expect(row[1]?.xlsxIsoDate).toBe(true);
        expect(row[1]?.numericRaw).toBe(45_306);
        expect(row[2] && 'numberFormat' in row[2]).toBe(false);
        expect(row[2] && 'xlsxIsoDate' in row[2]).toBe(false);
    });
    it('clears XLSX format metadata on overwrite and null', () => {
        const b = new ColumnarStore.Builder(1, 2);
        const formatted = {
            raw: '1', formatted: '1.00', bold: false, italic: false,
            rawType: 'number' as const, numberFormat: { code: '0.00' },
            xlsxIsoDate: true as const,
        };
        b.set(0, 0, formatted);
        b.set(0, 1, formatted);
        b.set(0, 0, {
            raw: 'plain', formatted: 'plain', bold: false, italic: false, rawType: 'string',
        });
        b.set(0, 1, null);
        const [row] = b.build().read_window(0, 1);
        expect(row[0]?.numberFormat).toBeUndefined();
        expect(row[0]?.xlsxIsoDate).toBeUndefined();
        expect(row[1]).toBeNull();
    });
    it('materializes only requested columns in compact requested order', () => {
        const builder = new ColumnarStore.Builder(2, 1_000);
        builder.set(0, 2, {
            raw: '2', formatted: '$2', bold: true, italic: false, rawType: 'number',
        });
        builder.set(0, 999, {
            raw: 'end', formatted: 'END', bold: false, italic: true, rawType: 'string',
        });
        const rows = builder.build().read_columns(0, 2, [999, 2]);
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.length === 2)).toBe(true);
        expect(rows[0]).toEqual([
            { raw: 'end', formatted: 'END', bold: false, italic: true, rawType: 'string' },
            { raw: '2', formatted: '$2', bold: true, italic: false, rawType: 'number' },
        ]);
        expect(rows[1]).toEqual([null, null]);
    });
    it('materializes arbitrary full rows in order with duplicates and types', () => {
        const builder = new ColumnarStore.Builder(3, 2);
        builder.set(0, 0, {
            raw: '0', formatted: '$0', bold: true, italic: false, rawType: 'number',
        });
        builder.set(2, 1, {
            raw: 'last', formatted: 'LAST', bold: false, italic: true, rawType: 'string',
        });
        const store = builder.build();
        expect(store.read_rows_indexed(Uint32Array.from([2, 0, 2]))).toEqual([
            [null, { raw: 'last', formatted: 'LAST', bold: false, italic: true, rawType: 'string' }],
            [{ raw: '0', formatted: '$0', bold: true, italic: false, rawType: 'number' }, null],
            [null, { raw: 'last', formatted: 'LAST', bold: false, italic: true, rawType: 'string' }],
        ]);
        expect(store.read_rows_indexed([])).toEqual([]);
        expect(() => store.read_rows_indexed([3])).toThrow(RangeError);
    });
});
