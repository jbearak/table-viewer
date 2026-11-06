import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    MISSING,
    formatValue,
    writeDta,
    writeParquet,
    type ColumnChunk,
    type Missing,
    type ParquetVariable,
    type Statistic,
    type ValueLabels,
} from '@jbearak/dta-parser';
import {
    MAX_COLUMN_DETAILS_BYTES,
    capped_column_details,
    list_text,
} from '../data-source/column-details';
import { DtaDataSource } from '../data-source/dta-source';
import { FileDtaDataSource } from '../data-source/file-dta-source';
import { FileParquetDataSource } from '../data-source/file-parquet-source';
import type { ColumnDetails, DataSource } from '../data-source/interface';
import {
    MAX_TEXT_BOUND_CHARACTERS,
    ParquetDataSource,
    compare_utf8,
    parquet_column_details,
} from '../data-source/parquet-source';
import { header_tooltip_size, header_tooltip_text } from '../webview/header-tooltip';

const FIXTURES = path.join(__dirname, 'fixtures');

function details_of(source: DataSource): (ColumnDetails | null)[] | undefined {
    return source.meta().sheets[0].columnDetails;
}

function labels(entries: [number | Missing, string][]): ValueLabels {
    return new Map(entries);
}

describe('.dta column details', () => {
    it('gives each variable its label, storage type and display format, and value label set', async () => {
        const source = await DtaDataSource.create(
            new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'all_types_v118.dta'))),
        );
        try {
            const details = details_of(source)!;
            expect(details).toHaveLength(8);
            expect(details[0]).toEqual({ label: 'Byte variable', type: 'byte, %8.0g' });
            expect(details[4]).toEqual({ label: 'Double variable', type: 'double, %10.0g' });
            expect(details[7]).toEqual({ label: 'Long string (strL)', type: 'strL, %9s' });
        } finally {
            source.close();
        }
    });

    it('names the value label set, and gives file-backed views the same details', async () => {
        const bytes = writeDta({
            valueLabels: { yesno: labels([[0, 'No'], [1, 'Yes']]) },
            variables: [
                { name: 'answer', type: 'byte', format: '%8.0g', label: 'Did you answer?', valueLabels: 'yesno', values: [1, 0] },
                { name: 'plain', type: 'double', format: '%10.0g', values: [1.5, 2] },
            ],
        });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-column-details-'));
        const file = path.join(directory, 'answers.dta');
        fs.writeFileSync(file, bytes);
        const buffered = await DtaDataSource.create(bytes);
        const on_disk = await FileDtaDataSource.open(file);
        try {
            const expected = [
                { label: 'Did you answer?', type: 'byte, %8.0g', valueLabels: 'yesno' },
                { type: 'double, %10.0g' },
            ];
            expect(details_of(buffered)).toEqual(expected);
            expect(details_of(on_disk)).toEqual(expected);
        } finally {
            buffered.close();
            on_disk.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe('Parquet column details', () => {
    it('gives each column its type, codec, and footer statistics over several row groups', async () => {
        const source = await ParquetDataSource.create(writeParquet({
            valueLabels: { yesno: labels([[0, 'No'], [1, 'Yes'], [MISSING['.a'], 'Refused']]) },
            variables: [
                { name: 'answer', type: 'byte', format: '%8.0g', label: 'Did you answer?', valueLabels: 'yesno', values: [1, MISSING['.a'], null, 0] },
                { name: 'price', type: 'double', format: '%9.2f', values: [3.14159, 2, 1.5, 10] },
                { name: 'big', type: 'int64', values: [2n ** 60n, -5n, null, 3n] },
                { name: 'day', type: 'date', values: [19_783, 0, -1, null] },
                { name: 'seen', type: 'timestamp', unit: 'us', timeZone: 'America/New_York', values: [1_709_301_600_123_456, 0, null, 1] },
                // By UTF-16 code units U+FF61 sorts after U+1F600; by UTF-8 bytes, before.
                { name: 'word', type: 'string', values: ['b', '｡', '\u{1F600}', 'a'] },
                { name: 'level', type: 'categorical', levels: ['low', 'high'], values: [0, null, 1, 0] },
                { name: 'blob', type: 'binary', values: [Uint8Array.of(1), null, Uint8Array.of(255), new Uint8Array()] },
                { name: 'flag', type: 'bool', values: [1, 0, null, 1] },
            ],
        }, { rowGroupSize: 2 }));
        try {
            const details = details_of(source)!;
            expect(details[0]).toEqual({
                label: 'Did you answer?',
                type: 'byte, %8.0g; Parquet DOUBLE; snappy',
                valueLabels: 'yesno',
                statistics: '1 null; between No and Yes',
            });
            expect(details[1]).toEqual({
                type: 'double, %9.2f; Parquet DOUBLE; snappy',
                statistics: 'No nulls; between 1.50 and 10.00',
            });
            expect(details[2]).toEqual({
                type: 'int64; Parquet INT64; snappy',
                statistics: '1 null; between -5 and 1152921504606846976',
            });
            expect(details[3]).toEqual({
                type: 'date; Parquet INT32 DATE; snappy',
                statistics: '1 null; between 1969-12-31 and 2024-03-01',
            });
            expect(details[4]?.statistics).toBe(
                '1 null; between 1969-12-31T19:00:00.000000-05:00[America/New_York] '
                + 'and 2024-03-01T09:00:00.123456-05:00[America/New_York]',
            );
            expect(details[5]).toEqual({
                type: 'string; Parquet BYTE_ARRAY STRING; snappy',
                statistics: 'No nulls; between "a" and "\u{1F600}"',
            });
            expect(details[6]?.statistics).toBe('1 null; between "high" and "low"');
            // Binary bounds are not shown; a bool has no range.
            expect(details[7]).toEqual({ type: 'binary; Parquet BYTE_ARRAY; snappy', statistics: '1 null' });
            expect(details[8]).toEqual({ type: 'bool; Parquet BOOLEAN; snappy', statistics: '1 null' });
        } finally {
            source.close();
        }
    });

    it('describes another library\'s file read from disk', async () => {
        const source = await FileParquetDataSource.open(path.join(FIXTURES, 'parquet', 'pyarrow_default.parquet'));
        try {
            const names = source.meta().sheets[0].columnNames!;
            const details = details_of(source)!;
            const of = (name: string) => details[names.indexOf(name)];
            expect(of('i8')).toEqual({
                type: 'byte; Parquet INT32 INT(8, signed); snappy',
                statistics: '60 nulls; between -125 and 124',
            });
            expect(of('ts_us_ny')).toEqual({
                type: 'timestamp; Parquet INT64 TIMESTAMP(MICROS, UTC); snappy',
                statistics: '28 nulls; between 2019-12-31T19:00:00.000000-05:00[America/New_York] '
                    + 'and 2019-12-31T19:09:59.001797-05:00[America/New_York]',
            });
            expect(of('word')?.statistics).toBe('36 nulls; between "word 0 ü" and "word 9 ü"');
            expect(of('blob')?.statistics).toBe('32 nulls');
        } finally {
            source.close();
        }
    });

    it('leaves the range out when a row group does not record a bound', async () => {
        // The package reports an infinite bound as unrecorded.
        const source = await ParquetDataSource.create(writeParquet({
            variables: [{ name: 'x', type: 'double', values: [1, 2, Infinity, 3] }],
        }, { rowGroupSize: 2 }));
        try {
            expect(details_of(source)![0]?.statistics).toBe('No nulls');
        } finally {
            source.close();
        }
    });
});

/** A column chunk from the footer, with what a test needs. */
function chunk(overrides: Partial<ColumnChunk>): ColumnChunk {
    return {
        compressedBytes: 1,
        uncompressedBytes: 1,
        codec: 'zstd',
        encodings: ['PLAIN'],
        dictionaryPageBytes: null,
        nullCount: 0,
        min: null,
        max: null,
        ...overrides,
    };
}

/** A stand-in variable whose footer says what a test needs. */
function variable(
    overrides: Partial<ParquetVariable>,
    chunks: (ColumnChunk | null)[],
): ParquetVariable {
    return {
        name: 'v',
        type: 'double',
        format: '',
        label: '',
        valueLabels: '',
        role: 'data',
        physicalType: 'DOUBLE',
        logicalType: '',
        columnKind: 'number',
        chunks,
        ...overrides,
    };
}

function bounds(min: Statistic | null, max: Statistic | null, nullCount: number | null = 0): ColumnChunk {
    return chunk({ min, max, nullCount });
}

const TEXT = { type: 'string', physicalType: 'BYTE_ARRAY', logicalType: 'STRING', columnKind: 'string' } as const;

describe('Parquet footer statistics', () => {
    it('combines numbers by value over row groups, and counts nulls only when every row group does', () => {
        expect(parquet_column_details(variable({}, [bounds(5, 9, 2), bounds(-1, 3, 1)])).statistics)
            .toBe('3 nulls; between -1 and 9');
        expect(parquet_column_details(variable({}, [bounds(5, 9, 2), bounds(-1, 3, null)])).statistics)
            .toBe('Between -1 and 9');
        expect(parquet_column_details(variable({}, [bounds(5, 9, 1_234), null])).statistics)
            .toBeUndefined();
        expect(parquet_column_details(variable({}, [bounds(5, 9, 1_234)])).statistics)
            .toBe('1,234 nulls; between 5 and 9');
    });

    it('leaves the range out when one row group lacks a bound, or a bound is not a value', () => {
        expect(parquet_column_details(variable({}, [bounds(5, 9), bounds(null, 3)])).statistics)
            .toBe('No nulls');
        expect(parquet_column_details(variable({}, [bounds(5, 9), bounds(1, NaN)])).statistics)
            .toBe('No nulls');
    });

    it('combines bigint bounds by value and formats times by their unit', () => {
        const big = variable(
            { type: 'int64', physicalType: 'INT64', columnKind: 'bigint' },
            [bounds(2n ** 60n, 2n ** 61n), bounds(-(2n ** 60n), 7n)],
        );
        expect(parquet_column_details(big).statistics)
            .toBe('No nulls; between -1152921504606846976 and 2305843009213693952');
        const time = variable(
            { type: 'time', physicalType: 'INT64', logicalType: 'TIME(MICROS, local)', unit: 'us' },
            [bounds(0, 3_600_000_000), bounds(1, 86_399_999_999)],
        );
        expect(parquet_column_details(time).statistics)
            .toBe('No nulls; between 00:00:00.000000 and 23:59:59.999999');
    });

    it('combines text by UTF-8 bytes, not UTF-16 code units', () => {
        expect(compare_utf8('｡', '\u{1F600}')).toBeLessThan(0);
        expect('｡' < '\u{1F600}').toBe(false);
        expect(compare_utf8('ab', 'abc')).toBeLessThan(0);
        expect(compare_utf8('abc', 'abc')).toBe(0);
        const text = variable(TEXT, [bounds('\u{1F600}', '\u{1F600}'), bounds('｡', '｡')]);
        expect(parquet_column_details(text).statistics)
            .toBe('No nulls; between "｡" and "\u{1F600}"');
    });

    it('does not show binary bounds, or text bounds that are not valid UTF-8', () => {
        const binary = variable(
            { type: 'binary', physicalType: 'BYTE_ARRAY', columnKind: 'string' },
            [bounds(Uint8Array.of(0), Uint8Array.of(9), 4)],
        );
        expect(parquet_column_details(binary).statistics).toBe('4 nulls');
        // The package gives a text bound that is not valid UTF-8 as bytes.
        const invalid = variable(TEXT, [bounds('a', 'b'), bounds(Uint8Array.of(0xff), 'c')]);
        expect(parquet_column_details(invalid).statistics).toBe('No nulls');
    });

    it(`leaves out text bounds longer than ${MAX_TEXT_BOUND_CHARACTERS} characters`, () => {
        // 64 characters of 2 UTF-16 code units each is not too long.
        const emoji = '\u{1F600}'.repeat(MAX_TEXT_BOUND_CHARACTERS);
        expect(parquet_column_details(variable(TEXT, [bounds('a', emoji)])).statistics)
            .toBe(`No nulls; between "a" and "${emoji}"`);
        const long = 'x'.repeat(MAX_TEXT_BOUND_CHARACTERS + 1);
        expect(parquet_column_details(variable(TEXT, [bounds('a', long)])).statistics)
            .toBe('No nulls');
    });

    it('formats bounds as the cells are: value labels and display formats', () => {
        const labelled = variable(
            { format: '%8.0g', valueLabels: 'yesno' },
            [bounds(0, 1)],
        );
        expect(parquet_column_details(labelled, labels([[0, 'No'], [1, 'Yes']])).statistics)
            .toBe('No nulls; between No and Yes');
        const dated = variable({ format: '%td' }, [bounds(0, 365)]);
        expect(parquet_column_details(dated).statistics)
            .toBe(`No nulls; between ${formatValue(0, '%td')} and ${formatValue(365, '%td')}`);
        expect(formatValue(365, '%td')).toBe('1960-12-31');
    });

    it('lists every codec the row groups use, and says uncompressed for none', () => {
        const mixed = variable({}, [chunk({ codec: 'snappy' }), chunk({ codec: 'zstd' }), chunk({ codec: 'none' })]);
        expect(parquet_column_details(mixed).type).toBe('double; Parquet DOUBLE; snappy, zstd, and uncompressed');
        expect(list_text(['snappy', 'zstd'])).toBe('snappy and zstd');
    });
});

describe('column details cap', () => {
    it(`stops before the details pass ${MAX_COLUMN_DETAILS_BYTES} bytes`, () => {
        // Each entry is {"label":"x…"}: the label and 12 bytes, and a comma before all but the first.
        const label = 'x'.repeat(1_000);
        const entry = 1_012;
        const fit = Math.floor((MAX_COLUMN_DETAILS_BYTES - 2 + 1) / (entry + 1));
        const built: number[] = [];
        const details = capped_column_details(2_000, (column) => {
            built.push(column);
            return { label };
        })!;
        expect(details).toHaveLength(fit);
        expect(JSON.stringify(details).length).toBeLessThanOrEqual(MAX_COLUMN_DETAILS_BYTES);
        expect(JSON.stringify([...details, { label }]).length).toBeGreaterThan(MAX_COLUMN_DETAILS_BYTES);
        // Columns past the cap are not built.
        expect(built).toHaveLength(fit + 1);
    });

    it('counts UTF-8 bytes, keeps nulls between columns, and gives nothing when no column has details', () => {
        expect(capped_column_details(3, (column) => (column === 1 ? { label: 'é' } : null)))
            .toEqual([null, { label: 'é' }]);
        // {"label":"é"} is 13 characters and 14 bytes.
        expect(capped_column_details(2, () => ({ label: 'é' }), 2 + 14 + 1 + 13)).toHaveLength(1);
        expect(capped_column_details(2, () => ({ label: 'é' }), 2 + 14 + 1 + 14)).toHaveLength(2);
        expect(capped_column_details(3, () => null)).toBeUndefined();
    });

    it('gives a Parquet file\'s columns past 1 MiB of details none', async () => {
        const source = await ParquetDataSource.create(writeParquet({
            // 250 columns: the buffered source's limit is 256.
            variables: Array.from({ length: 250 }, (_, k) => ({
                name: `v${k}`, type: 'double', label: 'x'.repeat(5_000), values: [k],
            })),
        }));
        try {
            const details = details_of(source)!;
            expect(details.length).toBeGreaterThan(150);
            expect(details.length).toBeLessThan(250);
            expect(JSON.stringify(details).length).toBeLessThanOrEqual(MAX_COLUMN_DETAILS_BYTES);
            expect(details[details.length - 1]).toMatchObject({ label: 'x'.repeat(5_000) });
            // The cells and the column names are not capped.
            expect(source.meta().sheets[0].columnNames).toHaveLength(250);
            expect(source.read_rows(0, 0, 1).rows[0][249]?.raw).toBe('249');
        } finally {
            source.close();
        }
    });
});

describe('header tooltip text', () => {
    it('shows the label, type, value label set, and statistics, one per line', () => {
        const text = header_tooltip_text(0, false, {
            label: 'Did you answer?',
            type: 'byte, %8.0g; Parquet DOUBLE; snappy',
            valueLabels: 'yesno',
            statistics: '1 null; between No and Yes',
        });
        expect(text).toBe([
            'Did you answer?',
            'byte, %8.0g; Parquet DOUBLE; snappy',
            'Value labels: yesno',
            '1 null; between No and Yes',
        ].join('\n'));
        expect(header_tooltip_text(0, false, { type: 'double, %10.0g' })).toBe('double, %10.0g');
    });

    it('keeps the Excel column of a promoted header, and shows nothing without details', () => {
        expect(header_tooltip_text(2, true, undefined)).toBe('Excel column C');
        expect(header_tooltip_text(2, true, { type: 'double' })).toBe('Excel column C\ndouble');
        expect(header_tooltip_text(2, false, undefined)).toBeNull();
        expect(header_tooltip_text(2, false, null)).toBeNull();
        expect(header_tooltip_text(2, false, {})).toBeNull();
    });

    it('sizes a multi-line tooltip by its longest line and its line count', () => {
        expect(header_tooltip_size('Excel column C')).toEqual({ width: 98, height: 28 });
        expect(header_tooltip_size('a\nbyte, %8.0g\nValue labels: yesno')).toEqual({ width: 133, height: 60 });
        expect(header_tooltip_size(`x\n${'y'.repeat(200)}`)).toEqual({ width: 480, height: 44 });
        expect(header_tooltip_size('a')).toEqual({ width: 80, height: 28 });
    });
});
