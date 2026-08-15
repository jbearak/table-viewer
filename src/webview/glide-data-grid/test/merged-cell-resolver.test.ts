// Fork addition: tests for the merged-cell resolver (Stage 2).
import { describe, expect, test } from "vitest";
import { MergedCellResolver } from "../internal/data-grid/merged-cell-resolver.js";
import { CellSet } from "../internal/data-grid/cell-set.js";

describe("MergedCellResolver", () => {
    test("resolves anchor and covered cells", () => {
        const r = new MergedCellResolver([{ x: 1, y: 2, width: 2, height: 3 }]);
        expect(r.isEmpty).toBe(false);
        expect(r.getRange(1, 2)).toEqual({ x: 1, y: 2, width: 2, height: 3 });
        expect(r.getRange(2, 4)).toEqual({ x: 1, y: 2, width: 2, height: 3 });
        expect(r.getRange(0, 2)).toBeUndefined();
        expect(r.getRange(3, 2)).toBeUndefined();
        expect(r.getRange(1, 5)).toBeUndefined();
    });

    test("returns one stable Rectangle identity per merge", () => {
        const r = new MergedCellResolver([{ x: 1, y: 1, width: 2, height: 2 }]);
        expect(r.getRange(1, 1)).toBe(r.getRange(2, 2));
    });

    test("applies column offset (row markers)", () => {
        const r = new MergedCellResolver([{ x: 0, y: 0, width: 2, height: 2 }], 1);
        expect(r.getRange(0, 0)).toBeUndefined();
        expect(r.getRange(1, 0)).toEqual({ x: 1, y: 0, width: 2, height: 2 });
        expect(r.getRange(2, 1)).toEqual({ x: 1, y: 0, width: 2, height: 2 });
    });

    test("drops degenerate ranges", () => {
        const r = new MergedCellResolver([
            { x: 0, y: 0, width: 1, height: 1 },
            { x: 2, y: 2, width: 0, height: 5 },
            { x: -1, y: 0, width: 3, height: 3 },
        ]);
        expect(r.isEmpty).toBe(true);
        expect(r.getRange(0, 0)).toBeUndefined();
    });

    test("drops ranges extending past the grid bounds", () => {
        const r = new MergedCellResolver(
            [
                { x: 8, y: 0, width: 3, height: 2 },
                { x: 0, y: 98, width: 2, height: 5 },
                { x: 0, y: 0, width: 2, height: 2 },
            ],
            0,
            10,
            100
        );
        expect(r.getRange(8, 0)).toBeUndefined();
        expect(r.getRange(0, 98)).toBeUndefined();
        expect(r.getRange(0, 0)).toEqual({ x: 0, y: 0, width: 2, height: 2 });
    });

    test("drops overlapping ranges, first listed wins", () => {
        const r = new MergedCellResolver([
            { x: 0, y: 0, width: 3, height: 3 },
            { x: 2, y: 2, width: 3, height: 3 },
            { x: 5, y: 5, width: 2, height: 1 },
        ]);
        expect(r.getRange(0, 0)).toEqual({ x: 0, y: 0, width: 3, height: 3 });
        expect(r.getRange(5, 5)).toEqual({ x: 5, y: 5, width: 2, height: 1 });
        // The overlapping second range was dropped entirely, including its
        // non-overlapping corner.
        expect(r.getRange(4, 4)).toBeUndefined();
        expect(r.getRange(3, 3)).toBeUndefined();
    });

    test("expandDamage expands merge members to the full merge", () => {
        const r = new MergedCellResolver([{ x: 1, y: 1, width: 2, height: 2 }]);
        const expanded = r.expandDamage(new CellSet([[2, 2]]));
        const items = [...expanded.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        expect(items).toEqual([
            [1, 1],
            [1, 2],
            [2, 1],
            [2, 2],
        ]);
    });

    test("expandDamage returns the same set when no merge is touched", () => {
        const r = new MergedCellResolver([{ x: 1, y: 1, width: 2, height: 2 }]);
        const input = new CellSet([
            [5, 5],
            [0, -1],
        ]);
        expect(r.expandDamage(input)).toBe(input);
    });

    test("expandDamage keeps untouched cells", () => {
        const r = new MergedCellResolver([{ x: 1, y: 1, width: 2, height: 1 }]);
        const expanded = r.expandDamage(
            new CellSet([
                [1, 1],
                [7, 9],
            ])
        );
        expect(expanded.has([7, 9])).toBe(true);
        expect(expanded.has([2, 1])).toBe(true);
        expect(expanded.size).toBe(3);
    });

    test("expandDamage handles many members of one merge", () => {
        const r = new MergedCellResolver([{ x: 0, y: 0, width: 3, height: 3 }]);
        const expanded = r.expandDamage(
            new CellSet([
                [0, 0],
                [1, 1],
                [2, 2],
            ])
        );
        expect(expanded.size).toBe(9);
    });
});
