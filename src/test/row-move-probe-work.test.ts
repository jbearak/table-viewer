// How much the Move dry run reads on a worksheet with many merges and a
// fragmented layout: each merge's destination check finds its staying rows by
// binary search, not by walking the removed rows from the start once per merge.
import { describe, expect, it, vi } from 'vitest';
import type { PendingStructuralChanges, RowIdentity } from '../pending-changes';
import type { SourceInterval } from '../worksheet-layout';
import { move_rows, probe_row_move_runs } from '../webview/pending-row-store';

const reads = vi.hoisted(() => ({ count: 0 }));

vi.mock('../worksheet-layout', async (import_original) => {
    const original = await import_original<typeof import('../worksheet-layout')>();
    return {
        ...original,
        // The interval lists the merge checks search, counting every entry read.
        canonical_source_intervals(intervals: readonly SourceInterval[]) {
            const canonical = original.canonical_source_intervals(intervals);
            return new Proxy(canonical, {
                get(target, key, receiver) {
                    if (typeof key === 'string' && /^\d+$/u.test(key)) reads.count += 1;
                    return Reflect.get(target, key, receiver);
                },
            });
        },
    };
});

const BODY_START = 2;
const REMOVED = 10_000;
const MERGES = 500;
// Removed rows 2, 4, …; then a moved row; then the merges, two rows each.
const MERGES_START = BODY_START + 2 * REMOVED + 8;
const SOURCE_ROWS = MERGES_START + 4 * MERGES + 10;

describe('probe_row_move_runs work', () => {
    it('checks each merge in a binary search of the removed rows, not a walk of them', () => {
        const basis = {
            kind: 'delimited' as const, byteLength: 40, digest: 'abc', sourceRowCount: SOURCE_ROWS, sourceColumnCount: 2,
        };
        const ctx = {
            worksheet: { sheetIndex: 0, sheetName: 'data' },
            bodyStart: BODY_START,
            sourceRowCount: SOURCE_ROWS,
            sourceColumnCount: 2,
            bodyViewTransformed: false,
            structuralBasis: basis,
            merges: Array.from({ length: MERGES }, (_, index) => ({
                startRow: MERGES_START + 4 * index, endRow: MERGES_START + 4 * index + 1, startCol: 0, endCol: 1,
            })),
        };
        const changes: PendingStructuralChanges = {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
            structuralBasis: basis,
            rowLayout: {
                runs: [{ kind: 'source', start: BODY_START, count: SOURCE_ROWS - BODY_START }],
                removedSourceRows: Array.from({ length: REMOVED }, (_, index) => ({ start: BODY_START + 2 * index, count: 1 })),
                discardedPendingRows: [],
            },
        };
        const moved = MERGES_START - 4;
        const before: RowIdentity = { kind: 'source', sourceRow: SOURCE_ROWS - 2 };
        const expected = move_rows(changes, ctx, [{ kind: 'source', sourceRow: moved }], before);
        reads.count = 0;
        const actual = probe_row_move_runs(changes, ctx, [{ kind: 'source', start: moved, count: 1 }], before);
        expect(actual.ok).toBe(expected.ok);
        expect(actual.ok).toBe(true);
        // Building the lists reads them once (tens of thousands); a walk from
        // the start per merge reads millions.
        expect(reads.count).toBeLessThan(200_000);
    });
});
