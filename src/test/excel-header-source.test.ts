import { describe, expect, it } from 'vitest';
import { ExcelHeaderDataSource } from '../data-source/excel-header-source';
import type {
    ColumnWindow,
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
    readonly read_requests: Array<{ start: number; count: number }> = [];
    readonly column_requests: Array<{
        start: number;
        count: number;
        columns: number[];
    }> = [];

    constructor(
        private readonly rows: (RenderedCell | null)[][],
        private readonly merges: MergeRange[] = [],
        private readonly name = 'Sheet1',
        private readonly source_rows?: readonly number[],
    ) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: this.rows.flat().some((value) => value?.bold),
            sheets: [{
                name: this.name,
                rowCount: this.rows.length,
                sourceRowCount: this.source_rows === undefined
                    ? this.rows.length
                    : Math.max(...this.source_rows) + 1,
                columnCount: this.rows.reduce(
                    (max, row) => Math.max(max, row.length),
                    0,
                ),
                merges: this.merges,
                hasFormatting: this.rows.flat().some((value) => value?.bold),
            }],
        };
    }

    source_row_indices(_sheet: number, projected_rows: ArrayLike<number>): Uint32Array {
        return Uint32Array.from(
            projected_rows,
            (row) => this.source_rows?.[row] ?? row,
        );
    }

    projected_row_index(_sheet: number, source_row: number): number | undefined {
        if (!this.source_rows) return source_row < this.rows.length ? source_row : undefined;
        const projected = this.source_rows.indexOf(source_row);
        return projected < 0 ? undefined : projected;
    }

    read_rows(_sheet: number, start: number, count: number): RowWindow {
        this.read_requests.push({ start, count });
        const clamped = Math.max(0, Math.min(start, this.rows.length));
        return {
            startRow: clamped,
            rows: this.rows.slice(clamped, clamped + Math.max(0, count)),
        };
    }

    read_columns(
        _sheet: number,
        start: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow {
        this.column_requests.push({ start, count, columns: [...column_indices] });
        const clamped = Math.max(0, Math.min(start, this.rows.length));
        return {
            startRow: clamped,
            rows: this.rows.slice(clamped, clamped + Math.max(0, count)).map((row) =>
                column_indices.map((column) => row[column] ?? null)),
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

    it('forwards compact column reads with active and inactive row projection', () => {
        const base = new StubSource([
            [cell('Name'), cell('Age'), cell('City')],
            [cell('Alice'), cell(30), cell('Boston')],
            [cell('Bob'), cell(25), cell('Paris')],
        ]);
        const ds = new ExcelHeaderDataSource(base);

        expect(ds.read_columns(0, 0, 2, [2, 0])).toMatchObject({
            startRow: 0,
            rows: [
                [expect.objectContaining({ raw: 'Boston' }), expect.objectContaining({ raw: 'Alice' })],
                [expect.objectContaining({ raw: 'Paris' }), expect.objectContaining({ raw: 'Bob' })],
            ],
        });
        expect(base.column_requests.at(-1)).toEqual({
            start: 1, count: 2, columns: [2, 0],
        });

        ds.set_override('Sheet1', 'off');
        expect(ds.read_columns(0, 0, 1, [2, 0]).rows[0].map((value) => value?.raw))
            .toEqual(['City', 'Name']);
        expect(base.column_requests.at(-1)).toEqual({
            start: 0, count: 1, columns: [2, 0],
        });
    });

    it('projects indexed rows through the header offset and legacy fallback', () => {
        const base = new StubSource([
            [cell('Name'), cell('Age')],
            [cell('Alice'), cell(30)],
            [cell('Bob'), cell(25)],
        ]);
        const ds = new ExcelHeaderDataSource(base);
        const before = base.read_requests.length;
        expect(ds.read_rows_indexed(0, Uint32Array.from([1, 0, 1])).rows)
            .toEqual([
                [cell('Bob'), cell(25)],
                [cell('Alice'), cell(30)],
                [cell('Bob'), cell(25)],
            ]);
        expect(base.read_requests.slice(before)).toEqual([
            { start: 2, count: 1 },
            { start: 1, count: 2 },
        ]);

        const reads = base.read_requests.length;
        expect(ds.read_rows_indexed(0, [])).toEqual({ rows: [] });
        expect(() => ds.read_rows_indexed(0, [2])).toThrow(RangeError);
        expect(base.read_requests).toHaveLength(reads);

        ds.set_override('Sheet1', 'off');
        expect(ds.read_rows_indexed(0, [0]).rows[0][0]?.raw).toBe('Name');
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

    it('keeps formatted Excel dates in the first row as data', () => {
        const ds = new ExcelHeaderDataSource(new StubSource([
            [
                cell('2024-01-01', { formatted: 'Jan 1, 2024' }),
                cell('2024-02-01', { formatted: 'Feb 1, 2024' }),
            ],
            [cell(10), cell(20)],
            [cell(30), cell(40)],
        ]));

        expect(ds.meta().sheets[0].excelFirstRowHeader?.detected).toBe(false);
        expect(ds.meta().sheets[0].excelFirstRowHeader?.active).toBe(false);
    });

    it('keeps native OOXML date cells in the first row as data', () => {
        const ds = new ExcelHeaderDataSource(new StubSource([
            [
                cell('2024-01-01', { rawType: 'date' }),
                cell('2024-02-01', { rawType: 'date' }),
            ],
            [cell(10), cell(20)],
            [cell(30), cell(40)],
        ]));

        expect(ds.meta().sheets[0].excelFirstRowHeader?.detected).toBe(false);
    });

    it('uses native date cells as typed body evidence', () => {
        const ds = new ExcelHeaderDataSource(new StubSource([
            [cell('Name'), cell('When')],
            [cell('Alpha'), cell('2024-01-01', { rawType: 'date' })],
            [cell('Beta'), cell('2024-02-01', { rawType: 'date' })],
        ]));

        expect(ds.meta().sheets[0].excelFirstRowHeader?.detected).toBe(true);
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

    it('does not sample body rows for structurally ineligible wide sheets', () => {
        const base = new StubSource([
            Array.from({ length: 300 }, (_, index) => cell(`Header ${index}`)),
            Array.from({ length: 300 }, (_, index) => cell(index)),
        ]);

        const ds = new ExcelHeaderDataSource(base);

        expect(base.read_requests).toEqual([{ start: 0, count: 1 }]);
        expect(ds.meta().sheets[0]).toMatchObject({
            rowCount: 2,
            columnCount: 300,
            excelFirstRowHeader: { detected: false, active: false },
        });
    });

    it('plans an override without exposing it to metadata or row requests', () => {
        const base = new StubSource([
            [cell('Name'), cell('Age')],
            [cell('Alice'), cell(30)],
        ], [{ startRow: 1, startCol: 0, endRow: 1, endCol: 1 }]);
        const ds = new ExcelHeaderDataSource(base, { Sheet1: 'off' });
        const before_meta = ds.meta();
        const reads_before = base.read_requests.length;

        const plan = ds.plan_override('Sheet1', 'on');

        expect(plan).toMatchObject({
            sheetIndex: 0,
            previousMode: 'off',
            nextMode: 'on',
            previousActive: false,
            nextActive: true,
            sheet: {
                rowCount: 1,
                columnNames: ['Name', 'Age'],
                excelFirstRowHeader: { mode: 'on', active: true },
            },
        });
        expect(ds.meta()).toBe(before_meta);
        expect(base.read_requests).toHaveLength(reads_before);
        expect(ds.meta().sheets[0].excelFirstRowHeader?.mode).toBe('off');
        expect(ds.read_rows(0, 0, 1).rows[0][0]?.raw).toBe('Name');
        expect(base.read_requests).toHaveLength(reads_before + 1);

        ds.set_override('Sheet1', 'on');
        expect(ds.meta().sheets[0]).toEqual(plan?.sheet);

        const inactive = ds.plan_override('Sheet1', 'off')!;
        inactive.sheet.merges[0].startRow = 99;
        expect(ds.plan_override('Sheet1', 'off')?.sheet.merges[0].startRow).toBe(1);
    });

    it('plans authoritative auto consistently from explicit modes', () => {
        const detected = new ExcelHeaderDataSource(new StubSource([
            [cell('Name'), cell('Age')],
            [cell('Alice'), cell(30)],
        ]), { Sheet1: 'off' });
        const detected_auto = detected.plan_override('Sheet1', 'auto')!;
        expect(detected_auto).toMatchObject({
            previousMode: 'off',
            previousActive: false,
            nextMode: 'auto',
            nextActive: true,
            sheet: {
                columnNames: ['Name', 'Age'],
                excelFirstRowHeader: { mode: 'auto', detected: true, active: true },
            },
        });
        expect(detected_auto.sheet.excelFirstRowHeader?.active)
            .toBe(detected_auto.nextActive);

        const ambiguous = new ExcelHeaderDataSource(new StubSource([
            [cell('Name'), cell('City')],
            [cell('Alice'), cell('London')],
            [cell('Bob'), cell('Paris')],
        ]), { Sheet1: 'on' });
        const ambiguous_auto = ambiguous.plan_override('Sheet1', 'auto')!;
        expect(ambiguous_auto).toMatchObject({
            previousMode: 'on',
            previousActive: true,
            nextMode: 'auto',
            nextActive: false,
            sheet: {
                columnNames: undefined,
                excelFirstRowHeader: { mode: 'auto', detected: false, active: false },
            },
        });
        expect(ambiguous_auto.sheet.excelFirstRowHeader?.active)
            .toBe(ambiguous_auto.nextActive);
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

    it('promotes the first non-hidden source row for an explicit override', () => {
        const base = new StubSource([
            [cell('Report title'), null],
            [cell('Generated today'), null],
            [cell('Name'), cell('Age')],
            [cell('Alice'), cell(30)],
            [cell('Bob'), cell(25)],
        ]);
        const ds = new ExcelHeaderDataSource(
            base,
            { Sheet1: 'on' },
            [[0, 1]],
        );

        expect(ds.meta().sheets[0]).toMatchObject({
            rowCount: 4,
            columnNames: ['Name', 'Age'],
            excelFirstRowHeader: {
                mode: 'on', active: true, available: true, sourceRow: 2,
            },
        });
        expect(ds.read_rows(0, 0, 4).rows.map((row) => row[0]?.raw)).toEqual([
            'Report title',
            'Generated today',
            'Alice',
            'Bob',
        ]);
        expect(ds.read_rows_indexed(0, [2, 0, 3]).rows.map((row) => row[0]?.raw))
            .toEqual(['Alice', 'Report title', 'Bob']);
        expect(ds.read_columns(0, 1, 2, [1, 0]).rows.map((row) => (
            row.map((value) => value?.raw ?? null)
        ))).toEqual([
            [null, 'Generated today'],
            ['30', 'Alice'],
        ]);
    });

    it('captures immutable planning facts for a specifically selected header row', () => {
        const ds = new ExcelHeaderDataSource(new StubSource([
            [cell('Report title'), null],
            [cell('Generated today'), null],
            [cell('Name'), cell('Age')],
            [cell('Alice'), cell(30)],
        ]));

        const input = ds.planning_input_for_header_source('Sheet1', 2)!;

        expect(input.sheets[0]).toMatchObject({
            manualHeaderRow: 2,
            manualHeaderSourceRow: 2,
            manualColumnNames: ['Name', 'Age'],
        });
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.sheets[0].manualColumnNames)).toBe(true);
        expect(ds.planning_input_for_header_source('Sheet1', 9)).toBeUndefined();
    });

    it('makes manual promotion unavailable when every source row is hidden', () => {
        const ds = new ExcelHeaderDataSource(
            new StubSource([
                [cell('Name'), cell('Age')],
                [cell('Alice'), cell(30)],
            ]),
            { Sheet1: 'on' },
            [[0, 1]],
        );

        expect(ds.meta().sheets[0]).toMatchObject({
            rowCount: 2,
            columnNames: undefined,
            excelFirstRowHeader: {
                mode: 'on', active: false, available: false,
            },
        });
    });

    it('keeps using exact membership after a non-monotonic source mapping', () => {
        const ds = new ExcelHeaderDataSource(
            new StubSource([
                [cell('Five')],
                [cell('One')],
                [cell('Two')],
            ], [], 'Sheet1', [5, 1, 2]),
            { Sheet1: 'on' },
            [[1, 2, 5]],
        );

        expect(ds.meta().sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'on', active: false, available: false,
        });
    });

    it('projects merges around an arbitrary promoted row', () => {
        const ds = new ExcelHeaderDataSource(new StubSource([
            [cell('before')],
            [cell('before span')],
            [cell('Header')],
            [cell('after')],
            [cell('after span')],
        ], [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
            { startRow: 1, startCol: 0, endRow: 3, endCol: 0 },
            { startRow: 2, startCol: 1, endRow: 2, endCol: 2 },
            { startRow: 3, startCol: 1, endRow: 4, endCol: 1 },
        ]), { Sheet1: 'on' }, [[0, 1]]);

        expect(ds.meta().sheets[0].merges).toEqual([
            { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
            { startRow: 1, startCol: 0, endRow: 2, endCol: 0 },
            { startRow: 2, startCol: 1, endRow: 3, endCol: 1 },
        ]);
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
