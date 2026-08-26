import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DtaDataSource } from '../data-source/dta-source';
import { FileDtaDataSource } from '../data-source/file-dta-source';

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
