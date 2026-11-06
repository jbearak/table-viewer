import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build_source_from_buffer } from '../data-source/from-buffer';
import {
    persisted_saved_row_snapshot,
    physical_row_format,
    saved_row_unchanged,
    source_row_cells_for_fingerprint,
} from '../saved-append-row';
import type { DataSource } from '../data-source/interface';

const enc = new TextEncoder();

/** What a save receipt records for the row at `source_row`, as it is now. */
function snapshot_of(
    source: DataSource,
    source_row: number,
    xlsx_bytes: Uint8Array | undefined,
) {
    const cells = source_row_cells_for_fingerprint(source, 0, source_row);
    return persisted_saved_row_snapshot(
        { cells },
        physical_row_format(source, 0, source_row, xlsx_bytes),
        cells,
    );
}

describe('saved appended rows', () => {
    it('recognizes an untouched CSV tail row and notices a changed one', async () => {
        const saved_source = await build_source_from_buffer(
            enc.encode('name,qty\nwidget,1\nadded,2\n'),
            'table.csv',
        );
        const last = saved_source.meta().sheets[0].sourceRowCount - 1;
        const saved = { sourceRow: last, savedRow: snapshot_of(saved_source, last, undefined) };
        expect(saved.savedRow.format).toEqual({ kind: 'none' });
        expect(saved_row_unchanged(saved_source, 0, saved, undefined)).toBe(true);

        const edited = await build_source_from_buffer(
            enc.encode('name,qty\nwidget,1\nadded,3\n'),
            'table.csv',
        );
        expect(saved_row_unchanged(edited, 0, saved, undefined)).toBe(false);
    });

    it('compares an XLSX tail row by its cells and its captured package format', async () => {
        const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'basic.xlsx')));
        const source = await build_source_from_buffer(bytes, 'book.xlsx');
        const last = source.meta().sheets[0].sourceRowCount - 1;
        const savedRow = snapshot_of(source, last, bytes);
        expect(savedRow.format.kind).toBe('xlsx');
        expect(saved_row_unchanged(source, 0, { sourceRow: last, savedRow }, bytes)).toBe(true);

        // The same cells saved with no format (as a CSV save would record
        // them) no longer match the workbook's physical row.
        const unformatted = { ...savedRow, format: { kind: 'none' as const } };
        expect(saved_row_unchanged(
            source,
            0,
            { sourceRow: last, savedRow: unformatted },
            bytes,
        )).toBe(false);
        // Another row's content does not pass for the saved one.
        expect(saved_row_unchanged(source, 0, { sourceRow: last - 1, savedRow }, bytes))
            .toBe(false);
    });

    it('ignores viewer-only state when comparing', async () => {
        const source = await build_source_from_buffer(
            enc.encode('name\nadded\n'),
            'table.csv',
        );
        const last = source.meta().sheets[0].sourceRowCount - 1;
        const cells = source_row_cells_for_fingerprint(source, 0, last);
        const savedRow = persisted_saved_row_snapshot(
            { cells, viewerRowHeight: 40, highlights: { 0: 'yellow' } as never },
            { kind: 'none' },
            cells,
        );
        expect(saved_row_unchanged(source, 0, { sourceRow: last, savedRow }, undefined))
            .toBe(true);
    });

    it('refuses a row that no longer exists', async () => {
        const source = await build_source_from_buffer(enc.encode('name\nadded\n'), 'table.csv');
        const savedRow = snapshot_of(source, source.meta().sheets[0].sourceRowCount - 1, undefined);
        expect(() => saved_row_unchanged(source, 0, { sourceRow: 5, savedRow }, undefined))
            .toThrow(/no longer available/u);
    });
});
