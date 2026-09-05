import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build_source_from_buffer } from '../data-source/from-buffer';
import { CompareDataSource } from '../diff-compare/compare-session';
import { profile_for } from '../viewer-controller';

function fixture(name: string): Buffer {
    return readFileSync(join(__dirname, 'fixtures', 'arrow', name));
}

describe('Arrow viewer integration', () => {
    it('opens mixed-case Arrow paths with named columns and exact transport values', async () => {
        const profile = profile_for('/data/example.ArRoW');
        expect(profile.editing).toBe(false);
        expect('plan_save' in profile).toBe(false);
        expect(profile.build_file_source).toBeUndefined();
        const source = await profile.build_source(
            fixture('plain-zstd.arrow'),
            '/data/example.ArRoW',
            {},
        );
        try {
            const sheet = source.meta().sheets[0];
            expect(sheet.columnNames?.[4]).toBe('i64');
            expect(sheet.excelFirstRowHeader).toBeUndefined();
            expect(sheet.rowCount).toBe(4);
            const rows = source.read_rows(0, 2, 2).rows;
            expect(rows[0][4]?.raw).toBe('9223372036854775807');
            expect(rows[1][4]?.raw).toBe('9007199254740993');
            expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
        } finally {
            source.close();
        }
    });

    it('compares equivalent Arrow revisions across compression codecs without false changes', async () => {
        const original = await build_source_from_buffer(fixture('plain-none.arrow'), '/git/base.arrow');
        const modified = await build_source_from_buffer(fixture('plain-lz4.arrow'), '/work/data.ARROW');
        const comparison = new CompareDataSource(modified, original);
        try {
            expect(comparison.pairings[0].status).toBe('matched');
            expect(comparison.changedColumnNames[0]).toEqual([]);
            expect((await comparison.diff_rows(0, [0, 1, 2, 3]))?.changedCells).toEqual([]);
        } finally {
            comparison.close();
            original.close();
            modified.close();
        }
    });

    it('reports changed dictionary meaning even when the stored category code is identical', async () => {
        const original_bytes = fixture('plain-none.arrow');
        const changed_bytes = Buffer.from(original_bytes);
        const levels_offset = changed_bytes.indexOf(Buffer.from('lowhighunused'));
        expect(levels_offset).toBeGreaterThan(0);
        changed_bytes.write('LOW', levels_offset, 'utf8');
        const original = await build_source_from_buffer(original_bytes, '/git/base.arrow');
        const modified = await build_source_from_buffer(changed_bytes, '/work/data.arrow');
        const comparison = new CompareDataSource(modified, original);
        try {
            expect(original.read_rows(0, 2, 1).rows[0][22]?.raw).toBe('0');
            expect(modified.read_rows(0, 2, 1).rows[0][22]).toMatchObject({ raw: '0', formatted: 'LOW' });
            const differences = await comparison.diff_rows(0, [2]);
            expect(differences?.changedCells).toEqual(expect.arrayContaining([
                expect.objectContaining({ row: 0, col: 22, formattedBase: 'low' }),
            ]));
        } finally {
            comparison.close();
            original.close();
            modified.close();
        }
    });

    it('surfaces malformed Arrow input through the same read-only open path', async () => {
        await expect(profile_for('/data/broken.arrow').build_source(
            new Uint8Array(20), '/data/broken.arrow', {},
        )).rejects.toThrow(/Arrow/i);
    });
});
