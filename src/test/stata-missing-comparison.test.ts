import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse_metadata } from '@jbearak/dta-parser';
import { cells_exactly_equal, materialize_cell_comparison_text } from '../cell-display';
import { ArrowDataSource } from '../data-source/arrow-source';
import { DtaDataSource } from '../data-source/dta-source';
import { FileDtaDataSource } from '../data-source/file-dta-source';

describe('Stata missing comparison across file formats', () => {
    it('shares all 27 missing identities across buffered DTA, file-backed DTA, and profiled Arrow', async () => {
        const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures/arrow/missing-values.dta')));
        const metadata = parse_metadata(bytes.buffer);
        const column = metadata.variables.findIndex(variable => variable.type === 'byte');
        expect(column).toBeGreaterThanOrEqual(0);
        expect(metadata.nobs).toBeGreaterThanOrEqual(27);
        // Expand the fixture's sampled missings to every code in its byte column.
        const data = metadata.section_offsets.data + '<data>'.length;
        for (let i = 0; i < 27; i++) {
            bytes[data + i * metadata.obs_length + metadata.variables[column].byte_offset] = 101 + i;
        }
        const directory = mkdtempSync(join(tmpdir(), 'table-viewer-stata-missing-'));
        const file = join(directory, 'all-missing.dta');
        writeFileSync(file, bytes);
        const buffered = await DtaDataSource.create(bytes);
        const disk = await FileDtaDataSource.open(file);
        const arrow = await ArrowDataSource.create(readFileSync(join(__dirname, 'fixtures/arrow/profile-none.arrow')));
        try {
            const dtaRows = buffered.read_columns(0, 0, 27, [column]).rows;
            const diskRows = disk.read_columns(0, 0, 27, [column]).rows;
            const arrowRows = arrow.read_columns(0, 1, 27, [0]).rows;
            const dtaRaw = buffered.read_raw_columns(0, 0, 27, [column]).rows;
            const diskRaw = disk.read_raw_columns(0, 0, 27, [column]).rows;
            const arrowRaw = arrow.read_raw_columns(0, 1, 27, [0]).rows;
            for (let i = 0; i < 27; i++) {
                const code = i === 0 ? '.' : `.${String.fromCharCode(96 + i)}`;
                const expected = { raw: code, rawType: 'number', comparisonKey: `stata:missing:${code}` };
                for (const rows of [dtaRows, diskRows, arrowRows, dtaRaw, diskRaw, arrowRaw]) {
                    const cell = rows[i][0];
                    expect(cell).toMatchObject(expected);
                    expect(await cells_exactly_equal(cell, arrowRows[i][0], () => false)).toBe(true);
                    expect(await materialize_cell_comparison_text(cell, () => false))
                        .toBe(`comparison:stata:missing:${code}`);
                    expect(await cells_exactly_equal(cell, arrowRows[(i + 1) % 27][0], () => false)).toBe(false);
                    expect(await cells_exactly_equal(cell, { raw: code, rawType: 'string' }, () => false)).toBe(false);
                    expect(cell?.filterKey).toBeUndefined();
                }
            }
        } finally {
            buffered.close();
            disk.close();
            arrow.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
