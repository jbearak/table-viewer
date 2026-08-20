import { describe, expect, it } from 'vitest';
import {
    diff_row_window,
    pair_sheets,
    type SheetPairing,
} from '../diff-compare/compare-source';
import { build_source_from_buffer } from '../data-source/from-buffer';
import type {
    DataSource,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from '../data-source/interface';

const cell = (raw: string): RenderedCell => ({
    raw,
    formatted: raw,
    bold: false,
    italic: false,
    rawType: 'string',
});

interface FixtureSheet {
    name: string;
    worksheetId?: string;
    rows: string[][];
}

class FixtureSource implements DataSource {
    constructor(private readonly fixture_sheets: FixtureSheet[]) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: this.fixture_sheets.map((sheet) => ({
                name: sheet.name,
                ...(sheet.worksheetId !== undefined
                    ? { worksheetId: sheet.worksheetId }
                    : {}),
                rowCount: sheet.rows.length,
                sourceRowCount: sheet.rows.length,
                columnCount: Math.max(0, ...sheet.rows.map((row) => row.length)),
                merges: [],
                hasFormatting: false,
            })),
        };
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        const rows = this.fixture_sheets[sheet_index].rows;
        const start = Math.max(0, Math.min(start_row, rows.length));
        return {
            startRow: start,
            rows: rows.slice(start, start + count)
                .map((row) => row.map((value) => (value === '' ? null : cell(value)))),
        };
    }

    close(): void {}
}

const single = (rows: string[][]): FixtureSource =>
    new FixtureSource([{ name: 'Sheet1', rows }]);

const matched: SheetPairing = {
    status: 'matched',
    name: 'Sheet1',
    modifiedIndex: 0,
    originalIndex: 0,
};

describe('pair_sheets', () => {
    it('matches by worksheetId before name', () => {
        const original = new FixtureSource([
            { name: 'Old Name', worksheetId: 'w1', rows: [] },
            { name: 'Kept', worksheetId: 'w2', rows: [] },
        ]).meta();
        const modified = new FixtureSource([
            { name: 'New Name', worksheetId: 'w1', rows: [] },
            { name: 'Kept', worksheetId: 'w3', rows: [] },
        ]).meta();
        expect(pair_sheets(original, modified)).toEqual([
            { status: 'matched', name: 'New Name', modifiedIndex: 0, originalIndex: 0 },
            { status: 'matched', name: 'Kept', modifiedIndex: 1, originalIndex: 1 },
        ]);
    });

    it('reports added and deleted sheets', () => {
        const original = new FixtureSource([
            { name: 'A', rows: [] },
            { name: 'Gone', rows: [] },
        ]).meta();
        const modified = new FixtureSource([
            { name: 'A', rows: [] },
            { name: 'Fresh', rows: [] },
        ]).meta();
        expect(pair_sheets(original, modified)).toEqual([
            { status: 'matched', name: 'A', modifiedIndex: 0, originalIndex: 0 },
            { status: 'added', name: 'Fresh', modifiedIndex: 1 },
            { status: 'deleted', name: 'Gone', originalIndex: 1 },
        ]);
    });

    it('never claims the same original sheet twice', () => {
        const original = new FixtureSource([{ name: 'A', rows: [] }]).meta();
        const modified = new FixtureSource([
            { name: 'A', rows: [] },
            { name: 'A', rows: [] },
        ]).meta();
        expect(pair_sheets(original, modified)).toEqual([
            { status: 'matched', name: 'A', modifiedIndex: 0, originalIndex: 0 },
            { status: 'added', name: 'A', modifiedIndex: 1 },
        ]);
    });
});

describe('diff_row_window', () => {
    it('reports only changed cells, sparsely', () => {
        const original = single([['a', 'b'], ['c', 'd'], ['e', 'f']]);
        const modified = single([['a', 'B'], ['c', 'd'], ['E', 'f']]);
        const diff = diff_row_window(original, modified, matched, 0, 10);
        expect(diff).toEqual({
            startRow: 0,
            rowStatus: ['same', 'same', 'same'],
            changedCells: [
                { row: 0, col: 1, base: 'b' },
                { row: 2, col: 0, base: 'e' },
            ],
        });
    });

    it('marks trailing modified rows as added', () => {
        const original = single([['a']]);
        const modified = single([['a'], ['new1'], ['new2']]);
        const diff = diff_row_window(original, modified, matched, 0, 10);
        expect(diff.rowStatus).toEqual(['same', 'added', 'added']);
        expect(diff.changedCells).toEqual([]);
    });

    it('marks trailing original rows as deleted and ships their base text', () => {
        const original = single([['a'], ['gone', 'too']]);
        const modified = single([['a']]);
        const diff = diff_row_window(original, modified, matched, 0, 10);
        expect(diff.rowStatus).toEqual(['same', 'deleted']);
        expect(diff.changedCells).toEqual([
            { row: 1, col: 0, base: 'gone' },
            { row: 1, col: 1, base: 'too' },
        ]);
    });

    it('treats a removed-mid-file row as positional changes (v1 limitation)', () => {
        const original = single([['a'], ['b'], ['c']]);
        const modified = single([['a'], ['c']]);
        const diff = diff_row_window(original, modified, matched, 0, 10);
        expect(diff.rowStatus).toEqual(['same', 'same', 'deleted']);
        expect(diff.changedCells).toEqual([
            { row: 1, col: 0, base: 'b' },
            { row: 2, col: 0, base: 'c' },
        ]);
    });

    it('pages: only the requested window is compared', () => {
        const original = single([['a'], ['b'], ['c'], ['d']]);
        const modified = single([['a'], ['B'], ['C'], ['d']]);
        const diff = diff_row_window(original, modified, matched, 1, 2);
        expect(diff).toEqual({
            startRow: 1,
            rowStatus: ['same', 'same'],
            changedCells: [
                { row: 1, col: 0, base: 'b' },
                { row: 2, col: 0, base: 'c' },
            ],
        });
    });

    it('clamps the window to the unified row count', () => {
        const original = single([['a']]);
        const modified = single([['a'], ['b']]);
        const diff = diff_row_window(original, modified, matched, 1, 100);
        expect(diff).toEqual({ startRow: 1, rowStatus: ['added'], changedCells: [] });
    });

    it('compares column-count differences cell by cell', () => {
        const original = single([['a', 'extra']]);
        const modified = single([['a']]);
        const diff = diff_row_window(original, modified, matched, 0, 10);
        expect(diff.rowStatus).toEqual(['same']);
        expect(diff.changedCells).toEqual([{ row: 0, col: 1, base: 'extra' }]);
    });

    it('handles empty sides', () => {
        const empty = single([]);
        const modified = single([['a']]);
        expect(diff_row_window(empty, modified, matched, 0, 10)).toEqual({
            startRow: 0,
            rowStatus: ['added'],
            changedCells: [],
        });
        expect(diff_row_window(empty, empty, matched, 0, 10)).toEqual({
            startRow: 0,
            rowStatus: [],
            changedCells: [],
        });
    });

    it('rejects unmatched pairings', () => {
        expect(() => diff_row_window(
            single([]),
            single([]),
            { status: 'added', name: 'X', modifiedIndex: 0 },
            0,
            1,
        )).toThrow();
    });
});

describe('build_source_from_buffer', () => {
    it('parses CSV with first-row headers like the table profile', async () => {
        const source = await build_source_from_buffer(
            new TextEncoder().encode('Name,Age\nAlice,30\nBob,40'),
            '/tmp/people.csv',
        );
        const sheet = source.meta().sheets[0];
        expect(sheet.rowCount).toBe(2);
        expect(sheet.columnNames).toEqual(['Name', 'Age']);
        expect(source.read_rows(0, 0, 1).rows[0][0]?.raw).toBe('Alice');
        source.close();
    });

    it('splits TSV on tabs', async () => {
        const source = await build_source_from_buffer(
            new TextEncoder().encode('a\tb\n1\t2'),
            '/tmp/data.tsv',
        );
        expect(source.meta().sheets[0].columnNames).toEqual(['a', 'b']);
        source.close();
    });

    it('respects the CSV row cap', async () => {
        const source = await build_source_from_buffer(
            new TextEncoder().encode('h\n1\n2\n3'),
            '/tmp/capped.csv',
            { csvMaxRows: 2 },
        );
        expect(source.meta().sheets[0].rowCount).toBe(2);
        expect(source.truncationMessage).toBeTruthy();
        source.close();
    });
});
