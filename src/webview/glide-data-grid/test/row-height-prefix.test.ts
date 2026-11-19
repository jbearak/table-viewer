// Fork tests: the row-height prefix index Glide reads from a row-height
// callable, against the row-by-row walks it replaces.
import { describe, expect, it } from "vitest";
import {
    computeBounds,
    rowHeightPrefixOf,
    rowSpanHeight,
    uniformRowHeight,
    type MappedGridColumn,
} from "../internal/data-grid/render/data-grid-lib.js";
import { verticalRegion } from "../internal/scrolling-data-grid/scrolling-data-grid.js";
import { create_row_height_index, geometry_row_height, indexed_row_height } from "../../row-height-index.js";

function random_source(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

/** Upstream's processArgs walk for a callable height, from row 0. */
function walked_region(y: number, height: number, rows: number, rowHeight: (row: number) => number, smooth: boolean) {
    let ty = 0;
    let cellY = 0;
    let cellBottom = 0;
    let top = 0;
    for (let row = 0; row < rows; row++) {
        const rh = rowHeight(row);
        const cy = top + (smooth ? 0 : rh / 2);
        if (y >= top + rh) {
            top += rh;
            cellY++;
            cellBottom++;
        } else if (y > cy) {
            top += rh;
            if (smooth) ty += cy - y;
            else cellY++;
            cellBottom++;
        } else if (y + height > rh / 2 + top) {
            top += rh;
            cellBottom++;
        } else {
            break;
        }
    }
    return { cellY, cellBottom, ty };
}

/** A random indexed callable over `rows` rows, its heights quantized as the app draws them. */
function random_heights(next: () => number, rows: number) {
    const choices = [24, 30, 48.5, 26.8, 27.2, 10.6667, 200].map((height) => geometry_row_height(height, 24));
    const runs = [];
    for (let row = 0; row < rows; row++) {
        if (next() < 0.4) runs.push({ start: row, count: 1, height: choices[Math.floor(next() * choices.length)]! });
    }
    const index = create_row_height_index(rows, 24, runs);
    const plain = (row: number) => index.height(row);
    return { indexed: indexed_row_height(index), plain, index };
}

describe("verticalRegion", () => {
    it("gives the walk's region with the index as without it, both scroll modes", () => {
        const next = random_source(7);
        for (let trial = 0; trial < 300; trial++) {
            const rows = Math.floor(next() * 40);
            const { indexed, plain, index } = random_heights(next, rows);
            const total = index.top(rows);
            const ys = [
                -50, 0, Number.NaN, total, total + 30,
                ...Array.from({ length: 8 }, () => next() * (total + 10)),
                ...Array.from({ length: rows + 1 }, (_, row) => index.top(row)),
                ...Array.from({ length: rows }, (_, row) => index.top(row) + index.height(row) / 2),
            ];
            for (const smooth of [true, false]) {
                for (const y of ys) {
                    const view = 10 + next() * 200;
                    const expected = walked_region(y, view, rows, plain, smooth);
                    expect(verticalRegion(y, view, rows, indexed, smooth), `trial ${trial} y ${y} smooth ${smooth}`)
                        .toEqual(expected);
                    expect(verticalRegion(y, view, rows, plain, smooth)).toEqual(expected);
                }
            }
        }
    });

    it("walks only the visible rows with the index", () => {
        const runs = Array.from({ length: 1000 }, (_, at) => ({ start: at * 1000, count: 2, height: 40 }));
        const index = create_row_height_index(1_000_000, 24, runs);
        let calls = 0;
        const callable = Object.assign((row: number) => {
            calls++;
            return index.height(row);
        }, { rowHeightIndex: index });
        const region = verticalRegion(index.top(700_000) + 5, 600, 1_000_000, callable, true);
        expect(region.cellY).toBe(700_000);
        expect(calls).toBeLessThan(40);
    });

    it("ends at the rows' end for +Infinity, as the walk does", () => {
        const { indexed, plain } = random_heights(random_source(3), 12);
        for (const smooth of [true, false]) {
            expect(verticalRegion(Number.POSITIVE_INFINITY, 100, 12, indexed, smooth))
                .toEqual(walked_region(Number.POSITIVE_INFINITY, 100, 12, plain, smooth));
        }
    });
});

describe("rowSpanHeight", () => {
    it("sums rows by arithmetic, by the index, or row by row, alike", () => {
        const next = random_source(11);
        for (let trial = 0; trial < 100; trial++) {
            const rows = 1 + Math.floor(next() * 50);
            const { indexed, plain } = random_heights(next, rows);
            const start = Math.floor(next() * rows);
            const end = start + Math.floor(next() * (rows - start + 3));
            let walked = 0;
            for (let row = start; row < end; row++) walked += plain(row);
            expect(rowSpanHeight(indexed, start, end)).toBe(walked);
            expect(rowSpanHeight(plain, start, end)).toBe(walked);
            expect(rowSpanHeight(24, start, end)).toBe((end - start) * 24);
            expect(rowSpanHeight(uniformRowHeight(24), start, end)).toBe((end - start) * 24);
        }
        expect(rowSpanHeight(24, 5, 3)).toBe(0);
    });

    it("reads a prefix index only from a callable that carries one", () => {
        expect(rowHeightPrefixOf(24)).toBeUndefined();
        expect(rowHeightPrefixOf(() => 24)).toBeUndefined();
        expect(rowHeightPrefixOf(uniformRowHeight(24))?.top(3)).toBe(72);
        expect(rowHeightPrefixOf(uniformRowHeight(24))?.rowAtY(47.9)).toBe(1);
    });
});

describe("computeBounds rows", () => {
    const columns = [{ width: 100, sticky: false, sourceIndex: 0 }] as unknown as readonly MappedGridColumn[];
    const bounds_y = (row: number, cellYOffset: number, rowHeight: number | ((row: number) => number)) =>
        computeBounds(0, row, 500, 400, 0, 36, 0, cellYOffset, 0, 0, 40, 0, 0, columns, rowHeight).y;

    it("places a row above or below the first visible row by the rows between", () => {
        const next = random_source(19);
        for (let trial = 0; trial < 100; trial++) {
            const { indexed, plain } = random_heights(next, 40);
            const cellYOffset = Math.floor(next() * 40);
            for (let row = 0; row < 40; row++) {
                // First principles: the header, then the rows from cellYOffset to row.
                let expected = 36;
                for (let r = cellYOffset; r < row; r++) expected += plain(r);
                for (let r = row; r < cellYOffset; r++) expected -= plain(r);
                expect(bounds_y(row, cellYOffset, indexed), `row ${row} offset ${cellYOffset}`).toBe(expected);
                expect(bounds_y(row, cellYOffset, plain)).toBe(expected);
            }
        }
    });

    it("puts a tall row above the first visible row its own height above it", () => {
        // Upstream used row 1's height for row 0 here.
        const heights = (row: number) => (row === 0 ? 60 : 24);
        expect(bounds_y(0, 1, heights)).toBe(36 - 60);
    });
});
