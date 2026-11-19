import { describe, expect, it } from 'vitest';
import {
    create_row_height_index,
    geometry_row_height,
    indexed_row_height,
    ROW_HEIGHT_QUANTUM,
    type RowHeightRun,
} from '../webview/row-height-index';
import { MAX_ROW_HEIGHT_PX } from '../webview/row-heights';

function random_source(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

/** Every row's height, written out, and the running sums Glide's loops make. */
function reference(row_count: number, default_height: number, runs: readonly RowHeightRun[]) {
    const heights = Array.from({ length: row_count }, () => default_height);
    for (const run of runs) {
        for (let row = Math.max(0, run.start); row < Math.min(row_count, run.start + run.count); row++) {
            heights[row] = run.height;
        }
    }
    const tops = [0];
    for (const height of heights) tops.push(tops[tops.length - 1]! + height);
    const height_at = (row: number) => (row >= 0 && row < row_count ? heights[row]! : default_height);
    const top_at = (row: number) => {
        if (row <= 0) return row * default_height;
        if (row <= row_count) return tops[row]!;
        return tops[row_count]! + (row - row_count) * default_height;
    };
    return { height_at, top_at };
}

function random_runs(next: () => number, row_count: number, heights: readonly number[]): RowHeightRun[] {
    const runs: RowHeightRun[] = [];
    let row = Math.floor(next() * 4);
    while (row < row_count + 3) {
        const count = 1 + Math.floor(next() * 6);
        runs.push({ start: row, count, height: heights[Math.floor(next() * heights.length)]! });
        row += count + Math.floor(next() * 5);
    }
    return runs;
}

describe('geometry_row_height', () => {
    it('rounds to the quantum, clamps to the bounds and takes the fallback for a non-finite height', () => {
        expect(geometry_row_height(24, 24)).toBe(24);
        expect(geometry_row_height(15.25 * 96 / 72, 24) % ROW_HEIGHT_QUANTUM).toBe(0);
        expect(Math.abs(geometry_row_height(15.25 * 96 / 72, 24) - 15.25 * 96 / 72)).toBeLessThanOrEqual(ROW_HEIGHT_QUANTUM / 2);
        expect(geometry_row_height(1e15, 24)).toBe(MAX_ROW_HEIGHT_PX);
        expect(geometry_row_height(0, 24)).toBe(ROW_HEIGHT_QUANTUM);
        expect(geometry_row_height(-5, 24)).toBe(ROW_HEIGHT_QUANTUM);
        expect(geometry_row_height(Number.NaN, 24)).toBe(24);
        expect(geometry_row_height(Number.POSITIVE_INFINITY, 30)).toBe(30);
        // Within half a quantum of the default it is the default; past that it is not.
        expect(geometry_row_height(24 + ROW_HEIGHT_QUANTUM / 4, 24)).toBe(24);
        expect(geometry_row_height(24.001, 24)).toBeGreaterThan(24);
        // To the nearest quantum, not down.
        expect(geometry_row_height(24 + 0.75 * ROW_HEIGHT_QUANTUM, 24)).toBe(24 + ROW_HEIGHT_QUANTUM);
        // A fallback that is not finite gives way to the stock default.
        expect(geometry_row_height(Number.NaN, Number.NaN)).toBe(24);
    });
});

describe('create_row_height_index', () => {
    it('answers height, top and rowAtY as a running sum of every row does', () => {
        const next = random_source(307);
        for (let trial = 0; trial < 400; trial++) {
            const row_count = Math.floor(next() * 60);
            const default_height = geometry_row_height(next() < 0.5 ? 24 : 15.25 * 96 / 72, 24);
            const heights = [default_height, 30, 48.5, geometry_row_height(26.8, 24), geometry_row_height(10.6667, 24), 4096];
            const runs = random_runs(next, row_count, heights);
            const index = create_row_height_index(row_count, default_height, runs);
            const { height_at, top_at } = reference(row_count, default_height, runs);
            for (let row = -3; row <= row_count + 3; row++) {
                expect(index.height(row), `trial ${trial} row ${row}`).toBe(height_at(row));
                expect(index.top(row), `trial ${trial} top ${row}`).toBe(top_at(row));
            }
            for (let row = 0; row <= row_count + 2; row++) {
                // The row holding each of its own top and its last quantum.
                expect(index.rowAtY(top_at(row)), `trial ${trial} y at top ${row}`).toBe(row);
                expect(index.rowAtY(top_at(row + 1) - ROW_HEIGHT_QUANTUM), `trial ${trial} y in ${row}`).toBe(row);
                const middle = top_at(row) + height_at(row) / 2;
                expect(index.rowAtY(middle)).toBe(row);
            }
            // The stored runs: no default-height run, none empty, sorted and joined.
            for (let at = 0; at < index.runs.length; at++) {
                const run = index.runs[at]!;
                expect(run.height).not.toBe(default_height);
                expect(run.count).toBeGreaterThan(0);
                expect(run.start + run.count).toBeLessThanOrEqual(row_count);
                const following = index.runs[at + 1];
                if (following !== undefined) {
                    expect(following.start).toBeGreaterThanOrEqual(run.start + run.count);
                    if (following.start === run.start + run.count) expect(following.height).not.toBe(run.height);
                }
            }
        }
    });

    it('gives the row a walk from row 0 gives at fractional boundaries', () => {
        // Ten 26.8 px rows, y at their end; ten 27.2 px rows then 24 px, y = 284.
        for (const [heights, y] of [
            [Array.from({ length: 10 }, () => 26.8), 268],
            [[...Array.from({ length: 10 }, () => 27.2), 24], 284],
        ] as [number[], number][]) {
            const geometry = heights.map((height) => geometry_row_height(height, 24));
            const index = create_row_height_index(
                geometry.length,
                24,
                geometry.map((height, start) => ({ start, count: 1, height })),
            );
            let walked = 0;
            let row = 0;
            while (row < geometry.length && y >= walked + geometry[row]!) walked += geometry[row++]!;
            expect(index.rowAtY(y)).toBe(row);
            expect(index.top(row)).toBe(walked);
        }
    });

    it('stays exact when the default is tall and a long run is short', () => {
        // A 4,096 px default and 34 million rows of 20 + 2^-16 px: the tops
        // fit in 2^37 px, though rows × default would not.
        const height = 20 + ROW_HEIGHT_QUANTUM;
        const count = 34_000_002;
        const index = create_row_height_index(count + 3, 4096, [{ start: 1, count, height }]);
        const quanta = (value: number) => BigInt(value / ROW_HEIGHT_QUANTUM);
        const exact = (row: number): bigint => {
            if (row <= 1) return BigInt(row) * quanta(4096);
            if (row <= count + 1) return quanta(4096) + BigInt(row - 1) * quanta(height);
            return quanta(4096) + BigInt(count) * quanta(height) + BigInt(row - count - 1) * quanta(4096);
        };
        for (const row of [0, 1, 2, 17_000_000, count, count + 1, count + 2, count + 3]) {
            expect(quanta(index.top(row)), `top ${row}`).toBe(exact(row));
            expect(index.rowAtY(index.top(row)), `row at top ${row}`).toBe(row);
        }
    });

    it('stays exact across a second run after an odd-length tall-default run', () => {
        // Under rev 3's row × default + extra the top inside the second run
        // was a quantum off.
        const short = 20 + ROW_HEIGHT_QUANTUM;
        const count = 34_000_001;
        const index = create_row_height_index(count + 10, 4096, [
            { start: 1, count, height: short },
            { start: count + 3, count: 4, height: 30 },
        ]);
        const quanta = (value: number) => BigInt(value / ROW_HEIGHT_QUANTUM);
        const before_second = quanta(4096) + BigInt(count) * quanta(short) + 2n * quanta(4096);
        for (const offset of [0, 1, 2, 3, 4]) {
            const row = count + 3 + offset;
            expect(quanta(index.top(row)), `top ${row}`).toBe(before_second + BigInt(offset) * quanta(30));
            expect(index.rowAtY(index.top(row))).toBe(row);
        }
    });

    it('answers a y far past any row without hanging', () => {
        for (const runs of [[], [{ start: 1, count: 2, height: 40 }]]) {
            const index = create_row_height_index(100, 24, runs);
            for (const y of [1e17, 1e18, 2 ** 60, 1e300]) {
                const row = index.rowAtY(y);
                expect(row).toBeGreaterThan(100);
                expect(row).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
            }
        }
    });

    it('treats fractional rows and bad inputs predictably', () => {
        const index = create_row_height_index(5, 24, [{ start: 1, count: 1, height: 8 }]);
        expect(index.height(1)).toBe(8);
        expect(index.height(1.5)).toBe(24);
        expect(index.height(Number.NaN)).toBe(24);
        expect(index.top(1.99)).toBe(index.top(1));
        expect(index.top(2.5)).toBe(32);
        // Not a row count, not a height, not a run: an empty index of the stock default.
        const bad = create_row_height_index(Number.NaN, Number.NaN, [
            { start: Number.NaN, count: 2, height: 40 },
            { start: 0, count: 1.5, height: 40 },
        ]);
        expect(bad.rowCount).toBe(0);
        expect(bad.defaultHeight).toBe(24);
        expect(bad.runs).toEqual([]);
        // Heights are drawn heights: a run that rounds to the default is the default.
        const near = create_row_height_index(5, 24, [{ start: 1, count: 1, height: 24 + ROW_HEIGHT_QUANTUM / 4 }]);
        expect(near.runs).toEqual([]);
    });

    it('joins runs at the safe-integer limit without losing a row', () => {
        const top_row = Number.MAX_SAFE_INTEGER;
        const index = create_row_height_index(top_row, 24, [
            { start: top_row - 3, count: 2, height: 40 },
            { start: top_row - 1, count: 1, height: 40 },
        ]);
        expect(index.runs).toEqual([{ start: top_row - 3, count: 3, height: 40 }]);
        expect(index.height(top_row - 1)).toBe(40);
    });

    it('takes NaN and negative y as row 0 and +Infinity as no row', () => {
        const index = create_row_height_index(5, 24, [{ start: 1, count: 2, height: 40 }]);
        expect(index.rowAtY(Number.NaN)).toBe(0);
        expect(index.rowAtY(-100)).toBe(0);
        expect(index.rowAtY(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
        // Past the last row, rows take the default.
        expect(index.rowAtY(index.top(5) + 24 * 3 + 1)).toBe(8);
    });

    it('clips runs to the rows and drops overlaps', () => {
        const index = create_row_height_index(10, 24, [
            { start: -2, count: 4, height: 30 },
            { start: 1, count: 3, height: 50 },
            { start: 8, count: 10, height: 30 },
        ]);
        expect(index.runs).toEqual([
            { start: 0, count: 2, height: 30 },
            { start: 2, count: 2, height: 50 },
            { start: 8, count: 2, height: 30 },
        ]);
    });

    it('answers a million rows with ten thousand runs by search', () => {
        const runs: RowHeightRun[] = Array.from({ length: 10_000 }, (_, index) => ({ start: index * 100, count: 3, height: 40 }));
        const index = create_row_height_index(1_000_000, 24, runs);
        expect(index.top(1_000_000)).toBe(1_000_000 * 24 + 10_000 * 3 * 16);
        expect(index.rowAtY(index.top(999_903))).toBe(999_903);
        expect(index.height(500_001)).toBe(40);
        expect(index.height(500_003)).toBe(24);
    });
});

describe('indexed_row_height', () => {
    it('is the index’s height, carrying the index', () => {
        const index = create_row_height_index(4, 24, [{ start: 2, count: 1, height: 60 }]);
        const callable = indexed_row_height(index);
        expect(callable(2)).toBe(60);
        expect(callable(3)).toBe(24);
        expect(callable.rowHeightIndex).toBe(index);
    });
});
