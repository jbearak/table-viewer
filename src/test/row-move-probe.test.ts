// The run-based dry run of a row move (`probe_row_move_runs`) against the
// identity planner it stands in for (`move_rows`), which the Move gesture
// still uses: the same answer and the same refusal, over layouts built by the
// real gestures, selections resolved as the menus resolve them, and every
// kind of drop target.
import { describe, expect, it } from 'vitest';
import type { MergeRange } from '../types';
import type { PendingStructuralChanges, RowIdentity } from '../pending-changes';
import { create_pending_row_projection } from '../webview/pending-row-projection';
import {
    move_rows,
    probe_row_move_runs,
    type RowSelectionRun,
    type StructureResult,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    identities_of_runs,
    plan_row_delete,
    plan_row_insert,
    plan_row_move,
    resolve_row_structure_selection,
    row_move_item_model,
    type RowStructureSelection,
} from '../webview/row-structure-model';
import { MAX_ROW_LAYOUT_RUNS, probe_row_move } from '../worksheet-layout';

const SOURCE_ROWS = 14;
const BODY_START = 2;
const template = { id: 'plain', format: { kind: 'none' as const } };
const APPEND_BASIS = { sourceRowCount: SOURCE_ROWS, columnCount: 2, schemaFingerprint: 'sha256:x' };
const EMPTY: PendingStructuralChanges = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };

function context(overrides: Partial<WorksheetStructureContext> = {}): WorksheetStructureContext {
    return {
        worksheet: { sheetIndex: 0, sheetName: 'data' },
        bodyStart: BODY_START,
        sourceRowCount: SOURCE_ROWS,
        sourceColumnCount: 2,
        bodyViewTransformed: false,
        structuralBasis: {
            kind: 'delimited', byteLength: 40, digest: 'abc', sourceRowCount: SOURCE_ROWS, sourceColumnCount: 2,
        },
        ...overrides,
    };
}

const source = (sourceRow: number): RowIdentity => ({ kind: 'source', sourceRow });
const pending = (pendingRowId: string): RowIdentity => ({ kind: 'pending', pendingRowId });

function random_source(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

/** Source row 1 is the Header Row: display row 0 is the row above it, then the body. */
function projection_for(changes: PendingStructuralChanges) {
    return create_pending_row_projection({
        sourceDisplayRowCount: SOURCE_ROWS - 1,
        sourceRowAt: (row) => (row < 1 ? row : row + 1),
        displayRowForSource: (row) => (row < 1 ? row : row === 1 ? undefined : row - 1),
        sourceRowCount: SOURCE_ROWS,
        changes,
        bodyStart: BODY_START,
        bodyViewTransformed: false,
    });
}

/** A worksheet some gestures have changed: rows deleted, inserted, moved, appended. */
function random_changes(next: () => number, ctx: WorksheetStructureContext): PendingStructuralChanges {
    let changes = EMPTY;
    let inserted = 0;
    const body_row = () => BODY_START + Math.floor(next() * (SOURCE_ROWS - BODY_START));
    for (let step = Math.floor(next() * 6); step > 0; step--) {
        const kind = next();
        if (kind < 0.15 && inserted > 0) {
            // Delete an inserted row: a discarded tombstone when an anchor names it.
            const plan = plan_row_delete(changes, ctx, [pending(`i${Math.floor(next() * inserted)}`)], new Map());
            if (plan.ok) changes = plan.outcome.next;
        } else if (kind < 0.35) {
            const first = body_row();
            const rows = Array.from({ length: 1 + Math.floor(next() * 3) }, (_, offset) => first + offset)
                .filter((row) => row < SOURCE_ROWS);
            const plan = plan_row_delete(changes, ctx, rows.map(source), new Map());
            if (plan.ok) changes = plan.outcome.next;
        } else if (kind < 0.65) {
            const ids = Array.from({ length: 1 + Math.floor(next() * 2) }, () => `i${inserted++}`);
            const plan = plan_row_insert(
                changes, ctx, source(body_row()), next() < 0.5 ? 'before' : 'after', ids, template, inserted, APPEND_BASIS,
            );
            if (plan.ok) changes = plan.outcome.next;
        } else {
            const first = body_row();
            const rows = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, offset) => first + offset)
                .filter((row) => row < SOURCE_ROWS);
            const plan = plan_row_move(changes, ctx, rows.map(source), next() < 0.2 ? 'end' : source(body_row()));
            if (plan.ok) changes = plan.outcome.next;
        }
    }
    if (next() < 0.25) {
        changes = {
            ...changes,
            formatTemplates: changes.formatTemplates.length > 0 ? changes.formatTemplates : [template],
            appendedRows: [...changes.appendedRows, { id: 'band', cells: {}, formatTemplateId: 'plain', createdOrder: 100 }],
        };
    }
    return changes;
}

function random_merges(next: () => number): MergeRange[] {
    const merges: MergeRange[] = [];
    for (let count = Math.floor(next() * 3); count > 0; count--) {
        const start = Math.floor(next() * SOURCE_ROWS);
        // Unclipped: a merge may run past the body's last row.
        const end = start + Math.floor(next() * 4);
        merges.push({ startRow: start, endRow: end, startCol: 0, endCol: next() < 0.5 ? 0 : 1 });
    }
    return merges;
}

function random_before(next: () => number, changes: PendingStructuralChanges): RowIdentity | 'end' {
    const choice = next();
    if (choice < 0.15) return 'end';
    if (choice < 0.7) return source(Math.floor(next() * (SOURCE_ROWS + 1)));
    const ids = [
        ...changes.appendedRows.map((row) => row.id),
        ...(changes.rowLayout?.discardedPendingRows ?? []).map((row) => row.id),
        'unknown',
    ];
    return pending(ids[Math.floor(next() * ids.length)]!);
}

/** What the menu's planner does with either answer: ok, or the refusal's reason and words. */
function outcome(result: StructureResult): string {
    return result.ok ? 'ok' : `${result.refusal.reason}: ${result.refusal.message}`;
}

describe('probe_row_move_runs', () => {
    it('answers as move_rows does for the runs’ rows, over gestures, selections and targets', () => {
        const next = random_source(405);
        const seen = new Map<string, number>();
        for (let trial = 0; trial < 3000; trial++) {
            // Half the time a Formula Anchor names every pending row, so
            // deleted inserted rows stay as discarded tombstones.
            const ctx = context({
                merges: random_merges(next),
                ...(next() < 0.5 ? { isRowReferenced: () => true } : {}),
            });
            const changes = random_changes(next, ctx);
            const projection = projection_for(changes);
            const start = Math.floor(next() * projection.rowCount);
            const end = Math.min(projection.rowCount - 1, start + Math.floor(next() * 5));
            const removed = changes.rowLayout?.removedSourceRows ?? [];
            const selection = resolve_row_structure_selection(projection, [{ start, end }], {
                bodyStart: BODY_START,
                isRemoved: (row) => removed.some((entry) => row >= entry.start && row < entry.start + entry.count),
                removedSourceRows: removed,
            });
            if (selection.runs === undefined) continue;
            const runs: RowSelectionRun[] = [...selection.runs];
            const before = random_before(next, changes);
            const variant = next();
            const used_ctx = variant < 0.05 ? { ...ctx, bodyViewTransformed: true } : ctx;
            const used_changes = variant > 0.97
                ? { ...changes, tailRemovals: [{
                    appendHistoryId: 'tail', sourceRow: SOURCE_ROWS - 1, savedFingerprint: 'f',
                    savedRow: { cells: {}, format: { kind: 'none' as const } },
                }] }
                : changes;
            const expected = outcome(move_rows(used_changes, used_ctx, identities_of_runs(runs), before));
            const actual = outcome(probe_row_move_runs(used_changes, used_ctx, runs, before));
            expect(actual, `trial ${trial} runs ${JSON.stringify(runs)} before ${JSON.stringify(before)}`)
                .toBe(expected);
            const key = expected.split(':')[0]!;
            seen.set(key, (seen.get(key) ?? 0) + 1);
            if ((changes.rowLayout?.discardedPendingRows.length ?? 0) > 0) {
                seen.set('with-tombstone', (seen.get('with-tombstone') ?? 0) + 1);
            }
        }
        // Every answer the planner can give came up.
        for (const reason of [
            'ok', 'unchanged', 'no-live-entry', 'unknown-identity', 'appended-band',
            'merge-split', 'merge-destination', 'transformed', 'tail-removal', 'with-tombstone',
        ]) {
            expect(seen.get(reason) ?? 0, `${reason} in ${JSON.stringify([...seen])}`).toBeGreaterThan(0);
        }
    });

    it('moves a million rows by their runs, without listing them', () => {
        const ctx = context({
            sourceRowCount: 1_000_002,
            structuralBasis: {
                kind: 'delimited', byteLength: 40, digest: 'abc', sourceRowCount: 1_000_002, sourceColumnCount: 2,
            },
        });
        const runs: RowSelectionRun[] = [{ kind: 'source', start: 2, count: 1_000_000 - 2 }];
        const result = probe_row_move_runs(EMPTY, ctx, runs, source(1_000_001));
        expect(result.ok ? 'ok' : result.refusal.message).toBe('ok');
    });

    it('moves a block across a layout fragmented into many removed runs', () => {
        // 100,000 removed rows, every other one: moving the block carries
        // 100,000 tombstones and as many live pieces.
        const rows = 200_002;
        const removed = Array.from({ length: 100_000 }, (_, index) => ({ start: 2 + 2 * index, count: 1 }));
        const layout = {
            runs: [{ kind: 'source' as const, start: 2, count: rows - 2 }],
            removedSourceRows: removed,
            discardedPendingRows: [],
        };
        const result = probe_row_move(layout, [{ start: 2, count: rows - 3 }], [], 'end');
        // Too many runs is a refusal, not a RangeError.
        expect(result.ok || result.refusal.reason === 'too-many-runs').toBe(true);
    });

    it('refuses runs that are not whole rows inside the body', () => {
        const layout = { runs: [{ kind: 'source' as const, start: 2, count: 12 }], removedSourceRows: [], discardedPendingRows: [] };
        for (const bad of [
            { start: 2, count: 0 },
            { start: 2, count: -1 },
            { start: 2.5, count: 1 },
            { start: 2, count: 1.5 },
            { start: Number.NaN, count: 1 },
            { start: 2, count: Number.POSITIVE_INFINITY },
            { start: 1, count: 1 },
            { start: 13, count: 2 },
        ]) {
            const result = probe_row_move(layout, [bad], [], 'end');
            expect(result.ok ? 'ok' : result.refusal.reason, JSON.stringify(bad)).toBe('unknown-identity');
        }
    });

    it('decides the Move items for a million rows without listing them', () => {
        const ctx = context({
            sourceRowCount: 1_000_002,
            structuralBasis: {
                kind: 'delimited', byteLength: 40, digest: 'abc', sourceRowCount: 1_000_002, sourceColumnCount: 2,
            },
        });
        const runs: RowSelectionRun[] = [{ kind: 'source', start: 10, count: 999_000 }];
        const selection = resolve_row_structure_selection(
            { rowCount: 1_000_001, row_at: () => undefined, source_row_runs: () => [], deletedBandStart: 1_000_001 },
            [],
            { bodyStart: BODY_START, isRemoved: () => false },
        );
        const huge: RowStructureSelection = {
            ...selection,
            count: 999_000,
            runs,
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
        for (const direction of ['backward', 'forward'] as const) {
            const model = row_move_item_model(
                { support: { supported: true }, ready: true, selection: huge, changes: EMPTY, context: ctx },
                direction,
            );
            expect(model.enabled, direction).toBe(true);
        }
    });

    it('answers as move_rows does for a merge that runs past the body', () => {
        const ctx = context({ merges: [{ startRow: SOURCE_ROWS - 2, endRow: SOURCE_ROWS + 2, startCol: 0, endCol: 1 }] });
        const seen = new Set<string>();
        for (const [runs, before] of [
            // The merge's rows inside the body, all of them: moves whole.
            [[{ kind: 'source', start: SOURCE_ROWS - 2, count: 2 }], source(3)],
            // Part of it: splits.
            [[{ kind: 'source', start: SOURCE_ROWS - 1, count: 1 }], source(3)],
            // Other rows dropped inside it.
            [[{ kind: 'source', start: 3, count: 2 }], source(SOURCE_ROWS - 1)],
            // Other rows dropped at its start.
            [[{ kind: 'source', start: 3, count: 2 }], source(SOURCE_ROWS - 2)],
            [[{ kind: 'source', start: 3, count: 2 }], 'end'],
        ] as [RowSelectionRun[], RowIdentity | 'end'][]) {
            const expected = outcome(move_rows(EMPTY, ctx, identities_of_runs(runs), before));
            expect(outcome(probe_row_move_runs(EMPTY, ctx, runs, before)), JSON.stringify([runs, before])).toBe(expected);
            seen.add(expected.split(':')[0]!);
        }
        expect([...seen].sort()).toEqual(['merge-destination', 'merge-split', 'ok']);
    });

    it('answers as move_rows does for discarded pending rows in the selection', () => {
        // A Formula Anchor names the deleted row, so its tombstone stays.
        const ctx = context({ isRowReferenced: () => true });
        const inserted = plan_row_insert(EMPTY, ctx, source(5), 'before', ['i0'], template, 1, APPEND_BASIS);
        if (!inserted.ok) throw new Error(inserted.message);
        const discarded = plan_row_delete(inserted.outcome.next, ctx, [pending('i0')], new Map());
        if (!discarded.ok) throw new Error(discarded.message);
        const changes = discarded.outcome.next;
        expect(changes.rowLayout?.discardedPendingRows.map((row) => row.id)).toEqual(['i0']);
        const only: RowSelectionRun[] = [{ kind: 'pending', identity: { kind: 'pending', pendingRowId: 'i0' } }];
        const mixed: RowSelectionRun[] = [...only, { kind: 'source', start: 6, count: 2 }];
        const seen = new Set<string>();
        for (const [runs, before] of [
            // Nothing live to move, whatever the target: the target is not checked.
            [only, pending('bogus')],
            [only, source(9)],
            [only, 'end'],
            // The live rows move; the discarded row stays where it is.
            [mixed, source(10)],
            [mixed, pending('i0')],
            [mixed, pending('bogus')],
        ] as [RowSelectionRun[], RowIdentity | 'end'][]) {
            const expected = outcome(move_rows(changes, ctx, identities_of_runs(runs), before));
            expect(outcome(probe_row_move_runs(changes, ctx, runs, before)), JSON.stringify([runs, before])).toBe(expected);
            seen.add(expected.split(':')[0]!);
        }
        expect(seen).toContain('no-live-entry');
        expect(seen).toContain('ok');
    });

    it('answers the run limit as move_rows does, at the limit', () => {
        // A three-row run, then single moved rows (pairs swapped, so no two
        // neighbours join): MAX_ROW_LAYOUT_RUNS - 1 runs. Taking the middle
        // row of the first run to the end splits it and adds a run: one over.
        const singles = MAX_ROW_LAYOUT_RUNS - 2;
        const layout_runs: { kind: 'source'; start: number; count: number }[] = [
            { kind: 'source', start: BODY_START, count: 3 },
            ...Array.from({ length: singles }, (_, index) => ({
                kind: 'source' as const,
                start: BODY_START + 3 + (index % 2 === 0 ? index + 1 : index - 1),
                count: 1,
            })),
        ];
        if (singles % 2 === 1) layout_runs[singles] = { kind: 'source', start: BODY_START + 3 + singles - 1, count: 1 };
        const rows = BODY_START + 3 + singles;
        const changes: PendingStructuralChanges = {
            ...EMPTY,
            rowLayout: { runs: layout_runs, removedSourceRows: [], discardedPendingRows: [] },
        };
        const ctx = context({
            sourceRowCount: rows,
            structuralBasis: {
                kind: 'delimited', byteLength: 40, digest: 'abc', sourceRowCount: rows, sourceColumnCount: 2,
            },
        });
        const seen = new Set<string>();
        for (const [run, before] of [
            // Splits the first run and adds one at the end: over.
            [{ kind: 'source', start: BODY_START + 1, count: 1 }, 'end'],
            // The first run whole to the end: no more runs.
            [{ kind: 'source', start: BODY_START, count: 3 }, 'end'],
            // Its last row: splits nothing apart in the middle.
            [{ kind: 'source', start: BODY_START + 2, count: 1 }, 'end'],
        ] as [RowSelectionRun, RowIdentity | 'end'][]) {
            const expected = outcome(move_rows(changes, ctx, identities_of_runs([run]), before));
            expect(outcome(probe_row_move_runs(changes, ctx, [run], before)), JSON.stringify([run, before])).toBe(expected);
            seen.add(expected.split(':')[0]!);
        }
        expect([...seen]).toContain('too-many-runs');
    });
});
