import { describe, expect, it, vi } from 'vitest';
import { create_pending_row_projection } from '../webview/pending-row-projection';
import type { PendingStructuralChanges } from '../pending-changes';

const saved = (sourceRow: number) => ({
    appendHistoryId: `history-${sourceRow}`,
    sourceRow,
    savedFingerprint: `fingerprint-${sourceRow}`,
    savedRow: { cells: {}, format: { kind: 'none' as const } },
});

const changes = (
    appended: readonly string[],
    removed: readonly number[],
): PendingStructuralChanges => ({
    formatTemplates: appended.length > 0
        ? [{ id: 'plain', format: { kind: 'none' } }]
        : [],
    appendedRows: appended.map((id, createdOrder) => ({
        id,
        cells: {},
        formatTemplateId: 'plain',
        createdOrder,
    })),
    tailRemovals: removed.map(saved),
    conflicts: [],
});

function projection(structural: PendingStructuralChanges) {
    const displayed = [4, 1, 7];
    return create_pending_row_projection({
        sourceDisplayRowCount: displayed.length,
        sourceRowAt: (row) => displayed[row],
        displayRowForSource: (source) => {
            const index = displayed.indexOf(source);
            return index < 0 ? undefined : index;
        },
        sourceRowCount: 10,
        changes: structural,
    });
}

describe('pending-row projection', () => {
    it('keeps transformed source order and appends pending identities after it', () => {
        const model = projection(changes(['row-a', 'row-b'], []));
        expect(model.rowCount).toBe(5);
        expect(model.row_at(0)).toMatchObject({
            kind: 'source', identity: { sourceRow: 4 }, sourceDisplayRow: 0,
        });
        expect(model.row_at(3)).toMatchObject({
            kind: 'pending', identity: { pendingRowId: 'row-a' }, intendedPhysicalRow: 10,
        });
        expect(model.display_row_for_identity({ kind: 'pending', pendingRowId: 'row-b' }))
            .toBe(4);
    });

    it('shows unmatched removals in a deleted band and coalesces replacements', () => {
        const model = projection(changes(['replacement'], [8, 9]));
        expect(model.deletedBandStart).toBe(3);
        expect(model.pendingBandStart).toBe(4);
        expect(model.rowCount).toBe(5);
        expect(model.row_at(3)).toMatchObject({ kind: 'removal', intendedPhysicalRow: 9 });
        expect(model.row_at(4)).toMatchObject({
            kind: 'replacement',
            intendedPhysicalRow: 8,
            removedIdentity: { sourceRow: 8 },
            identity: { pendingRowId: 'replacement' },
        });
        expect(model.display_row_for_tail_removal_id('history-9')).toBe(3);
        expect(model.display_row_for_tail_removal_id('history-8')).toBe(4);
    });

    it('maps raw source-display rows through removal compression without residency', () => {
        const model = create_pending_row_projection({
            sourceDisplayRowCount: 5,
            sourceRowAt: () => undefined,
            displayRowForSource: () => undefined,
            sourceRowCount: 5,
            changes: changes([], [4]),
            removedSourceDisplayRows: [2],
        });
        expect(model.row_at(2)).toEqual({ kind: 'source', sourceDisplayRow: 3 });
        expect(model.display_row_for_source_display(3)).toBe(2);
        expect(model.source_display_intervals([{ start: 1, end: 3 }])).toEqual([
            { start: 1, end: 1 },
            { start: 3, end: 4 },
        ]);
    });

    it('does not materialize or scan a large source projection', () => {
        const sourceRowAt = vi.fn((row: number) => row);
        const displayRowForSource = vi.fn((row: number) => row);
        const model = create_pending_row_projection({
            sourceDisplayRowCount: 1_000_000,
            sourceRowAt,
            displayRowForSource,
            sourceRowCount: 1_000_000,
            changes: changes([], []),
        });
        expect(sourceRowAt).not.toHaveBeenCalled();
        expect(model.row_at(999_999)).toMatchObject({ identity: { sourceRow: 999_999 } });
        expect(sourceRowAt).toHaveBeenCalledTimes(1);
        expect(model.display_row_for_identity({ kind: 'source', sourceRow: 400_000 }))
            .toBe(400_000);
        expect(displayRowForSource).toHaveBeenCalledTimes(1);
    });

    it('reads current row payloads without rebuilding stable topology', () => {
        const structural = changes(['row-a'], []);
        let current = structural.appendedRows[0];
        const model = create_pending_row_projection({
            sourceDisplayRowCount: 0,
            sourceRowAt: () => undefined,
            displayRowForSource: () => undefined,
            sourceRowCount: 0,
            changes: structural,
            appendedRowAt: () => current,
        });
        current = { ...current, cells: { 0: { value: 'latest' } } };

        expect(model.row_at(0)).toMatchObject({
            kind: 'pending',
            identity: { pendingRowId: 'row-a' },
            row: { cells: { 0: { value: 'latest' } } },
        });
    });

    it('does not project an unresolved transformed removal as a duplicate tail row', () => {
        const structural = changes(['replacement'], [2]);
        const unresolved = create_pending_row_projection({
            sourceDisplayRowCount: 3,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: 3,
            changes: structural,
            removedSourceDisplayRows: [],
            projectedTailRemovalIds: new Set(),
        });
        expect(unresolved.row_at(2)).toMatchObject({
            kind: 'source', identity: { sourceRow: 2 },
        });
        expect(unresolved.row_at(3)).toMatchObject({
            kind: 'pending', identity: { pendingRowId: 'replacement' },
        });
        expect(unresolved.display_row_for_tail_removal_id('history-2')).toBeUndefined();

        const resolved = create_pending_row_projection({
            sourceDisplayRowCount: 3,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: 3,
            changes: structural,
            removedSourceDisplayRows: [2],
            projectedTailRemovalIds: new Set(['history-2']),
        });
        expect(resolved.rowCount).toBe(3);
        expect(resolved.row_at(2)).toMatchObject({
            kind: 'replacement',
            identity: { pendingRowId: 'replacement' },
            removedIdentity: { sourceRow: 2 },
        });
    });

    it('projects source cells across a large removed suffix without linear scans', () => {
        const removals = Array.from({ length: 10_000 }, (_, index) => index * 2);
        const structural = changes([], removals);
        const model = create_pending_row_projection({
            sourceDisplayRowCount: 30_000,
            sourceRowAt: (row) => row,
            displayRowForSource: (row) => row,
            sourceRowCount: 30_000,
            changes: structural,
            removedSourceDisplayRows: removals,
        });

        expect(model.display_row_for_source_display(20_001)).toBe(10_001);
        expect(model.row_at(10_001)).toMatchObject({
            kind: 'source', identity: { sourceRow: 20_001 },
        });
    });
});

describe('pending-row projection, layout mode', () => {
    const inserted = (id: string, createdOrder: number) => ({
        id, origin: 'insert' as const, cells: {}, formatTemplateId: 'plain', createdOrder,
    });
    const appended = (id: string, createdOrder: number) => ({
        id, cells: {}, formatTemplateId: 'plain', createdOrder,
    });
    /**
     * Two fixed rows (source rows 0-1, Header Row 2 means bodyStart 2), body
     * source rows 2-7. Layout: 2, [ins], 3 (removed), 6, 7, 4, 5 with 5
     * removed, discarded tombstone `gone` after 2, then the band `app`.
     */
    const layout_changes: PendingStructuralChanges = {
        formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
        appendedRows: [inserted('ins', 1), appended('app', 3)],
        tailRemovals: [],
        conflicts: [],
        rowLayout: {
            runs: [
                { kind: 'source', start: 2, count: 1 },
                { kind: 'pending', ids: ['gone', 'ins'] },
                { kind: 'source', start: 3, count: 1 },
                { kind: 'source', start: 6, count: 2 },
                { kind: 'source', start: 4, count: 2 },
            ],
            removedSourceRows: [{ start: 3, count: 1 }, { start: 5, count: 1 }],
            discardedPendingRows: [{ id: 'gone', createdOrder: 2 }],
        },
    };
    const layout_projection = (overrides: Partial<Parameters<typeof create_pending_row_projection>[0]> = {}) =>
        create_pending_row_projection({
            sourceDisplayRowCount: 8,
            sourceRowAt: (row) => row,
            displayRowForSource: (source) => source,
            sourceRowCount: 8,
            bodyStart: 2,
            bodyViewTransformed: false,
            changes: layout_changes,
            ...overrides,
        });

    it('lays out fixed rows, the layout in order with removals in place, and the band last', () => {
        const model = layout_projection();
        expect(model.layoutMode).toBe(true);
        // 2 fixed + 7 displayed layout rows (tombstone skipped) + 1 appended.
        expect(model.rowCount).toBe(10);
        expect(model.pendingBandStart).toBe(9);
        const rows = Array.from({ length: model.rowCount }, (_, row) => model.row_at(row));
        expect(rows.map((row) => row?.kind === 'pending'
            ? `p:${row.identity.pendingRowId}`
            : row?.kind === 'source' ? `s:${row.identity?.sourceRow}` : row?.kind)).toEqual([
            's:0', 's:1', 's:2', 'p:ins', 's:3', 's:6', 's:7', 's:4', 's:5', 'p:app',
        ]);
        expect(Array.from({ length: model.rowCount }, (_, row) => model.row_state(row))).toEqual([
            // Keeping 6-7 in order explains the layout with one moved row, 4.
            'source', 'source', 'source', 'inserted', 'removed', 'source', 'source', 'moved', 'removed', 'appended',
        ]);
        // Prospective rows: removals have none; the band follows the live layout (H + N + i).
        expect(Array.from({ length: model.rowCount }, (_, row) => model.prospective_row(row))).toEqual([
            0, 1, 2, 3, undefined, 4, 5, 6, undefined, 7,
        ]);
        expect(model.row_at(9)).toMatchObject({ intendedPhysicalRow: 7 });
        expect(model.row_at(3)).toMatchObject({ kind: 'pending', intendedPhysicalRow: 3 });
    });

    it('maps identities, prospective rows, and source-display rows to grid rows', () => {
        const model = layout_projection();
        expect(model.display_row_for_identity({ kind: 'source', sourceRow: 4 })).toBe(7);
        expect(model.display_row_for_identity({ kind: 'source', sourceRow: 1 })).toBe(1);
        expect(model.display_row_for_identity({ kind: 'pending', pendingRowId: 'ins' })).toBe(3);
        expect(model.display_row_for_identity({ kind: 'pending', pendingRowId: 'app' })).toBe(9);
        expect(model.display_row_for_identity({ kind: 'pending', pendingRowId: 'gone' })).toBeUndefined();
        for (let row = 0; row < model.rowCount; row++) {
            const prospective = model.prospective_row(row);
            if (prospective !== undefined) expect(model.display_row_for_prospective_row(prospective)).toBe(row);
        }
        // Every source grid row resolves to its source-display row and back.
        for (let row = 0; row < model.pendingBandStart; row++) {
            const projected = model.row_at(row);
            if (projected?.kind !== 'source') continue;
            expect(projected.sourceDisplayRow).toBe(projected.identity!.sourceRow);
            expect(model.display_row_for_source_display(projected.sourceDisplayRow)).toBe(row);
        }
    });

    it('fetches the union of source-display rows across run boundaries', () => {
        const model = layout_projection();
        // Grid rows 2-7: source 2, ins, 3, 6, 7, 4.
        expect(model.source_display_intervals([{ start: 2, end: 7 }])).toEqual([{ start: 2, end: 4 }, { start: 6, end: 7 }]);
        // Grid rows 0-1 are fixed; 5-6 are source 6-7.
        expect(model.source_display_intervals([{ start: 0, end: 1 }, { start: 5, end: 6 }]))
            .toEqual([{ start: 0, end: 1 }, { start: 6, end: 7 }]);
        expect(model.source_display_intervals([{ start: 3, end: 3 }])).toEqual([]);
    });

    it('stays in band mode for a transformed view, keeping removals in place', () => {
        const removal_only: PendingStructuralChanges = {
            ...changes([], []),
            rowLayout: {
                runs: [{ kind: 'source', start: 0, count: 10 }],
                removedSourceRows: [{ start: 1, count: 1 }],
                discardedPendingRows: [],
            },
        };
        const displayed = [4, 1, 7];
        const model = create_pending_row_projection({
            sourceDisplayRowCount: displayed.length,
            sourceRowAt: (row) => displayed[row],
            displayRowForSource: (source) => displayed.indexOf(source) < 0 ? undefined : displayed.indexOf(source),
            sourceRowCount: 10,
            bodyViewTransformed: true,
            changes: { ...removal_only, appendedRows: [appended('app', 1)], formatTemplates: [{ id: 'plain', format: { kind: 'none' } }] },
        });
        expect(model.layoutMode).toBe(false);
        expect(model.row_at(1)).toEqual({
            kind: 'source', identity: { kind: 'source', sourceRow: 1 }, sourceDisplayRow: 1,
        });
        expect([0, 1, 2, 3].map((row) => model.row_state(row))).toEqual(['source', 'removed', 'source', 'appended']);
        expect([0, 1, 2].map((row) => model.prospective_row(row))).toEqual([3, undefined, 6]);
        // The band starts after the 9 live rows.
        expect(model.row_at(3)).toMatchObject({ kind: 'pending', intendedPhysicalRow: 9 });
        expect(model.display_row_for_prospective_row(9)).toBe(3);
        expect(model.display_row_for_prospective_row(6)).toBe(2);
    });

    it('keeps band mode, byte for byte, without a layout or an explicit untransformed flag', () => {
        const base = {
            sourceDisplayRowCount: 3,
            sourceRowAt: (row: number) => [4, 1, 7][row],
            displayRowForSource: (source: number) => [4, 1, 7].indexOf(source),
            sourceRowCount: 10,
        };
        const today = projection(changes(['row-a'], [9]));
        const with_flag = create_pending_row_projection({
            ...base, changes: changes(['row-a'], [9]), bodyViewTransformed: false, bodyStart: 0,
        });
        expect(with_flag.layoutMode).toBe(false);
        for (let row = 0; row < today.rowCount; row++) {
            expect(JSON.stringify(with_flag.row_at(row))).toBe(JSON.stringify(today.row_at(row)));
        }
        // A layout without the explicit flag stays in band mode.
        expect(layout_projection({ bodyViewTransformed: undefined }).layoutMode).toBe(false);
        // So does a worksheet with a tail removal.
        expect(layout_projection({
            changes: { ...layout_changes, rowLayout: undefined, appendedRows: [appended('app', 3)], tailRemovals: [saved(7)] },
        }).layoutMode).toBe(false);
    });
});
