import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    MISSING,
    openDta,
    openParquet,
    writeParquet,
    type Missing,
    type ParquetReader,
    type ValueLabels,
    type WriteDataset,
    type WriteVariable,
} from '@jbearak/dta-parser';
import { cells_exactly_equal } from '../cell-display';
import { align_sheet } from '../diff-compare/row-alignment';
import { DtaDataSource } from '../data-source/dta-source';
import { FileParquetDataSource } from '../data-source/file-parquet-source';
import { build_source_from_buffer } from '../data-source/from-buffer';
import {
    DEFERRED_COMPARISON_IDENTITY,
    type DataSource,
    type RawCell,
    type RenderedCell,
} from '../data-source/interface';
import {
    MAX_PARQUET_COLUMNS,
    MAX_PARQUET_ROWS,
    ParquetDataSource,
    assert_parquet_limits,
} from '../data-source/parquet-source';
import { temporal_text } from '../data-source/parquet-temporal';
import { compute_transform } from '../table-transform';
import { profile_for } from '../viewer-controller';

const FIXTURES = path.join(__dirname, 'fixtures', 'parquet');
const PAIRING = { status: 'matched', name: 'Sheet1', originalIndex: 0, modifiedIndex: 0 } as const;

interface ExpectedColumn {
    readonly name: string;
    readonly arrow_type: string;
    /** Numbers are kept as their JSON text, so 64-bit integers keep every digit. */
    readonly values: readonly unknown[];
}

function expected_of(name: string): { rows: number; columns: ExpectedColumn[] } {
    const text = fs.readFileSync(path.join(FIXTURES, 'expected', `${name}.json`), 'utf8');
    return JSON.parse(text, function (this: unknown, _key, value, context?: { source?: string }) {
        return Array.isArray(this) && typeof value === 'number' && context?.source !== undefined
            ? { number: context.source }
            : value;
    });
}

function all_rows(source: DataSource): RenderedCell[][] {
    const rows = source.meta().sheets[0].rowCount;
    return source.read_rows(0, 0, rows).rows as RenderedCell[][];
}

function binary_key(cell: RawCell): Promise<string> {
    return cell[DEFERRED_COMPARISON_IDENTITY]!.resolveKey(() => false);
}

function binary_preview(bytes: readonly number[]): string {
    const hex = bytes.slice(0, 32).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `binary (${bytes.length} bytes): ${hex}${bytes.length > 32 ? '…' : ''}`;
}

const UNIT_DIGITS: Record<string, number> = { s: 0, ms: 3, us: 6, ns: 9 };

/** A count of `unit` since 1970 in UTC, as ISO text with the unit's fraction digits. */
function utc_text(count: bigint, unit: string): string {
    const per = 10n ** BigInt(UNIT_DIGITS[unit]);
    let seconds = count / per;
    let rest = count % per;
    if (rest < 0n) {
        rest += per;
        seconds -= 1n;
    }
    const iso = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
    return UNIT_DIGITS[unit] === 0 ? iso : `${iso}.${rest.toString().padStart(UNIT_DIGITS[unit], '0')}`;
}

/**
 * Check one fixture column cell by cell against pyarrow's reading. Numbers,
 * text, and nulls are compared directly; dates, timestamps, times, decimals,
 * and binary values through the conversion rules here.
 */
async function check_column(
    column: ExpectedColumn,
    cells: RenderedCell[],
    variable: { type: string; columnKind: string | null; timeZone?: string },
): Promise<void> {
    const type = column.arrow_type;
    for (let row = 0; row < column.values.length; row++) {
        const value = column.values[row];
        const cell = cells[row];
        const where = `${column.name} row ${row}`;
        if (value === null) {
            // A null in a string or dictionary column is a text null; elsewhere `.`.
            if (variable.columnKind === 'string' || variable.columnKind === 'dictionary') {
                expect(cell, where).toMatchObject({ raw: null, rawType: 'empty', comparisonKey: 'parquet:null', formatted: '' });
            } else {
                expect(cell, where).toMatchObject({ raw: '.', rawType: 'number', formatted: '.' });
            }
            continue;
        }
        if (Array.isArray(value)) {
            // Bytes: the preview, and the identity is the sha256 of exactly these bytes.
            const bytes = value.map((byte) => Number((byte as { number: string }).number));
            expect(cell.raw, where).toBe(binary_preview(bytes));
            const digest = createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
            await expect(binary_key(cell), where).resolves.toBe(`stata-binary:sha256:${digest}:${bytes.length}`);
            continue;
        }
        if (typeof value === 'string') {
            if (value === 'NaN') {
                expect(cell, where).toMatchObject({ raw: 'NaN', rawType: 'number', formatted: 'NaN' });
            } else if (type.startsWith('decimal')) {
                // At most 15 digits: the nearest double; more: every digit, as text.
                if (variable.columnKind === 'string') {
                    expect(cell, where).toMatchObject({ rawType: 'number', formatted: value });
                } else {
                    expect(Number(cell.raw), where).toBe(Number(value));
                }
            } else {
                expect(cell, where).toMatchObject({ raw: value, rawType: 'string', formatted: value });
            }
            continue;
        }
        if (typeof value === 'boolean') {
            expect(cell, where).toMatchObject({ raw: value ? '1' : '0', formatted: String(value) });
            continue;
        }
        const digits = (value as { number: string }).number;
        expect(cell.rawType, where).toBe('number');
        if (/^-?\d+$/u.test(digits) && /int|timestamp|time|date/u.test(type)) {
            expect(BigInt(cell.raw!), where).toBe(BigInt(digits));
        } else {
            // == rather than Object.is: -0.0 shows as 0, as it does for .dta (String(-0)).
            expect(Number(cell.raw) === Number(digits), `${where}: ${cell.raw} ${digits}`).toBe(true);
        }
        if (type.startsWith('date32')) {
            const days = Number(digits);
            expect(cell.formatted, where).toBe(new Date(days * 86_400_000).toISOString().slice(0, 10));
        } else if (type.startsWith('timestamp')) {
            const unit = /timestamp\[(\w+)/u.exec(type)![1];
            const utc = utc_text(BigInt(digits), unit);
            if (variable.timeZone === undefined) expect(cell.formatted, where).toBe(utc);
            else if (variable.timeZone === 'UTC') expect(cell.formatted, where).toBe(`${utc}+00:00[UTC]`);
            else expect(cell.formatted, where).toMatch(new RegExp(`[+-]\\d\\d:\\d\\d\\[${variable.timeZone}\\]$`, 'u'));
        } else if (type.startsWith('time')) {
            const unit = /time\d+\[(\w+)/u.exec(type)![1];
            expect(cell.formatted, where).toBe(utc_text(BigInt(digits), unit).slice(11));
        } else if (type === 'bool') {
            throw new Error('unreachable');
        } else {
            expect(cell.formatted, where).toBe(cell.raw);
        }
    }
}

describe('Parquet files from other libraries', () => {
    it.each([
        ['pyarrow_default', []],
        ['pyarrow_nested', ['3 columns are not shown: "tags" (a list, map, or struct), "point" (a list, map, or struct), "props" (a list, map, or struct).']],
        ['pyarrow_types', []],
        ['pyarrow_delta', []],
        ['polars_default', []],
        ['duckdb_default', []],
        ['arrow_r_default', []],
        ['fastparquet_default', []],
    ])('reads %s as pyarrow does', async (name, warnings) => {
        const expected = expected_of(name);
        const file = path.join(FIXTURES, `${name}.parquet`);
        const source = await FileParquetDataSource.open(file);
        const buffered = await ParquetDataSource.create(new Uint8Array(fs.readFileSync(file)));
        try {
            const sheet = source.meta().sheets[0];
            expect(sheet.rowCount).toBe(expected.rows);
            expect(sheet.columnNames).toEqual(expected.columns.map((column) => column.name));
            expect(source.warnings).toEqual(warnings);
            const rows = all_rows(source);
            const reader = openParquet(new Uint8Array(fs.readFileSync(file)));
            const readable = reader.variables.filter((variable) => variable.columnKind !== null);
            for (const [k, column] of expected.columns.entries()) {
                await check_column(column, rows.map((row) => row[k]), readable[k]);
            }
            reader.close();
            expect(strip(all_rows(buffered))).toEqual(strip(rows));
        } finally {
            source.close();
            buffered.close();
        }
    });
});

/** Cells without their deferred identities, for structural comparison. */
function strip(rows: readonly (readonly (RenderedCell | null)[])[]) {
    return rows.map((row) => row.map((cell) => cell && {
        raw: cell.raw, rawType: cell.rawType, formatted: cell.formatted,
        comparisonKey: cell.comparisonKey, rawByteLength: cell.rawByteLength,
    }));
}

function labels(entries: [number | Missing, string][]): ValueLabels {
    return new Map(entries);
}

async function source_of(data: WriteDataset): Promise<ParquetDataSource> {
    return ParquetDataSource.create(writeParquet(data));
}

describe('Parquet cells', () => {
    it('shows each column kind raw and formatted', async () => {
        const blob = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
        const source = await source_of({
            valueLabels: { yesno: labels([[0, 'No'], [1, 'Yes'], [MISSING['.a'], 'Refused']]) },
            variables: [
                { name: 'labelled', type: 'byte', valueLabels: 'yesno', values: [1, MISSING['.a'], null, MISSING['.z']] },
                { name: 'formatted', type: 'double', format: '%9.2f', values: [3.14159, NaN, Infinity, -Infinity] },
                { name: 'big', type: 'int64', values: [2n ** 60n + 1n, null, -5n, 2n ** 53n + 1n] },
                { name: 'flag', type: 'bool', values: [1, 0, null, 1] },
                { name: 'day', type: 'date', values: [19_783, null, -1, 0] },
                { name: 'seen', type: 'timestamp', unit: 'us', timeZone: 'America/New_York', values: [1_709_301_600_123_456, null, 0, 1] },
                { name: 'logged', type: 'timestamp', unit: 'ns', values: [1_709_301_600_000_000_001n, null, -1n, 1n] },
                { name: 'text', type: 'string', values: ['plain', null, '', 'ü'] },
                { name: 'level', type: 'categorical', levels: ['low', 'high'], values: [0, null, 1, 0] },
                { name: 'bytes', type: 'binary', values: [blob, null, new Uint8Array(), blob] },
            ],
        });
        try {
            const rows = all_rows(source);
            const column = (k: number) => rows.map((row) => [row[k].raw, row[k].formatted, row[k].rawType]);
            expect(column(0)).toEqual([['1', 'Yes', 'number'], ['.a', 'Refused', 'number'], ['.', '.', 'number'], ['.z', '.z', 'number']]);
            expect(column(1)).toEqual([['3.14159', '3.14', 'number'], ['NaN', 'NaN', 'number'], ['Infinity', 'Infinity', 'number'], ['-Infinity', '-Infinity', 'number']]);
            expect(column(2)).toEqual([['1152921504606846977', '1152921504606846977', 'number'], ['.', '.', 'number'], ['-5', '-5', 'number'], ['9007199254740993', '9007199254740993', 'number']]);
            expect(column(3)).toEqual([['1', 'true', 'number'], ['0', 'false', 'number'], ['.', '.', 'number'], ['1', 'true', 'number']]);
            expect(column(4)).toEqual([['19783', '2024-03-01', 'number'], ['.', '.', 'number'], ['-1', '1969-12-31', 'number'], ['0', '1970-01-01', 'number']]);
            expect(column(5)).toEqual([
                ['1709301600123456', '2024-03-01T09:00:00.123456-05:00[America/New_York]', 'number'],
                ['.', '.', 'number'],
                ['0', '1969-12-31T19:00:00.000000-05:00[America/New_York]', 'number'],
                ['1', '1969-12-31T19:00:00.000001-05:00[America/New_York]', 'number'],
            ]);
            expect(column(6)).toEqual([
                ['1709301600000000001', '2024-03-01T14:00:00.000000001', 'number'],
                ['.', '.', 'number'],
                ['-1', '1969-12-31T23:59:59.999999999', 'number'],
                ['1', '1970-01-01T00:00:00.000000001', 'number'],
            ]);
            expect(column(7)).toEqual([['plain', 'plain', 'string'], [null, '', 'empty'], ['', '', 'string'], ['ü', 'ü', 'string']]);
            expect(column(8)).toEqual([['low', 'low', 'string'], [null, '', 'empty'], ['high', 'high', 'string'], ['low', 'low', 'string']]);
            expect(column(9)).toEqual([
                ['binary (4 bytes): deadbeef', 'binary (4 bytes): deadbeef', 'string'],
                [null, '', 'empty'],
                ['binary (0 bytes): ', 'binary (0 bytes): ', 'string'],
                ['binary (4 bytes): deadbeef', 'binary (4 bytes): deadbeef', 'string'],
            ]);
            expect(rows[1][0].comparisonKey).toBe('stata:missing:.a');
            expect(rows[2][0].comparisonKey).toBe('stata:missing:.');
            expect(rows[2][3].comparisonKey).toBe('stata:missing:.');
            for (const k of [2, 4, 5, 6]) {
                expect(rows[1][k].comparisonKey).toBe('stata:missing:.');
            }
            for (const k of [7, 8, 9]) expect(rows[1][k].comparisonKey).toBe('parquet:null');
            expect(rows[2][7].comparisonKey).toBeUndefined();
            await expect(binary_key(rows[0][9])).resolves.toBe(await binary_key(rows[3][9]));

            // Raw-only reads, sparse reads, and async rendered reads agree with windows.
            const raw = source.read_raw_columns(0, 0, 4, source.meta().sheets[0].columnNames!.map((_, k) => k)).rows;
            expect(strip(raw.map((row) => row.map((cell) => cell && { ...cell, formatted: '' } as RenderedCell))))
                .toEqual(strip(rows.map((row) => row.map((cell) => ({ ...cell, formatted: '' })))));
            const indexed = source.read_rows_indexed(0, [3, 1, 0, 2]).rows;
            expect(strip(indexed)).toEqual(strip([rows[3], rows[1], rows[0], rows[2]]));
            const async_indexed = await source.read_rows_indexed_async(0, [3, 1, 0, 2], () => false);
            expect(strip(async_indexed.rows)).toEqual(strip([rows[3], rows[1], rows[0], rows[2]]));
        } finally {
            source.close();
        }
    });

    it('shows numbers without a format, decimals, and times as other libraries write them', async () => {
        const defaults = await FileParquetDataSource.open(path.join(FIXTURES, 'pyarrow_default.parquet'));
        const types = await FileParquetDataSource.open(path.join(FIXTURES, 'pyarrow_types.parquet'));
        try {
            const names = defaults.meta().sheets[0].columnNames!;
            const f64 = all_rows(defaults).map((row) => row[names.indexOf('f64')]);
            expect(f64.find((cell) => cell.raw === 'NaN')).toMatchObject({ formatted: 'NaN' });
            expect(f64[1]).toMatchObject({ raw: '0.14285714285714285', formatted: '0.14285714285714285' });
            const type_names = types.meta().sheets[0].columnNames!;
            const row = all_rows(types)[1];
            expect(row[type_names.indexOf('t_ns')]).toMatchObject({ raw: '143999999999', formatted: '00:02:23.999999999' });
            expect(row[type_names.indexOf('dec9')]).toMatchObject({ raw: '-2987.63', rawType: 'number' });
            expect(row[type_names.indexOf('dec38')]).toMatchObject({
                raw: '-369135799146913579.9146913643', rawType: 'number', formatted: '-369135799146913579.9146913643',
            });
        } finally {
            defaults.close();
            types.close();
        }
    });

    it('formats a date by its Parquet unit even when the profile gives a Stata format', async () => {
        const source = await source_of({
            variables: [{ name: 'born', type: 'date', format: '%td', values: [19_783] }],
        });
        try {
            expect(source.read_rows(0, 0, 1).rows[0][0]).toMatchObject({ raw: '19783', formatted: '2024-03-01' });
        } finally {
            source.close();
        }
    });

    it('shows a zone this runtime does not know as UTC with the zone name', () => {
        expect(temporal_text(1_709_301_600_123_456, { type: 'timestamp', unit: 'us', timeZone: 'Mars/Olympus_Mons' }))
            .toBe('2024-03-01T14:00:00.123456[Mars/Olympus_Mons]');
        expect(temporal_text(8_640_000_000_000_001, { type: 'timestamp', unit: 'ms' })).toBe('8640000000000001');
        expect(temporal_text(10n ** 20n, { type: 'date', unit: 'day' })).toBe('100000000000000000000');
        expect(temporal_text(-1, { type: 'time', unit: 's' })).toBe('-1');
    });

    it('sorts and filters 64-bit integers past 2^53 by their digits', async () => {
        const base = 2n ** 53n;
        const source = await source_of({
            variables: [{ name: 'id', type: 'int64', values: [base + 3n, base + 1n, null, base + 2n] }],
        });
        try {
            const sorted = await compute_transform(source, 0, { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] });
            expect([...sorted.indices!]).toEqual([1, 3, 0, 2]);
            const filtered = await compute_transform(source, 0, {
                sort: [],
                filters: [{ id: 'lt', colIndex: 0, operator: 'lessThan', value: String(base + 3n), caseSensitive: false, enabled: true }],
            });
            expect([...filtered.indices!]).toEqual([1, 3]);
        } finally {
            source.close();
        }
    });

    it('compares a 64-bit column read as bigints equal to the same data read as numbers', async () => {
        const bytes = writeParquet({ variables: [{ name: 'n', type: 'int64', values: [1n, null, -7n, 42n] }] });
        const as_numbers = await ParquetDataSource.create(bytes);
        const BigintSource = ParquetDataSource as unknown as new (reader: ParquetReader) => ParquetDataSource;
        const as_bigints = new BigintSource(openParquet(bytes, { int64: 'bigint', nested: 'error' }));
        try {
            expect(strip(all_rows(as_bigints))).toEqual(strip(all_rows(as_numbers)));
            const alignment = await align_sheet(as_numbers, as_bigints, PAIRING);
            expect(alignment).toMatchObject({ changedCells: 0, addedRows: 0, deletedRows: 0 });
        } finally {
            as_numbers.close();
            as_bigints.close();
        }
    });
});

describe('Parquet cell identity', () => {
    it('keeps a text null, an empty string, and . apart', async () => {
        const nulls = await source_of({ variables: [{ name: 'v', type: 'string', values: [null, 'x'] }] });
        const empty = await source_of({ variables: [{ name: 'v', type: 'string', values: ['', 'x'] }] });
        const dot = await source_of({ variables: [{ name: 'v', type: 'double', values: [null, 1] }] });
        try {
            const [text_null] = nulls.read_raw_columns(0, 0, 1, [0]).rows[0];
            const [text_empty] = empty.read_raw_columns(0, 0, 1, [0]).rows[0];
            const [number_null] = dot.read_raw_columns(0, 0, 1, [0]).rows[0];
            expect(text_null).toEqual({ raw: null, rawType: 'empty', comparisonKey: 'parquet:null' });
            expect(text_empty).toEqual({ raw: '', rawType: 'string' });
            expect(number_null).toEqual({ raw: '.', rawType: 'number', comparisonKey: 'stata:missing:.' });
            for (const [left, right] of [[text_null, text_empty], [text_null, number_null], [text_empty, number_null]]) {
                expect(await cells_exactly_equal(left, right, () => false)).toBe(false);
            }
            expect(await cells_exactly_equal(text_null, nulls.read_raw_columns(0, 0, 1, [0]).rows[0][0], () => false)).toBe(true);
            for (const [original, modified] of [[nulls, empty], [nulls, dot], [empty, dot]]) {
                const alignment = await align_sheet(original, modified, PAIRING);
                expect(alignment.changedCells + alignment.addedRows + alignment.deletedRows).toBeGreaterThan(0);
            }
            const same = await align_sheet(nulls, await source_of({ variables: [{ name: 'v', type: 'string', values: [null, 'x'] }] }), PAIRING);
            expect(same).toMatchObject({ changedCells: 0, addedRows: 0, deletedRows: 0 });
        } finally {
            nulls.close();
            empty.close();
            dot.close();
        }
    });
});

/** A .dta file's variables, labels, and values as `writeParquet` takes them. */
function dta_as_parquet(bytes: Uint8Array): Uint8Array {
    const reader = openDta(bytes);
    try {
        const columns = reader.readColumns(reader.variables.map((_, index) => index));
        const value_labels: Record<string, ValueLabels> = {};
        for (const variable of reader.variables) {
            const set = variable.valueLabels ? reader.valueLabels(variable.valueLabels) : undefined;
            if (set) value_labels[variable.valueLabels] = set;
        }
        const variables: WriteVariable[] = reader.variables.map((variable, index) => ({
            name: variable.name,
            type: variable.type,
            format: variable.format,
            label: variable.label,
            ...(variable.valueLabels ? { valueLabels: variable.valueLabels } : {}),
            values: columns[index],
        }));
        return writeParquet({ variables, valueLabels: value_labels, label: reader.info.label });
    } finally {
        reader.close();
    }
}

describe('Parquet and .dta parity', () => {
    it.each(['all_types_v118.dta', 'missing-values.dta'])(
        'renders %s written to Parquet as the .dta source does',
        async (name) => {
            const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
            const dta = await DtaDataSource.create(bytes);
            const parquet = await ParquetDataSource.create(dta_as_parquet(bytes));
            try {
                expect(parquet.warnings).toEqual([]);
                expect(strip(all_rows(parquet))).toEqual(strip(all_rows(dta)));
                const alignment = await align_sheet(dta, parquet, PAIRING);
                expect(alignment).toMatchObject({ changedCells: 0, addedRows: 0, deletedRows: 0 });
                const columns = dta.meta().sheets[0].columnNames!.map((_, k) => k);
                for (const column of columns) {
                    expect(parquet.column_filter_metadata(0, column)?.categoricalCodes)
                        .toBe(dta.column_filter_metadata(0, column)?.categoricalCodes);
                }
            } finally {
                dta.close();
                parquet.close();
            }
        },
    );
});

describe('Parquet registration', () => {
    it('dispatches .parquet bytes to the Parquet source and opens files read-only from disk', async () => {
        const bytes = writeParquet({ variables: [{ name: 'x', values: [1, 2] }] });
        const source = await build_source_from_buffer(bytes, '/tmp/table.PARQUET');
        expect(source).toBeInstanceOf(ParquetDataSource);
        source.close();
        const profile = profile_for('/tmp/table.parquet');
        expect(profile.editing).toBe(false);
        expect(profile.prefer_file_source).toBe(true);
        expect(profile.build_file_source).toBeTypeOf('function');
    });
});

/** A stand-in reader whose footer says what a test needs. */
function footer_reader(overrides: {
    nobs?: number;
    columns?: number;
    groups?: number;
    profile_bytes?: number;
    uncompressed?: number;
    dictionary_page?: number;
}) {
    const groups = overrides.groups ?? 1;
    const nobs = overrides.nobs ?? 10;
    const chunk = {
        compressedBytes: 1, uncompressedBytes: 1, codec: 'none', encodings: ['PLAIN'],
        dictionaryPageBytes: overrides.dictionary_page ?? null, nullCount: 0, min: null, max: null,
    };
    return {
        info: {
            nobs,
            rowGroups: Array.from({ length: groups }, (_, g) => ({
                firstRow: g, rows: 1, compressedBytes: 1, uncompressedBytes: overrides.uncompressed ?? 1,
            })),
            keyValue: overrides.profile_bytes === undefined ? [] : [{ key: 'dta', bytes: overrides.profile_bytes }],
            warnings: [],
        },
        variables: Array.from({ length: overrides.columns ?? 1 }, (_, k) => ({
            name: `v${k}`, columnKind: 'number', chunks: Array.from({ length: groups }, () => chunk),
        })),
    } as unknown as ParquetReader;
}

describe('Parquet limits and damage', () => {
    it.each([
        ['rows', { nobs: MAX_PARQUET_ROWS + 1 }, /too many rows.*2,000,000/u],
        ['columns', { columns: MAX_PARQUET_COLUMNS + 1 }, /too many columns.*10,000/u],
        ['column chunks', { columns: 401, groups: 1000, nobs: 1000 }, /too many column chunks.*400,000/u],
        ['dta profile', { profile_bytes: 16 * 1024 * 1024 + 1 }, /dta metadata is larger than the 16 MiB/u],
        ['bytes per row', { nobs: 1, uncompressed: 1024 * 1024 + 1 }, /1 MiB per-row safety limit/u],
        ['dictionary page', { dictionary_page: 16 * 1024 * 1024 + 1 }, /"v0" has a dictionary page larger than the 16 MiB/u],
    ])('refuses a file past the %s limit', (_name, overrides, message) => {
        expect(() => assert_parquet_limits(footer_reader(overrides))).toThrow(message);
    });

    it('accepts a file at every limit', () => {
        expect(() => assert_parquet_limits(footer_reader({
            nobs: MAX_PARQUET_ROWS, profile_bytes: 16 * 1024 * 1024, dictionary_page: 16 * 1024 * 1024,
        }))).not.toThrow();
    });

    it('refuses a footer longer than 64 MiB before the parser reads it', async () => {
        const bytes = writeParquet({ variables: [{ name: 'x', values: [1] }] });
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(bytes.length - 8, 64 * 1024 * 1024 + 1, true);
        await expect(ParquetDataSource.create(bytes)).rejects.toThrow(
            /^Could not open Parquet file: Parquet footer is 67,108,865 bytes, more than the 64 MiB safety limit/u,
        );
    });

    it('holds decoded value labels to the .dta limits', async () => {
        const many = labels(Array.from({ length: 65_537 }, (_, k): [number, string] => [k, 'x']));
        await expect(source_of({
            valueLabels: { many },
            variables: [{ name: 'x', type: 'long', valueLabels: 'many', values: [1] }],
        })).rejects.toThrow(/Parquet value-label data exceeds the 65,536 entry safety limit/u);
    });

    it('applies the buffered sheet shape to git and compare originals', async () => {
        const variables = Array.from({ length: 257 }, (_, k) => ({ name: `v${k}`, type: 'byte', values: [1] }));
        await expect(source_of({ variables })).rejects.toThrow(/too many columns/u);
    });

    it('opens a file of only unreadable columns as a table with none, naming them', () => {
        const reader = {
            info: { nobs: 3, rowGroups: [{ firstRow: 0, rows: 3, compressedBytes: 1, uncompressedBytes: 1 }], keyValue: [], warnings: ['a newer dta profile'] },
            variables: [
                { name: 'tags', role: 'nested', columnKind: null, valueLabels: '', chunks: [] },
                { name: 'half', role: 'data', columnKind: null, notRead: 'FLOAT16 is not read', valueLabels: '', chunks: [] },
            ],
            valueLabels: () => undefined,
            close: () => undefined,
        } as unknown as ParquetReader;
        const UnsafeSource = ParquetDataSource as unknown as new (reader: ParquetReader) => ParquetDataSource;
        const source = new UnsafeSource(reader);
        expect(source.meta().sheets[0]).toMatchObject({ rowCount: 3, columnCount: 0, columnNames: [] });
        expect(source.warnings).toEqual([
            '2 columns are not shown: "tags" (a list, map, or struct), "half" (FLOAT16 is not read).',
            'a newer dta profile',
        ]);
        expect(source.read_rows(0, 0, 3).rows).toEqual([[], [], []]);
        source.close();
    });

    it('calls a truncated file corrupt', async () => {
        const bytes = writeParquet({ variables: [{ name: 'x', values: [1, 2, 3] }] });
        await expect(ParquetDataSource.create(bytes.subarray(0, bytes.length - 20)))
            .rejects.toThrow(/^Could not open Parquet file: Corrupt Parquet file/u);
        await expect(ParquetDataSource.create(bytes.subarray(0, 6)))
            .rejects.toThrow(/^Could not open Parquet file: Corrupt Parquet file/u);
    });

    it('calls a damaged page corrupt when it is read', async () => {
        const bytes = writeParquet({
            variables: [{ name: 'x', type: 'string', values: Array.from({ length: 1000 }, (_, k) => `value ${k}`) }],
        });
        // Overwrite the first page header, just after the leading magic.
        bytes.fill(0xff, 4, 24);
        const source = await ParquetDataSource.create(bytes);
        try {
            expect(() => source.read_rows(0, 0, 10)).toThrow(/^Corrupt Parquet file: /u);
        } finally {
            source.close();
        }
    });

    it('closes its descriptor when the view closes', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-parquet-'));
        const file = path.join(directory, 'x.parquet');
        fs.writeFileSync(file, writeParquet({ variables: [{ name: 'x', values: [1] }] }));
        const source = await FileParquetDataSource.open(file);
        const fd = (source as unknown as { file: { descriptor: number } }).file.descriptor;
        expect(() => fs.fstatSync(fd)).not.toThrow();
        source.close();
        expect(() => fs.fstatSync(fd)).toThrow(/EBADF/u);
        expect(() => source.read_rows(0, 0, 1)).toThrow(/Parquet source is closed/u);
        fs.rmSync(directory, { recursive: true, force: true });
    });
});
