import { describe, expect, it } from 'vitest';
import { CompareDataSource } from '../diff-compare/compare-session';
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
    closed = false;

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

    close(): void {
        this.closed = true;
    }
}

const compare = (
    original_rows: string[][],
    modified_rows: string[][],
): CompareDataSource =>
    new CompareDataSource(
        new FixtureSource([{ name: 'Sheet1', rows: modified_rows }]),
        new FixtureSource([{ name: 'Sheet1', rows: original_rows }]),
    );

describe('CompareDataSource', () => {
    it('pads matched sheets to the larger side so deleted rows have grid rows', () => {
        const source = compare([['a'], ['b'], ['c']], [['a']]);
        const sheet = source.meta().sheets[0];
        expect(sheet.rowCount).toBe(3);
        expect(sheet.sourceRowCount).toBe(3);
        const window = source.read_rows(0, 0, 10);
        expect(window.rows).toHaveLength(3);
        expect(window.rows[0][0]?.raw).toBe('a');
        // Deleted-band rows carry the original content, so filters, sorting,
        // copy, and auto-fit see the removed text the grid shows.
        expect(window.rows[1][0]?.raw).toBe('b');
        expect(window.rows[2][0]?.raw).toBe('c');
    });

    it('leaves the modified meta untouched when it is already the larger side', () => {
        const source = compare([['a']], [['a'], ['b']]);
        expect(source.meta().sheets[0].rowCount).toBe(2);
    });

    it('answers diff pages only for matched sheets', () => {
        const source = new CompareDataSource(
            new FixtureSource([
                { name: 'Kept', rows: [['x']] },
                { name: 'Added', rows: [['y']] },
            ]),
            new FixtureSource([{ name: 'Kept', rows: [['z']] }]),
        );
        const kept = source.diff_page(0, 0, 10);
        expect(kept?.changedCells).toEqual([{ row: 0, col: 0, base: 'z' }]);
        expect(source.diff_page(1, 0, 10)).toBeUndefined();
    });

    it('exposes pairings including added and deleted sheets', () => {
        const source = new CompareDataSource(
            new FixtureSource([{ name: 'New', rows: [] }]),
            new FixtureSource([{ name: 'Gone', rows: [] }]),
        );
        expect(source.pairings).toEqual([
            { status: 'added', name: 'New', modifiedIndex: 0 },
            { status: 'deleted', name: 'Gone', originalIndex: 0 },
        ]);
    });

    it('closes both sides even when the modified close throws', () => {
        const modified = new FixtureSource([{ name: 'Sheet1', rows: [] }]);
        const original = new FixtureSource([{ name: 'Sheet1', rows: [] }]);
        modified.close = () => {
            modified.closed = true;
            throw new Error('boom');
        };
        const source = new CompareDataSource(modified, original);
        expect(() => source.close()).toThrow('boom');
        expect(modified.closed).toBe(true);
        expect(original.closed).toBe(true);
    });

    it('exposes deleted sheets as navigable read-only all-deleted bands', () => {
        const source = new CompareDataSource(
            new FixtureSource([{ name: 'Kept', rows: [['x']] }]),
            new FixtureSource([
                { name: 'Kept', rows: [['x']] },
                { name: 'Gone', rows: [['g1'], ['g2']] },
            ]),
        );
        const sheets = source.meta().sheets;
        expect(sheets.map((sheet) => sheet.name)).toEqual(['Kept', 'Gone']);
        expect(sheets[1].rowCount).toBe(2);
        const window = source.read_rows(1, 0, 10);
        expect(window.rows.map((row) => row[0]?.raw)).toEqual(['g1', 'g2']);
        expect(source.read_rows_indexed(1, [1]).rows[0][0]?.raw).toBe('g2');
        expect(source.diff_rows(1, [0, 1])?.rowStatus).toEqual(['deleted', 'deleted']);
    });

    it('serves repeated diff_rows requests from the cache', () => {
        const original = new FixtureSource([{ name: 'Sheet1', rows: [['a']] }]);
        const source = new CompareDataSource(
            new FixtureSource([{ name: 'Sheet1', rows: [['b']] }]),
            original,
        );
        const first = source.diff_rows(0, [0]);
        let reads = 0;
        const read_rows = original.read_rows.bind(original);
        original.read_rows = (...read_args) => {
            reads += 1;
            return read_rows(...read_args);
        };
        expect(source.diff_rows(0, [0])).toBe(first);
        expect(reads).toBe(0);
    });

    it('maps padded rows to canonical rows appended after the modified side', () => {
        const source = compare([['a'], ['b'], ['c']], [['a']]);
        // Grid rows 1-2 are the deleted band; modified has 1 source row.
        expect([...source.source_row_indices(0, [0, 1, 2])]).toEqual([0, 1, 2]);
        expect(source.projected_row_index(0, 1)).toBe(1);
        expect(source.projected_row_index(0, 5)).toBeUndefined();
    });

    it('forwards the modified side row mapping for real rows', () => {
        const modified = new FixtureSource([{ name: 'Sheet1', rows: [['a'], ['b']] }]);
        (modified as DataSource).source_row_indices = (_sheet, rows) =>
            Uint32Array.from(rows as number[], (row) => row + 1);
        (modified as DataSource).projected_row_index = (_sheet, source_row) =>
            source_row - 1;
        const source = new CompareDataSource(
            modified,
            new FixtureSource([{ name: 'Sheet1', rows: [['a']] }]),
        );
        expect([...source.source_row_indices(0, [0, 1])]).toEqual([1, 2]);
        expect(source.projected_row_index(0, 1)).toBe(0);
    });

    it('clamps read windows to the padded row count', () => {
        const source = compare([['a'], ['b']], [['a']]);
        const window = source.read_rows(0, 1, 10);
        expect(window.startRow).toBe(1);
        expect(window.rows).toHaveLength(1);
        expect(window.rows[0][0]?.raw).toBe('b');
        expect(source.read_rows(0, 5, 10).rows).toEqual([]);
    });
});
