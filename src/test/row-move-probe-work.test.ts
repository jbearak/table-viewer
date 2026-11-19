// How much the Move dry run reads on a worksheet with many merges and a
// fragmented layout: each merge's checks and each run's live ends are found
// by binary search, not by walking the removed rows from the start each time;
// and the dry run never hands the layout one identity per selected row.
import { describe, expect, it, vi } from 'vitest';
import type { PendingStructuralChanges, RowIdentity } from '../pending-changes';
import type { SourceInterval } from '../worksheet-layout';
import { move_rows, probe_row_move_runs } from '../webview/pending-row-store';
import {
    resolve_row_structure_selection,
    row_move_item_model,
    type RowStructureSelection,
} from '../webview/row-structure-model';

/** An array whose entry reads are counted: the removed rows as the layout stores them. */
function counted<T>(entries: T[]): T[] {
    return new Proxy(entries, {
        get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/u.test(key)) reads.count += 1;
            return Reflect.get(target, key, receiver);
        },
    });
}

const reads = vi.hoisted(() => ({ count: 0, identity_moves: 0, run_probes: 0 }));

vi.mock('../worksheet-layout', async (import_original) => {
    const original = await import_original<typeof import('../worksheet-layout')>();
    return {
        ...original,
        // The identity move `move_rows` plans with, and the run-based one.
        move_rows(...args: Parameters<typeof original.move_rows>) {
            reads.identity_moves += 1;
            return original.move_rows(...args);
        },
        probe_row_move(...args: Parameters<typeof original.probe_row_move>) {
            reads.run_probes += 1;
            return original.probe_row_move(...args);
        },
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
                removedSourceRows: counted(Array.from(
                    { length: REMOVED }, (_, index) => ({ start: BODY_START + 2 * index, count: 1 }),
                )),
                discardedPendingRows: [],
            },
        };
        const moved = MERGES_START - 4;
        const before: RowIdentity = { kind: 'source', sourceRow: SOURCE_ROWS - 2 };
        const expected = move_rows(changes, ctx, [{ kind: 'source', sourceRow: moved }], before);
        reads.count = 0;
        reads.run_probes = 0;
        reads.identity_moves = 0;
        const actual = probe_row_move_runs(changes, ctx, [{ kind: 'source', start: moved, count: 1 }], before);
        expect(actual.ok).toBe(expected.ok);
        expect(actual.ok).toBe(true);
        expect(reads.run_probes).toBeGreaterThan(0);
        // Building the lists reads them once (tens of thousands); a walk from
        // the start per merge reads millions.
        expect(reads.count).toBeLessThan(200_000);
        // Planned by the runs, not by listing the rows for the identity move.
        expect(reads.identity_moves).toBe(0);
    });

    it('decides a Move item for a block spanning the removals and merges by search', () => {
        // One block from the body's first row through every merge, all of
        // them whole inside it, moved down one step.
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
        const removed = counted(Array.from(
            { length: REMOVED }, (_, index) => ({ start: BODY_START + 2 * index, count: 1 }),
        ));
        const changes: PendingStructuralChanges = {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
            structuralBasis: basis,
            rowLayout: {
                runs: [{ kind: 'source', start: BODY_START, count: SOURCE_ROWS - BODY_START }],
                removedSourceRows: removed,
                discardedPendingRows: [],
            },
        };
        const count = MERGES_START + 4 * MERGES - BODY_START;
        const base = resolve_row_structure_selection(
            { rowCount: SOURCE_ROWS, row_at: () => undefined, source_row_runs: () => [], deletedBandStart: SOURCE_ROWS },
            [],
            { bodyStart: BODY_START, isRemoved: () => false },
        );
        const selection: RowStructureSelection = {
            ...base,
            count,
            runs: [{ kind: 'source', start: BODY_START, count }],
            get identities(): never {
                throw new Error('listed every selected row');
            },
            removedSourceRuns: [],
            removedCount: 0,
            fixedRows: false,
            tailRemovals: false,
            contiguous: true,
            bandRows: 0,
        };
        reads.count = 0;
        reads.run_probes = 0;
        reads.identity_moves = 0;
        const model = row_move_item_model(
            { support: { supported: true }, ready: true, selection, changes, context: ctx },
            'forward',
        );
        expect(model.enabled ? 'enabled' : model.reason).toBe('enabled');
        expect(reads.run_probes).toBe(1);
        expect(reads.identity_moves).toBe(0);
        // Indexing and sorting the removed rows reads them about 20 times over
        // (about 200,000 reads); walking them per merge reads 10 million.
        expect(reads.count).toBeLessThan(1_000_000);
    });
});
