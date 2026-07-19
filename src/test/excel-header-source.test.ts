import { describe, expect, it } from 'vitest';
import { ExcelHeaderDataSource } from '../data-source/excel-header-source';
import type {
    DataSource,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from '../data-source/interface';
import type { MergeRange } from '../types';

function cell(
    raw: string | number | boolean | null,
    opts?: Partial<RenderedCell>,
): RenderedCell | null {
    if (raw === null) return null;
    return {
        raw: String(raw),
        formatted: String(raw),
        bold: false,
        italic: false,
        rawType: typeof raw === 'number'
            ? 'number'
            : typeof raw === 'boolean'
            ? 'boolean'
            : 'string',
        ...opts,
    };
}

class StubSource implements DataSource {
    closed = false;

    constructor(
        private readonly rows: (RenderedCell | null)[][],
        private readonly merges: MergeRange[] = [],
        private readonly name = 'Sheet1',
    ) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: this.rows.flat().some((value) => value?.bold),
            sheets: [{
                name: this.name,
                rowCount: this.rows.length,
                columnCount: this.rows.reduce(
                    (max, row) => Math.max(max, row.length),
                    0,
                ),
                merges: this.merges,
                hasFormatting: this.rows.flat().some((value) => value?.bold),
            }],
        };
    }

    read_rows(_sheet: number, start: number, count: number): RowWindow {
        const clamped = Math.max(0, Math.min(start, this.rows.length));
        return {
            startRow: clamped,
            rows: this.rows.slice(clamped, clamped + Math.max(0, count)),
        };
    }

    close(): void {
        this.closed = true;
    }
}

describe('ExcelHeaderDataSource', () => {
    it('auto-detects a text header above typed data', () => {
        const ds = new ExcelHeaderDataSource(new StubSource([
            [cell('Name'), cell('Age'), cell('Active')],
            [cell('Alice'), cell(30), cell(true)],
            [cell('Bob'), cell(25), cell(false)],
        ]));

        const sheet = ds.meta().sheets[0];
        expect(sheet.excelFirstRowHeader).toEqual({
            mode: 'auto', detected: true, active: true, available: true,
        });
        expect(sheet.columnNames).toEqual(['Name', 'Age', 'Active']);
        expect(sheet.rowCount).toBe(2);
        expect(ds.read_rows(0, 0, 2)).toMatchObject({
            startRow: 0,
            rows: [
                [expect.objectContaining({ raw: 'Alice' }), expect.objectContaining({ raw: '30' }), expect.objectContaining({ raw: 'true' })],
                [expect.objectContaining({ raw: 'Bob' }), expect.objectContaining({ raw: '25' }), expect.objectContaining({ raw: 'false' })],
            ],
        });
    });

    it('keeps an ambiguous plain all-text first row as data', () => {
        const ds = new ExcelHeaderDataSource(new StubSource([
            [cell('Name'), cell('City')],
            [cell('Alice'), cell('London')],
            [cell('Bob'), cell('Paris')],
            [cell('Carol'), cell('Rome')],
        ]));

        const sheet = ds.meta().sheets[0];
        expect(sheet.excelFirstRowHeader?.detected).toBe(false);
        expect(sheet.excelFirstRowHeader?.active).toBe(false);
        expect(sheet.columnNames).toBeUndefined();
        expect(sheet.rowCount).toBe(4);
    });

    it('detects a distinctly bold all-text header', () => {
        const ds = new ExcelHeaderDataSource(new StubSource([
            [cell('Name', { bold: true }), cell('City', { bold: true })],
            [cell('Alice'), cell('London')],
            [cell('Bob'), cell('Paris')],
        ]));

        expect(ds.meta().sheets[0].excelFirstRowHeader?.detected).toBe(true);
    });

    it('rejects blank, duplicate, single-row, and merged candidates', () => {
        const blank = new ExcelHeaderDataSource(new StubSource([
            [cell('Name'), null],
            [cell('Alice'), cell(30)],
        ]));
        expect(blank.meta().sheets[0].excelFirstRowHeader?.detected).toBe(false);

        const duplicate = new ExcelHeaderDataSource(new StubSource([
            [cell(' Name '), cell('name')],
            [cell('Alice'), cell(30)],
        ]));
        expect(duplicate.meta().sheets[0].excelFirstRowHeader?.detected).toBe(false);

        const one_row = new ExcelHeaderDataSource(new StubSource([
            [cell('Name'), cell('Age')],
        ]));
        expect(one_row.meta().sheets[0].excelFirstRowHeader?.detected).toBe(false);

        const merged = new ExcelHeaderDataSource(new StubSource([
            [cell('Name'), cell('Age')],
            [cell('Alice'), cell(30)],
        ], [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }]));
        expect(merged.meta().sheets[0].excelFirstRowHeader?.detected).toBe(false);
    });

    it('manual overrides switch projection without rebuilding the base source', () => {
        const base = new StubSource([
            [cell('Name'), null],
            [cell('Alice'), cell(30)],
            [cell('Bob'), cell(25)],
        ], [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
            { startRow: 1, startCol: 0, endRow: 2, endCol: 0 },
        ]);
        const ds = new ExcelHeaderDataSource(base);
        expect(ds.meta().sheets[0].rowCount).toBe(3);

        expect(ds.set_override('Sheet1', 'on')).toBe(true);
        const enabled = ds.meta().sheets[0];
        expect(enabled.excelFirstRowHeader).toMatchObject({ mode: 'on', active: true });
        expect(enabled.columnNames).toEqual(['Name', '']);
        expect(enabled.rowCount).toBe(2);
        expect(enabled.merges).toEqual([
            { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
        ]);
        expect(ds.read_rows(0, 0, 1).startRow).toBe(0);
        expect(ds.read_rows(0, 0, 1).rows[0][0]?.raw).toBe('Alice');
        expect(base.closed).toBe(false);

        expect(ds.set_override('Sheet1', 'off')).toBe(true);
        expect(ds.meta().sheets[0]).toMatchObject({
            rowCount: 3,
            columnNames: undefined,
            excelFirstRowHeader: { mode: 'off', active: false },
        });
        expect(ds.read_rows(0, 0, 1).rows[0][0]?.raw).toBe('Name');
    });

    it('uses formatted text for manual column names and supports header-only sheets', () => {
        const ds = new ExcelHeaderDataSource(new StubSource([[
            cell('2024-01-01', { formatted: 'Jan 1, 2024' }),
            cell(0.25, { formatted: '25%' }),
        ]]), { Sheet1: 'on' });

        const sheet = ds.meta().sheets[0];
        expect(sheet.columnNames).toEqual(['Jan 1, 2024', '25%']);
        expect(sheet.rowCount).toBe(0);
        expect(ds.read_rows(0, 0, 5)).toEqual({ startRow: 0, rows: [] });
    });

    it('handles worksheet names that collide with Object.prototype', () => {
        for (const name of ['constructor', 'toString']) {
            const ds = new ExcelHeaderDataSource(new StubSource([
                [cell('Name'), cell('Age')],
                [cell('Alice'), cell(30)],
            ], [], name));
            expect(ds.meta().sheets[0].excelFirstRowHeader).toMatchObject({
                mode: 'auto', active: true,
            });
        }

        const overrides = Object.create(null) as Record<string, 'on' | 'off'>;
        overrides.__proto__ = 'off';
        const proto = new ExcelHeaderDataSource(new StubSource([
            [cell('Name'), cell('Age')],
            [cell('Alice'), cell(30)],
        ], [], '__proto__'), overrides);
        expect(proto.meta().sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'off', active: false,
        });
        proto.replace_overrides({});
        expect(proto.meta().sheets[0].excelFirstRowHeader?.mode).toBe('auto');
    });

    it('applies overrides by worksheet name and delegates close once', () => {
        const base = new StubSource([
            [cell('Name'), cell('Age')],
            [cell('Alice'), cell(30)],
        ], [], 'People');
        const ds = new ExcelHeaderDataSource(base, { People: 'off', Missing: 'on' });
        expect(ds.meta().sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'off', active: false, detected: true,
        });
        ds.replace_overrides({ People: 'on' });
        expect(ds.meta().sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'on', active: true,
        });
        ds.close();
        ds.close();
        expect(base.closed).toBe(true);
    });
});
