import { describe, expect, it } from 'vitest';
import { rebase_pending_edits_for_header } from '../header-rebase';
import {
    own_pending_structural_changes,
    type PendingAppendedRow,
    type PendingColumn,
    type PendingStructuralChanges,
    type StructuralBasis,
} from '../pending-changes';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    value_only_overlay,
} from '../webview/history-cell-state-model';
import { entry_for_current_header, type HeaderSheet } from '../webview/history-header-rebase';
import {
    empty_history_stack,
    record_history_action,
    type HistoryChange,
    type HistoryEntry,
} from '../webview/history-stack-model';
import { plan_pending_row_history_replay } from '../webview/pending-row-history';
import {
    delete_rows,
    insert_columns,
    type StructureResult,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';

const ROWS = 10;
const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const OTHER: WorksheetTarget = { sheetIndex: 1, sheetName: 'Notes', worksheetId: 'rId2' };
const template = { id: 'plain', format: { kind: 'none' as const } };

const CLEAN: PendingStructuralChanges = {
    formatTemplates: [],
    appendedRows: [],
    tailRemovals: [],
    conflicts: [],
};

function basis(body_start: number): StructuralBasis {
    return {
        kind: 'xlsx',
        worksheetPartDigest: 'part',
        sharedStringsDigest: null,
        stylesDigest: null,
        workbookDigest: 'book',
        sourceRowCount: ROWS,
        sourceColumnCount: 2,
        bodyStart: body_start,
    };
}

function context(body_start: number): WorksheetStructureContext {
    return {
        worksheet: SHEET,
        bodyStart: body_start,
        sourceRowCount: ROWS,
        sourceColumnCount: 2,
        bodyViewTransformed: false,
        structuralBasis: basis(body_start),
    };
}

function planned(result: StructureResult) {
    if (!result.ok) throw new Error(result.refusal.message);
    return result.outcome;
}

/** Delete source row `row` on a clean worksheet whose body starts at `body_start`. */
function deleted(body_start: number, row: number) {
    return planned(delete_rows(CLEAN, context(body_start), [{ kind: 'source', sourceRow: row }]));
}

/** `changes` recorded while every worksheet's body started at `body_start`. */
function entry_at(body_start: number, changes: readonly HistoryChange[]): HistoryEntry {
    const outcome = record_history_action(
        empty_history_stack(),
        { label: 'Gesture', changes },
        undefined,
        () => body_start,
    );
    if (outcome.kind !== 'recorded') throw new Error('not recorded');
    return outcome.state.undoStack[0];
}

const sheet_at = (body_start: number) => (): HeaderSheet => ({ bodyStart: body_start, sourceRowCount: ROWS });

function carried(entry: HistoryEntry, body_start: number): HistoryEntry {
    const result = entry_for_current_header(entry, sheet_at(body_start));
    if (!result.ok) throw new Error(`waits: ${result.reason}`);
    return result.entry;
}

function cell_change(row: number, worksheet: WorksheetTarget = SHEET): HistoryChange {
    const delta = build_cell_history_delta({
        worksheet,
        sourceRow: row,
        sourceColumn: 0,
        before: absent_overlay(),
        after: value_only_overlay(history_value('typed'), history_value('base')),
        persistedValue: history_value('base'),
        persistedHyperlink: null,
    });
    if (delta === undefined) throw new Error('fixture built a delta that moved nothing');
    return { kind: 'cell', delta };
}

function highlight_change(row: number): HistoryChange {
    return {
        kind: 'highlight',
        delta: { worksheet: SHEET, sourceRow: row, sourceColumn: 0, before: null, after: 'yellow' },
    };
}

function column(fields: Partial<PendingColumn> = {}): PendingColumn {
    return { id: 'col', header: '', cells: {}, format: { kind: 'none' }, createdOrder: 1, ...fields };
}

/** Insert `inserted` after the first column, at `body_start`. */
function column_inserted(
    body_start: number,
    inserted: PendingColumn,
    slot: PendingStructuralChanges = CLEAN,
) {
    return planned(insert_columns(
        slot, context(body_start), { kind: 'source', sourceColumn: 0 }, 'after', [inserted],
    ));
}

/** The change an insert of `inserted` records, whatever Pending Rows its cells name. */
function column_insert_change(body_start: number, inserted: PendingColumn): HistoryChange {
    const { change } = column_inserted(body_start, column());
    if (change.kind !== 'columnLayout') throw new Error('not a column change');
    return {
        kind: 'columnLayout',
        delta: { ...change.delta, pendingColumns: [{ id: inserted.id, before: null, after: inserted }] },
    };
}

function column_change(entry: HistoryEntry): Extract<HistoryChange, { kind: 'columnLayout' }> {
    const [change] = entry.action.changes;
    if (change.kind !== 'columnLayout') throw new Error('not a column change');
    return change;
}

describe('entry_for_current_header', () => {
    it('returns the entry itself when no worksheet it names moved', () => {
        const at_two = entry_at(2, [deleted(2, 5).change, cell_change(1)]);
        expect(at_two.bodyStarts).toEqual({ 'id:rId1': 2 });
        const same = entry_for_current_header(at_two, sheet_at(2));
        expect(same.ok && same.entry).toBe(at_two);

        // No stamp means the header was off.
        const at_zero = entry_at(0, [deleted(0, 5).change]);
        expect(at_zero.bodyStarts).toBeUndefined();
        const off = entry_for_current_header(at_zero, sheet_at(0));
        expect(off.ok && off.entry).toBe(at_zero);
    });

    it('leaves a worksheet it cannot resolve alone', () => {
        const entry = entry_at(1, [deleted(1, 5).change]);
        const result = entry_for_current_header(entry, () => undefined);
        expect(result.ok && result.entry).toBe(entry);
    });

    it.each([
        { from: 0, to: 1 },
        { from: 1, to: 0 },
        { from: 1, to: 2 },
        { from: 3, to: 1 },
    ])('re-expresses a row delete recorded at body start $from as one recorded at $to', ({ from, to }) => {
        const entry = entry_at(from, [deleted(from, 5).change]);
        const moved = carried(entry, to);
        // Exactly what the same gesture records where the body starts now.
        expect(moved.action.changes).toEqual(entry_at(to, [deleted(to, 5).change]).action.changes);
        // The stored entry is untouched, and the re-expressed one is the same entry.
        expect(entry.action.changes).toEqual(entry_at(from, [deleted(from, 5).change]).action.changes);
        expect(moved.id).toBe(entry.id);
        expect(moved.moves).toBe(entry.moves);
        expect(moved.epoch).toBe(entry.epoch);
        expect(moved.bodyStarts).toEqual(entry.bodyStarts);
        const [change] = moved.action.changes;
        if (change.kind !== 'rowLayout') throw new Error('not a row change');
        // A null side is the source layout at any body start.
        expect(change.delta.before).toBeNull();
        expect(change.delta.structuralBasis).toEqual({ before: null, after: basis(to) });
    });

    it('is the identity there and back', () => {
        const entry = entry_at(1, [deleted(1, 5).change, column_inserted(1, column({
            cells: { 's:4': { value: 'x', valueEditOrder: 1 } },
        })).change]);
        const there = carried(entry, 3);
        const back = carried({ ...there, bodyStarts: { 'id:rId1': 3 } }, 1);
        expect(back.action.changes).toEqual(entry.action.changes);
    });

    it('re-expresses only the worksheets that moved', () => {
        const other = cell_change(4, OTHER);
        const entry = entry_at(1, [deleted(1, 5).change, other]);
        const result = entry_for_current_header(entry, (worksheet) => ({
            bodyStart: worksheet.worksheetId === 'rId1' ? 2 : 1,
            sourceRowCount: ROWS,
        }));
        if (!result.ok) throw new Error('waits');
        expect(result.entry.action.changes[0]).toEqual(deleted(2, 5).change);
        expect(result.entry.action.changes[1]).toBe(entry.action.changes[1]);
    });

    it('carries a highlight anywhere, the header rows included', () => {
        const entry = entry_at(1, [highlight_change(0), highlight_change(2), highlight_change(7)]);
        expect(carried(entry, 3).action.changes).toBe(entry.action.changes);
    });

    it('waits for a cell on the old or the new Header Row, and for no other cell', () => {
        // Row 0 was the Header Row; row 2 is now.
        const move = { worksheet: SHEET, from: 1, to: 3 };
        expect(entry_for_current_header(entry_at(1, [cell_change(0)]), sheet_at(3)))
            .toEqual({ ok: false, reason: 'header-cell', row: 0, ...move });
        expect(entry_for_current_header(entry_at(1, [cell_change(5), cell_change(2)]), sheet_at(3)))
            .toEqual({ ok: false, reason: 'header-cell', row: 2, ...move });
        // Row 1 is above the header now, hidden: still the cell it was.
        const hidden = entry_at(1, [cell_change(1), cell_change(5)]);
        expect(carried(hidden, 3)).toBe(hidden);
        // The same row is the Header Row at both: a column name either way.
        const name = entry_at(3, [cell_change(2)]);
        expect(carried(name, 3)).toBe(name);
    });

    it('waits for a row change naming rows that left the body', () => {
        const move = { worksheet: SHEET, from: 1, to: 3 };
        expect(entry_for_current_header(entry_at(1, [deleted(1, 2).change]), sheet_at(3)))
            .toEqual({ ok: false, reason: 'rows', ...move });
        const removal = {
            appendHistoryId: 'saved',
            sourceRow: 2,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: { kind: 'none' as const } },
        };
        const tail: HistoryChange = {
            kind: 'tailRemoval',
            delta: {
                worksheet: SHEET,
                appendHistoryId: 'saved',
                before: null,
                after: removal as never,
                beforeIndex: null,
                afterIndex: 0,
            },
        };
        expect(entry_for_current_header(entry_at(1, [tail]), sheet_at(3)))
            .toEqual({ ok: false, reason: 'rows', ...move });
        // Still in the body: carried as it is.
        const kept = entry_at(1, [tail]);
        expect(carried(kept, 2).action.changes).toBe(kept.action.changes);
    });

    it('waits with the notice reason when a side was authored at yet another body start', () => {
        const recorded = deleted(2, 5).change;
        // Stamped 1, but the layout says it was authored at 2.
        const entry = entry_at(1, [recorded]);
        expect(entry_for_current_header(entry, sheet_at(0)))
            .toEqual({ ok: false, reason: 'notice', worksheet: SHEET, from: 1, to: 0 });
    });

    describe('Pending Columns', () => {
        const typed = { value: 'x', valueEditOrder: 1 };

        it('carries an empty, a named, and a Pending-Row-only column unchanged in content', () => {
            for (const given of [
                column(),
                column({ header: 'Total' }),
                column({ cells: { 'p:row-1': typed } }),
            ]) {
                const entry = entry_at(1, [column_insert_change(1, given)]);
                const moved = column_change(carried(entry, 3));
                expect(moved.delta.pendingColumns).toEqual([{ id: 'col', before: null, after: given }]);
                expect(moved.delta.structuralBasis).toEqual({ before: null, after: basis(3) });
                // A column layout names no rows.
                expect(moved.delta.after).toEqual(column_change(entry).delta.after);
            }
        });

        it('re-keys cells and highlights as their rows cross the header', () => {
            const given = column({
                header: 'Total',
                cells: { 's:1': typed, 's:5': typed, 'p:row-1': typed },
                highlights: { 's:1': 'yellow', 's:2': 'green', 's:6': 'yellow' },
            });
            const down = column_change(carried(entry_at(1, [column_insert_change(1, given)]), 3));
            expect(down.delta.pendingColumns[0].after).toEqual({
                ...given,
                cells: { 'f:1': typed, 's:5': typed, 'p:row-1': typed },
                // A highlight on the row that became the header is carried too.
                highlights: { 'f:1': 'yellow', 'f:2': 'green', 's:6': 'yellow' },
            });

            const above = column({ cells: { 'f:1': typed, 's:5': typed } });
            const up = column_change(carried(entry_at(3, [column_inserted(3, above).change]), 1));
            expect(up.delta.pendingColumns[0].after?.cells).toEqual({ 's:1': typed, 's:5': typed });
        });

        it('waits for a cell on a row that switched header role, naming the row', () => {
            const move = { worksheet: SHEET, from: 1, to: 3 };
            const on_new_header = column({ cells: { 's:2': typed } });
            expect(entry_for_current_header(
                entry_at(1, [column_inserted(1, on_new_header).change]), sheet_at(3),
            )).toEqual({ ok: false, reason: 'header-cell', row: 2, ...move });
            const on_old_header = column({ cells: { 'f:0': typed } });
            expect(entry_for_current_header(
                entry_at(1, [column_inserted(1, on_old_header).change]), sheet_at(3),
            )).toEqual({ ok: false, reason: 'header-cell', row: 0, ...move });
        });
    });

    describe('whole-slot snapshots', () => {
        const row: PendingAppendedRow = { id: 'a', cells: {}, formatTemplateId: 'plain', createdOrder: 1 };
        const append_basis = {
            sourceRowCount: ROWS,
            provisionalStartRow: ROWS,
            provisionalRowCount: 1,
            columnCount: 2,
            schemaFingerprint: 'schema',
        };

        it('carries an append\'s basis arm as it is: nothing in it is relative to the body', () => {
            const after = { ...CLEAN, formatTemplates: [template], appendedRows: [row], appendBasis: append_basis };
            const entry = entry_at(1, [{
                kind: 'pendingRows',
                delta: { worksheet: SHEET, before: { ...after, appendBasis: undefined }, after },
            }]);
            const [change] = carried(entry, 3).action.changes;
            expect(change).toEqual(entry.action.changes[0]);
        });

        it('carries a Discard holding a layout and a Pending Column, in the shape the store holds', () => {
            const before = own_pending_structural_changes(column_inserted(
                1,
                column({ cells: { 's:1': { value: 'x', valueEditOrder: 1 } } }),
                deleted(1, 5).next,
            ).next);
            const entry = entry_at(1, [{ kind: 'pendingRows', delta: { worksheet: SHEET, before, after: CLEAN } }]);
            const [change] = carried(entry, 3).action.changes;
            if (change.kind !== 'pendingRows') throw new Error('not a snapshot');
            expect(change.delta.after).toEqual(own_pending_structural_changes(CLEAN));
            expect(change.delta.before).not.toHaveProperty('cells');
            expect(change.delta.before.rowLayout).toEqual(deleted(3, 5).next.rowLayout);
            expect(change.delta.before.structuralBasis).toEqual(basis(3));
            expect(change.delta.before.pendingColumns?.[0].cells)
                .toEqual({ 'f:1': { value: 'x', valueEditOrder: 1 } });
            // Owned: byte-for-byte what the store would hold for the same slot.
            expect(JSON.stringify(change.delta.before))
                .toBe(JSON.stringify(own_pending_structural_changes(change.delta.before)));
        });

        it('waits when a snapshot names rows that left the body', () => {
            const entry = entry_at(1, [{
                kind: 'pendingRows',
                delta: { worksheet: SHEET, before: deleted(1, 2).next, after: CLEAN },
            }]);
            expect(entry_for_current_header(entry, sheet_at(3)))
                .toEqual({ ok: false, reason: 'rows', worksheet: SHEET, from: 1, to: 3 });
        });
    });

    describe('against the store the header change carried', () => {
        /** The slot as the header change's own write carries it. */
        function carried_slot(slot: PendingStructuralChanges, from: number, to: number): PendingStructuralChanges {
            const result = rebase_pending_edits_for_header(
                { cells: {}, ...slot }, { from, to, sourceRowCount: ROWS },
            );
            if (!result.ok) throw new Error(result.message);
            const { cells: _cells, ...structural } = result.slot;
            return own_pending_structural_changes(structural as PendingStructuralChanges);
        }

        function replayed(
            entry: HistoryEntry,
            direction: 'undo' | 'redo',
            current: PendingStructuralChanges,
        ): PendingStructuralChanges {
            const result = plan_pending_row_history_replay(entry.action, direction, () => current);
            if (result.kind !== 'plan') throw new Error(`expected a plan, got ${JSON.stringify(result)}`);
            return result.plans[0].next;
        }

        it.each([
            { path: [1, 2] },
            { path: [1, 2, 4] },
            { path: [2, 0] },
            { path: [1, 3, 1] },
        ])('undoes a pending delete after the header moved $path', ({ path }) => {
            const [from] = path;
            const gesture = deleted(from, 6);
            const entry = entry_at(from, [gesture.change]);
            let slot = own_pending_structural_changes(gesture.next);
            for (let index = 1; index < path.length; index++) {
                slot = carried_slot(slot, path[index - 1], path[index]);
            }
            const now = path[path.length - 1];
            // The stored entry no longer matches the store; the re-expressed one does.
            if (now !== from) {
                expect(plan_pending_row_history_replay(entry.action, 'undo', () => slot))
                    .toEqual({ kind: 'refused', reason: 'conflict' });
            }
            const current = carried(entry, now);
            const undone = replayed(current, 'undo', slot);
            expect(undone.rowLayout).toBeUndefined();
            expect(replayed(current, 'redo', undone)).toEqual(slot);
        });

        it('redoes an undone delete under a header chosen afterwards', () => {
            const gesture = deleted(1, 6);
            const entry = entry_at(1, [gesture.change]);
            // Undone before the header moved: the store held nothing to carry.
            const redone = replayed(carried(entry, 3), 'redo', own_pending_structural_changes(CLEAN));
            expect(redone).toEqual(own_pending_structural_changes(deleted(3, 6).next));
        });
    });
});
