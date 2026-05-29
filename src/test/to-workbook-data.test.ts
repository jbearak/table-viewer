import { describe, it, expect } from 'vitest';
import { workbook_data_from_source } from '../data-source/to-workbook-data';
import { CsvDataSource } from '../data-source/csv-source';
import type { DataSource, RowWindow, RenderedCell, WorkbookMeta } from '../data-source/interface';
import type { MergeRange } from '../types';

const enc = (s: string) => new TextEncoder().encode(s);

describe('workbook_data_from_source (legacy transitional shim)', () => {
    it('rebuilds the legacy WorkbookData shape from a CSV source', () => {
        const ds = new CsvDataSource(enc('a,b\n1,2\n,4\n'), ',', 10000);
        const wb = workbook_data_from_source(ds);
        expect(wb.hasFormatting).toBe(false);
        expect(wb.sheets.length).toBe(1);
        const s = wb.sheets[0];
        expect(s.name).toBe('Sheet1');
        expect(s.rowCount).toBe(3);
        expect(s.columnCount).toBe(2);
        expect(s.rows[0][0]?.raw).toBe('a');
        expect(s.rows[2][0]).toBeNull();      // empty first field of row 3
        expect(s.rows[2][1]?.raw).toBe('4');
        expect(s.merges).toEqual([]);
    });

    it('carries merges, formatting flags and multiple sheets from meta', () => {
        const merges: MergeRange[] = [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }];
        const stub: DataSource = {
            meta(): WorkbookMeta {
                return {
                    hasFormatting: true,
                    sheets: [
                        { name: 'One', rowCount: 2, columnCount: 2, merges, hasFormatting: true },
                        { name: 'Two', rowCount: 1, columnCount: 1, merges: [], hasFormatting: false },
                    ],
                };
            },
            read_rows(sheet: number, start: number, count: number): RowWindow {
                const cell: RenderedCell = { raw: `s${sheet}`, formatted: `s${sheet}`, bold: true, italic: false };
                const rows: (RenderedCell | null)[][] = [];
                const meta = this.meta().sheets[sheet];
                const end = Math.min(start + count, meta.rowCount);
                for (let r = start; r < end; r++) {
                    rows.push(Array.from({ length: meta.columnCount }, () => cell));
                }
                return { startRow: start, rows };
            },
            read_all_rows: () => [],
            close: () => {},
        };
        const wb = workbook_data_from_source(stub);
        expect(wb.hasFormatting).toBe(true);
        expect(wb.sheets.map((s) => s.name)).toEqual(['One', 'Two']);
        expect(wb.sheets[0].merges).toEqual(merges);
        expect(wb.sheets[0].rows.length).toBe(2);
        expect(wb.sheets[0].rows[0][0]?.bold).toBe(true);
        expect(wb.sheets[1].rows.length).toBe(1);
    });
});
