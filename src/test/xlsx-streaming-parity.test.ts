import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse_xlsx, parse_xlsx_streaming } from '../parse-xlsx';
import { ColumnarStore } from '../data-source/columnar-store';
import { build_store_old_way } from './helpers/build-store-old-way';

const load = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

const FIXTURES = ['basic.xlsx', 'merged.xlsx', 'styled.xlsx', 'formatted.xlsx', 'empty-sheet.xlsx'];

describe('xlsx streaming parity (Task A7)', () => {
    for (const name of FIXTURES) {
        it(`produces byte-identical ColumnarStore output for ${name}`, async () => {
            const buf = load(name);

            const legacy = await parse_xlsx(buf);
            const streaming = await parse_xlsx_streaming(buf);

            expect(streaming.sheets.length).toBe(legacy.data.sheets.length);
            expect(streaming.hasFormatting).toBe(legacy.data.hasFormatting);

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
