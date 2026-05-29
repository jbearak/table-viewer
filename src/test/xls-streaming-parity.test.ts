import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse_xls, parse_xls_streaming } from '../parse-xls';
import { ColumnarStore } from '../data-source/columnar-store';
import type { CellData } from '../types';

const load = (name: string) => Buffer.from(readFileSync(join(__dirname, 'fixtures', name)));

const FIXTURES = ['basic.xls', 'merged.xls', 'styled.xls', 'empty-sheet.xls', 'large-range.xls'];

/**
 * Build a sheet's ColumnarStore the OLD way: densify via parse_xls, then copy
 * each cell exactly as XlsDataSource.create used to. This baseline does NOT route
 * through the streaming code (parse_xls densifies independently), so the parity
 * assertion below is non-tautological.
 */
function build_store_old_way(rows: (CellData | null)[][], rowCount: number, colCount: number): ColumnarStore {
    const b = new ColumnarStore.Builder(rowCount, colCount);
    for (let r = 0; r < rowCount; r++) {
        const row = rows[r] ?? [];
        for (let c = 0; c < colCount; c++) {
            const cell = row[c] ?? null;
            b.set(r, c, cell === null ? null : {
                raw: cell.raw === null ? '' : String(cell.raw),
                formatted: cell.formatted,
                bold: cell.bold,
                italic: cell.italic,
            });
        }
    }
    return b.build();
}

describe('xls streaming parity (Task A7)', () => {
    for (const name of FIXTURES) {
        it(`produces byte-identical ColumnarStore output for ${name}`, () => {
            const buf = load(name);

            const legacy = parse_xls(buf);
            const streaming = parse_xls_streaming(buf);

            expect(streaming.sheets.length).toBe(legacy.data.sheets.length);
            expect(streaming.hasFormatting).toBe(legacy.data.hasFormatting);
            expect(streaming.warnings).toEqual(legacy.warnings);

            for (let si = 0; si < legacy.data.sheets.length; si++) {
                const ls = legacy.data.sheets[si];
                const ss = streaming.sheets[si];

                expect(ss.name).toBe(ls.name);
                expect(ss.rowCount).toBe(ls.rowCount);
                expect(ss.columnCount).toBe(ls.columnCount);
                expect(ss.merges).toEqual(ls.merges);

                const oldStore = build_store_old_way(ls.rows, ls.rowCount, ls.columnCount);

                const newBuilder = new ColumnarStore.Builder(ss.rowCount, ss.columnCount);
                ss.fill(newBuilder);
                const newStore = newBuilder.build();

                // The whole-sheet read_window must be deeply equal — covers merged
                // cells (null), blank cells, bold/italic flags, and numeric/string raw.
                const oldWin = oldStore.read_window(0, ls.rowCount);
                const newWin = newStore.read_window(0, ss.rowCount);
                expect(newWin).toEqual(oldWin);
            }
        });
    }
});
