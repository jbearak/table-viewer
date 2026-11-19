import { describe, expect, it } from 'vitest';
import type { PendingStructuralChanges } from '../pending-changes';
import { create_pending_row_projection, type PendingRowProjection } from '../webview/pending-row-projection';
import {
    row_fit_targets,
    row_fit_targets_by_resident_rows,
    row_fit_targets_by_rows,
    rows_hold_fit_target,
    type RowFitTargetSources,
} from '../webview/row-fit-targets';
import type { DisplayRowInterval } from '../types';

const saved = (sourceRow: number) => ({
    appendHistoryId: `history-${sourceRow}`,
    sourceRow,
    savedFingerprint: `fingerprint-${sourceRow}`,
    savedRow: { cells: {}, format: { kind: 'none' as const } },
});
const appended = (id: string, createdOrder: number) => ({
    id, cells: {}, formatTemplateId: 'plain', createdOrder,
});
const inserted = (id: string, createdOrder: number) => ({ ...appended(id, createdOrder), origin: 'insert' as const });

/**
 * Band mode: a sorted view of 12 source rows, rows removed at the end, rows
 * appended; with more removals than appended rows some removals stay rows of
 * their own, with fewer the extra appended rows are plain Pending Rows. Rows
 * 3 and 7 have no identity yet.
 */
function band_projection(removed: readonly number[], appended_ids: readonly string[]): PendingRowProjection {
    const displayed = [4, 1, 7, 0, 2, 3, 5, 6, 8, 9, 10, 11];
    const changes: PendingStructuralChanges = {
        formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
        appendedRows: appended_ids.map((id, order) => appended(id, order)),
        tailRemovals: removed.map(saved),
        conflicts: [],
    };
    return create_pending_row_projection({
        sourceDisplayRowCount: displayed.length,
        sourceRowAt: (row) => (row === 3 || row === 7 ? undefined : displayed[row]),
        displayRowForSource: (source) => {
            const index = displayed.indexOf(source);
            return index < 0 ? undefined : index;
        },
        sourceRowCount: 12,
        changes,
        removedSourceDisplayRows: removed.map((source) => displayed.indexOf(source)),
    });
}

/**
 * Band mode over a layout: a sorted view of 12 source rows after source rows
 * 3 and 5 were removed in place, so removed rows sit among saved ones.
 */
function sorted_projection_with_removals(): PendingRowProjection {
    const displayed = [4, 1, 7, 0, 2, 3, 5, 6, 8, 9, 10, 11];
    return create_pending_row_projection({
        sourceDisplayRowCount: displayed.length,
        sourceRowAt: (row) => displayed[row],
        displayRowForSource: (source) => {
            const index = displayed.indexOf(source);
            return index < 0 ? undefined : index;
        },
        sourceRowCount: 12,
        bodyViewTransformed: true,
        changes: {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
            rowLayout: {
                runs: [{ kind: 'source', start: 0, count: 12 }],
                removedSourceRows: [{ start: 3, count: 1 }, { start: 5, count: 1 }],
                discardedPendingRows: [],
            },
        },
    });
}

/**
 * Layout mode: rows moved, one inserted, two removed inline, one appended;
 * or, `ends_removed`, nothing appended and the last rows removed.
 */
function layout_projection(ends_removed = false): PendingRowProjection {
    const changes: PendingStructuralChanges = {
        formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
        appendedRows: ends_removed ? [inserted('ins', 1)] : [inserted('ins', 1), appended('app', 3)],
        tailRemovals: [],
        conflicts: [],
        rowLayout: {
            runs: [
                { kind: 'source', start: 2, count: 1 },
                { kind: 'pending', ids: ['gone', 'ins'] },
                { kind: 'source', start: 3, count: 1 },
                { kind: 'source', start: 6, count: 6 },
                { kind: 'source', start: 4, count: 2 },
            ],
            removedSourceRows: ends_removed
                ? [{ start: 3, count: 1 }, { start: 4, count: 2 }]
                : [{ start: 3, count: 1 }, { start: 5, count: 1 }],
            discardedPendingRows: [{ id: 'gone', createdOrder: 2 }],
        },
    };
    return create_pending_row_projection({
        sourceDisplayRowCount: 12,
        sourceRowAt: (row) => row,
        displayRowForSource: (source) => source,
        sourceRowCount: 12,
        bodyStart: 2,
        bodyViewTransformed: false,
        changes,
    });
}

function random_source(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

function sources_for(
    projection: PendingRowProjection,
    resident: readonly DisplayRowInterval[],
    rendered: ReadonlySet<string>,
    unresolved: ReadonlySet<number>,
): RowFitTargetSources {
    const loaded = (row: number) => resident.some((range) => row >= range.start && row <= range.end);
    return {
        projection,
        resident_rows: () => resident,
        row_loaded: loaded,
        source_row_of: (row) => (unresolved.has(row) ? undefined : 100 + row),
        pending_rendered: (id) => rendered.has(id),
    };
}

const sorted = <T extends { display_row: number }>(list: readonly T[]) =>
    [...list].sort((left, right) => left.display_row - right.display_row);

describe('row_fit_targets', () => {
    const cases = [
        ['band mode with removals left over', () => band_projection([8, 9, 10, 11], ['replacement'])],
        ['band mode with Pending Rows left over', () => band_projection([11], ['replacement', 'row-a', 'row-b'])],
        ['layout mode', () => layout_projection()],
        ['layout mode ending in removed rows', () => layout_projection(true)],
        ['a sorted view with rows removed in place', sorted_projection_with_removals],
    ] as const;
    for (const [name, make] of cases) {
        it(`finds the same rows and the same skipped count by either walk, in ${name}`, () => {
            const projection = make();
            const kinds = new Set(Array.from(
                { length: projection.rowCount },
                (_, row) => `${projection.row_at(row)?.kind ?? 'unresolved'}/${projection.row_state(row) ?? 'unknown'}`,
            ));
            expect(kinds.size, `${name} rows: ${[...kinds].join(', ')}`).toBeGreaterThanOrEqual(2);
            const next = random_source(name.length * 31);
            for (let trial = 0; trial < 400; trial++) {
                const resident: DisplayRowInterval[] = [];
                for (let start = 0; start < 12; start += 3) {
                    if (next() < 0.6) resident.push({ start, end: Math.min(11, start + 2) });
                }
                const rendered = new Set(['replacement', 'row-a', 'row-b', 'ins', 'app'].filter(() => next() < 0.6));
                const unresolved = new Set([0, 3, 7, 10].filter(() => next() < 0.2));
                const intervals: DisplayRowInterval[] = [];
                let row = Math.floor(next() * 3);
                while (row < projection.rowCount) {
                    const end = Math.min(projection.rowCount - 1, row + Math.floor(next() * 4));
                    intervals.push({ start: row, end });
                    row = end + 2 + Math.floor(next() * 3);
                }
                const sources = sources_for(projection, resident, rendered, unresolved);
                const by_rows = row_fit_targets_by_rows(intervals, sources);
                const by_resident = row_fit_targets_by_resident_rows(intervals, sources);
                expect(sorted(by_resident.sources), `trial ${trial}`).toEqual(sorted(by_rows.sources));
                expect(sorted(by_resident.pending), `trial ${trial}`).toEqual(sorted(by_rows.pending));
                expect(by_resident.skipped, `trial ${trial}`).toBe(by_rows.skipped);
            }
        });
    }

    it('reads a million-row selection through the rows the loader holds', () => {
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: 1_000_000,
            sourceRowAt: (row) => row,
            displayRowForSource: (source) => source,
            sourceRowCount: 1_000_000,
            changes: { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] },
        });
        let reads = 0;
        const resident = [{ start: 500, end: 599 }];
        const targets = row_fit_targets([{ start: 0, end: 999_999 }], {
            projection: {
                ...projection,
                row_at: (row) => {
                    reads += 1;
                    return projection.row_at(row);
                },
                display_row_for_source_display: (row) => projection.display_row_for_source_display(row),
                inline_pending_display_rows: (start, end) => projection.inline_pending_display_rows(start, end),
                deletedBandStart: projection.deletedBandStart,
                rowCount: projection.rowCount,
            },
            resident_rows: () => resident,
            row_loaded: (row) => row >= 500 && row <= 599,
            source_row_of: (row) => row,
            pending_rendered: () => false,
        });
        expect(targets.sources).toHaveLength(100);
        expect(targets.sources[0]).toEqual({ display_row: 500, source_row: 500 });
        expect(targets.skipped).toBe(999_900);
        expect(reads).toBe(100);
    });

    it('walks a selection no larger than the loaded rows row by row', () => {
        const projection = band_projection([11], ['replacement']);
        let reads = 0;
        const sources = sources_for(projection, [{ start: 0, end: 11 }], new Set(), new Set());
        row_fit_targets([{ start: 2, end: 3 }], {
            ...sources,
            projection: {
                ...projection,
                row_at: (row) => {
                    reads += 1;
                    return projection.row_at(row);
                },
                display_row_for_source_display: (row) => projection.display_row_for_source_display(row),
                inline_pending_display_rows: (start, end) => projection.inline_pending_display_rows(start, end),
                deletedBandStart: projection.deletedBandStart,
                rowCount: projection.rowCount,
            },
        });
        expect(reads).toBe(2);
    });
});

describe('rows_hold_fit_target', () => {
    /** The rule as a walk over every row: the oracle. */
    const walked = (projection: PendingRowProjection, rows: readonly DisplayRowInterval[]) => rows.some((interval) => {
        for (let row = interval.start; row <= interval.end; row += 1) {
            const state = projection.row_state(row);
            if (state !== 'removed' && state !== 'tail-removal') return true;
        }
        return false;
    });

    it('agrees with walking every row, in band and layout mode', () => {
        const projections = [
            band_projection([8, 9, 10, 11], ['replacement']),
            band_projection([11], ['replacement', 'row-a', 'row-b']),
            band_projection([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], []),
            layout_projection(),
            layout_projection(true),
            sorted_projection_with_removals(),
        ];
        const next = random_source(52);
        for (const [index, projection] of projections.entries()) {
            let removed = 0;
            for (let row = 0; row < projection.rowCount; row += 1) {
                const state = projection.row_state(row);
                if (state === 'removed' || state === 'tail-removal') removed += 1;
            }
            if (index !== 1) expect(removed, `projection ${index}`).toBeGreaterThan(0);
            for (let trial = 0; trial < 600; trial++) {
                const intervals: DisplayRowInterval[] = [];
                let row = Math.floor(next() * projection.rowCount);
                for (let count = next() < 0.7 ? 1 : 2; count > 0 && row < projection.rowCount; count--) {
                    const end = Math.min(projection.rowCount - 1, row + Math.floor(next() * 3));
                    intervals.push({ start: row, end });
                    row = end + 2 + Math.floor(next() * 4);
                }
                expect(rows_hold_fit_target(projection, intervals), `projection ${index} trial ${trial} ${JSON.stringify(intervals)}`)
                    .toBe(walked(projection, intervals));
            }
        }
    });

    it('reads past ten thousand rows removed in place in a sorted view, to the first not known removed', () => {
        const rows = 20_000;
        const sorted_removed = (unloaded: number | undefined) => create_pending_row_projection({
            sourceDisplayRowCount: rows,
            // Sorted in reverse; one row may have no loaded page.
            sourceRowAt: (row) => (row === unloaded ? undefined : rows - 1 - row),
            displayRowForSource: (source) => rows - 1 - source,
            sourceRowCount: rows,
            bodyViewTransformed: true,
            changes: {
                formatTemplates: [],
                appendedRows: [],
                tailRemovals: [],
                conflicts: [],
                rowLayout: {
                    runs: [{ kind: 'source', start: 0, count: rows }],
                    removedSourceRows: [{ start: 0, count: rows }],
                    discardedPendingRows: [],
                },
            },
        });
        const every_row = [{ start: 0, end: rows - 1 }];
        expect(rows_hold_fit_target(sorted_removed(undefined), every_row)).toBe(false);
        expect(rows_hold_fit_target(sorted_removed(15_000), every_row)).toBe(true);
    });

    it('finds the first live row of an interval as a row walk does, in every projection', () => {
        const projections = [
            band_projection([8, 9, 10, 11], ['replacement']),
            sorted_projection_with_removals(),
            layout_projection(),
            layout_projection(true),
        ];
        for (const [index, projection] of projections.entries()) {
            for (let start = 0; start < projection.rowCount; start++) {
                for (let end = start; end < projection.rowCount; end++) {
                    let expected: number | undefined;
                    for (let row = start; row <= end && expected === undefined; row++) {
                        const state = projection.row_state(row);
                        if (state !== 'removed' && state !== 'tail-removal') expected = row;
                    }
                    expect(projection.first_live_display_row_in(start, end), `projection ${index} [${start}, ${end}]`)
                        .toBe(expected);
                }
            }
        }
    });

    it('reads no further than each interval when many removed runs follow one another', () => {
        // 200,000 moved rows: the even ones first, all removed, then the odd
        // ones. A search from each removed row to the next live one would
        // read on through every removed run after it.
        const count = 200_000;
        const runs = [
            ...Array.from({ length: count / 2 }, (_, index) => ({ kind: 'source' as const, start: 2 * index, count: 1 })),
            ...Array.from({ length: count / 2 }, (_, index) => ({ kind: 'source' as const, start: 2 * index + 1, count: 1 })),
        ];
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: count,
            sourceRowAt: (row) => row,
            displayRowForSource: (source) => source,
            sourceRowCount: count,
            bodyViewTransformed: false,
            changes: {
                formatTemplates: [],
                appendedRows: [],
                tailRemovals: [],
                conflicts: [],
                rowLayout: {
                    runs,
                    removedSourceRows: Array.from({ length: count / 2 }, (_, index) => ({ start: 2 * index, count: 1 })),
                    discardedPendingRows: [],
                },
            },
        });
        const removed_rows = Array.from({ length: count / 4 }, (_, index) => ({ start: 2 * index, end: 2 * index }));
        const started = performance.now();
        expect(rows_hold_fit_target(projection, removed_rows)).toBe(false);
        expect(performance.now() - started).toBeLessThan(1_000);
    });
});
