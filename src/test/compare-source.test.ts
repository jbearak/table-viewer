import { describe, expect, it } from 'vitest';
import {
    diff_column_names,
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

    it('pairs a lone unnamed sheet with the workbook\u2019s first', () => {
        // A CSV is one sheet the reader calls Sheet1. Matching on that name
        // reported it and every worksheet as one-sided unless the workbook
        // happened to have a sheet called Sheet1.
        const original = new FixtureSource([
            { name: 'Sheet1', unnamedSingleSheet: true, rows: [] },
        ]).meta();
        const modified = new FixtureSource([
            { name: 'Sales', worksheetId: 'w1', rows: [] },
            { name: 'Notes', worksheetId: 'w2', rows: [] },
        ]).meta();
        expect(pair_sheets(original, modified)).toEqual([
            { status: 'matched', name: 'Sales', modifiedIndex: 0, originalIndex: 0 },
            { status: 'added', name: 'Notes', modifiedIndex: 1 },
        ]);
    });

    it('pairs the first sheets with the workbook on the original side', () => {
        const original = new FixtureSource([
            { name: 'Sales', worksheetId: 'w1', rows: [] },
            { name: 'Notes', worksheetId: 'w2', rows: [] },
        ]).meta();
        const modified = new FixtureSource([
            { name: 'Sheet1', unnamedSingleSheet: true, rows: [] },
        ]).meta();
        expect(pair_sheets(original, modified)).toEqual([
            { status: 'matched', name: 'Sheet1', modifiedIndex: 0, originalIndex: 0 },
            { status: 'deleted', name: 'Notes', originalIndex: 1 },
        ]);
    });

    it('pairs a delimited file with a single-sheet .xls by position', () => {
        // .xls exposes no worksheetId, so inferring \u201cdelimited\u201d from a missing
        // identity made a one-sheet .xls look like a CSV: neither side won the
        // XOR, and the two fell back to the placeholder name that the
        // first-sheet rule exists to avoid depending on.
        const csv = [{ name: 'Sheet1', unnamedSingleSheet: true, rows: [] }];
        const xls = [{ name: 'Budget', rows: [] }];
        expect(pair_sheets(
            new FixtureSource(csv).meta(),
            new FixtureSource(xls).meta(),
        )).toEqual([
            { status: 'matched', name: 'Budget', modifiedIndex: 0, originalIndex: 0 },
        ]);
        expect(pair_sheets(
            new FixtureSource(xls).meta(),
            new FixtureSource(csv).meta(),
        )).toEqual([
            { status: 'matched', name: 'Sheet1', modifiedIndex: 0, originalIndex: 0 },
        ]);
    });

    it('keeps name pairing between two single-sheet workbooks', () => {
        // Neither side is delimited, so their names are the user's own and
        // differing ones mean genuinely different worksheets.
        const original = new FixtureSource([{ name: 'Budget', rows: [] }]).meta();
        const modified = new FixtureSource([{ name: 'Forecast', rows: [] }]).meta();
        expect(pair_sheets(original, modified)).toEqual([
            { status: 'added', name: 'Forecast', modifiedIndex: 0 },
            { status: 'deleted', name: 'Budget', originalIndex: 0 },
        ]);
    });

    it('pairs two delimited files with each other', () => {
        const side = () => new FixtureSource([
            { name: 'Sheet1', unnamedSingleSheet: true, rows: [] },
        ]).meta();
        expect(pair_sheets(side(), side())).toEqual([
            { status: 'matched', name: 'Sheet1', modifiedIndex: 0, originalIndex: 0 },
        ]);
    });

    it('reports a delimited file against an empty workbook as one-sided', () => {
        // First-sheet pairing needs a first sheet on both sides; with none,
        // fall through rather than index into an empty array.
        const original = new FixtureSource([]).meta();
        const modified = new FixtureSource([
            { name: 'Sheet1', unnamedSingleSheet: true, rows: [] },
        ]).meta();
        expect(pair_sheets(original, modified)).toEqual([
            { status: 'added', name: 'Sheet1', modifiedIndex: 0 },
        ]);
    });

    it('keeps identity pairing when both sides are workbooks', () => {
        // Two workbooks must not fall into first-sheet pairing: an inserted
        // first worksheet would glue unrelated sheets into a bogus cell diff.
        const original = new FixtureSource([
            { name: 'Sales', worksheetId: 'w1', rows: [] },
        ]).meta();
        const modified = new FixtureSource([
            { name: 'Cover', worksheetId: 'w9', rows: [] },
            { name: 'Sales', worksheetId: 'w1', rows: [] },
        ]).meta();
        expect(pair_sheets(original, modified)).toEqual([
            { status: 'added', name: 'Cover', modifiedIndex: 0 },
            { status: 'matched', name: 'Sales', modifiedIndex: 1, originalIndex: 0 },
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
