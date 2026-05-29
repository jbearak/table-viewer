import { describe, it, expect } from 'vitest';
import type { RenderedCell, RowWindow, SheetMeta, WorkbookMeta, DataSource } from '../data-source/interface';

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
