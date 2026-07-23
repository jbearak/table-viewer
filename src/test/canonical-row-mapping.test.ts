import { describe, expect, it, vi } from 'vitest';
import { CsvDataSource } from '../data-source/csv-source';
import { ExcelHeaderDataSource } from '../data-source/excel-header-source';
import {
    projected_row_for_source,
    read_source_row_indices,
    type DataSource,
    type RenderedCell,
    type RowWindow,
    type WorkbookMeta,
} from '../data-source/interface';
import { ViewerPanelCore } from '../panel-core';
import { transformed_window } from '../table-transform';
import { transform_schema_for_sheet } from '../types';

const cell = (raw: string): RenderedCell => ({
    raw,
    formatted: raw,
    bold: false,
    italic: false,
    rawType: 'string',
});

class Source implements DataSource {
    constructor(private readonly values: string[]) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: this.values.length,
                sourceRowCount: this.values.length,
                columnCount: 1,
                merges: [],
                hasFormatting: false,
            }],
        };
    }

    read_rows(_sheet_index: number, start_row: number, count: number): RowWindow {
        const start = Math.max(0, Math.min(start_row, this.values.length));
        return {
            startRow: start,
            rows: this.values.slice(start, start + count).map((value) => [cell(value)]),
        };
    }

    close(): void {}
}

describe('canonical source row mapping', () => {
    it('provides validated identity defaults for ordinary DataSources', () => {
        const source = new Source(['zero', 'one']);

        expect([...read_source_row_indices(source, 0, Uint32Array.of(1, 0, 1))])
            .toEqual([1, 0, 1]);
        expect(projected_row_for_source(source, 0, 1)).toBe(1);
        expect(projected_row_for_source(source, 0, 2)).toBeUndefined();
        expect(() => read_source_row_indices(source, 0, [2])).toThrow(RangeError);
    });

    it('keeps CSV source rows in its already header-projected data space', () => {
        const source = new CsvDataSource(
            new TextEncoder().encode('Name\nAlice\nBob\nCharlie'),
            ',',
            2,
            { firstRowIsHeader: true },
        );

        expect(source.meta().sheets[0]).toMatchObject({
            rowCount: 2,
            sourceRowCount: 2,
        });
        expect([...read_source_row_indices(source, 0, Uint32Array.of(0, 1))])
            .toEqual([0, 1]);
        expect(projected_row_for_source(source, 0, 0)).toBe(0);
    });

    it('maps Excel projected rows across the physical header in both directions', () => {
        const source = new ExcelHeaderDataSource(
            new Source(['Header', 'Alice', 'Bob']),
            { Sheet1: 'on' },
        );

        expect(source.meta().sheets[0]).toMatchObject({
            rowCount: 2,
            sourceRowCount: 3,
        });
        expect([...read_source_row_indices(source, 0, Uint32Array.of(1, 0, 1))])
            .toEqual([2, 1, 2]);
        expect(projected_row_for_source(source, 0, 0)).toBeUndefined();
        expect(projected_row_for_source(source, 0, 1)).toBe(0);
        expect(projected_row_for_source(source, 0, 2)).toBe(1);
    });

    it('maps around an explicitly promoted nonzero source row', () => {
        const source = new ExcelHeaderDataSource(
            new Source(['title', 'note', 'Header', 'Alice', 'Bob']),
            { Sheet1: 'on' },
            [[0, 1]],
        );

        expect(source.meta().sheets[0].excelFirstRowHeader?.sourceRow).toBe(2);
        expect([...read_source_row_indices(source, 0, [0, 1, 2, 3])])
            .toEqual([0, 1, 3, 4]);
        expect(projected_row_for_source(source, 0, 0)).toBe(0);
        expect(projected_row_for_source(source, 0, 1)).toBe(1);
        expect(projected_row_for_source(source, 0, 2)).toBeUndefined();
        expect(projected_row_for_source(source, 0, 3)).toBe(2);
        expect(projected_row_for_source(source, 0, 4)).toBe(3);
    });

    it('returns sourceRows aligned with identity and transformed windows', () => {
        const source = new ExcelHeaderDataSource(
            new Source(['Header', 'zero', 'one', 'two']),
            { Sheet1: 'on' },
        );

        expect(transformed_window(source, 0, 1, 2, undefined).sourceRows)
            .toEqual([2, 3]);
        const transformed = transformed_window(
            source,
            0,
            0,
            3,
            Uint32Array.from([2, 0, 1]),
        );
        expect(transformed.rows.map((row) => row[0]?.raw))
            .toEqual(['two', 'zero', 'one']);
        expect(transformed.sourceRows).toEqual([3, 1, 2]);
    });

    it('emits aligned rowData and invalidates inverse transforms on view changes', async () => {
        const posted: any[] = [];
        const panel = {
            webview: {
                postMessage: vi.fn((message: unknown) => {
                    posted.push(message);
                    return Promise.resolve(true);
                }),
            },
        };
        const first = new ExcelHeaderDataSource(
            new Source(['Header', 'b', 'a', 'c']),
            { Sheet1: 'on' },
        );
        const core = new ViewerPanelCore(panel, first);

        expect([...core.map_display_rows_to_source(0, [
            { start: 0, end: 1 },
            { start: 1, end: 2 },
        ])]).toEqual([1, 2, 2, 3]);
        expect(core.map_display_rows_to_source(0, [{ start: 0, end: 0 }])[0]).toBe(1);
        expect(core.display_row_for_source(0, 1)).toBe(0);
        expect(core.display_row_for_source(0, 0)).toBeUndefined();
        expect(() => core.map_display_rows_to_source(0, [
            { start: 2, end: 3 },
        ])).toThrow(RangeError);

        const sheet = first.meta().sheets[0];
        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort',
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: transform_schema_for_sheet(sheet),
            },
        });

        expect([...core.map_display_rows_to_source(0, [
            { start: 0, end: 2 },
        ])]).toEqual([2, 1, 3]);
        expect(core.map_display_rows_to_source(0, [{ start: 0, end: 0 }])[0]).toBe(2);
        for (const source_row of [1, 2, 3]) {
            const display_row = core.display_row_for_source(0, source_row);
            expect(display_row).toBeDefined();
            expect(core.map_display_rows_to_source(
                0,
                [{ start: display_row!, end: display_row! }],
            )[0]).toBe(source_row);
        }

        await core.handle_message({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 3,
            requestId: 'rows',
            generation: core.generation,
        });
        expect(posted.at(-1)).toMatchObject({
            type: 'rowData',
            sourceRows: [2, 1, 3],
        });

        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'filter',
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [],
                filters: [{
                    id: 'only-a',
                    colIndex: 0,
                    operator: 'equals',
                    value: 'a',
                    caseSensitive: false,
                    enabled: true,
                }],
                schema: transform_schema_for_sheet(sheet),
            },
        });
        expect([...core.map_display_rows_to_source(0, [
            { start: 0, end: 0 },
        ])]).toEqual([2]);
        expect(core.display_row_for_source(0, 2)).toBe(0);
        expect(core.display_row_for_source(0, 1)).toBeUndefined();
        expect(core.display_row_for_source(0, 3)).toBeUndefined();

        core.adopt_source(new Source(['x', 'y', 'z']));
        expect(core.display_row_for_source(0, 0)).toBe(0);
        expect(core.map_display_rows_to_source(0, [{ start: 0, end: 0 }])[0]).toBe(0);
    });
});
