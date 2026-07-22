import { CompactSelection, type GridSelection } from '@glideapps/glide-data-grid';
import { describe, expect, it, vi } from 'vitest';
import { plan_cell_highlight_mutation } from '../cell-highlight-command';
import { create_column_projection } from '../webview/column-projection';
import {
    grid_selection_contains_cell,
    highlight_selection_from_grid,
} from '../webview/highlight-selection-model';
import type { MergeRange } from '../types';

const projection = create_column_projection(4, { hiddenColumns: [1] });
const empty = (): GridSelection => ({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
});
const current = (x: number, y: number, width = 1, height = 1): GridSelection => ({
    ...empty(),
    current: { cell: [x, y], range: { x, y, width, height }, rangeStack: [] },
});

describe('highlight_selection_from_grid', () => {
    it('converts a display cell to a canonical source column', () => {
        expect(highlight_selection_from_grid(current(1, 2), 10, projection, []))
            .toEqual({
                selection: { displayRows: [{ start: 2, end: 2 }], sourceColumns: [2] },
                estimatedCellCount: 1,
            });
    });

    it('converts rectangular, row, and column selections deterministically', () => {
        expect(highlight_selection_from_grid(current(0, 2, 3, 4), 10, projection, []))
            .toMatchObject({
                selection: {
                    displayRows: [{ start: 2, end: 5 }],
                    sourceColumns: [0, 2, 3],
                },
                estimatedCellCount: 12,
            });

        expect(highlight_selection_from_grid({
            ...empty(),
            rows: CompactSelection.fromSingleSelection([3, 6]),
        }, 10, projection, [])?.selection).toEqual({
            displayRows: [{ start: 3, end: 5 }],
            sourceColumns: [0, 2, 3],
        });

        expect(highlight_selection_from_grid({
            ...empty(),
            columns: CompactSelection.fromSingleSelection([1, 3]),
        }, 10, projection, [])?.selection).toEqual({
            displayRows: [{ start: 0, end: 9 }],
            sourceColumns: [2, 3],
        });
    });

    it('projects source-coordinate merges before expanding display selections', () => {
        const merges: MergeRange[] = [
            { startRow: 2, endRow: 3, startCol: 0, endCol: 1 },
        ];
        expect(highlight_selection_from_grid(current(1, 3), 10, projection, merges)?.selection)
            .toEqual({
                displayRows: [{ start: 3, end: 3 }],
                sourceColumns: [2],
            });
        expect(highlight_selection_from_grid(current(0, 3), 10, projection, merges)?.selection)
            .toEqual({
                displayRows: [{ start: 2, end: 3 }],
                sourceColumns: [0],
            });
    });

    it('projects merges into display coordinates for rangeStack entries', () => {
        const merges: MergeRange[] = [
            { startRow: 2, endRow: 3, startCol: 0, endCol: 1 },
        ];
        // Column 1 is hidden, so the merge occupies only display column 0.
        // A stacked range on display column 0 must expand by the projected
        // merge (rows 2-3, one column), not the raw source-coordinate one.
        expect(highlight_selection_from_grid({
            ...empty(),
            current: {
                cell: [0, 2],
                range: { x: 0, y: 2, width: 1, height: 2 },
                rangeStack: [{ x: 0, y: 3, width: 1, height: 1 }],
            },
        }, 10, projection, merges)?.selection).toEqual({
            displayRows: [{ start: 2, end: 3 }],
            sourceColumns: [0],
        });
    });

    it('expands cell selections through merges with an identity projection', () => {
        const identity = create_column_projection(4);
        const merges: MergeRange[] = [
            { startRow: 2, endRow: 3, startCol: 0, endCol: 1 },
        ];
        expect(highlight_selection_from_grid(current(1, 3), 10, identity, merges)?.selection)
            .toEqual({
                displayRows: [{ start: 2, end: 3 }],
                sourceColumns: [0, 1],
            });
    });

    it('expands whole-row and whole-column marker selections through merges', () => {
        const identity = create_column_projection(3);
        const vertical: MergeRange[] = [
            { startRow: 0, endRow: 1, startCol: 1, endCol: 1 },
        ];
        expect(highlight_selection_from_grid({
            ...empty(),
            rows: CompactSelection.fromSingleSelection(1),
        }, 4, identity, vertical)?.selection).toEqual({
            displayRows: [{ start: 0, end: 1 }],
            sourceColumns: [0, 1, 2],
        });

        const horizontal: MergeRange[] = [
            { startRow: 1, endRow: 1, startCol: 0, endCol: 1 },
        ];
        expect(highlight_selection_from_grid({
            ...empty(),
            columns: CompactSelection.fromSingleSelection(1),
        }, 4, identity, horizontal)?.selection).toEqual({
            displayRows: [{ start: 0, end: 3 }],
            sourceColumns: [0, 1],
        });
    });

    it('applies and clears marker-expanded vertical and horizontal merges', () => {
        const identity = create_column_projection(3);
        const sheet = {
            name: 'Sheet1',
            rowCount: 4,
            sourceRowCount: 4,
            columnCount: 3,
            merges: [],
            hasFormatting: false,
        };
        const context = {
            meta: { sheets: [sheet], hasFormatting: false },
            sourceDigest: 'digest',
            mapDisplayRowsToSource: (
                _sheet: number,
                intervals: readonly { start: number; end: number }[],
            ) => Uint32Array.from(intervals.flatMap(({ start, end }) =>
                Array.from({ length: end - start + 1 }, (_, offset) => start + offset))),
            displayRowForSource: (_sheet: number, sourceRow: number) => sourceRow,
        };
        const round_trip = (selection: NonNullable<ReturnType<
            typeof highlight_selection_from_grid
        >>['selection']) => {
            const applied = plan_cell_highlight_mutation({
                sheetIndex: 0,
                sheetName: 'Sheet1',
                selection,
                mutation: { type: 'set', color: 'yellow' },
            }, { ...context, current: undefined });
            expect(applied.type).toBe('applied');
            if (applied.type !== 'applied') return;
            const cleared = plan_cell_highlight_mutation({
                sheetIndex: 0,
                sheetName: 'Sheet1',
                selection,
                mutation: { type: 'clear' },
            }, { ...context, current: applied.state });
            expect(cleared).toMatchObject({ type: 'applied', state: undefined });
        };

        round_trip(highlight_selection_from_grid({
            ...empty(),
            rows: CompactSelection.fromSingleSelection(1),
        }, 4, identity, [{
            startRow: 0, endRow: 1, startCol: 1, endCol: 1,
        }])!.selection);
        round_trip(highlight_selection_from_grid({
            ...empty(),
            columns: CompactSelection.fromSingleSelection(1),
        }, 4, identity, [{
            startRow: 1, endRow: 1, startCol: 0, endCol: 1,
        }])!.selection);
    });

    it('clamps ranges and rejects a cross-shaped overlapping range stack', () => {
        const selection: GridSelection = {
            ...empty(),
            current: {
                cell: [-2, -3],
                range: { x: -2, y: -3, width: 4, height: 5 },
                rangeStack: [
                    { x: 1, y: 1, width: 2, height: 4 },
                    { x: 2, y: 4, width: 8, height: 8 },
                ],
            },
        };
        expect(highlight_selection_from_grid(selection, 6, projection, [])).toBeNull();
    });

    it('rejects disjoint rectangles that the Cartesian wire shape cannot represent', () => {
        const selection: GridSelection = {
            ...empty(),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 1, height: 1 },
                rangeStack: [{ x: 2, y: 2, width: 1, height: 1 }],
            },
        };
        expect(highlight_selection_from_grid(selection, 10, projection, [])).toBeNull();
    });

    it('coalesces sparse CompactSelection indices without scanning the dataset', () => {
        const toArray = vi.fn(() => [2, 3, 8]);
        const rows = { length: 3, toArray } as unknown as GridSelection['rows'];
        expect(highlight_selection_from_grid({ ...empty(), rows }, 1_000_000, projection, []))
            .toMatchObject({
                selection: {
                    displayRows: [{ start: 2, end: 3 }, { start: 8, end: 8 }],
                    sourceColumns: [0, 2, 3],
                },
                estimatedCellCount: 9,
            });
        expect(toArray).toHaveBeenCalledTimes(1);
    });

    it('recognizes cells in current, stacked, row, and column selections', () => {
        const selection: GridSelection = {
            columns: CompactSelection.fromSingleSelection(3),
            rows: CompactSelection.fromSingleSelection(7),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 1, height: 1 },
                rangeStack: [{ x: 2, y: 4, width: 1, height: 1 }],
            },
        };
        expect(grid_selection_contains_cell(selection, 0, 0)).toBe(true);
        expect(grid_selection_contains_cell(selection, 2, 4)).toBe(true);
        expect(grid_selection_contains_cell(selection, 1, 7)).toBe(true);
        expect(grid_selection_contains_cell(selection, 3, 9)).toBe(true);
        expect(grid_selection_contains_cell(selection, 1, 9)).toBe(false);
    });

    it('returns null for empty dimensions or no selection', () => {
        expect(highlight_selection_from_grid(empty(), 10, projection, [])).toBeNull();
        expect(highlight_selection_from_grid(current(0, 0), 0, projection, [])).toBeNull();
        expect(highlight_selection_from_grid(current(0, 0), 10, create_column_projection(0), []))
            .toBeNull();
    });
});
