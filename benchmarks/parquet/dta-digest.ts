// The .dta page benchmark and rendered-cell digest from #309, run before and
// after a change to the Stata sources to show that cells and speed did not
// change. Bundle with esbuild (--bundle --platform=node --packages=external)
// and run with node: dta-digest.js <fixtures dir> <long.dta> <wide.dta>.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DtaDataSource } from '../../src/data-source/dta-source';
import { FileDtaDataSource } from '../../src/data-source/file-dta-source';
import type { RenderedCell } from '../../src/data-source/interface';

const cell = (c: RenderedCell | null) => c === null
    ? null
    : [c.raw, c.formatted, c.rawType, c.comparisonKey ?? null, c.rawByteLength ?? null];

async function main(): Promise<void> {
    const [fixtures, ...large] = process.argv.slice(2);
    const out: string[] = [];
    for (const name of ['all_types_v118.dta', 'missing-values.dta']) {
        const file = join(fixtures, name);
        const buffered = await DtaDataSource.create(new Uint8Array(readFileSync(file)));
        const rows = buffered.meta().sheets[0].rowCount;
        const digest = (rendered: (RenderedCell | null)[][]) => createHash('sha256')
            .update(JSON.stringify(rendered.map((row) => row.map(cell)))).digest('hex');
        out.push(`${name} buffered ${digest(buffered.read_rows(0, 0, rows).rows)}`);
        buffered.close();
        const disk = await FileDtaDataSource.open(file);
        out.push(`${name} file ${digest(disk.read_rows(0, 0, rows).rows)}`);
        disk.close();
    }
    for (const file of large) {
        const source = await FileDtaDataSource.open(file);
        const rows = source.meta().sheets[0].rowCount;
        let seed = 99;
        const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        const hash = createHash('sha256');
        const times: number[] = [];
        for (let page = 0; page < 200; page++) {
            const start = Math.floor(random() * (rows - 256));
            const began = performance.now();
            const window = source.read_rows(0, start, 256);
            times.push(performance.now() - began);
            hash.update(JSON.stringify(window.rows.map((row) => row.map(cell))));
        }
        times.sort((a, b) => a - b);
        out.push(`${file.split('/').pop()} 200 pages ${hash.digest('hex')}`
            + ` median ${times[100].toFixed(2)} ms p95 ${times[190].toFixed(2)} ms`);
        source.close();
    }
    console.log(out.join('\n'));
}

void main();
