import { describe, it, expect } from 'vitest';
import { CsvDataSource } from '../data-source/csv-source';
import { serialize_csv } from '../serialize-csv';
import type { CellData } from '../types';

const enc = (s: string) => new TextEncoder().encode(s);

/** Read a source's full cell grid as raw strings ('' for null cells). */
function grid(ds: CsvDataSource): string[][] {
    const rowCount = ds.meta().sheets[0].rowCount;
    return ds.read_rows(0, 0, rowCount).rows.map((row) =>
        row.map((cell) => (cell ? String((cell as CellData).raw ?? '') : ''))
    );
}

/**
 * Round-trip a buffer through the save path: parse → serialize (no edits) →
 * re-parse. The cell grids before and after must be identical — that is the
 * core anti-corruption invariant. Returns both grids and the serialized text.
 */
function round_trip(buf: Uint8Array, delimiter: ',' | '\t' = ',') {
    const ds = new CsvDataSource(buf, delimiter, 10000);
    const before = grid(ds);
    // Serialize via small (2-row) windows, mirroring the csv-panel save path and
    // exercising the Iterable contract / chunk-boundary handling.
    const rowCount = ds.meta().sheets[0].rowCount;
    function* windows(): Generator<(CellData | null)[]> {
        for (let start = 0; start < rowCount; start += 2) {
            for (const row of ds.read_rows(0, start, 2).rows) {
                yield row as (CellData | null)[];
            }
        }
    }
    const text = serialize_csv(
        windows(),
        delimiter,
        undefined,
        ds.originalColumnCounts,
        ds.lineEnding,
    );
    const reloaded = new CsvDataSource(enc(text), delimiter, 10000);
    const after = grid(reloaded);
    return { before, after, text };
}

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
        expect(w.rows.length).toBe(2);
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
    it('read_rows over the whole sheet returns every row', () => {
        const ds = new CsvDataSource(enc('a\nb\nc\n'), ',', 10000);
        expect(ds.read_rows(0, 0, ds.meta().sheets[0].rowCount).rows.length).toBe(3);
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
    it('returns empty rows when start_row >= rowCount (fast path)', () => {
        const ds = new CsvDataSource(enc('a\nb\nc\n'), ',', 10000);
        // 3-row source; requesting start_row=99 triggers the start>=end fast path
        const w = ds.read_rows(0, 99, 5);
        expect(w.rows.length).toBe(0);
    });
    it('read_rows respects max_rows truncation', () => {
        const ds = new CsvDataSource(enc('a\nb\nc\nd\n'), ',', 2);
        // max_rows=2 on a 4-row source; reading from row 0 should return at most 2 rows
        const w = ds.read_rows(0, 0, 10);
        expect(w.rows.length).toBe(2);
    });
    it('create() is an async factory yielding a working source', async () => {
        const ds = await CsvDataSource.create(enc('a,b\n1,2\n'), ',', 10000);
        expect(ds).toBeInstanceOf(CsvDataSource);
        expect(ds.meta().sheets[0].rowCount).toBe(2);
        expect(ds.read_rows(0, 1, 1).rows[0][0]?.raw).toBe('1');
    });
    it('exposes originalColumnCounts (per-row, pre-padding) for the save path', () => {
        const ds = new CsvDataSource(enc('a,b,c\n1\n2,3\n'), ',', 10000);
        expect(ds.originalColumnCounts).toEqual([3, 1, 2]);
    });
    it('caps originalColumnCounts to max_rows', () => {
        const ds = new CsvDataSource(enc('a,b\n1\n2,3,4\n'), ',', 2);
        expect(ds.originalColumnCounts).toEqual([2, 1]);
    });
    it('detects lineEnding for the save path', () => {
        expect(new CsvDataSource(enc('a\r\nb\r\n'), ',', 10000).lineEnding).toBe('\r\n');
        expect(new CsvDataSource(enc('a\nb\n'), ',', 10000).lineEnding).toBe('\n');
        expect(new CsvDataSource(enc('a\rb\r'), ',', 10000).lineEnding).toBe('\r');
    });
    it('ignores a newline inside a quoted field when detecting lineEnding', () => {
        // The first physical row holds a quoted field with an embedded bare \n,
        // but the real row terminator is CRLF. A quote-blind scan would latch
        // onto the embedded \n and rewrite every terminator to \n on save.
        expect(
            new CsvDataSource(enc('a,"x\ny"\r\nc,d\r\n'), ',', 10000).lineEnding
        ).toBe('\r\n');
    });

    describe('save round-trips without data corruption', () => {
        it('round-trips well-formed quoted fields unchanged', () => {
            const { before, after, text } = round_trip(enc('x,"a,b",z\n1,2,3\n'));
            expect(before).toEqual([['x', 'a,b', 'z'], ['1', '2', '3']]);
            expect(after).toEqual(before);
            expect(text).toBe('x,"a,b",z\n1,2,3\n');
        });

        it('round-trips a trailing-empty-field row without growing columns', () => {
            const { before, after } = round_trip(enc('a,b,c\n1,2\n'));
            expect(before).toEqual([['a', 'b', 'c'], ['1', '2', '']]);
            expect(after).toEqual(before);
        });

        it('does not inject a spurious trailing column for a stray quote', () => {
            // `"a"b,c` is malformed; both the index and the cell parse must agree
            // it is two fields. Pre-fix, the index said 2 but Papa produced cells
            // that serialized to `"a""b,c\n",` — an extra empty column.
            const { before, after, text } = round_trip(enc('"a"b,c\n'));
            expect(before).toEqual([['ab', 'c']]);
            expect(after).toEqual(before);
            expect(text).toBe('ab,c\n');
        });

        it('loses no cells across mixed line endings', () => {
            // Pre-fix, PapaParse auto-detected a single newline type, so the LF
            // row merged into a neighbour and the final `y` was dropped.
            const { before, after } = round_trip(enc('a,b\r\nc,d\nx,y\r\n'));
            expect(before).toEqual([['a', 'b'], ['c', 'd'], ['x', 'y']]);
            expect(after).toEqual(before);
        });

        it('strips a leading UTF-8 BOM so the first cell is clean', () => {
            const ds = new CsvDataSource(enc('﻿a,b\n1,2\n'), ',', 10000);
            expect(ds.read_rows(0, 0, 1).rows[0][0]?.raw).toBe('a');
            const { before, after } = round_trip(enc('﻿a,b\n1,2\n'));
            expect(before).toEqual([['a', 'b'], ['1', '2']]);
            expect(after).toEqual(before);
        });

        it('a leading BOM before a quoted field still opens the quote', () => {
            // After BOM strip, the first byte is `"`, which must open a quoted
            // field — both in the index scan and the cell parse.
            const ds = new CsvDataSource(enc('﻿"a,b",c\n'), ',', 10000);
            expect(ds.meta().sheets[0].columnCount).toBe(2);
            expect(ds.read_rows(0, 0, 1).rows[0][0]?.raw).toBe('a,b');
        });
    });

    describe('lineMap (preview scroll sync)', () => {
        it('maps rows to source lines, accounting for multi-line quoted fields', () => {
            const ds = new CsvDataSource(
                enc('Name,Bio\nAlice,"Line 1\nLine 2"\nBob,x\n'), ',', 10000,
            );
            expect(ds.lineMap()).toEqual([0, 1, 3]);
        });
        it('length always equals the grid row count (mixed line endings)', () => {
            const ds = new CsvDataSource(enc('a,b\r\nc,d\nx,y\r\n'), ',', 10000);
            expect(ds.lineMap().length).toBe(ds.meta().sheets[0].rowCount);
            expect(ds.lineMap()).toEqual([0, 1, 2]);
        });
        it('length always equals the grid row count (stray quote)', () => {
            const ds = new CsvDataSource(enc('"a"b,c\nd,e\n'), ',', 10000);
            expect(ds.lineMap().length).toBe(ds.meta().sheets[0].rowCount);
        });
        it('is capped to max_rows like the grid', () => {
            const ds = new CsvDataSource(enc('a\nb\nc\nd\n'), ',', 2);
            expect(ds.lineMap().length).toBe(ds.meta().sheets[0].rowCount);
            expect(ds.lineMap()).toEqual([0, 1]);
        });
        it('ignores a leading BOM for line numbering', () => {
            const ds = new CsvDataSource(enc('﻿a,b\nc,d\n'), ',', 10000);
            expect(ds.lineMap()).toEqual([0, 1]);
        });
    });
});
