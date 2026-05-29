import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse_xls, parse_xls_streaming } from '../parse-xls';
import { ColumnarStore } from '../data-source/columnar-store';
import { build_store_old_way } from './helpers/build-store-old-way';

const load = (name: string) => Buffer.from(readFileSync(join(__dirname, 'fixtures', name)));

const FIXTURES = ['basic.xls', 'merged.xls', 'styled.xls', 'empty-sheet.xls', 'large-range.xls'];

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
