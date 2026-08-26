import * as fs from 'node:fs';
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
});
