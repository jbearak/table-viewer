import { describe, it, expect } from 'vitest';
import type { RenderedCell, RowWindow, SheetMeta, WorkbookMeta, DataSource } from '../data-source/interface';
import { read_source_columns, read_source_rows_indexed } from '../data-source/interface';

describe('data-source interface shapes', () => {
    it('RenderedCell allows null raw and string formatted', () => {
        const cell: RenderedCell = { raw: null, formatted: '', bold: false, italic: false };
        expect(cell.formatted).toBe('');
    });
    it('RowWindow carries absolute startRow', () => {
        const w: RowWindow = { startRow: 200, rows: [[{ raw: 'a', formatted: 'a', bold: false, italic: false }]] };
        expect(w.startRow).toBe(200);
        expect(w.rows[0][0]?.raw).toBe('a');
    });
    it('WorkbookMeta nests SheetMeta with merges', () => {
        const meta: WorkbookMeta = {
            hasFormatting: false,
            sheets: [{ name: 'Sheet1', rowCount: 3, columnCount: 2, merges: [], hasFormatting: false }],
        };
        const s: SheetMeta = meta.sheets[0];
        expect(s.rowCount).toBe(3);
    });
    it('DataSource is structurally implementable', () => {
        const ds: DataSource = {
            meta: () => ({ hasFormatting: false, sheets: [] }),
            read_rows: () => ({ startRow: 0, rows: [] }),
            close: () => {},
        };
        expect(ds.meta().sheets).toEqual([]);
    });
    it('projects full rows for legacy sources without read_columns', () => {
        const ds: DataSource = {
            meta: () => ({ hasFormatting: false, sheets: [] }),
            read_rows: () => ({
                startRow: 4,
                rows: [[
                    { raw: 'a', formatted: 'a', bold: false, italic: false },
                    null,
                    { raw: 'c', formatted: 'c', bold: false, italic: false },
                ]],
            }),
            close: () => {},
        };
        expect(read_source_columns(ds, 0, 4, 1, [2, 0])).toEqual({
            startRow: 4,
            rows: [[
                { raw: 'c', formatted: 'c', bold: false, italic: false },
                { raw: 'a', formatted: 'a', bold: false, italic: false },
            ]],
        });
    });
    it('reads legacy indexed rows as adjacent runs without spanning sparse gaps', () => {
        const calls: Array<{ start: number; count: number }> = [];
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 200, columnCount: 1,
                    merges: [], hasFormatting: false,
                }],
            }),
            read_rows: (_sheet, start, count) => {
                calls.push({ start, count });
                return {
                    startRow: start,
                    rows: Array.from({ length: count }, (_, offset) => [{
                        raw: String(start + offset),
                        formatted: String(start + offset),
                        bold: false,
                        italic: false,
                    }]),
                };
            },
            close: () => {},
        };
        const result = read_source_rows_indexed(
            ds,
            0,
            Uint32Array.from([5, 6, 150, 2, 2]),
        );
        expect(result.rows.map((row) => row[0]?.raw))
            .toEqual(['5', '6', '150', '2', '2']);
        expect(calls).toEqual([
            { start: 5, count: 2 },
            { start: 150, count: 1 },
            { start: 2, count: 1 },
            { start: 2, count: 1 },
        ]);
    });
    it('validates indexed rows before reading and accepts an empty request', () => {
        let calls = 0;
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 2, columnCount: 0,
                    merges: [], hasFormatting: false,
                }],
            }),
            read_rows: () => { calls += 1; return { startRow: 0, rows: [] }; },
            close: () => {},
        };
        expect(read_source_rows_indexed(ds, 0, [])).toEqual({ rows: [] });
        expect(() => read_source_rows_indexed(ds, 0, [0, 2])).toThrow(RangeError);
        expect(() => read_source_rows_indexed(ds, 0, [-1])).toThrow(RangeError);
        expect(() => read_source_rows_indexed(ds, 0, [0.5])).toThrow(RangeError);
        expect(calls).toBe(0);
    });
    it('DataSource carries optional diagnostics read polymorphically by panel-core', () => {
        const ds: DataSource = {
            meta: () => ({ hasFormatting: false, sheets: [] }),
            read_rows: () => ({ startRow: 0, rows: [] }),
            close: () => {},
            truncationMessage: 'Showing 2 of 4 rows',
            warnings: ['heads up'],
            originalColumnCounts: [3, 1, 2],
            lineEnding: '\r\n',
        };
        expect(ds.truncationMessage).toMatch(/2 of 4/);
        expect(ds.warnings).toEqual(['heads up']);
        expect(ds.originalColumnCounts).toEqual([3, 1, 2]);
        expect(ds.lineEnding).toBe('\r\n');
    });
});
