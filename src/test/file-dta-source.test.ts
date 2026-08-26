import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DtaDataSource } from '../data-source/dta-source';
import {
    FileDtaDataSource,
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

    it('rejects an oversized strL file before the parser can load its strL section', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-file-dta-'));
        const sparse = path.join(directory, 'oversized-strl.dta');
        try {
            fs.copyFileSync(fixture, sparse);
            fs.truncateSync(sparse, 2 * 1024 * 1024 * 1024);

            await expect(FileDtaDataSource.open_observed(sparse)).rejects.toThrow(
                /larger than 2 GiB.*strL variables/u,
            );
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
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
