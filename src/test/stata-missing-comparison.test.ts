import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDta } from '@jbearak/dta-parser';
import { cells_exactly_equal, materialize_cell_comparison_text } from '../cell-display';
import { DtaDataSource, stata_observation_bytes } from '../data-source/dta-source';
import { FileDtaDataSource } from '../data-source/file-dta-source';

describe('Stata missing comparison across sources', () => {
    it('shares all 27 missing identities across buffered and file-backed DTA', async () => {
        // missing-values.dta is tests/fixtures/dta/missing_values.dta from dta-tools
        // commit 75bf5ec88c6e6fde090f07a8684f9916ff48e34c, unchanged.
        const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures/missing-values.dta')));
        const reader = openDta(bytes);
        const variables = reader.variables;
        const nobs = reader.info.nobs;
        reader.close();
        const column = variables.findIndex(variable => variable.type === 'byte');
        expect(column).toBeGreaterThanOrEqual(0);
        expect(nobs).toBeGreaterThanOrEqual(27);
        // Expand the fixture's sampled missings to every code in its byte column.
        const obs_length = stata_observation_bytes(variables);
        const byte_offset = stata_observation_bytes(variables.slice(0, column));
        const data = Buffer.from(bytes).indexOf('<data>') + '<data>'.length;
        for (let i = 0; i < 27; i++) {
            bytes[data + i * obs_length + byte_offset] = 101 + i;
        }
        const directory = mkdtempSync(join(tmpdir(), 'table-viewer-stata-missing-'));
        const file = join(directory, 'all-missing.dta');
        writeFileSync(file, bytes);
        const buffered = await DtaDataSource.create(bytes);
        const disk = await FileDtaDataSource.open(file);
        try {
            const dtaRows = buffered.read_columns(0, 0, 27, [column]).rows;
            const diskRows = disk.read_columns(0, 0, 27, [column]).rows;
            const dtaRaw = buffered.read_raw_columns(0, 0, 27, [column]).rows;
            const diskRaw = disk.read_raw_columns(0, 0, 27, [column]).rows;
            for (let i = 0; i < 27; i++) {
                const code = i === 0 ? '.' : `.${String.fromCharCode(96 + i)}`;
                const expected = { raw: code, rawType: 'number', comparisonKey: `stata:missing:${code}` };
                for (const rows of [dtaRows, diskRows, dtaRaw, diskRaw]) {
                    const cell = rows[i][0];
                    expect(cell).toMatchObject(expected);
                    expect(await cells_exactly_equal(cell, diskRows[i][0], () => false)).toBe(true);
                    expect(await materialize_cell_comparison_text(cell, () => false))
                        .toBe(`comparison:stata:missing:${code}`);
                    expect(await cells_exactly_equal(cell, dtaRows[(i + 1) % 27][0], () => false)).toBe(false);
                    expect(await cells_exactly_equal(cell, { raw: code, rawType: 'string' }, () => false)).toBe(false);
                    expect(cell?.filterKey).toBeUndefined();
                }
            }
        } finally {
            buffered.close();
            disk.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
