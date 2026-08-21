import { describe, expect, it } from 'vitest';
import {
    diff_column_names,
    diff_row_window,
    diff_rows_indexed,
    pair_sheets,
    type SheetPairing,
} from '../diff-compare/compare-source';
import { build_source_from_buffer } from '../data-source/from-buffer';
import { FixtureSource } from './helpers/fixture-source';

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
            { name: 'Kept', rows: [] },
        ]).meta();
        const modified = new FixtureSource([
            { name: 'New Name', worksheetId: 'w1', rows: [] },
            { name: 'Kept', rows: [] },
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

    it('does not glue two different worksheetIds together by shared name', () => {
        const original = new FixtureSource([
            { name: 'Kept', worksheetId: 'w2', rows: [] },
        ]).meta();
        const modified = new FixtureSource([
            { name: 'Kept', worksheetId: 'w3', rows: [] },
        ]).meta();
        expect(pair_sheets(original, modified)).toEqual([
            { status: 'added', name: 'Kept', modifiedIndex: 0 },
            { status: 'deleted', name: 'Kept', originalIndex: 0 },
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

    it('marks trailing original rows as deleted with no changed cells', () => {
        // Deleted rows carry the original content as the grid row itself
        // (CompareDataSource.read_rows), so no bases are shipped for them.
        const original = single([['a'], ['gone', 'too']]);
        const modified = single([['a']]);
        const diff = diff_row_window(original, modified, matched, 0, 10);
        expect(diff.rowStatus).toEqual(['same', 'deleted']);
        expect(diff.changedCells).toEqual([]);
    });

    it('treats a removed-mid-file row as positional changes (v1 limitation)', () => {
        const original = single([['a'], ['b'], ['c']]);
        const modified = single([['a'], ['c']]);
        const diff = diff_row_window(original, modified, matched, 0, 10);
        expect(diff.rowStatus).toEqual(['same', 'same', 'deleted']);
        expect(diff.changedCells).toEqual([
            { row: 1, col: 0, base: 'b' },
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

    it('clamps a negative start without shortening the page', () => {
        const rows = Array.from({ length: 8 }, (_, i) => [`r${i}`]);
        const diff = diff_row_window(single(rows), single(rows), matched, -5, 6);
        expect(diff.startRow).toBe(0);
        expect(diff.rowStatus).toHaveLength(6);
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

describe('diff_rows_indexed', () => {
    it('names positions in the requested row set, not absolute grid rows', () => {
        // A sorted/filtered page requests non-contiguous, out-of-order rows;
        // rowStatus[i] and changedCells[*].row must name rows[i]'s position.
        const original = single([['a'], ['b'], ['c'], ['d']]);
        const modified = single([['a'], ['B'], ['c'], ['D']]);
        const diff = diff_rows_indexed(original, modified, matched, [3, 0, 1]);
        expect(diff).toEqual({
            startRow: 0,
            rowStatus: ['same', 'same', 'same'],
            changedCells: [
                { row: 0, col: 0, base: 'd' },
                { row: 2, col: 0, base: 'b' },
            ],
        });
    });

    it('marks rows past one side as added or deleted, positionally', () => {
        const original = single([['a'], ['gone']]);
        const modified = single([['a'], ['b'], ['new']]);
        // Row 2 exists only in modified (added); with the sides swapped a row
        // past the modified count would be deleted — cover both directions.
        expect(diff_rows_indexed(original, modified, matched, [2, 0]).rowStatus)
            .toEqual(['added', 'same']);
        expect(diff_rows_indexed(modified, original, matched, [2, 0]).rowStatus)
            .toEqual(['deleted', 'same']);
    });

    it('rejects unmatched pairings', () => {
        expect(() => diff_rows_indexed(
            single([]),
            single([]),
            { status: 'added', name: 'X', modifiedIndex: 0 },
            [0],
        )).toThrow();
    });
});

describe('diff_column_names', () => {
    it('reports renamed and removed headers with their base text', () => {
        expect(diff_column_names(
            { columnCount: 3, columnNames: ['a', 'b', 'c'] },
            { columnCount: 2, columnNames: ['a', 'B'] },
        )).toEqual([
            { col: 1, base: 'b' },
            { col: 2, base: 'c' },
        ]);
    });

    it('returns nothing when headers are identical or both unnamed', () => {
        expect(diff_column_names(
            { columnCount: 2, columnNames: ['a', 'b'] },
            { columnCount: 2, columnNames: ['a', 'b'] },
        )).toEqual([]);
        expect(diff_column_names({ columnCount: 2 }, { columnCount: 2 })).toEqual([]);
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
