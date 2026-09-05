import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArrowBuffer, type ArrowVariable } from '@jbearak/dta-parser';
import { ArrowDataSource } from '../data-source/arrow-source';
import { format_arrow_value, raw_arrow_cell } from '../data-source/arrow-format';
import { cells_exactly_equal } from '../cell-display';
import { compare_cells } from '../table-transform';

const fixture = (name: string) => new Uint8Array(readFileSync(
    join(__dirname, 'fixtures/arrow', `${name}.arrow`),
));
const rendered = (raw: string) => ({
    raw,
    rawType: 'number' as const,
    formatted: raw,
    bold: false,
    italic: false,
});

describe('Arrow source', () => {
    for (const codec of ['none', 'lz4', 'zstd']) {
        it(`reads exact values and temporal formatting, ${codec}`, async () => {
            const source = await ArrowDataSource.create(fixture(`plain-${codec}`));
            expect(source.meta().sheets[0]).toMatchObject({
                name: 'Sheet1',
                unnamedSingleSheet: true,
                rowCount: 4,
                columnCount: 26,
            });
            const rows = source.read_rows(0, 0, 4).rows;
            expect(rows[0][0]).toMatchObject({ raw: 'true', rawType: 'boolean' });
            expect(rows[1][0]).toMatchObject({ raw: null, formatted: '' });
            expect(rows[2][4]?.raw).toBe('9223372036854775807');
            expect(rows[3][4]?.raw).toBe('9007199254740993');
            expect(rows[2][8]?.raw).toBe('18446744073709551615');
            expect(rows[2][9]?.raw).toBe('NaN');
            expect(rows[0][10]?.raw).toBe('-0');
            expect(rows[0][11]?.formatted).toBe('café');
            expect(rows[0][13]?.formatted).toBe('1969-12-31');
            expect(rows[0][14]?.formatted).toBe('1969-12-31T23:59:59');
            expect(rows[0][15]?.formatted).toBe('1969-12-31T23:59:59.999Z [America/New_York]');
            expect(rows[3][17]?.formatted).toBe('2023-11-14T22:13:20.000000001');
            expect(rows[3][21]?.formatted).toBe('60000000001 nanosecond');
            expect(rows[0][22]).toMatchObject({ raw: '1', formatted: 'high', rawType: 'number' });
            expect(source.column_filter_metadata(0, 22)?.valueLabel?.('2')).toBe('unused');
            expect(source.column_filter_metadata(0, 22)?.categoricalCodes).toBe(true);
            expect(source.column_filter_metadata(0, 22)?.valueLabel?.('9007199254740993')).toBeUndefined();
            expect(() => JSON.stringify(rows)).not.toThrow();
            source.close();
        });
        it(`preserves profiled labels, missing codes and temporal fallbacks, ${codec}`, async () => {
            const source = await ArrowDataSource.create(fixture(`profile-${codec}`));
            const rows = source.read_rows(0, 0, 28).rows;
            expect(rows[0][0]).toMatchObject({ raw: '1', formatted: 'yes' });
            for (let column = 0; column < 5; column++) {
                expect(rows[1][column]?.raw).toBe('.');
                expect(rows[2][column]?.raw).toBe('.a');
                expect(rows[27][column]?.raw).toBe('.z');
            }
            expect(rows[0][5]).toMatchObject({ raw: '1.25', formatted: '1.25 days since 1970-01-01' });
            expect(rows[0][6]?.formatted).toBe('1.0000000001 secs since 1970-01-01T00:00:00Z [UTC]');
            expect(rows[0][7]?.formatted).toBe('2.5 hours');
            expect(rows[0][8]?.formatted).toBe('café');
            expect(rows[0][9]).toMatchObject({ raw: '0', formatted: 'low' });
            expect(source.column_filter_metadata(0, 0)?.valueLabel?.('1')).toBe('yes');
            source.close();
        });
    }
    it('preserves requested projection/index order and duplicates', async () => {
        const source = await ArrowDataSource.create(fixture('plain-zstd'));
        const full = source.read_rows(0, 0, 4).rows;
        expect(source.read_columns(0, 2, 20, [8, 4, 8]).rows).toEqual(full.slice(2).map(row => [row[8], row[4], row[8]]));
        expect(source.read_rows_indexed(0, [3, 0, 3]).rows).toEqual([full[3], full[0], full[3]]);
        expect(source.read_columns(0, 0, 2, []).rows).toEqual([[], []]);
        expect(source.read_rows(0, 100, 2)).toEqual({ startRow: 4, rows: [] });
        const raw = source.read_raw_columns(0, 0, 1, [4]);
        expect(raw.rows[0][0]).toEqual({ raw: '-9223372036854775808', rawType: 'number' });
        const indexed = await source.read_raw_columns_indexed_async(0, [3, 0], [8, 4], () => false);
        expect(indexed.rows.map(row => row.map(cell => cell?.raw))).toEqual([
            ['9007199254740993', '9007199254740993'],
            ['0', '-9223372036854775808'],
        ]);
        source.close();
    });

    it('uses public parser projections without decoding unselected gaps', async () => {
        const spy = vi.spyOn(ArrowBuffer.prototype, 'read_rows');
        try {
            const source = await ArrowDataSource.create(fixture('plain-none'));
            source.read_raw_columns(0, 0, 1, [8, 4]);
            expect(spy.mock.calls.map(args => args.slice(2, 4))).toEqual([[4, 5], [8, 9]]);
            source.read_raw_columns(0, 1, 1, [4, 8]);
            expect(spy).toHaveBeenCalledTimes(2);
            source.close();
        }
        finally {
            spy.mockRestore();
        }
    });

    it('handles dictionary deltas and empty data', async () => {
        const source = await ArrowDataSource.create(fixture('dictionary-delta'));
        expect(source.read_rows(0, 0, 3).rows.map(row => row[0]?.formatted)).toEqual(['a', 'b', 'a']);
        const empty = await ArrowDataSource.create(fixture('empty'));
        expect(empty.meta().sheets[0].rowCount).toBe(0);
        expect(empty.read_rows(0, 0, 1).rows).toEqual([]);
        source.close();
        empty.close();
    });

    it('keeps exact comparisons while separating otherwise ambiguous raw strings', () => {
        const pairs = [
            [raw_arrow_cell(null), raw_arrow_cell('')],
            [raw_arrow_cell(NaN), raw_arrow_cell('NaN')],
            [raw_arrow_cell({ kind: 'missing', missing_type: '.a' }), raw_arrow_cell('.a')],
            [raw_arrow_cell(0, 'first'), raw_arrow_cell(0, 'different')],
        ] as const;
        for (const [a, b] of pairs) {
            expect(cells_exactly_equal(a, b, () => false)).toBe(false);
        }
        expect(cells_exactly_equal(raw_arrow_cell(123n), { raw: '123' }, () => false)).toBe(true);
        expect(compare_cells(rendered('9007199254740993'), rendered('9007199254740992'), 'asc')).toBe(1);
        expect(compare_cells(rendered('-9223372036854775808'), rendered('-9223372036854775807'), 'asc')).toBe(-1);
    });

    it('rejects malformed input, invalid indices and use after close', async () => {
        await expect(ArrowDataSource.create(new Uint8Array(20))).rejects.toThrow();
        const source = await ArrowDataSource.create(fixture('plain-none'));
        expect(() => source.read_rows(1, 0, 1)).toThrow();
        expect(() => source.read_rows(0, NaN, 1)).toThrow();
        expect(() => source.read_rows(0, 0, -1)).toThrow();
        expect(() => source.read_columns(0, 0, 1, [26])).toThrow();
        expect(() => source.read_rows_indexed(0, [4])).toThrow();
        source.close();
        source.close();
        expect(() => source.read_rows(0, 0, 1)).toThrow('closed');
        expect(() => source.meta()).toThrow('closed');
    });

    it('checks cancellation and close between asynchronous chunks', async () => {
        const source = await ArrowDataSource.create(fixture('profile-none'));
        await expect(source.read_raw_columns_async(0, 0, 28, [0], () => true)).rejects.toMatchObject({ name: 'AbortError' });
        let cancelled = false;
        const result = source.read_raw_columns_async(0, 0, 28, [0], () => cancelled);
        cancelled = true;
        await expect(result).rejects.toMatchObject({ name: 'AbortError' });
        const closing = source.read_raw_columns_async(0, 0, 28, [0], () => false);
        source.close();
        await expect(closing).rejects.toThrow('closed');
    });

    it('verifies selected data checksums with parser defaults', async () => {
        const bytes = fixture('profile-none');
        const missingBytes = Buffer.from([1, ...Array.from({ length: 27 }, (_, i) => 101 + i)]);
        const offset = Buffer.from(bytes).indexOf(missingBytes);
        expect(offset).toBeGreaterThan(0);
        bytes[offset] ^= 1;
        const source = await ArrowDataSource.create(bytes);
        expect(() => source.read_columns(0, 0, 1, [1])).not.toThrow();
        expect(() => source.read_columns(0, 0, 1, [0])).toThrow(/checksum/i);
        source.close();
    });

    it('includes temporal units in comparison identity', async () => {
        const source = await ArrowDataSource.create(fixture('plain-none'));
        const rows = source.read_rows(0, 0, 1).rows;
        // Both stored ticks are -1, but their units describe different instants.
        expect(rows[0][14]?.raw).toBe('-1');
        expect(rows[0][15]?.raw).toBe('-1');
        expect(cells_exactly_equal(rows[0][14], rows[0][15], () => false)).toBe(false);
        source.close();
    });

    it('rejects excessive metadata dimensions before any row read', async () => {
        const rowSpy = vi.spyOn(ArrowBuffer.prototype, 'read_rows');
        const countSpy = vi.spyOn(ArrowBuffer.prototype, 'nobs', 'get').mockReturnValue(1000001);
        try {
            await expect(ArrowDataSource.create(fixture('empty'))).rejects.toThrow('too many rows');
            expect(rowSpy).not.toHaveBeenCalled();
        }
        finally {
            rowSpy.mockRestore();
            countSpy.mockRestore();
        }
    });

    it('bounds aggregate dictionary retention without caching a rejected entry', async () => {
        const source = await ArrowDataSource.create(fixture('plain-none'));
        const dictionary = vi.spyOn(ArrowBuffer.prototype, 'get_dictionary')
            .mockReturnValue({ ordered: false, levels: ['x'.repeat(8 * 1024 * 1024)] });
        try {
            expect(source.column_filter_metadata(0, 22)?.categoricalCodes).toBe(true);
            expect(() => source.column_filter_metadata(0, 23)).toThrow('32 MiB');
            expect(() => source.column_filter_metadata(0, 23)).toThrow('32 MiB');
            expect(dictionary).toHaveBeenCalledTimes(3);
            expect(source.column_filter_metadata(0, 22)?.categoricalCodes).toBe(true);
            expect(dictionary).toHaveBeenCalledTimes(3);
        } finally {
            source.close();
            source.close();
            dictionary.mockRestore();
        }
    });

    it('rejects an individual oversized dictionary before publishing its cache', async () => {
        const source = await ArrowDataSource.create(fixture('plain-none'));
        const dictionary = vi.spyOn(ArrowBuffer.prototype, 'get_dictionary')
            .mockReturnValue({ ordered: false, levels: ['x'.repeat(17 * 1024 * 1024)] });
        try {
            expect(() => source.column_filter_metadata(0, 22)).toThrow('32 MiB');
            expect(() => source.column_filter_metadata(0, 22)).toThrow('32 MiB');
            expect(dictionary).toHaveBeenCalledTimes(2);
        } finally {
            source.close();
            dictionary.mockRestore();
        }
    });

    it('shares value-label maps and counts unique tables against the metadata budget', async () => {
        const metadata = ArrowBuffer.open(fixture('plain-none')).metadata;
        const entries = [{ value: 1, label: 'x'.repeat(8 * 1024 * 1024) }];
        metadata.dataset = {
            version: 0, label: '', notes: [], characteristics: [],
            value_labels: { shared: entries, other: entries },
        };
        for (const variable of metadata.variables) {
            variable.profile = {
                version: 0, label: '', format: '', notes: [], characteristics: [],
                value_labels: 'shared',
            };
        }
        const snapshot = vi.spyOn(ArrowBuffer.prototype, 'metadata', 'get')
            .mockReturnValue(metadata);
        try {
            // Every column references the same 16 MiB decoded label map.
            const source = await ArrowDataSource.create(fixture('plain-none'));
            expect(source.column_filter_metadata(0, 0)?.categoricalCodes).toBe(true);
            metadata.variables[1].profile!.value_labels = 'other';
            await expect(ArrowDataSource.create(fixture('plain-none')))
                .rejects.toThrow('32 MiB');
            source.close();
        } finally {
            snapshot.mockRestore();
        }
    });

    it('falls back to exact ticks beyond the JavaScript Date range', () => {
        const variable: ArrowVariable = {
            name: 't',
            type: 'timestamp',
            nullable: true,
            unit: 'second',
            epoch: '1970-01-01',
            custom_metadata: new Map(),
        };
        expect(format_arrow_value(
            9223372036854775807n, variable, '9223372036854775807',
        )).toBe('9223372036854775807 second since 1970-01-01');
    });
});
