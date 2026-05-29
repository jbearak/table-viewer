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
});
