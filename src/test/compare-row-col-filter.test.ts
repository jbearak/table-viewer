import { describe, expect, it } from 'vitest';
import { compute_transform } from '../table-transform';
import { create_column_projection } from '../webview/column-projection';
import type {
    ColumnWindow,
    DataSource,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from '../data-source/interface';
import type { SheetTransformState } from '../types';

class MockSource implements DataSource {
    readonly kind = 'test';
    constructor(private readonly grid: (RenderedCell | null)[][]) {}
    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: this.grid.length,
                sourceRowCount: this.grid.length,
                columnCount: this.grid[0]?.length ?? 0,
                columnNames: ['Col0', 'Col1', 'Col2', 'Col3'],
                merges: [],
                hasFormatting: false,
            }],
        };
    }
    read_rows(_sheet: number, start: number, count: number): RowWindow {
        return {
            startRow: start,
            rows: this.grid.slice(start, start + count),
        };
    }
    read_columns(
        _sheet: number,
        start: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow {
        const rows = this.grid.slice(start, start + count).map((row) =>
            column_indices.map((column) => row[column] ?? null));
        return { startRow: start, rows };
    }
    close(): void {}
}

function cell(raw: string): RenderedCell {
    return { formatted: raw, raw, rawType: 'string', bold: false, italic: false };
}

describe('Row and Column Diff Filter Combinations', () => {
    // 4 rows x 4 columns grid
    const source = new MockSource([
        [cell('r0c0'), cell('r0c1'), cell('r0c2'), cell('r0c3')],
        [cell('r1c0'), cell('r1c1*'), cell('r1c2'), cell('r1c3')], // changed row 1, changed col 1
        [cell('r2c0'), cell('r2c1'), cell('r2c2'), cell('r2c3')],
        [cell('r3c0'), cell('r3c1'), cell('r3c2*'), cell('r3c3')], // changed row 3, changed col 2
    ]);

    const changed_rows = [1, 3];
    const changed_columns = [1, 2];
    const column_count = 4;

    it('Combination 1: Both OFF -> all rows and all columns visible', async () => {
        const row_transform: SheetTransformState = { sort: [], filters: [] };
        const row_result = await compute_transform(
            source, 0, row_transform, undefined, undefined, undefined, changed_rows,
        );
        const col_projection = create_column_projection(column_count, undefined, undefined, undefined);

        expect(row_result.indices).toBeUndefined(); // All rows
        expect(row_result.rowCount).toBe(4);
        expect(col_projection.visible_to_source).toEqual([0, 1, 2, 3]); // All cols
    });

    it('Combination 2: Only changed rows ON, Only changed columns OFF -> changed rows, all columns', async () => {
        const row_transform: SheetTransformState = { sort: [], filters: [], onlyChangedRows: true };
        const row_result = await compute_transform(
            source, 0, row_transform, undefined, undefined, undefined, changed_rows,
        );
        const col_projection = create_column_projection(column_count, undefined, undefined, undefined);

        expect(Array.from(row_result.indices!)).toEqual([1, 3]);
        expect(row_result.rowCount).toBe(2);
        expect(col_projection.visible_to_source).toEqual([0, 1, 2, 3]);
    });

    it('Combination 3: Only changed rows OFF, Only changed columns ON -> all rows, changed columns', async () => {
        const row_transform: SheetTransformState = { sort: [], filters: [] };
        const row_result = await compute_transform(
            source, 0, row_transform, undefined, undefined, undefined, changed_rows,
        );
        const col_projection = create_column_projection(column_count, undefined, undefined, changed_columns);

        expect(row_result.indices).toBeUndefined();
        expect(row_result.rowCount).toBe(4);
        expect(col_projection.visible_to_source).toEqual([1, 2]);
    });

    it('Combination 4: Both ON -> intersection of changed rows and changed columns', async () => {
        const row_transform: SheetTransformState = { sort: [], filters: [], onlyChangedRows: true };
        const row_result = await compute_transform(
            source, 0, row_transform, undefined, undefined, undefined, changed_rows,
        );
        const col_projection = create_column_projection(column_count, undefined, undefined, changed_columns);

        const visible_rows = Array.from(row_result.indices!);
        const visible_cols = col_projection.visible_to_source;

        expect(visible_rows).toEqual([1, 3]);
        expect(visible_cols).toEqual([1, 2]);

        // Intersection mapping test:
        // Display cell [displayCol: 0, displayRow: 0] maps to source [col 1, row 1]
        // Display cell [displayCol: 1, displayRow: 0] maps to source [col 2, row 1]
        // Display cell [displayCol: 0, displayRow: 1] maps to source [col 1, row 3]
        // Display cell [displayCol: 1, displayRow: 1] maps to source [col 2, row 3]
        const source_coords = visible_rows.map((r) => visible_cols.map((c) => `r${r}c${c}`));
        expect(source_coords).toEqual([
            ['r1c1', 'r1c2'],
            ['r3c1', 'r3c2'],
        ]);
    });

    it('overlays with manual hidden columns and does not unhide manually hidden columns', () => {
        // User manually hid column 2
        const manual_visibility = { hiddenColumns: [2] };

        // When column filter is active with changed_columns [1, 2]
        const col_projection_on = create_column_projection(column_count, manual_visibility, undefined, changed_columns);
        // Column 2 was changed, but manually hidden, so only column 1 is visible
        expect(col_projection_on.visible_to_source).toEqual([1]);
        expect(col_projection_on.hidden_count).toBe(3);

        // When column filter is toggled off
        const col_projection_off = create_column_projection(column_count, manual_visibility, undefined, undefined);
        // Column 2 remains hidden, original visible columns [0, 1, 3] restored
        expect(col_projection_off.visible_to_source).toEqual([0, 1, 3]);
        expect(col_projection_off.hidden_count).toBe(1);
    });
});
