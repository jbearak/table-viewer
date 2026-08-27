import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DtaDataSource } from '../data-source/dta-source';
import {
    FileDtaDataSource,
    MAX_FILE_BACKED_DTA_ROWS,
    assert_file_backed_dta_layout,
    assert_file_backed_dta_row_size,
} from '../data-source/file-dta-source';
import { parse_metadata } from '@jbearak/dta-parser';

const fixture = path.join(__dirname, 'fixtures', 'all_types_v118.dta');

describe('FileDtaDataSource', () => {
    it('matches the buffer-backed source while reading rows on demand', async () => {
        const buffered = await DtaDataSource.create(fs.readFileSync(fixture));
        const file_backed = await FileDtaDataSource.open(fixture);
        try {
            expect(file_backed.meta()).toEqual(buffered.meta());
            expect(file_backed.read_rows(0, 0, 4)).toEqual(
                buffered.read_rows(0, 0, 4),
            );
            await expect(file_backed.read_raw_columns_async(
                0, 0, 4, [0, 2, 4], () => false,
            )).resolves.toEqual(await buffered.read_raw_columns_async(
                0, 0, 4, [0, 2, 4], () => false,
            ));
        } finally {
            file_backed.close();
            buffered.close();
        }
    });

    it('aborts an indexed read from the observable cancellation predicate', async () => {
        const source = await FileDtaDataSource.open(fixture);
        try {
            await expect(source.read_raw_columns_indexed_async(
                0, [0], [0], () => true,
            )).rejects.toMatchObject({ name: 'AbortError' });
        } finally {
            source.close();
        }
    });

    it('yields and observes cancellation during a large sparse indexed read', async () => {
        const source = await FileDtaDataSource.open(fixture);
        let cancelled = false;
        setImmediate(() => { cancelled = true; });
        try {
            await expect(source.read_raw_columns_indexed_async(
                0,
                new Array<number>(10_000).fill(0),
                [0, 2, 4, 6],
                () => cancelled,
            )).rejects.toMatchObject({ name: 'AbortError' });
        } finally {
            source.close();
        }
    });

    it('digests the same descriptor that backs the source', async () => {
        const observed = await FileDtaDataSource.open_observed(fixture);
        try {
            expect(observed.digest).toBe(
                createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'),
            );
            expect(observed.size).toBe(fs.statSync(fixture).size);
        } finally {
            observed.source.close();
        }
    });

    it('rechecks descriptor content instead of trusting an unchanged file stat', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-file-dta-'));
        const copy = path.join(directory, 'same-stat.dta');
        fs.copyFileSync(fixture, copy);
        const observed = await FileDtaDataSource.open_observed(copy);
        try {
            await expect(observed.source.physical_content_matches(
                observed.digest,
                () => false,
            )).resolves.toBe(true);
            const original_stat = fs.statSync(copy);
            const fd = fs.openSync(copy, 'r+');
            try {
                const tail = Buffer.allocUnsafe(1);
                fs.readSync(fd, tail, 0, 1, original_stat.size - 1);
                tail[0] ^= 1;
                fs.writeSync(fd, tail, 0, 1, original_stat.size - 1);
            } finally {
                fs.closeSync(fd);
            }
            fs.utimesSync(copy, original_stat.atime, original_stat.mtime);

            await expect(observed.source.physical_content_matches(
                observed.digest,
                () => false,
            )).resolves.toBe(false);
        } finally {
            observed.source.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('cancels an obsolete open before hashing the descriptor', async () => {
        await expect(FileDtaDataSource.open_observed(
            fixture,
            true,
            () => true,
        )).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects byte-heavy fixed-width observation layouts', () => {
        const metadata = parse_metadata(new Uint8Array(fs.readFileSync(fixture)).buffer);
        expect(() => assert_file_backed_dta_row_size({
            ...metadata,
            obs_length: 1024 * 1024 + 1,
        })).toThrow(/per-row safety limit/u);
    });

    it('rejects oversized strL layouts before the parser can load their strL section', () => {
        const metadata = parse_metadata(new Uint8Array(fs.readFileSync(fixture)).buffer);
        expect(() => assert_file_backed_dta_layout(
            metadata,
            2 * 1024 * 1024 * 1024,
        )).toThrow(/larger than 2 GiB.*strL variables/u);
    });

    it('fails clearly when the parser random-access interface is unavailable', () => {
        const UnsafeConstructor = FileDtaDataSource as unknown as new (
            file: unknown,
            file_path: string,
        ) => FileDtaDataSource;
        expect(() => new UnsafeConstructor({
            nobs: 0,
            nvar: 0,
            variables: [],
        }, fixture)).toThrow(/parser.*random-access file interface/u);
    });

    it('accepts paged datasets beyond the eager worksheet row budget', () => {
        const close = vi.fn();
        const decode_range = vi.fn((
            _data: Uint8Array,
            _start: number,
            _count: number,
            _column_start: number,
            _column_end: number,
            out: string[][],
        ) => { out[0] = ['tail']; });
        const UnsafeConstructor = FileDtaDataSource as unknown as new (
            file: unknown,
            file_path: string,
        ) => FileDtaDataSource;
        const source = new UnsafeConstructor({
            nobs: 1_274_250,
            nvar: 1,
            variables: [{ name: 'value' }],
            close,
            _fd: 1,
            _metadata: {
                format_version: 118,
                obs_length: 0,
                section_offsets: { data: 0 },
            },
            _decode_rows_range: decode_range,
        }, fixture);

        expect(source.meta().sheets[0].rowCount).toBe(1_274_250);
        expect(source.read_raw_columns(0, 1_274_249, 1, [0])).toMatchObject({
            startRow: 1_274_249,
            rows: [[{ raw: 'tail' }]],
        });
        expect(decode_range).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            1_274_249,
            1,
            0,
            1,
            expect.any(Array),
            0,
        );
        source.close();
        expect(close).toHaveBeenCalledOnce();
    });

    it('decodes large row ranges in bounded byte batches', () => {
        const observation_bytes = 4096;
        const count = 3000;
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-dta-batches-'));
        const data_file = path.join(directory, 'observations.dta');
        fs.writeFileSync(data_file, Buffer.alloc(count * observation_bytes + '<data>'.length));
        const fd = fs.openSync(data_file, 'r');
        const decode_range = vi.fn((
            data: Uint8Array,
            start: number,
            batch_count: number,
            _column_start: number,
            _column_end: number,
            out: string[][],
            out_offset: number,
        ) => {
            for (let index = 0; index < batch_count; index += 1) {
                out[out_offset + index] = [`${start + index}`];
            }
            expect(data.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
        });
        const UnsafeConstructor = FileDtaDataSource as unknown as new (
            file: unknown,
            file_path: string,
        ) => FileDtaDataSource;
        const source = new UnsafeConstructor({
            nobs: count,
            nvar: 1,
            variables: [{ name: 'value' }],
            close: () => fs.closeSync(fd),
            _fd: fd,
            _metadata: {
                format_version: 117,
                obs_length: observation_bytes,
                section_offsets: { data: 0 },
            },
            _decode_rows_range: decode_range,
        }, fixture);
        try {
            expect(source.read_raw_columns(0, 0, count, [0])).toMatchObject({
                rows: Array.from({ length: count }, (_, index) => [{ raw: `${index}` }]),
            });
            expect(decode_range).toHaveBeenCalledTimes(2);
            for (const [data] of decode_range.mock.calls) {
                expect((data as Uint8Array).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
            }
        } finally {
            source.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('bounds paged rows by whole-sheet rendering and transform work', () => {
        const UnsafeConstructor = FileDtaDataSource as unknown as new (
            file: unknown,
            file_path: string,
        ) => FileDtaDataSource;
        expect(() => new UnsafeConstructor({
            nobs: MAX_FILE_BACKED_DTA_ROWS + 1,
            nvar: 0,
            variables: [],
        }, fixture)).toThrow(/too many observations.*2,000,000/u);
    });

    it('preserves reordered and duplicate sparse column projections', async () => {
        const buffered = await DtaDataSource.create(fs.readFileSync(fixture));
        const file_backed = await FileDtaDataSource.open(fixture);
        try {
            const columns = [7, 0, 7, 3];
            await expect(file_backed.read_raw_columns_async(
                0, 0, 5, columns, () => false,
            )).resolves.toEqual(await buffered.read_raw_columns_async(
                0, 0, 5, columns, () => false,
            ));
        } finally {
            file_backed.close();
            buffered.close();
        }
    });
});
