import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    ABSENT,
    AlignmentCancelledError,
    align_sheet,
    identity_alignment,
    type AlignedRow,
} from '../diff-compare/row-alignment';
import type { SheetPairing } from '../diff-compare/compare-source';
import {
    DEFERRED_COMPARISON_IDENTITY,
    type DataSource,
    type DeferredCellIdentity,
    type RawCell,
    type RowWindow,
    type WorkbookMeta,
} from '../data-source/interface';
import { FixtureSource } from './helpers/fixture-source';

const single = (rows: string[][]): FixtureSource =>
    new FixtureSource([{ name: 'Sheet1', rows }]);

const raw_cell = (raw: string): RawCell => ({ raw, rawType: 'string' });

class RawFixtureSource implements DataSource {
    constructor(protected readonly fixture_rows: readonly (readonly (RawCell | null)[])[]) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: this.fixture_rows.length,
                sourceRowCount: this.fixture_rows.length,
                columnCount: this.fixture_rows.reduce(
                    (widest, row) => Math.max(widest, row.length),
                    0,
                ),
                merges: [],
                hasFormatting: false,
            }],
        };
    }

    read_rows(_sheet_index: number, start_row: number, count: number): RowWindow {
        const start = Math.max(0, Math.min(start_row, this.fixture_rows.length));
        return {
            startRow: start,
            rows: this.fixture_rows.slice(start, start + count).map((row) => row.map((cell) =>
                cell === null
                    ? null
                    : Object.assign(cell, {
                        formatted: cell.raw ?? '',
                        bold: false,
                        italic: false,
                    }))),
        };
    }

    close(): void {}
}

class IndexedRawFixtureSource extends RawFixtureSource {
    readonly indexedReads: number[][] = [];

    async read_raw_columns_indexed_async(
        _sheet_index: number,
        row_indices: ArrayLike<number>,
        column_indices: readonly number[],
    ) {
        const requested = Array.from(row_indices);
        this.indexedReads.push(requested);
        return {
            rows: requested.map((row) => column_indices.map(
                (column) => this.fixture_rows[row]?.[column] ?? null,
            )),
        };
    }
}

function deferred_binary_cell(key: string, raw_byte_length: number): RawCell {
    const identity: DeferredCellIdentity = {
        cachedKey: () => key,
        resolveKey: async () => key,
    };
    const cell: RawCell = {
        raw: `binary (${raw_byte_length} bytes)`,
        rawType: 'string',
        rawByteLength: raw_byte_length,
    };
    Object.defineProperty(cell, DEFERRED_COMPARISON_IDENTITY, { value: identity });
    return cell;
}

const eager_identity_cell = (
    comparison_key: string,
    raw_byte_length: number,
): RawCell => ({
    raw: '',
    rawType: 'string',
    comparisonKey: comparison_key,
    rawByteLength: raw_byte_length,
});

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

function single_raw_cell_row_hash(raw: string): number {
    let hash = 0x811c9dc5;
    const mix = (value: number) => {
        hash ^= value;
        hash = Math.imul(hash, 0x01000193);
    };
    mix(1);
    mix(raw.length);
    for (let index = 0; index < raw.length; index++) mix(raw.charCodeAt(index));
    return hash >>> 0;
}

describe('align_sheet', () => {
    it('pairs identical files row for row', async () => {
        const rows = rows_of('a', 'b', 'c');
        const alignment = await align_sheet(single(rows), single(rows), matched);
        expect(shape(alignment.rows)).toEqual(['0,0', '1,1', '2,2']);
        expect(alignment).toMatchObject({
            addedRows: 0, deletedRows: 0, changedCells: 0, degraded: false,
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
            addedRows: 1, deletedRows: 0, changedCells: 0,
        });
    });

    it('reports a deleted row as one deletion', async () => {
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c')),
            single(rows_of('a', 'c')),
            matched,
        );
        expect(shape(alignment.rows)).toEqual(['0,0', '1,-', '2,1']);
        expect(alignment).toMatchObject({ addedRows: 0, deletedRows: 1 });
    });

    it('reports an in-place edit as a changed row, with no add or delete', async () => {
        const alignment = await align_sheet(
            single([['a', 'x'], ['b', 'y']]),
            single([['a', 'x'], ['b', 'CHANGED']]),
            matched,
        );
        expect(shape(alignment.rows)).toEqual(['0,0', '1,1']);
        expect(alignment).toMatchObject({
            addedRows: 0, deletedRows: 0, changedCells: 1,
        });
    });

    it('pairs a moved row at its new position instead of a delete and an add', async () => {
        // Was asserted the other way until move detection existed: Myers has no
        // move op, so 'a' came out as a deletion plus an unrelated insertion.
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c', 'd')),
            single(rows_of('b', 'c', 'd', 'a')),
            matched,
        );
        expect(shape(alignment.rows)).toEqual(['1,0', '2,1', '3,2', '0,3']);
        expect(alignment).toMatchObject({
            addedRows: 0, deletedRows: 0, changedCells: 0, movedRowIndices: [3],
        });
    });

    it('rejects a real FNV collision instead of claiming an exact move', async () => {
        expect(single_raw_cell_row_hash('45zx')).toBe(2244945817);
        expect(single_raw_cell_row_hash('fpcd')).toBe(2244945817);

        const alignment = await align_sheet(
            single(rows_of('45zx', 'anchor')),
            single(rows_of('anchor', 'fpcd')),
            matched,
            { maxMoveSearchRows: 0 },
        );

        expect(shape(alignment.rows)).toEqual(['0,-', '1,0', '-,1']);
        expect(alignment).toMatchObject({
            addedRows: 1,
            deletedRows: 1,
            movedRowIndices: [],
        });
    });

    it('verifies exact move candidates through deferred cell equality', async () => {
        const exactly_equals = vi.fn(() => true);
        const deferred_cell = (identity: DeferredCellIdentity): RawCell => {
            const value: RawCell = { raw: 'bounded preview', rawType: 'string' };
            Object.defineProperty(value, DEFERRED_COMPARISON_IDENTITY, { value: identity });
            return value;
        };
        const original_identity: DeferredCellIdentity = {
            cachedKey: () => undefined,
            resolveKey: async () => 'same-lossless-value',
            exactlyEquals: exactly_equals,
        };
        const modified_identity: DeferredCellIdentity = {
            cachedKey: () => undefined,
            resolveKey: async () => 'same-lossless-value',
        };
        const alignment = await align_sheet(
            new RawFixtureSource([
                [deferred_cell(original_identity)],
                [raw_cell('anchor')],
            ]),
            new RawFixtureSource([
                [raw_cell('anchor')],
                [deferred_cell(modified_identity)],
            ]),
            matched,
        );

        expect(exactly_equals).toHaveBeenCalled();
        expect(shape(alignment.rows)).toEqual(['1,0', '0,1']);
        expect(alignment.movedRowIndices).toEqual([1]);
    });

    it('reads exact move candidates sparsely in bounded batches', async () => {
        const values = Array.from({ length: 600 }, (_, index) => `row-${index}`);
        const original = new IndexedRawFixtureSource(
            values.map((value) => [raw_cell(value)]),
        );
        const modified = new IndexedRawFixtureSource(
            [...values].reverse().map((value) => [raw_cell(value)]),
        );

        const alignment = await align_sheet(original, modified, matched);

        expect(alignment).toMatchObject({ addedRows: 0, deletedRows: 0 });
        expect(original.indexedReads.some((rows) => rows.length === 512)).toBe(true);
        expect(modified.indexedReads.some((rows) => rows.length === 512)).toBe(true);
        expect([...original.indexedReads, ...modified.indexedReads]
            .every((rows) => rows.length <= 512)).toBe(true);
    });

    it('yields during exact move verification so cancellation can arrive', async () => {
        const moved_row = Array.from({ length: 300 }, () => raw_cell('same'));
        const original = new IndexedRawFixtureSource([
            moved_row,
            [raw_cell('anchor')],
        ]);
        const modified = new IndexedRawFixtureSource([
            [raw_cell('anchor')],
            moved_row,
        ]);
        let cancellation_checks_after_exact_reads = 0;

        await expect(align_sheet(original, modified, matched, {
            isCancelled: () => {
                if (original.indexedReads.length === 0 || modified.indexedReads.length === 0) {
                    return false;
                }
                cancellation_checks_after_exact_reads += 1;
                // Admit the modified adapter's final publication check. The next
                // check is the real macrotask checkpoint after 256 exact cells.
                return cancellation_checks_after_exact_reads > 1;
            },
        })).rejects.toBeInstanceOf(AlignmentCancelledError);
        expect(original.indexedReads).toHaveLength(1);
        expect(modified.indexedReads).toHaveLength(1);
        expect(cancellation_checks_after_exact_reads).toBe(2);
    });

    it('reports the changed cells of a row that moved and was edited', async () => {
        // The case that motivates move detection. Before it existed this was
        // one deletion plus one addition with changedCells 0 — the 20 to 99
        // edit was invisible AS an edit, leaving the user to eyeball a red row
        // against a green one to find it.
        const alignment = await align_sheet(
            single([['Al', 'Eng', '10'], ['Bo', 'Ops', '20'], ['Cy', 'Fin', '30']]),
            single([['Al', 'Eng', '10'], ['Cy', 'Fin', '30'], ['Bo', 'Ops', '99']]),
            matched,
        );
        expect(shape(alignment.rows)).toEqual(['0,0', '2,1', '1,2']);
        expect(alignment).toMatchObject({
            addedRows: 0, deletedRows: 0,
            changedCells: 1, changedRowIndices: [2], movedRowIndices: [2],
        });
    });

    it('weights an unchanged deferred binary by source bytes when scoring a move', async () => {
        const key = `stata-binary:sha256:${'a'.repeat(64)}:1024`;
        const original = new RawFixtureSource([
            [deferred_binary_cell(key, 1024), raw_cell('x'.repeat(200))],
            [raw_cell('anchor')],
        ]);
        const modified = new RawFixtureSource([
            [raw_cell('anchor')],
            [deferred_binary_cell(key, 1024), raw_cell('y'.repeat(200))],
        ]);

        const alignment = await align_sheet(original, modified, matched);

        expect(shape(alignment.rows)).toEqual(['1,0', '0,1']);
        expect(alignment).toMatchObject({
            addedRows: 0,
            deletedRows: 0,
            changedCells: 1,
            movedRowIndices: [1],
            changedRowIndices: [1],
        });
    });

    it('normalizes move candidates returned through a cross-realm promise', async () => {
        const cross_realm_key = runInNewContext(
            'Promise.resolve("same-lossless-value")',
        ) as Promise<string>;
        const deferred_cell = (preview: string): RawCell => {
            const identity: DeferredCellIdentity = {
                cachedKey: () => undefined,
                resolveKey: () => cross_realm_key,
            };
            const value: RawCell = {
                raw: preview,
                rawType: 'string',
                rawByteLength: 1024,
            };
            Object.defineProperty(value, DEFERRED_COMPARISON_IDENTITY, { value: identity });
            return value;
        };
        const original = new RawFixtureSource([
            [deferred_cell('old preview'), raw_cell('x')],
            [raw_cell('anchor')],
        ]);
        const modified = new RawFixtureSource([
            [raw_cell('anchor')],
            [deferred_cell('new preview'), raw_cell('y')],
        ]);

        const alignment = await align_sheet(original, modified, matched);

        expect(shape(alignment.rows)).toEqual(['1,0', '0,1']);
        expect(alignment).toMatchObject({
            addedRows: 0,
            deletedRows: 0,
            changedCells: 1,
            movedRowIndices: [1],
        });
    });

    it('weights an eager comparison identity by source bytes when scoring a move', async () => {
        const key = `stata-binary:sha256:${'b'.repeat(64)}:1024`;
        const original = new RawFixtureSource([
            [eager_identity_cell(key, 1024), raw_cell('x'.repeat(200))],
            [raw_cell('anchor')],
        ]);
        const modified = new RawFixtureSource([
            [raw_cell('anchor')],
            [eager_identity_cell(key, 1024), raw_cell('y'.repeat(200))],
        ]);

        const alignment = await align_sheet(original, modified, matched);

        expect(shape(alignment.rows)).toEqual(['1,0', '0,1']);
        expect(alignment).toMatchObject({
            addedRows: 0,
            deletedRows: 0,
            changedCells: 1,
            movedRowIndices: [1],
            changedRowIndices: [1],
        });
    });

    it('does not pair distinct zero-preview comparison identities as a move', async () => {
        const original = new RawFixtureSource([
            [eager_identity_cell('old-id', 0)],
            [raw_cell('anchor')],
        ]);
        const modified = new RawFixtureSource([
            [raw_cell('anchor')],
            [eager_identity_cell('new-id', 0)],
        ]);

        const alignment = await align_sheet(original, modified, matched);

        expect(alignment).toMatchObject({
            addedRows: 1,
            deletedRows: 1,
            movedRowIndices: [],
        });
    });

    it('still pairs the same zero-preview comparison identity as a move', async () => {
        const original = new RawFixtureSource([
            [eager_identity_cell('same-id', 0)],
            [raw_cell('anchor')],
        ]);
        const modified = new RawFixtureSource([
            [raw_cell('anchor')],
            [eager_identity_cell('same-id', 0)],
        ]);

        const alignment = await align_sheet(original, modified, matched);

        expect(shape(alignment.rows)).toEqual(['1,0', '0,1']);
        expect(alignment.movedRowIndices).toEqual([1]);
    });

    it('still pairs an ordinary blank row as a move', async () => {
        const alignment = await align_sheet(
            single([[''], ['anchor']]),
            single([['anchor'], ['']]),
            matched,
        );

        expect(shape(alignment.rows)).toEqual(['1,0', '0,1']);
        expect(alignment.movedRowIndices).toEqual([1]);
    });

    it('pairs a whole re-sort after exact candidate verification', async () => {
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c', 'd')),
            single(rows_of('d', 'c', 'b', 'a')),
            matched,
        );
        expect(shape(alignment.rows)).toEqual(['3,0', '2,1', '1,2', '0,3']);
        expect(alignment).toMatchObject({
            addedRows: 0, deletedRows: 0, changedCells: 0,
        });
    });

    it('pairs an adjacent swap as two moves rather than four one-sided rows', async () => {
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c')),
            single(rows_of('b', 'a', 'c')),
            matched,
        );
        expect(alignment).toMatchObject({ addedRows: 0, deletedRows: 0, changedCells: 0 });
        expect(alignment.rows).toHaveLength(3);
    });

    it('leaves a below-threshold pair as a delete and an add', async () => {
        // Similarity is whole-cell, so a row whose content lives in one edited
        // cell scores zero. Pinned deliberately: the metric fails safely (this
        // is exactly the pre-move-detection behavior), and asserting the
        // boundary keeps it a decision rather than an accident.
        const alignment = await align_sheet(
            single(rows_of('x', 'customer-000123', 'y')),
            single(rows_of('x', 'y', 'customer-000124')),
            matched,
        );
        expect(alignment).toMatchObject({
            addedRows: 1, deletedRows: 1, movedRowIndices: [],
        });
    });

    it('does not count comparison namespaces as sparse-row content', async () => {
        const alignment = await align_sheet(
            single([
                ['old-id', '', '', ''],
                ['anchor', '', '', ''],
            ]),
            single([
                ['anchor', '', '', ''],
                ['new-id', '', '', ''],
            ]),
            matched,
        );
        expect(alignment).toMatchObject({
            addedRows: 1,
            deletedRows: 1,
            movedRowIndices: [],
        });
    });

    it('pairs each moved row with its strongest match, not its nearest', async () => {
        // Both destinations clear the 50% threshold against both sources, so
        // ranking decides. Ranking on displacement alone pairs each row with
        // whichever source sits closest, which here is the weaker match on
        // both counts: four changed cells reported where two actually changed.
        const alignment = await align_sheet(
            new FixtureSource([{ name: 'S', rows: [
                ['a', 'a', 'b', 'b'],
                ['a', 'a', 'x', 'z'],
                ['KEEP', '', '', ''],
            ] }]),
            new FixtureSource([{ name: 'S', rows: [
                ['KEEP', '', '', ''],
                ['a', 'a', 'b', 'y'],
                ['a', 'a', 'x', 'y'],
            ] }]),
            matched,
        );
        expect(alignment.movedRowIndices).toEqual([1, 2]);
        expect(shape(alignment.rows)).toEqual(['2,0', '0,1', '1,2']);
        expect(alignment.changedCells).toBe(2);
    });

    it('pairs duplicate identical rows identically across runs', async () => {
        const original = single(rows_of('dup', 'dup', 'a', 'b', 'dup'));
        const modified = single(rows_of('a', 'b', 'dup', 'dup', 'dup'));
        const first = await align_sheet(original, modified, matched);
        const second = await align_sheet(original, modified, matched);
        expect(shape(second.rows)).toEqual(shape(first.rows));
        expect(second.movedRowIndices).toEqual(first.movedRowIndices);
    });

    it('still finds exact moves when the inexact phase is over its work cap', async () => {
        // 'x' moves identically and costs nothing to detect; the edited Bo row
        // moved too far to be adjacent, so it needs a similarity score and is
        // given up on. Exact moves are never
        // discarded for being numerous — a re-sorted huge file is the case that
        // most needs detection and is the cheapest to serve.
        const alignment = await align_sheet(
            single([['x'], ['Bo', 'Ops', '20'], ['keep'], ['y']]),
            single([['keep'], ['y'], ['x'], ['Bo', 'Ops', '99']]),
            matched,
            { maxMoveSearchRows: 0 },
        );
        expect(alignment.moveSearchTruncated).toBe(true);
        // Pinned by shape, not by count: an implementation that lost the exact
        // pass but ran the capped inexact one would pair the edited Bo row
        // instead, and both a non-zero moved count and the add/delete pair
        // below would still hold, with the two rows swapped.
        expect(shape(alignment.rows)).toEqual(['1,-', '2,0', '3,1', '0,2', '-,3']);
        expect(alignment.movedRowIndices).toEqual([3]);
        // The row needing a score stayed a delete plus an add, as before.
        expect(alignment).toMatchObject({ addedRows: 1, deletedRows: 1 });
    });

    it('observes a cancel when every scored pair is rejected on length', async () => {
        // The scoring loop's checkpoint counted pairs that SURVIVED the size
        // prefilter, so a run where every pair is rejected never reached one
        // and could not be cancelled — and rejection is the cheap-per-pair
        // case, which is where the iteration count runs highest.
        const size = 400;
        const original = single([
            ...Array.from({ length: size }, (_, index) => [`${'x'.repeat(80)}${index}`]),
            ['anchor'],
        ]);
        const modified = single([
            ['anchor'],
            ...Array.from({ length: size }, (_, index) => [String(index % 10)]),
        ]);
        // Armed by the move pass's own reads, so the cancel becomes visible
        // only once scoring is under way. Arming it on hashing progress
        // instead lets the hashing checkpoint catch it, and the test then
        // passes whether or not the scoring loop yields at all.
        let armed = false;
        let reads = 0;
        const arm_on_move_reads = new Proxy(original, {
            get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== 'read_rows' || typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                    // Hashing reads this side in one batch; the move pass then
                    // reads its candidates one scattered row at a time. So the
                    // second read onwards can only be the move pass.
                    if (++reads > 1) armed = true;
                    return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
            },
        });
        const pending = align_sheet(arm_on_move_reads, modified, matched, {
            maxMoveSearchRows: size,
            isCancelled: () => armed,
        });
        await expect(pending).rejects.toBeInstanceOf(AlignmentCancelledError);
        // The error alone proves nothing: `count_changes` runs after the move
        // pass and has a checkpoint of its own, so an uncancellable scoring
        // loop still ends in an AlignmentCancelledError — thrown one phase too
        // late, after the whole quadratic loop has already run. Reads tell the
        // two apart. `count_changes` reads a third time to compare the paired
        // `anchor` row; observing the cancel during scoring means it never got
        // that far.
        expect(reads).toBe(2);
    });

    it('does not hunt for moves in a degraded alignment', async () => {
        // A degraded alignment is positional and means "these files do not
        // correspond"; decorating it with moves would dress a failed alignment
        // up as a partial result.
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c', 'd')),
            single(rows_of('d', 'c', 'b', 'a')),
            matched,
            { maxEditDistance: 1 },
        );
        expect(alignment.degraded).toBe(true);
        expect(alignment.movedRowIndices).toEqual([]);
        expect(alignment.moveSearchTruncated).toBe(false);
    });

    it('observes a cancel raised before the move pass runs', async () => {
        let hashed = false;
        await expect(align_sheet(
            single(rows_of('a', 'b', 'c', 'd')),
            single(rows_of('d', 'c', 'b', 'a')),
            matched,
            {
                rowsPerCheckpoint: 1,
                isCancelled: () => {
                    const was = hashed;
                    hashed = true;
                    return was;
                },
            },
        )).rejects.toBeInstanceOf(AlignmentCancelledError);
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
            addedRows: 2, deletedRows: 0, changedCells: 3,
        });
    });

    it('reports a distant deletion and insertion of the same row as one move', async () => {
        // 'a' leaves the top and reappears at the bottom. The runs are not
        // adjacent, so build_rows cannot coalesce them into a changed row —
        // which would be wrong anyway. The move pass pairs them instead, and
        // must not report the pairing as changed cells.
        const alignment = await align_sheet(
            single(rows_of('a', 'b', 'c', 'd', 'e')),
            single(rows_of('b', 'c', 'd', 'e', 'a')),
            matched,
        );
        expect(alignment).toMatchObject({
            addedRows: 0, deletedRows: 0, changedCells: 0,
            movedRowIndices: [4], changedRowIndices: [],
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
        expect(alignment).toMatchObject({ changedCells: 1 });
    });

    it('hashes trailing absent, null, and empty cells at the shared width', async () => {
        const original = new RawFixtureSource([
            [raw_cell('a')],
            [raw_cell('b'), null],
            [raw_cell('c'), raw_cell('')],
        ]);
        const modified = new RawFixtureSource([
            [raw_cell('a'), null],
            [raw_cell('b'), raw_cell('')],
            [raw_cell('c')],
        ]);

        const alignment = await align_sheet(original, modified, matched, {
            maxEditDistance: 0,
        });

        expect(shape(alignment.rows)).toEqual(['0,0', '1,1', '2,2']);
        expect(alignment).toMatchObject({
            addedRows: 0,
            deletedRows: 0,
            changedCells: 0,
            degraded: false,
        });
    });

    it('compares rows of differing width against the wider column count', async () => {
        const alignment = await align_sheet(
            single([['a']]),
            single([['a', 'extra']]),
            matched,
        );
        expect(alignment).toMatchObject({ changedCells: 1 });
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
        expect(alignment).toMatchObject({ addedRows: 0, deletedRows: 0 });
    });

    it('does not conflate cell boundaries with cell text', async () => {
        // The row hash once used a unit separator between cells, so a cell
        // whose own text contained one hashed identically to the two cells it
        // looked like. Prefix trimming pairs rows on hash alone, so this was
        // not a near-miss: it aligned two structurally different rows and
        // reported the genuinely unchanged row below as an addition.
        const alignment = await align_sheet(
            single([['a\u001fb'], ['tail']]),
            single([['a', 'b'], ['a\u001fb'], ['tail']]),
            matched,
        );
        expect(alignment).toMatchObject({
            addedRows: 1, deletedRows: 0, changedCells: 0,
        });
    });

    it('accepts an edit distance that exactly fills the cap', async () => {
        // The cap bounds the whole comparison, and a parent's distance already
        // covers every edit its children re-find at finer grain. Deducting each
        // recursive step from the remaining budget charged the same edits twice
        // and degraded inputs that comfortably fit.
        const alignment = await align_sheet(
            single(rows_of('a', 'M', 'b', 'c')),
            single(rows_of('A', 'M', 'B', 'C')),
            matched,
            { maxEditDistance: 6 },
        );
        expect(alignment.degraded).toBe(false);
    });

    it('degrades when a single substitution exceeds a tiny cap', async () => {
        // One substitution is a distance of 2, so caps of 0 and 1 must both
        // degrade. The search's depth bound alone is a step too loose to say
        // so — the distance itself is what has to be checked.
        for (const cap of [0, 1]) {
            const alignment = await align_sheet(
                single(rows_of('a')),
                single(rows_of('b')),
                matched,
                { maxEditDistance: cap },
            );
            expect(alignment.degraded, `cap ${cap}`).toBe(true);
        }
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
            addedRows: 1, deletedRows: 0, degraded: false,
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

    it('stops change counting when sparse raw reads observe cancellation', async () => {
        const rows = rows_of(...Array.from({ length: 1_200 }, (_, index) => `r${index}`));
        const original = single(rows);
        let original_reads = 0;
        let counting_changes = false;
        const observed = new Proxy(original, {
            get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== 'read_rows' || typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                    original_reads += 1;
                    // Hashing uses three 512-row reads. The fourth starts change
                    // counting and arms cancellation; the indexed raw adapter
                    // observes it before a later fallback run can start.
                    if (original_reads > 3) counting_changes = true;
                    return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
            },
        });

        await expect(align_sheet(observed, single(rows), matched, {
            rowsPerCheckpoint: 700,
            isCancelled: () => counting_changes,
        })).rejects.toBeInstanceOf(AlignmentCancelledError);
        expect(original_reads).toBe(4);
    });

    it('throws when cancelled before a sheet too small to checkpoint', async () => {
        // Cancellation used to be observed only at a hash checkpoint, so a
        // sheet that finished hashing without reaching one ran to completion
        // after the user had already cancelled — and a workbook of small
        // sheets ignored Cancel outright.
        await expect(align_sheet(single([]), single([['x']]), matched, {
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

// A randomized cross-check of the aligner against a brute-force LCS.
//
// The linear-space Myers rewrite is subtle in a way that fails quietly: a
// mistaken parity case or a stale frontier entry yields a valid-looking but
// non-minimal edit script, which reads as "these rows changed" for rows that
// merely moved. The examples above pin the behaviours that were specified;
// this pins the property that makes them all true at once.
describe('aligner minimality', () => {
    /** Longest common subsequence — the ground truth a minimal diff must reach. */
    function lcs(a: readonly string[], b: readonly string[]): number {
        const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                dp[i][j] = a[i - 1] === b[j - 1]
                    ? dp[i - 1][j - 1] + 1
                    : Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
        return dp[a.length][b.length];
    }

    /** Seeded so a failure is reproducible rather than a one-off CI story. */
    function rng(seed: number): () => number {
        let state = seed >>> 0;
        return () => {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state / 4294967296;
        };
    }

    it('produces a minimal, correctly ordered alignment for random inputs', async () => {
        const random = rng(12345);
        for (let trial = 0; trial < 400; trial++) {
            // A small alphabet makes coincidental matches common, which is what
            // actually exercises the divide-and-conquer rather than the
            // prefix/suffix trim.
            const alphabet = 1 + Math.floor(random() * 6);
            const generate = (length: number) => Array.from({ length },
                () => String.fromCharCode(97 + Math.floor(random() * alphabet)));
            const left = generate(Math.floor(random() * 30));
            // Sometimes a truncation of the other side: empty and lopsided
            // pairs take branches random pairs rarely reach.
            const right = random() < 0.25
                ? left.slice(0, Math.floor(random() * (left.length + 1)))
                : generate(Math.floor(random() * 30));
            const context = `${left.join('')} vs ${right.join('')}`;

            const alignment = await align_sheet(
                single(rows_of(...left)),
                single(rows_of(...right)),
                matched,
            );
            expect(alignment.degraded, context).toBe(false);

            // Every row of each side appears exactly once: an alignment may
            // pair or orphan a row, never drop or duplicate one. The original
            // side is checked as a permutation rather than a sequence, because
            // detecting a move deliberately lifts a row out of its original
            // order — that reordering IS the finding. Its exactly-once half is
            // the invariant that must survive, so it is asserted separately
            // rather than folded into a weaker single check.
            const originals = alignment.rows
                .map((row) => row.original).filter((row) => row !== ABSENT);
            expect(originals.length, context).toBe(left.length);
            expect([...originals].sort((a, b) => a - b), context)
                .toEqual(left.map((_, index) => index));
            // The modified side stays strictly ascending: a moved row is
            // emitted at the modified slot it already occupied.
            expect(
                alignment.rows.map((row) => row.modified).filter((row) => row !== ABSENT),
                context,
            ).toEqual(right.map((_, index) => index));

            // And it pairs as many equal rows as any diff possibly could.
            // Moved rows are excluded: they pair rows Myers left one-sided, so
            // counting them would push the total above the LCS and turn this
            // minimality check into a tautology. Restricting it to the
            // stationary pairs keeps it pinning what it was written to pin.
            const moved = new Set(alignment.movedRowIndices);
            const equal_pairs = alignment.rows.filter((row, index) =>
                !moved.has(index)
                && row.original !== ABSENT && row.modified !== ABSENT
                && left[row.original] === right[row.modified]).length;
            expect(equal_pairs, context).toBe(lcs(left, right));
        }
    }, 60_000);
});
