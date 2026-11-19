// The row-height runs GridShell hands the grid, against the row-by-row
// resolution they stand in for (`geometry_row_height_of`), over band-mode and
// layout-mode projections built the way the viewer builds them.
import { describe, expect, it, vi } from 'vitest';
import type { PendingAppendedRow, PendingStructuralChanges, RowIdentity } from '../pending-changes';
import { CompactSelection } from '../webview/glide-data-grid/internal/data-grid/data-grid-types';
import { create_pending_row_projection, type PendingRowProjection } from '../webview/pending-row-projection';
import type { WorksheetStructureContext } from '../webview/pending-row-store';
import { create_row_height_index, geometry_row_height } from '../webview/row-height-index';
import {
    display_height_runs,
    geometry_row_height_of,
    preview_row_height_index,
    raw_row_height_of,
    same_row_heights,
    source_display_height_runs,
    type RowHeightInputs,
    type RowHeightPreview,
} from '../webview/row-height-runs';
import type { RowHeightLayer, RowHeightOverrides } from '../webview/row-heights';
import { plan_row_delete, plan_row_insert, plan_row_move } from '../webview/row-structure-model';

function random_source(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

const DEFAULT = 24;
const HEIGHTS = [DEFAULT, 30, 48.5, 26.8, 20.333333, 10.6667, 4096, 1e9];
const pick = <T,>(next: () => number, values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
const template = { id: 'plain', format: { kind: 'none' as const } };
const EMPTY: PendingStructuralChanges = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };
const source = (sourceRow: number): RowIdentity => ({ kind: 'source', sourceRow });
const pending = (pendingRowId: string): RowIdentity => ({ kind: 'pending', pendingRowId });

/** The structural heights GridShell reads: an unsaved row's own height, else the saved row's. */
function structural_height(projection: PendingRowProjection) {
    return (row: number): number | undefined => {
        const projected = projection.row_at(row);
        if (projected?.kind === 'pending' || projected?.kind === 'replacement') return projected.row.viewerRowHeight;
        if (projected?.kind === 'removal') return projected.removal.savedRow.viewerRowHeight;
        return undefined;
    };
}

function with_heights(next: () => number, rows: readonly PendingAppendedRow[]): PendingAppendedRow[] {
    return rows.map((row) => (next() < 0.5 ? { ...row, viewerRowHeight: pick(next, HEIGHTS) } : row));
}

/** A band-mode projection: hidden or sorted rows, tail removals and appended rows. */
function band_projection(next: () => number): PendingRowProjection {
    const source_rows = Math.floor(next() * 30);
    // Some rows hidden or filtered: the displayed ones, possibly reordered.
    const displayed = Array.from({ length: source_rows }, (_, row) => row).filter(() => next() < 0.8);
    if (next() < 0.3) displayed.reverse();
    const removed = displayed.slice(Math.max(0, displayed.length - Math.floor(next() * 3)));
    const appended = Array.from({ length: Math.floor(next() * 4) }, (_, at) => ({
        id: `a${at}`, cells: {}, formatTemplateId: 'plain', createdOrder: at,
    }));
    const changes: PendingStructuralChanges = {
        formatTemplates: appended.length > 0 ? [template] : [],
        appendedRows: with_heights(next, appended),
        tailRemovals: removed.map((sourceRow) => ({
            appendHistoryId: `history-${sourceRow}`,
            sourceRow,
            savedFingerprint: `f${sourceRow}`,
            savedRow: {
                cells: {},
                format: { kind: 'none' as const },
                ...(next() < 0.5 ? { viewerRowHeight: pick(next, HEIGHTS) } : {}),
            },
        })),
        conflicts: [],
    };
    return create_pending_row_projection({
        sourceDisplayRowCount: displayed.length,
        sourceRowAt: (row) => displayed[row],
        displayRowForSource: (row) => {
            const at = displayed.indexOf(row);
            return at < 0 ? undefined : at;
        },
        sourceRowCount: source_rows,
        changes,
        removedSourceDisplayRows: removed.map((row) => displayed.indexOf(row)).filter(() => next() < 0.8)
            .sort((left, right) => left - right),
        bodyViewTransformed: true,
    });
}

/** A layout-mode projection: a promoted header row, then rows deleted, inserted and moved. */
function layout_projection(next: () => number): PendingRowProjection {
    const source_rows = 4 + Math.floor(next() * 20);
    const body_start = pick(next, [0, 1, 2, 4]);
    const header = body_start - 1;
    const ctx: WorksheetStructureContext = {
        worksheet: { sheetIndex: 0, sheetName: 'data' },
        bodyStart: body_start,
        sourceRowCount: source_rows,
        sourceColumnCount: 2,
        bodyViewTransformed: false,
        structuralBasis: {
            kind: 'delimited', byteLength: 40, digest: 'abc', sourceRowCount: source_rows, sourceColumnCount: 2,
        },
        isRowReferenced: () => next() < 0.5,
    };
    let changes = EMPTY;
    let inserted = 0;
    const body_row = () => body_start + Math.floor(next() * (source_rows - body_start));
    for (let step = 1 + Math.floor(next() * 6); step > 0; step--) {
        const kind = next();
        if (kind < 0.3) {
            const plan = plan_row_delete(changes, ctx, [source(body_row())], new Map());
            if (plan.ok) changes = plan.outcome.next;
        } else if (kind < 0.6) {
            const ids = [`i${inserted++}`];
            const plan = plan_row_insert(changes, ctx, source(body_row()), 'before', ids, template, inserted, {
                sourceRowCount: source_rows, columnCount: 2, schemaFingerprint: 'x',
            });
            if (plan.ok) changes = plan.outcome.next;
        } else if (kind < 0.7 && inserted > 0) {
            const plan = plan_row_delete(changes, ctx, [pending(`i${Math.floor(next() * inserted)}`)], new Map());
            if (plan.ok) changes = plan.outcome.next;
        } else {
            const first = body_row();
            const plan = plan_row_move(changes, ctx, [source(first)], next() < 0.3 ? 'end' : source(body_row()));
            if (plan.ok) changes = plan.outcome.next;
        }
    }
    changes = { ...changes, appendedRows: with_heights(next, changes.appendedRows) };
    // Display rows above the body: every source row but the header row.
    return create_pending_row_projection({
        sourceDisplayRowCount: source_rows - (header >= 0 ? 1 : 0),
        sourceRowAt: (row) => (header >= 0 && row >= header ? row + 1 : row),
        displayRowForSource: (row) => (row === header ? undefined : header >= 0 && row > header ? row - 1 : row),
        sourceRowCount: source_rows,
        changes,
        bodyStart: body_start,
        bodyViewTransformed: false,
    });
}

function random_record(next: () => number, rows: number): RowHeightOverrides {
    const record: Record<string, number> = {};
    for (let count = Math.floor(next() * 10); count > 0; count--) {
        record[String(Math.floor(next() * (rows + 6)))] = pick(next, [...HEIGHTS, Number.NaN]);
    }
    // Keys a numeric lookup never reaches.
    if (next() < 0.3) record['05'] = 99;
    if (next() < 0.3) record['1.5'] = 99;
    if (next() < 0.3) record['-1'] = 99;
    return record as RowHeightOverrides;
}

function random_layers(next: () => number, rows: number): RowHeightLayer[] {
    const layers: RowHeightLayer[] = [];
    for (let count = Math.floor(next() * 4); count > 0; count--) {
        const intervals: { start: number; end: number }[] = [];
        let row = Math.floor(next() * 4);
        while (row < rows + 4 && next() < 0.7) {
            const end = row + Math.floor(next() * (next() < 0.2 ? rows + 5 : 4));
            intervals.push({ start: row, end });
            row = end + 2 + Math.floor(next() * 3);
        }
        layers.push({ rows: intervals, height: pick(next, HEIGHTS) });
    }
    return layers;
}

function random_preview(next: () => number, rows: number): RowHeightPreview | undefined {
    if (rows === 0 || next() < 0.4) return undefined;
    const row = Math.floor(next() * rows);
    let selection: CompactSelection | null = null;
    if (next() < 0.5) {
        selection = CompactSelection.empty();
        for (let count = Math.floor(next() * 3); count >= 0; count--) {
            const start = Math.floor(next() * rows);
            selection = selection.add([start, start + 1 + Math.floor(next() * (next() < 0.2 ? rows : 3))]);
        }
    }
    return { row, rows: selection, height: pick(next, HEIGHTS) };
}

function indexed(inputs: RowHeightInputs, preview: RowHeightPreview | undefined) {
    const base = create_row_height_index(
        inputs.projection.rowCount,
        inputs.defaultHeight,
        display_height_runs(inputs, source_display_height_runs(inputs.rowHeights, inputs.layers, inputs.defaultHeight)),
    );
    return preview_row_height_index(base, preview);
}

describe('display_height_runs', () => {
    it('gives every row the height the row-by-row resolution gives, in both projection modes', () => {
        const next = random_source(307);
        const seen = { band: 0, layout: 0, fixed: 0, tombstone: 0, preview: 0 };
        for (let trial = 0; trial < 1500; trial++) {
            const projection = next() < 0.5 ? band_projection(next) : layout_projection(next);
            const rows = projection.rowCount;
            const default_height = geometry_row_height(next() < 0.7 ? DEFAULT : 20.333333, DEFAULT);
            const inputs: RowHeightInputs = {
                projection,
                rowHeights: random_record(next, rows),
                layers: next() < 0.2 ? undefined : random_layers(next, rows),
                defaultHeight: default_height,
                structuralHeight: structural_height(projection),
            };
            const preview = random_preview(next, rows);
            const index = indexed(inputs, preview);
            for (let row = -1; row <= rows + 2; row++) {
                expect(index.height(row), `trial ${trial} row ${row}`)
                    .toBe(geometry_row_height_of(inputs, preview, row));
            }
            seen[projection.layoutMode ? 'layout' : 'band']++;
            if (projection.fixedRowCount > 0) seen.fixed++;
            if (preview !== undefined) seen.preview++;
            for (let row = 0; row < rows; row++) {
                if (projection.row_state(row) === 'removed') seen.tombstone++;
            }
        }
        for (const [what, count] of Object.entries(seen)) expect(count, what).toBeGreaterThan(20);
    });
});

describe('raw_row_height_of', () => {
    const projection = create_pending_row_projection({
        sourceDisplayRowCount: 3,
        sourceRowAt: (row) => row,
        displayRowForSource: (row) => row,
        sourceRowCount: 3,
        changes: EMPTY,
    });
    const inputs: RowHeightInputs = {
        projection,
        rowHeights: { 1: 40, 5: 70 },
        layers: [{ rows: [{ start: 2, end: 9 }], height: 50 }],
        defaultHeight: DEFAULT,
        structuralHeight: () => undefined,
    };

    it('gives a row outside the grid the default, whatever is stored at its number', () => {
        expect(raw_row_height_of(inputs, undefined, 1)).toBe(40);
        expect(raw_row_height_of(inputs, undefined, 2)).toBe(50);
        expect(raw_row_height_of(inputs, undefined, 5)).toBe(DEFAULT);
        expect(raw_row_height_of(inputs, { row: 0, rows: null, height: 80 }, 0)).toBe(80);
        expect(raw_row_height_of(inputs, { row: 0, rows: null, height: 80 }, 0, false)).toBe(DEFAULT);
        expect(raw_row_height_of(inputs, undefined, -1)).toBe(DEFAULT);
    });

    it('keeps fractional heights raw, and bounds and quantizes them only for drawing', () => {
        const fractional = { ...inputs, rowHeights: { 0: 20.333333333 } };
        expect(raw_row_height_of(fractional, undefined, 0)).toBe(20.333333333);
        expect(geometry_row_height_of(fractional, undefined, 0)).toBe(geometry_row_height(20.333333333, DEFAULT));
        const huge = { ...inputs, rowHeights: { 0: 1e15 } };
        expect(geometry_row_height_of(huge, undefined, 0)).toBe(4096);
    });
});

describe('row height runs work', () => {
    it('builds a million-row layout with ten thousand stored heights without resolving its rows', () => {
        const rows = 1_000_000;
        const projection = create_pending_row_projection({
            sourceDisplayRowCount: rows,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: rows,
            changes: {
                ...EMPTY,
                rowLayout: {
                    runs: [
                        { kind: 'source', start: 500_000, count: 500_000 },
                        { kind: 'source', start: 0, count: 500_000 },
                    ],
                    removedSourceRows: [],
                    discardedPendingRows: [],
                },
            },
            bodyStart: 0,
            bodyViewTransformed: false,
        });
        const row_at = vi.fn(projection.row_at);
        const record: Record<number, number> = {};
        for (let at = 0; at < 10_000; at++) record[at * 100] = 40;
        const inputs: RowHeightInputs = {
            projection: {
                rowCount: projection.rowCount,
                deletedBandStart: projection.deletedBandStart,
                fixedRowCount: projection.fixedRowCount,
                source_row_runs: projection.source_row_runs,
                row_at,
            },
            rowHeights: record,
            layers: [{ rows: [{ start: 0, end: rows - 1 }], height: 30 }, { rows: [{ start: 0, end: 9 }], height: 60 }],
            defaultHeight: DEFAULT,
            structuralHeight: () => undefined,
        };
        const index = indexed(inputs, undefined);
        expect(row_at).not.toHaveBeenCalled();
        expect(index.runs.length).toBeLessThan(10);
        expect(index.height(500_000)).toBe(60);
        expect(index.height(500_010)).toBe(30);
        expect(index.top(rows)).toBe(10 * 60 + (rows - 10) * 30);
    });

    it('tells two indexes of the same heights apart from different ones', () => {
        const a = create_row_height_index(10, 24, [{ start: 2, count: 2, height: 30 }]);
        const b = create_row_height_index(10, 24, [{ start: 2, count: 1, height: 30 }, { start: 3, count: 1, height: 30 }]);
        const c = create_row_height_index(10, 24, [{ start: 2, count: 2, height: 31 }]);
        expect(same_row_heights(a, b)).toBe(true);
        expect(same_row_heights(a, c)).toBe(false);
        expect(same_row_heights(a, create_row_height_index(11, 24, a.runs))).toBe(false);
    });
});
