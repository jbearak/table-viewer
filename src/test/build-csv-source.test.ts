import { describe, expect, it, vi } from 'vitest';
import { CsvDataSource } from '../data-source/csv-source';
import { build_csv_source } from '../viewer-controller';

const enc = new TextEncoder();
const csv = enc.encode('h\na\nb\nc\n');

describe('build_csv_source max-row normalization', () => {
    it('uses a hostile ConfigPort value safely (NaN falls back to the cap)', async () => {
        const source = await build_csv_source(csv, '/tmp/rows.csv', Number.NaN);
        expect(source.meta().sheets[0].rowCount).toBe(3);
        source.close();
    });

    it('floors fractional values instead of forwarding them as array lengths', async () => {
        const source = await build_csv_source(csv, '/tmp/rows.csv', 2.7);
        expect(source.meta().sheets[0].rowCount).toBe(2);
        source.close();
    });

    it('respects a configured limit above the historical default', async () => {
        const create = vi.spyOn(CsvDataSource, 'create')
            .mockResolvedValue({} as CsvDataSource);
        try {
            await build_csv_source(csv, '/tmp/rows.csv', 1_250_000);

            expect(create).toHaveBeenCalledWith(
                csv,
                ',',
                1_250_000,
                { firstRowIsHeader: true },
            );
        } finally {
            create.mockRestore();
        }
    });

    it('clamps negative and infinite values to the safe range', async () => {
        const negative = await build_csv_source(csv, '/tmp/rows.csv', -5);
        expect(negative.meta().sheets[0].rowCount).toBe(0);
        negative.close();

        const infinite = await build_csv_source(csv, '/tmp/rows.csv', Infinity);
        expect(infinite.meta().sheets[0].rowCount).toBe(3);
        infinite.close();
    });

    it('forwards an unlimited row count for an explicit per-view override', async () => {
        const create = vi.spyOn(CsvDataSource, 'create')
            .mockResolvedValue({} as CsvDataSource);
        try {
            await build_csv_source(
                csv,
                '/tmp/rows.csv',
                2,
                { loadAllRows: true },
            );

            expect(create).toHaveBeenCalledWith(
                csv,
                ',',
                Number.MAX_SAFE_INTEGER,
                { firstRowIsHeader: true },
            );
        } finally {
            create.mockRestore();
        }
    });
});
