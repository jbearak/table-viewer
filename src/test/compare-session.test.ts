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
        expect(window.rows[1]).toEqual([]);
        expect(window.rows[2]).toEqual([]);
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

    it('clamps read windows to the padded row count', () => {
        const source = compare([['a'], ['b']], [['a']]);
        const window = source.read_rows(0, 1, 10);
        expect(window.startRow).toBe(1);
        expect(window.rows).toEqual([[]]);
        expect(source.read_rows(0, 5, 10).rows).toEqual([]);
    });
});
