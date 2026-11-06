import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build_source_from_buffer } from '../data-source/from-buffer';
import { get_delimiter } from '../host-ports';
import {
    parser_format_for,
    table_format_for,
    table_format_for_extension,
    TABLE_FILE_EXTENSION_PATTERN,
    TABLE_FORMATS,
} from '../table-format';
import { profile_for } from '../viewer-controller';

const FIXTURES = join(__dirname, 'fixtures');
const FIXTURE_FOR: Record<string, string> = {
    csv: 'basic.csv',
    tsv: 'basic.tsv',
    xlsx: 'basic.xlsx',
    xls: 'basic.xls',
    parquet: 'parquet/pyarrow_default.parquet',
    dta: 'all_types_v118.dta',
};

describe('table formats', () => {
    it('looks formats up by path and extension in any case', () => {
        expect(table_format_for('/a/B.XLSX')?.id).toBe('xlsx');
        expect(table_format_for('C:\\data\\x.Parquet')?.id).toBe('parquet');
        expect(table_format_for_extension('.TSV')?.id).toBe('tsv');
        expect(table_format_for_extension('dta')?.id).toBe('dta');
        // The extension proper, not a suffix of it.
        expect(table_format_for('/a/b.mycsv')).toBeUndefined();
        expect(table_format_for('/a/b.xlsm')).toBeUndefined();
        expect(TABLE_FILE_EXTENSION_PATTERN.test('/a/b.mycsv')).toBe(false);
    });

    it('sends an unsupported extension to the BIFF parser, as before', () => {
        expect(parser_format_for('/a/b.xlsm').id).toBe('xls');
        expect(parser_format_for('/a/b').id).toBe('xls');
    });

    it('splits only .tsv on tabs', () => {
        expect(get_delimiter('/a/b.TSV')).toBe('\t');
        expect(get_delimiter('/a/b.csv')).toBe(',');
        expect(get_delimiter('/a/b.txt')).toBe(',');
    });

    it('edits only CSV, TSV and XLSX', () => {
        const editing = TABLE_FORMATS
            .filter(({ extension }) => profile_for(`/tmp/file.${extension}`).editing)
            .map(({ id }) => id);
        expect(editing).toEqual(['csv', 'tsv', 'xlsx']);
        expect(profile_for('/tmp/file.xlsx').plan_save).toBeDefined();
        expect(profile_for('/tmp/file.xls').editing).toBe(false);
    });

    it('marks exactly the formats whose sources open as one unnamed sheet single-table', async () => {
        for (const format of TABLE_FORMATS) {
            const fixture = FIXTURE_FOR[format.id];
            expect(fixture, `fixture for ${format.id}`).toBeDefined();
            const raw = new Uint8Array(readFileSync(join(FIXTURES, fixture)));
            const source = await build_source_from_buffer(raw, fixture);
            try {
                const sheets = source.meta().sheets;
                const single = sheets.length === 1 && sheets[0].unnamedSingleSheet === true;
                expect(single, format.id).toBe(format.singleTable);
            } finally {
                source.close();
            }
        }
    });
});
