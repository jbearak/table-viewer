import { describe, expect, it } from 'vitest';
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

    it('clamps negative and infinite values to the safe range', async () => {
        const negative = await build_csv_source(csv, '/tmp/rows.csv', -5);
        expect(negative.meta().sheets[0].rowCount).toBe(0);
        negative.close();

        const infinite = await build_csv_source(csv, '/tmp/rows.csv', Infinity);
        expect(infinite.meta().sheets[0].rowCount).toBe(3);
        infinite.close();
    });
});
