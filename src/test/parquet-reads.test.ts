import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ParquetReader,
    openParquet,
    writeParquet,
    type ReadRange,
} from '@jbearak/dta-parser';
import { FileParquetDataSource } from '../data-source/file-parquet-source';
import { DEFERRED_COMPARISON_IDENTITY, type RawCell, type RenderedCell } from '../data-source/interface';
import { ParquetDataSource } from '../data-source/parquet-source';

const FIXTURES = path.join(__dirname, 'fixtures', 'parquet');

afterEach(() => {
    vi.restoreAllMocks();
});

interface ColumnsCall { columns: number[]; start: number; count: number }

function spy_read_columns(): ColumnsCall[] {
    const calls: ColumnsCall[] = [];
    const original = ParquetReader.prototype.readColumns;
    vi.spyOn(ParquetReader.prototype, 'readColumns').mockImplementation(function (
        this: ParquetReader,
        columns: readonly (number | string)[],
        range?: ReadRange,
    ) {
        calls.push({ columns: columns as number[], start: range!.start!, count: range!.count! });
        return original.call(this, columns, range);
    });
    return calls;
}

function spy_read_rows_at(): { rows: number[]; columns: number[] }[] {
    const calls: { rows: number[]; columns: number[] }[] = [];
    const original = ParquetReader.prototype.readRowsAt;
    vi.spyOn(ParquetReader.prototype, 'readRowsAt').mockImplementation(function (
        this: ParquetReader,
        rows: readonly number[],
        columns?: readonly (number | string)[],
    ) {
        calls.push({ rows: [...rows], columns: [...(columns ?? [])] as number[] });
        return original.call(this, rows, columns);
    });
    return calls;
}

function strip(rows: readonly (readonly (RawCell | RenderedCell | null)[])[]) {
    return rows.map((row) => row.map((cell) => cell && {
        raw: cell.raw, rawType: cell.rawType, comparisonKey: cell.comparisonKey,
        ...('formatted' in cell ? { formatted: cell.formatted } : {}),
    }));
}

const ROWS = 4096;
const RUN_START = 1024;
const RUN_END = 1280;
const LARGE_BYTES = 200_000;

function note(row: number): string {
    return row >= RUN_START && row < RUN_END
        ? `${'x'.repeat(LARGE_BYTES)}${row}`
        : `short ${row}`;
}

/**
 * Short strings with one 256-row run of 200 KB strings in a row group of its
 * own, beside a number column. `rowGroupSize` applies to the whole file.
 */
function skewed_bytes(): Uint8Array {
    return writeParquet({
        variables: [
            { name: 'n', type: 'double', values: Array.from({ length: ROWS }, (_, row) => row * 0.5) },
            { name: 'note', type: 'string', values: Array.from({ length: ROWS }, (_, row) => note(row)) },
        ],
    }, { rowGroupSize: 256 });
}

function expected_raw(row: number): [string, string] {
    return [String(row * 0.5), note(row)];
}

interface BlockState { block?: { start: number; count: number }; oversized_block?: number }

describe('Parquet block cache and bounded reads', () => {
    it('reads text whose chunks store every value in plain encodings within the block bound', () => {
        const reader = openParquet(skewed_bytes());
        try {
            // The bound rules under test apply only if the text is stored plainly.
            for (const chunk of reader.variables[1].chunks) {
                expect(chunk!.encodings).not.toContain('RLE_DICTIONARY');
                expect(chunk!.encodings).not.toContain('PLAIN_DICTIONARY');
                expect(chunk!.dictionaryPageBytes).toBeNull();
            }
        } finally {
            reader.close();
        }
    });

    it('does not keep a block whose text passes the budget, and reads its later windows alone', async () => {
        const source = await ParquetDataSource.create(skewed_bytes());
        const state = source as unknown as BlockState;
        try {
            const block_rows = source.block_rows;
            expect(block_rows % 256).toBe(0);
            const run_block = Math.floor(RUN_START / block_rows) * block_rows;
            const calls = spy_read_columns();

            const first = source.read_raw_columns(0, RUN_START, 256, [0, 1]).rows;
            expect(first.map((row) => row.map((cell) => cell!.raw)))
                .toEqual(Array.from({ length: 256 }, (_, i) => expected_raw(RUN_START + i)));
            const rendered = source.read_rows(0, RUN_START, 256).rows;
            expect(rendered.map((row) => row.map((cell) => cell!.raw)))
                .toEqual(Array.from({ length: 256 }, (_, i) => expected_raw(RUN_START + i)));
            expect(state.block).toBeUndefined();
            expect(state.oversized_block).toBe(run_block);
            // Rendered windows over the run read only the window's rows.
            const rendered_calls = calls.splice(0);
            expect(rendered_calls.filter((call) => call.count > 256)).toEqual([]);

            // A later window in the same block reads only its own rows.
            const later = run_block === RUN_START ? RUN_START + 256 : run_block;
            const window = source.read_rows(0, later, 256).rows;
            expect(window.map((row) => row.map((cell) => cell!.raw)))
                .toEqual(Array.from({ length: 256 }, (_, i) => expected_raw(later + i)));
            expect(calls.length).toBeGreaterThan(0);
            for (const call of calls.splice(0)) {
                expect(call).toMatchObject({ start: later, count: 256 });
            }

            // A block clear of the run is kept and read once for its windows.
            const clear = Math.ceil(RUN_END / block_rows) * block_rows;
            source.read_rows(0, clear, 256);
            expect(state.block).toMatchObject({ start: clear });
            expect(calls.every((call) => call.start === clear && call.count === Math.min(block_rows, ROWS - clear)))
                .toBe(true);
            calls.splice(0);
            const next = source.read_rows(0, clear + 256, 256).rows;
            expect(calls).toEqual([]);
            expect(next.map((row) => row.map((cell) => cell!.raw)))
                .toEqual(Array.from({ length: 256 }, (_, i) => expected_raw(clear + 256 + i)));
        } finally {
            source.close();
        }
    });

    it('gives every window the cells a sparse read of the same rows gives', async () => {
        const source = await ParquetDataSource.create(skewed_bytes());
        try {
            const windows: (RenderedCell | null)[][] = [];
            // Out of order, so blocks are evicted and decoded again.
            for (const start of [3840, 0, 2048, 1024, 256, 3584, 1280, 512, 768, 1536, 1792, 2304, 2560, 2816, 3072, 3328]) {
                const rows = source.read_rows(0, start, 256).rows;
                rows.forEach((row, i) => { windows[start + i] = row; });
            }
            const sparse = source.read_rows_indexed(0, Array.from({ length: ROWS }, (_, row) => row)).rows;
            expect(strip(windows)).toEqual(strip(sparse));
            expect(windows.map((row) => row.map((cell) => cell!.raw)))
                .toEqual(Array.from({ length: ROWS }, (_, row) => expected_raw(row)));
        } finally {
            source.close();
        }
    });

    it('reads the large column alone, 256 rows at a time, when a scan crosses the run', async () => {
        const source = await ParquetDataSource.create(skewed_bytes());
        try {
            const calls = spy_read_columns();
            const scanned = await source.read_raw_columns_async(0, 0, ROWS, [0, 1], () => false);
            expect(scanned.rows.map((row) => row.map((cell) => cell!.raw)))
                .toEqual(Array.from({ length: ROWS }, (_, row) => expected_raw(row)));
            const over_run = calls.filter((call) =>
                call.columns.includes(1) && call.start < RUN_END && call.start + call.count > RUN_START);
            expect(over_run.length).toBeGreaterThan(0);
            for (const call of over_run) {
                expect(call.columns).toEqual([1]);
                expect(call.count).toBeLessThanOrEqual(256);
            }
            // The number column is read in one batch for the whole chunk.
            expect(calls).toContainEqual({ columns: [0], start: 0, count: ROWS });
        } finally {
            source.close();
        }
    });

    it('reads every 3rd row in readRowsAt calls bounded by span and columns', async () => {
        const source = await ParquetDataSource.create(skewed_bytes());
        try {
            const rows = Array.from({ length: Math.ceil(ROWS / 3) }, (_, i) => i * 3);
            const calls = spy_read_rows_at();
            const sparse = await source.read_raw_columns_indexed_async(0, rows, [1, 0], () => false);
            expect(sparse.rows.map((row) => row.map((cell) => cell!.raw)))
                .toEqual(rows.map((row) => [note(row), String(row * 0.5)]));
            expect(calls.length).toBeGreaterThan(1);
            for (const call of calls) {
                const span = call.rows[call.rows.length - 1] - call.rows[0] + 1;
                expect(span).toBeLessThanOrEqual(source.block_rows);
                const touches_run = call.rows.some((row) => row >= RUN_START && row < RUN_END);
                if (call.columns.includes(1) && touches_run) {
                    expect(call.columns).toEqual([1]);
                    expect(span).toBeLessThanOrEqual(256);
                }
            }
            expect(calls.some((call) => call.columns.length === 2)).toBe(true);
        } finally {
            source.close();
        }
    });

    it('reads a dictionary-encoded binary column alone for each window and keeps the block', async () => {
        const large = new Uint8Array(100_000).fill(0x5a);
        const bytes = writeParquet({
            variables: [
                { name: 'n', type: 'long', values: Array.from({ length: 1024 }, (_, row) => row) },
                { name: 'blob', type: 'binary', values: Array.from({ length: 1024 }, () => large) },
            ],
        });
        const reader = openParquet(bytes);
        expect(reader.variables[1].chunks[0]!.encodings.some((encoding) => encoding.endsWith('DICTIONARY')))
            .toBe(true);
        reader.close();
        const source = await ParquetDataSource.create(bytes);
        const state = source as unknown as BlockState;
        try {
            expect(source.bound(1, 0, 256)).toBe(Number.POSITIVE_INFINITY);
            const calls = spy_read_columns();
            const first = source.read_rows(0, 256, 256).rows;
            expect(calls).toContainEqual({ columns: [1], start: 256, count: 256 });
            expect(calls).toContainEqual({ columns: [0], start: 0, count: 1024 });
            expect(state.block).toMatchObject({ start: 0 });
            calls.splice(0);
            source.read_rows(0, 512, 256);
            expect(calls).toEqual([{ columns: [1], start: 512, count: 256 }]);
            expect(first[0][1]!.raw).toBe(`binary (100000 bytes): ${'5a'.repeat(32)}…`);
            const key = (cell: RenderedCell | null) =>
                cell![DEFERRED_COMPARISON_IDENTITY]!.resolveKey(() => false);
            await expect(key(first[0][1])).resolves.toBe(await key(first[255][1]));
        } finally {
            source.close();
        }
    });

    it('reads a DELTA_BYTE_ARRAY text column alone for each window', async () => {
        const file = path.join(FIXTURES, 'pyarrow_delta.parquet');
        const source = await FileParquetDataSource.open(file);
        try {
            const names = source.meta().sheets[0].columnNames!;
            const word = names.indexOf('word');
            const reader = openParquet(new Uint8Array(fs.readFileSync(file)));
            expect(reader.variables[word].chunks[0]!.encodings).toContain('DELTA_BYTE_ARRAY');
            reader.close();
            expect(source.bound(word, 0, 256)).toBe(Number.POSITIVE_INFINITY);
            expect(Number.isFinite(source.bound(names.indexOf('unique'), 0, 256))).toBe(true);
            const calls = spy_read_columns();
            const rows = source.read_rows(0, 256, 256).rows;
            expect(calls).toContainEqual({ columns: [word], start: 256, count: 256 });
            expect(calls.filter((call) => call.columns.includes(word))).toHaveLength(1);
            expect(rows[0][word]!.raw).toMatch(/^word \d+ ü$/u);
        } finally {
            source.close();
        }
    });
});

describe('Parquet sparse reads', () => {
    async function mixed_source(): Promise<ParquetDataSource> {
        const rows = 3000;
        return ParquetDataSource.create(writeParquet({
            variables: [
                { name: 'id', type: 'long', values: Array.from({ length: rows }, (_, row) => row) },
                { name: 'name', type: 'string', values: Array.from({ length: rows }, (_, row) => row % 7 === 0 ? null : `name ${row % 50}`) },
                { name: 'big', type: 'int64', values: Array.from({ length: rows }, (_, row) => row % 5 === 0 ? null : 2n ** 60n + BigInt(row)) },
                { name: 'when', type: 'timestamp', unit: 'ms', timeZone: 'Europe/Paris', values: Array.from({ length: rows }, (_, row) => row * 3_600_000) },
            ],
        }, { rowGroupSize: 700 }));
    }

    it('gives sparse, repeated, and reordered rows and columns what contiguous reads give', async () => {
        const source = await mixed_source();
        try {
            const contiguous = source.read_rows(0, 0, 3000).rows;
            const raw = source.read_raw_columns(0, 0, 3000, [0, 1, 2, 3]).rows;
            const rows = [2999, 5, 5, 0, 1400, 701, 699, 2100, 3, 2999];
            expect(strip(source.read_rows_indexed(0, rows).rows))
                .toEqual(strip(rows.map((row) => contiguous[row])));
            expect(strip((await source.read_rows_indexed_async(0, rows, () => false)).rows))
                .toEqual(strip(rows.map((row) => contiguous[row])));
            const columns = [3, 1, 3, 0];
            const sparse = await source.read_raw_columns_indexed_async(0, rows, columns, () => false);
            expect(strip(sparse.rows)).toEqual(strip(rows.map((row) => columns.map((column) => raw[row][column]))));
            const projected = source.read_columns(0, 690, 20, columns).rows;
            expect(strip(projected)).toEqual(strip(contiguous.slice(690, 710).map((row) => columns.map((column) => row[column]))));
            const scan = await source.read_raw_columns_async(0, 10, 2900, columns, () => false);
            expect(strip(scan.rows)).toEqual(strip(raw.slice(10, 2910).map((row) => columns.map((column) => row[column]))));
        } finally {
            source.close();
        }
    });

    it('stops between chunks when cancelled', async () => {
        const source = await mixed_source();
        try {
            let checks = 0;
            const cancel_after_first_read = () => ++checks > 3;
            await expect(source.read_raw_columns_indexed_async(
                0, Array.from({ length: 1000 }, (_, i) => i * 3), [0, 1, 2, 3], cancel_after_first_read,
            )).rejects.toMatchObject({ name: 'AbortError', message: 'Parquet source read was cancelled.' });
            const long = await ParquetDataSource.create(writeParquet({
                variables: [{ name: 'x', values: Array.from({ length: 10_000 }, (_, row) => row) }],
            }));
            checks = 0;
            const reads = spy_read_columns();
            await expect(long.read_raw_columns_async(0, 0, 10_000, [0], cancel_after_first_read))
                .rejects.toMatchObject({ name: 'AbortError' });
            expect(reads).toEqual([{ columns: [0], start: 0, count: 4096 }]);
            long.close();
            checks = 0;
            await expect(source.read_rows_indexed_async(0, [0, 2000, 2999], cancel_after_first_read))
                .rejects.toMatchObject({ name: 'AbortError' });
        } finally {
            source.close();
        }
    });
});

describe('FileParquetDataSource', () => {
    it('hashes the descriptor it reads and detects a rewritten file', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-parquet-'));
        const file = path.join(directory, 'x.parquet');
        try {
            fs.writeFileSync(file, writeParquet({ variables: [{ name: 'x', values: [1, 2, 3] }] }));
            const observed = await FileParquetDataSource.open_observed(file);
            try {
                expect(observed.digest).toMatch(/^[0-9a-f]{64}$/u);
                expect(observed.size).toBe(fs.statSync(file).size);
                await expect(observed.source.physical_content_matches(observed.digest, () => false))
                    .resolves.toBe(true);
                const replacement = path.join(directory, 'y.parquet');
                fs.writeFileSync(replacement, writeParquet({ variables: [{ name: 'x', values: [1, 2, 4] }] }));
                fs.renameSync(replacement, file);
                await expect(observed.source.physical_content_matches(observed.digest, () => false))
                    .resolves.toBe(false);
            } finally {
                observed.source.close();
            }
            await expect(FileParquetDataSource.open_observed(file, true, () => true))
                .rejects.toMatchObject({ name: 'AbortError' });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('matches the buffered source', async () => {
        const file = path.join(FIXTURES, 'fastparquet_default.parquet');
        const disk = await FileParquetDataSource.open(file);
        const buffered = await ParquetDataSource.create(new Uint8Array(fs.readFileSync(file)));
        try {
            expect(disk.meta()).toEqual(buffered.meta());
            expect(strip(disk.read_rows(0, 0, 600).rows)).toEqual(strip(buffered.read_rows(0, 0, 600).rows));
        } finally {
            disk.close();
            buffered.close();
        }
    });
});
