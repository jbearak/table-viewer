import { describe, it, expect, vi } from 'vitest';
import type { RenderedCell, RowWindow, SheetMeta, WorkbookMeta, DataSource } from '../data-source/interface';
import {
    read_source_columns,
    read_source_raw_columns,
    read_source_raw_columns_indexed_async,
    read_source_raw_rows_indexed,
    read_source_raw_rows_indexed_async,
    read_source_rows_indexed,
} from '../data-source/interface';

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
            sheets: [{ name: 'Sheet1', rowCount: 3, sourceRowCount: 3, columnCount: 2, merges: [], hasFormatting: false }],
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
    it('projects raw cells through full-render fallbacks for legacy sources', () => {
        const rich_cell = {
            raw: '7', formatted: 'Seven', bold: true, italic: false,
            rawType: 'number' as const, hyperlink: { kind: 'external' as const, target: 'https://example.com' },
        };
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: true,
                sheets: [{
                    name: 'Sheet1', rowCount: 2, sourceRowCount: 2,
                    columnCount: 1, merges: [], hasFormatting: true,
                }],
            }),
            read_rows: (_sheet, start, count) => ({
                startRow: start,
                rows: Array.from({ length: count }, () => [rich_cell]),
            }),
            close: () => {},
        };
        expect(read_source_raw_columns(ds, 0, 0, 1, [0])).toEqual({
            startRow: 0,
            rows: [[rich_cell]],
        });
        expect(read_source_raw_rows_indexed(ds, 0, [1, 0]).rows).toEqual([
            [rich_cell],
            [rich_cell],
        ]);
    });

    it('uses an optional raw reader without materializing rendered cells', () => {
        const read_rows = vi.fn(() => ({ startRow: 0, rows: [] }));
        const read_raw_columns = vi.fn((
            _sheet: number, start: number, count: number, columns: readonly number[],
        ) => ({
            startRow: start,
            rows: Array.from({ length: count }, (_, row) => columns.map((column) => ({
                raw: `${start + row}:${column}`,
                rawType: 'string' as const,
            }))),
        }));
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 4, sourceRowCount: 4,
                    columnCount: 2, merges: [], hasFormatting: false,
                }],
            }),
            read_rows,
            read_raw_columns,
            close: () => {},
        };
        expect(read_source_raw_rows_indexed(ds, 0, [2, 3, 1]).rows).toEqual([
            [{ raw: '2:0', rawType: 'string' }, { raw: '2:1', rawType: 'string' }],
            [{ raw: '3:0', rawType: 'string' }, { raw: '3:1', rawType: 'string' }],
            [{ raw: '1:0', rawType: 'string' }, { raw: '1:1', rawType: 'string' }],
        ]);
        expect(read_raw_columns).toHaveBeenCalledTimes(1);
        expect(read_rows).not.toHaveBeenCalled();
    });

    it('reads legacy indexed rows as adjacent runs without spanning sparse gaps', () => {
        const calls: Array<{ start: number; count: number }> = [];
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 200, sourceRowCount: 200,
                    columnCount: 1, merges: [], hasFormatting: false,
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
                    name: 'Sheet1', rowCount: 2, sourceRowCount: 2,
                    columnCount: 0, merges: [], hasFormatting: false,
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
    it('prefers one native indexed raw request and preserves both dimensions', async () => {
        const native = vi.fn(async (
            _sheet: number,
            rows: ArrayLike<number>,
            columns: readonly number[],
        ) => ({
            rows: Array.from(rows, (row) => columns.map((column) => ({
                raw: `${row}:${column}`,
                rawType: 'string' as const,
            }))),
        }));
        const fallback = vi.fn();
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 8, sourceRowCount: 8,
                    columnCount: 4, merges: [], hasFormatting: false,
                }],
            }),
            read_rows: fallback,
            read_raw_columns_async: fallback,
            read_raw_columns_indexed_async: native,
            close: () => {},
        };

        const result = await read_source_raw_columns_indexed_async(
            ds,
            0,
            [5, 1, 5],
            [3, 0, 3],
            () => false,
        );
        expect(result.rows.map((row) => row.map((cell) => cell?.raw))).toEqual([
            ['5:3', '5:0', '5:3'],
            ['1:3', '1:0', '1:3'],
            ['5:3', '5:0', '5:3'],
        ]);
        expect(native).toHaveBeenCalledTimes(1);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('falls back to sorted adjacent runs without crossing gaps', async () => {
        const calls: Array<{ start: number; count: number; columns: readonly number[] }> = [];
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 20, sourceRowCount: 20,
                    columnCount: 3, merges: [], hasFormatting: false,
                }],
            }),
            read_rows: () => ({ startRow: 0, rows: [] }),
            read_raw_columns_async: async (_sheet, start, count, columns) => {
                calls.push({ start, count, columns });
                return {
                    startRow: start,
                    rows: Array.from({ length: count }, (_, offset) => columns.map((column) => ({
                        raw: `${start + offset}:${column}`,
                        rawType: 'string' as const,
                    }))),
                };
            },
            close: () => {},
        };

        const result = await read_source_raw_columns_indexed_async(
            ds,
            0,
            [9, 2, 3, 9, 6],
            [2, 0, 2],
            () => false,
        );
        expect(calls).toEqual([
            { start: 2, count: 2, columns: [2, 0, 2] },
            { start: 6, count: 1, columns: [2, 0, 2] },
            { start: 9, count: 1, columns: [2, 0, 2] },
        ]);
        expect(result.rows.map((row) => row.map((cell) => cell?.raw))).toEqual([
            ['9:2', '9:0', '9:2'],
            ['2:2', '2:0', '2:2'],
            ['3:2', '3:0', '3:2'],
            ['9:2', '9:0', '9:2'],
            ['6:2', '6:0', '6:2'],
        ]);
    });

    it('validates all indexed dimensions before source invocation', async () => {
        const native = vi.fn(async () => ({ rows: [] }));
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 2, sourceRowCount: 2,
                    columnCount: 2, merges: [], hasFormatting: false,
                }],
            }),
            read_rows: () => ({ startRow: 0, rows: [] }),
            read_raw_columns_indexed_async: native,
            close: () => {},
        };
        await expect(read_source_raw_columns_indexed_async(ds, 1, [], [], () => false))
            .rejects.toThrow(RangeError);
        await expect(read_source_raw_columns_indexed_async(ds, 0, [0, 2], [0], () => false))
            .rejects.toThrow(RangeError);
        await expect(read_source_raw_columns_indexed_async(ds, 0, [0], [0, -1], () => false))
            .rejects.toThrow(RangeError);
        expect(native).not.toHaveBeenCalled();
    });

    it('avoids source work for either empty indexed dimension', async () => {
        const native = vi.fn(async () => ({ rows: [] }));
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 2, sourceRowCount: 2,
                    columnCount: 2, merges: [], hasFormatting: false,
                }],
            }),
            read_rows: () => ({ startRow: 0, rows: [] }),
            read_raw_columns_indexed_async: native,
            close: () => {},
        };
        await expect(read_source_raw_columns_indexed_async(ds, 0, [], [0], () => false))
            .resolves.toEqual({ rows: [] });
        await expect(read_source_raw_columns_indexed_async(ds, 0, [0], [], () => false))
            .resolves.toEqual({ rows: [] });
        expect(native).not.toHaveBeenCalled();
    });

    it('checks cancellation between fallback runs and wraps all columns', async () => {
        let cancelled = false;
        const calls: number[] = [];
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 8, sourceRowCount: 8,
                    columnCount: 2, merges: [], hasFormatting: false,
                }],
            }),
            read_rows: () => ({ startRow: 0, rows: [] }),
            read_raw_columns_async: async (_sheet, start, count, columns) => {
                calls.push(start);
                cancelled = true;
                return {
                    startRow: start,
                    rows: Array.from({ length: count }, (_, offset) => columns.map((column) => ({
                        raw: `${start + offset}:${column}`,
                    }))),
                };
            },
            close: () => {},
        };
        await expect(read_source_raw_rows_indexed_async(ds, 0, [1, 4], () => cancelled))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(calls).toEqual([1]);
    });

    it('does not publish a native indexed result after its final await is cancelled', async () => {
        let cancelled = false;
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 1, sourceRowCount: 1,
                    columnCount: 1, merges: [], hasFormatting: false,
                }],
            }),
            read_rows: () => ({ startRow: 0, rows: [] }),
            read_raw_columns_indexed_async: async () => {
                cancelled = true;
                return { rows: [[{ raw: 'late' }]] };
            },
            close: () => {},
        };

        await expect(read_source_raw_columns_indexed_async(
            ds, 0, [0], [0], () => cancelled,
        )).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('does not publish a fallback result after its final run is cancelled', async () => {
        let cancelled = false;
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 1, sourceRowCount: 1,
                    columnCount: 1, merges: [], hasFormatting: false,
                }],
            }),
            read_rows: () => ({ startRow: 0, rows: [] }),
            read_raw_columns_async: async () => {
                cancelled = true;
                return { startRow: 0, rows: [[{ raw: 'late' }]] };
            },
            close: () => {},
        };

        await expect(read_source_raw_columns_indexed_async(
            ds, 0, [0], [0], () => cancelled,
        )).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('uses the indexed column adapter for all-column raw rows', async () => {
        const native = vi.fn(async () => ({ rows: [[{ raw: 'ok' }]] }));
        const ds: DataSource = {
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 1, sourceRowCount: 1,
                    columnCount: 3, merges: [], hasFormatting: false,
                }],
            }),
            read_rows: () => ({ startRow: 0, rows: [] }),
            read_raw_columns_indexed_async: native,
            close: () => {},
        };
        await expect(read_source_raw_rows_indexed_async(ds, 0, [0], () => false))
            .resolves.toEqual({ rows: [[{ raw: 'ok' }]] });
        expect(native).toHaveBeenCalledWith(0, [0], [0, 1, 2], expect.any(Function));
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
