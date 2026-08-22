import { describe, expect, it } from 'vitest';
import {
    ABSENT,
    AlignmentCancelledError,
    align_sheet,
    identity_alignment,
    type AlignedRow,
} from '../diff-compare/row-alignment';
import type { SheetPairing } from '../diff-compare/compare-source';
import { FixtureSource } from './helpers/fixture-source';

const single = (rows: string[][]): FixtureSource =>
    new FixtureSource([{ name: 'Sheet1', rows }]);

const matched: SheetPairing = {
    status: 'matched',
    name: 'Sheet1',
    modifiedIndex: 0,
    originalIndex: 0,
};

/** Compact rendering of an alignment: 'o,m' per row with '-' for ABSENT. */
const shape = (rows: readonly AlignedRow[]): string[] =>
    rows.map((row) =>
        `${row.original === ABSENT ? '-' : row.original},${row.modified === ABSENT ? '-' : row.modified}`);

const rows_of = (...values: string[]): string[][] => values.map((value) => [value]);

describe('align_sheet', () => {
    it('pairs identical files row for row', async () => {
        const rows = rows_of('a', 'b', 'c');
        const alignment = await align_sheet(single(rows), single(rows), matched);
        expect(shape(alignment.rows)).toEqual(['0,0', '1,1', '2,2']);
        expect(alignment).toMatchObject({
            addedRows: 0, deletedRows: 0, changedRows: 0, changedCells: 0, degraded: false,
        });
    });

    it('reports an inserted row as one addition, not a cascade of changes', async () => {
        // The whole point of the module: positionally, rows 1..3 all differ.
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c')),
            single(rows_of('a', 'NEW', 'b', 'c')),
            matched,
        );
        expect(shape(alignment.rows)).toEqual(['0,0', '-,1', '1,2', '2,3']);
        expect(alignment).toMatchObject({
            addedRows: 1, deletedRows: 0, changedRows: 0, changedCells: 0,
        });
    });

    it('reports a deleted row as one deletion', async () => {
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c')),
            single(rows_of('a', 'c')),
            matched,
        );
        expect(shape(alignment.rows)).toEqual(['0,0', '1,-', '2,1']);
        expect(alignment).toMatchObject({ addedRows: 0, deletedRows: 1, changedRows: 0 });
    });

    it('reports an in-place edit as a changed row, with no add or delete', async () => {
        const alignment = await align_sheet(
            single([['a', 'x'], ['b', 'y']]),
            single([['a', 'x'], ['b', 'CHANGED']]),
            matched,
        );
        expect(shape(alignment.rows)).toEqual(['0,0', '1,1']);
        expect(alignment).toMatchObject({
            addedRows: 0, deletedRows: 0, changedRows: 1, changedCells: 1,
        });
    });

    it('represents a moved row as a delete and an add, not changed cells', async () => {
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c', 'd')),
            single(rows_of('b', 'c', 'd', 'a')),
            matched,
        );
        expect(alignment).toMatchObject({
            addedRows: 1, deletedRows: 1, changedRows: 0, changedCells: 0,
        });
    });

    it('pairs a replaced block row for row, then reports the excess', async () => {
        // Three rows replaced by five: three changed rows and two additions,
        // not three deletions and five additions stacked on each other.
        const alignment = await align_sheet(
            single(rows_of('a', 'x', 'y', 'z', 'b')),
            single(rows_of('a', 'p', 'q', 'r', 's', 't', 'b')),
            matched,
        );
        expect(alignment).toMatchObject({
            addedRows: 2, deletedRows: 0, changedRows: 3, changedCells: 3,
        });
    });

    it('does not pair a deletion with a distant insertion', async () => {
        // 'a' leaves the top and reappears at the bottom with unchanged rows in
        // between: a move, so the runs are not adjacent and must not coalesce
        // into a changed row.
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c', 'd', 'e')),
            single(rows_of('b', 'c', 'd', 'e', 'a')),
            matched,
        );
        expect(alignment).toMatchObject({
            addedRows: 1, deletedRows: 1, changedRows: 0, changedCells: 0,
        });
    });

    it('counts trailing added rows', async () => {
        const alignment = await align_sheet(
            single(rows_of('a')),
            single(rows_of('a', 'b', 'c')),
            matched,
        );
        expect(shape(alignment.rows)).toEqual(['0,0', '-,1', '-,2']);
        expect(alignment.addedRows).toBe(2);
    });

    it('handles an empty original', async () => {
        const alignment = await align_sheet(single([]), single(rows_of('a', 'b')), matched);
        expect(shape(alignment.rows)).toEqual(['-,0', '-,1']);
        expect(alignment).toMatchObject({ addedRows: 2, deletedRows: 0 });
    });

    it('handles an empty modified', async () => {
        const alignment = await align_sheet(single(rows_of('a', 'b')), single([]), matched);
        expect(shape(alignment.rows)).toEqual(['0,-', '1,-']);
        expect(alignment).toMatchObject({ addedRows: 0, deletedRows: 2 });
    });

    it('handles both sides empty', async () => {
        const alignment = await align_sheet(single([]), single([]), matched);
        expect(alignment.rows).toEqual([]);
        expect(alignment.degraded).toBe(false);
    });

    it('counts a changed cell even where the two rows differ only by empties', async () => {
        const alignment = await align_sheet(
            single([['a', '']]),
            single([['a', 'b']]),
            matched,
        );
        expect(alignment).toMatchObject({ changedRows: 1, changedCells: 1 });
    });

    it('compares rows of differing width against the wider column count', async () => {
        const alignment = await align_sheet(
            single([['a']]),
            single([['a', 'extra']]),
            matched,
        );
        expect(alignment).toMatchObject({ changedRows: 1, changedCells: 1 });
    });

    it('degrades to positional when the edit distance exceeds the cap', async () => {
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c', 'd')),
            single(rows_of('w', 'x', 'y', 'z')),
            matched,
            { maxEditDistance: 2 },
        );
        expect(alignment.degraded).toBe(true);
        // Positional fallback: every row pairs by index, so all four are changed.
        expect(shape(alignment.rows)).toEqual(['0,0', '1,1', '2,2', '3,3']);
        expect(alignment).toMatchObject({ addedRows: 0, deletedRows: 0, changedRows: 4 });
    });

    it('aligns two wholly unrelated files without a quadratic-memory blowup', async () => {
        // The regression the linear-space rewrite exists for. The textbook
        // Myers keeps one frontier per edit distance, which for inputs this
        // dissimilar is O(D^2) — gigabytes here, and tens of gigabytes at the
        // default cap, so the process died rather than reaching the graceful
        // degradation it was supposed to reach. Memory is now O(N+M): what
        // this asserts is that the call simply completes.
        const rows = (tag: string) =>
            rows_of(...Array.from({ length: 4_000 }, (_, i) => `${tag}-${i}`));
        const alignment = await align_sheet(
            single(rows('original')),
            single(rows('modified')),
            matched,
        );
        // Nothing in common, so every row is one delete plus one insert; the
        // point is that it answers at all.
        expect(alignment.rows.length).toBeGreaterThan(0);
    });

    it('abandons a hopeless comparison at the cap rather than after it', async () => {
        // The cap is charged against the middle-snake search itself, not
        // checked once the search has finished. Checking afterwards made the
        // capped path slower than the uncapped one — it paid the full cost and
        // then threw the answer away.
        const rows = (tag: string) =>
            rows_of(...Array.from({ length: 4_000 }, (_, i) => `${tag}-${i}`));
        const alignment = await align_sheet(
            single(rows('original')),
            single(rows('modified')),
            matched,
            { maxEditDistance: 64 },
        );
        expect(alignment.degraded).toBe(true);
    });

    it('still aligns a large file whose changes are few', async () => {
        // Prefix/suffix trimming must keep this cheap: without it, Myers would
        // run over 20,000 rows rather than the handful that actually differ.
        const original = rows_of(...Array.from({ length: 20_000 }, (_, i) => `row-${i}`));
        const modified = original.slice();
        modified.splice(10_000, 0, ['inserted']);
        const alignment = await align_sheet(single(original), single(modified), matched, {
            maxEditDistance: 16,
        });
        expect(alignment).toMatchObject({
            addedRows: 1, deletedRows: 0, changedRows: 0, degraded: false,
        });
        expect(alignment.rows).toHaveLength(20_001);
    });

    it('reports progress while scanning', async () => {
        const seen: number[] = [];
        await align_sheet(
            single(rows_of(...Array.from({ length: 400 }, (_, i) => `r${i}`))),
            single(rows_of(...Array.from({ length: 400 }, (_, i) => `r${i}`))),
            matched,
            { rowsPerCheckpoint: 100, onProgress: (scanned) => seen.push(scanned) },
        );
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[seen.length - 1]).toBeLessThanOrEqual(800);
        // Monotonic, so a progress bar never runs backwards.
        expect(seen).toEqual([...seen].sort((left, right) => left - right));
    });

    it('throws when cancelled mid-scan', async () => {
        const rows = rows_of(...Array.from({ length: 4_000 }, (_, i) => `r${i}`));
        await expect(align_sheet(single(rows), single(rows), matched, {
            rowsPerCheckpoint: 100,
            isCancelled: () => true,
        })).rejects.toBeInstanceOf(AlignmentCancelledError);
    });

    it('refuses an unmatched pairing', async () => {
        await expect(align_sheet(single([]), single([]), {
            status: 'added', name: 'Sheet1', modifiedIndex: 0,
        })).rejects.toThrow(/matched sheet pairing/u);
    });
});

describe('identity_alignment', () => {
    it('pairs by position and marks the tail of the longer side', () => {
        expect(shape(identity_alignment(2, 4))).toEqual(['0,0', '1,1', '-,2', '-,3']);
        expect(shape(identity_alignment(3, 1))).toEqual(['0,0', '1,-', '2,-']);
    });
});
