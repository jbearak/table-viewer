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
