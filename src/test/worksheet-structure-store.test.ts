// Worksheet structural store (row and column structure design, delivery step
// 4): the pure Insert/Delete/Restore/Move operations, every refusal, and
// committing an outcome through the store.
import { describe, expect, it } from 'vitest';
import {
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    MAX_PENDING_USER_CHANGES_ENCODED_BYTES,
    type PendingAppendedRow,
    type PendingColumn,
    type PendingStructuralChanges,
    type StructuralBasis,
} from '../pending-changes';
import {
    APPENDED_BAND_MESSAGE,
    create_pending_row_store,
    delete_columns,
    delete_rows,
    insert_columns,
    insert_rows,
    LAST_LIVE_COLUMN_MESSAGE,
    merge_anchor_message,
    merge_destination_message,
    MERGE_SPLIT_MESSAGE,
    move_columns,
    move_rows,
    restore_columns,
    restore_rows,
    source_cells_removed_by,
    STRUCTURE_CELL_MOVE_MESSAGE,
    STRUCTURE_TAIL_REMOVAL_MESSAGE,
    STRUCTURE_TRANSFORMED_MESSAGE,
    type StructureResult,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import { TOO_MANY_ROW_REMOVALS_MESSAGE, TOO_MANY_ROW_RUNS_MESSAGE } from '../worksheet-layout';

const worksheet = { sheetIndex: 0, sheetName: 'Data' };
const template = { id: 'plain', format: { kind: 'none' as const } };
const BASIS: StructuralBasis = {
    kind: 'delimited',
    byteLength: 10,
    digest: 'sha256:x',
    sourceRowCount: 6,
    sourceColumnCount: 3,
};

/** Body rows 0-5, three columns, untransformed. */
function context(overrides: Partial<WorksheetStructureContext> = {}): WorksheetStructureContext {
    return {
        worksheet,
        bodyStart: 0,
        sourceRowCount: 6,
        sourceColumnCount: 3,
        bodyViewTransformed: false,
        structuralBasis: BASIS,
        ...overrides,
    };
}

const source = (sourceRow: number) => ({ kind: 'source' as const, sourceRow });
const pending = (pendingRowId: string) => ({ kind: 'pending' as const, pendingRowId });
const column = (sourceColumn: number) => ({ kind: 'source' as const, sourceColumn });
const pending_column = (pendingColumnId: string) => ({ kind: 'pending' as const, pendingColumnId });

function ok(result: StructureResult) {
    if (!result.ok) throw new Error(`Refused: ${result.refusal.message}`);
    return result.outcome;
}

function refusal(result: StructureResult) {
    if (result.ok) throw new Error('Expected a refusal');
    return result.refusal;
}

function appended(id: string, createdOrder: number, cells: PendingAppendedRow['cells'] = {}): PendingAppendedRow {
    return { id, cells, formatTemplateId: template.id, createdOrder };
}

function with_appended(...rows: PendingAppendedRow[]): PendingStructuralChanges {
    return { ...EMPTY_PENDING_STRUCTURAL_CHANGES, formatTemplates: [template], appendedRows: rows };
}

function new_column(id: string, createdOrder: number): PendingColumn {
    return { id, header: 'New column', cells: {}, format: { kind: 'none' }, createdOrder };
}

describe('row operations', () => {
    it('inserts blank Pending Inserted Rows inline and records the Structural Basis', () => {
        const outcome = ok(insert_rows(
            EMPTY_PENDING_STRUCTURAL_CHANGES, context(), source(2), 'before', ['a', 'b'], template, 7));
        expect(outcome.next.rowLayout?.runs).toEqual([
            { kind: 'source', start: 0, count: 2 },
            { kind: 'pending', ids: ['a', 'b'] },
            { kind: 'source', start: 2, count: 4 },
        ]);
        expect(outcome.next.appendedRows).toEqual([
            { id: 'a', origin: 'insert', cells: {}, formatTemplateId: 'plain', createdOrder: 7 },
            { id: 'b', origin: 'insert', cells: {}, formatTemplateId: 'plain', createdOrder: 8 },
        ]);
        expect(outcome.next.structuralBasis).toEqual(BASIS);
        expect(outcome.change.kind).toBe('rowLayout');
        expect(outcome.change.delta).toMatchObject({
            worksheet,
            before: null,
            after: outcome.next.rowLayout,
            formatTemplates: [template],
            structuralBasis: { before: null, after: BASIS },
        });
        expect(outcome.change.delta.pendingRows.map((entry) => [entry.id, entry.before])).toEqual([
            ['a', null],
            ['b', null],
        ]);
    });

    it('records the append basis an insert admission carries', () => {
        const append_basis = {
            sourceRowCount: 6,
            columnCount: 3,
            schemaFingerprint: 'sha256:schema',
        };
        const outcome = ok(insert_rows(
            EMPTY_PENDING_STRUCTURAL_CHANGES, context(), source(5), 'after', ['a'], template, 1, append_basis));
        expect(outcome.next.appendBasis).toEqual(append_basis);
        expect(outcome.change.delta.appendBasis).toEqual({ before: null, after: append_basis });
    });

    it('deletes source rows in place and drops a discarded inserted row with its content', () => {
        const inserted = ok(insert_rows(
            EMPTY_PENDING_STRUCTURAL_CHANGES, context(), source(1), 'after', ['a'], template, 1)).next;
        const typed: PendingStructuralChanges = {
            ...inserted,
            appendedRows: [{ ...inserted.appendedRows[0]!, cells: { 0: { value: 'typed' } } }],
        };
        const outcome = ok(delete_rows(typed, context(), [source(1), pending('a'), source(4)]));
        expect(outcome.next.rowLayout).toEqual({
            runs: [{ kind: 'source', start: 0, count: 6 }],
            removedSourceRows: [{ start: 1, count: 1 }, { start: 4, count: 1 }],
            discardedPendingRows: [],
        });
        expect(outcome.next.appendedRows).toEqual([]);
        expect(outcome.discardedRows).toEqual([typed.appendedRows[0]]);
        expect(outcome.removedSourceRows).toEqual([{ start: 1, count: 1 }, { start: 4, count: 1 }]);
        expect(outcome.change.delta.pendingRows).toEqual([
            { id: 'a', before: typed.appendedRows[0], after: null },
        ]);
        expect(outcome.change.delta.formatTemplates).toEqual([template]);
    });

    it('keeps a discarded inserted row as a tombstone while an anchor names it', () => {
        const inserted = ok(insert_rows(
            EMPTY_PENDING_STRUCTURAL_CHANGES, context(), source(1), 'after', ['a'], template, 1)).next;
        const outcome = ok(delete_rows(inserted, context({ isRowReferenced: (id) => id === 'a' }), [pending('a')]));
        expect(outcome.next.rowLayout?.discardedPendingRows).toEqual([{ id: 'a', createdOrder: 1 }]);
        // Tombstones alone are no live layout change, so no basis is kept.
        expect(outcome.next.structuralBasis).toBeUndefined();
    });

    it('removes appended rows from the band in a mixed delete and clears the emptied append basis', () => {
        const start: PendingStructuralChanges = {
            ...with_appended(appended('x', 1)),
            appendBasis: { sourceRowCount: 6, columnCount: 3, schemaFingerprint: 'sha256:s' },
        };
        const outcome = ok(delete_rows(start, context(), [source(0), pending('x')]));
        expect(outcome.next.appendedRows).toEqual([]);
        expect(outcome.next.appendBasis).toBeUndefined();
        expect(outcome.change.delta.appendBasis).toEqual({ before: start.appendBasis, after: null });
        expect(outcome.next.rowLayout?.removedSourceRows).toEqual([{ start: 0, count: 1 }]);
    });

    it('drops Pending Column cells in removed rows and returns them for history', () => {
        const with_column = ok(insert_columns(
            EMPTY_PENDING_STRUCTURAL_CHANGES, context(), column(0), 'after', [new_column('c', 1)])).next;
        const typed: PendingStructuralChanges = {
            ...with_column,
            pendingColumns: [{ ...with_column.pendingColumns![0]!, cells: { 's:2': { value: 'v' }, 's:3': { value: 'w' } } }],
        };
        const outcome = ok(delete_rows(typed, context(), [source(2)]));
        expect(outcome.next.pendingColumns?.[0]?.cells).toEqual({ 's:3': { value: 'w' } });
        expect(outcome.change.delta.pendingColumns).toEqual([{
            id: 'c',
            before: typed.pendingColumns![0],
            after: outcome.next.pendingColumns![0],
        }]);
    });

    it('lists the source cell edits a delete removes', () => {
        const outcome = ok(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context(), [source(1), source(2)]));
        expect(source_cells_removed_by(outcome, ['0:0', '1:0', '2:2', '3:1', 'junk']))
            .toEqual([
                { key: '1:0', sourceRow: 1, sourceColumn: 0 },
                { key: '2:2', sourceRow: 2, sourceColumn: 2 },
            ]);
    });

    it('restores removed rows and drops the basis with the last live change', () => {
        const deleted = ok(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context(), [source(3)])).next;
        const outcome = ok(restore_rows(deleted, context(), [3]));
        expect(outcome.next.rowLayout).toBeUndefined();
        expect(outcome.next.structuralBasis).toBeUndefined();
        expect(outcome.change.delta).toMatchObject({ after: null, structuralBasis: { before: BASIS, after: null } });
        expect(refusal(restore_rows(deleted, context(), [2])).reason).toBe('not-removed');
    });

    it('moves rows with their removals and reports nothing-changed moves', () => {
        const deleted = ok(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context(), [source(3)])).next;
        const outcome = ok(move_rows(deleted, context(), [source(2), source(3)], source(5)));
        expect(outcome.next.rowLayout?.runs).toEqual([
            { kind: 'source', start: 0, count: 2 },
            { kind: 'source', start: 4, count: 1 },
            { kind: 'source', start: 2, count: 2 },
            { kind: 'source', start: 5, count: 1 },
        ]);
        expect(refusal(move_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context(), [source(2)], source(3))).reason)
            .toBe('unchanged');
    });

    it('never mutates the snapshot it planned against', () => {
        const start = with_appended(appended('x', 1, { 0: { value: 'v' } }));
        const frozen = JSON.stringify(start);
        ok(delete_rows(start, context(), [source(0), pending('x')]));
        ok(insert_rows(start, context(), source(0), 'before', ['a'], template, 5));
        expect(JSON.stringify(start)).toBe(frozen);
    });
});

describe('row refusals', () => {
    it('refuses every structure item beside a Pending Tail Removal', () => {
        const start: PendingStructuralChanges = {
            ...EMPTY_PENDING_STRUCTURAL_CHANGES,
            tailRemovals: [{
                appendHistoryId: 'h',
                sourceRow: 5,
                savedFingerprint: 'f',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }],
        };
        for (const result of [
            delete_rows(start, context(), [source(0)]),
            insert_rows(start, context(), source(0), 'before', ['a'], template, 1),
            move_rows(start, context(), [source(0)], 'end'),
            restore_rows(start, context(), [0]),
            delete_columns(start, context(), [column(0)]),
        ]) {
            expect(refusal(result)).toEqual({ reason: 'tail-removal', message: STRUCTURE_TAIL_REMOVAL_MESSAGE });
        }
    });

    it('refuses structure items beside a pending cell move, from the caller or a pending cell', () => {
        expect(refusal(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context({ hasPendingCellMove: () => true }),
            [source(0)]))).toEqual({ reason: 'cell-move', message: STRUCTURE_CELL_MOVE_MESSAGE });
        const moved = with_appended(appended('x', 1, {
            0: { value: 'v', movedFrom: { sourceRow: 0, sourceColumn: 0 } } as never,
        }));
        expect(refusal(move_columns(moved, context(), [column(0)], 'end')).reason).toBe('cell-move');
    });

    it('refuses row insert and move in a transformed view, but not delete', () => {
        const transformed = context({ bodyViewTransformed: true });
        expect(refusal(insert_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, transformed, source(0), 'after', ['a'], template, 1)))
            .toEqual({ reason: 'transformed', message: STRUCTURE_TRANSFORMED_MESSAGE });
        expect(refusal(move_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, transformed, [source(0)], 'end')).reason)
            .toBe('transformed');
        ok(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, transformed, [source(0)]));
        ok(move_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, transformed, [column(0)], 'end'));
    });

    it('keeps appended rows out of inserts and moves', () => {
        const start = with_appended(appended('x', 1));
        const band = { reason: 'appended-band', message: APPENDED_BAND_MESSAGE };
        expect(refusal(insert_rows(start, context(), pending('x'), 'after', ['a'], template, 2))).toEqual(band);
        expect(refusal(move_rows(start, context(), [source(0), pending('x')], 'end'))).toEqual(band);
        expect(refusal(move_rows(start, context(), [source(0)], pending('x')))).toEqual(band);
        // 'end' is the end of the layout, before the band.
        expect(ok(move_rows(start, context(), [source(0)], 'end')).next.appendedRows).toEqual(start.appendedRows);
    });

    it('refuses rows that are not body rows and selections of only tombstones', () => {
        expect(refusal(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context({ bodyStart: 1, sourceRowCount: 7 }),
            [source(0)])).reason).toBe('unknown-identity');
        const deleted = ok(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context(), [source(3)])).next;
        expect(refusal(delete_rows(deleted, context(), [source(3)])).reason).toBe('no-live-entry');
        expect(refusal(move_rows(deleted, context(), [source(3)], 'end')).reason).toBe('no-live-entry');
        expect(refusal(insert_rows(deleted, context(), source(3), 'after', ['a'], template, 1)).reason)
            .toBe('no-live-entry');
    });

    it('applies the merge rules', () => {
        // Rows 1-2, columns 0-1.
        const merges = [{ startRow: 1, endRow: 2, startCol: 0, endCol: 1 }];
        const with_merges = context({ merges });
        expect(refusal(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, with_merges, [source(1)])))
            .toEqual({ reason: 'merge-anchor', message: merge_anchor_message('rows') });
        // Deleting the whole merge, or a row that is not its anchor, is fine.
        ok(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, with_merges, [source(1), source(2)]));
        ok(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, with_merges, [source(2)]));
        expect(refusal(move_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, with_merges, [source(2)], source(5))))
            .toEqual({ reason: 'merge-split', message: MERGE_SPLIT_MESSAGE });
        ok(move_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, with_merges, [source(1), source(2)], source(5)));
        expect(refusal(move_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, with_merges, [source(4)], source(2))))
            .toEqual({ reason: 'merge-destination', message: merge_destination_message('rows') });
        // Inserting inside a merge expands it.
        ok(insert_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, with_merges, source(2), 'before', ['a'], template, 1));
        expect(refusal(delete_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, with_merges, [column(0)])))
            .toEqual({ reason: 'merge-anchor', message: merge_anchor_message('columns') });
        expect(refusal(move_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, with_merges, [column(2)], column(1))))
            .toEqual({ reason: 'merge-destination', message: merge_destination_message('columns') });
    });

    it('applies the row limits', () => {
        const wide = context({ sourceRowCount: 300_000, structuralBasis: { ...BASIS, sourceRowCount: 300_000 } });
        const every_other = Array.from({ length: 100_001 }, (_, index) => source(index * 2));
        expect(refusal(delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, wide, every_other)))
            .toEqual({ reason: 'too-many-removals', message: TOO_MANY_ROW_REMOVALS_MESSAGE });
        const runs = context({ sourceRowCount: 20_000, structuralBasis: { ...BASIS, sourceRowCount: 20_000 } });
        // 4,999 single inserted rows between single source rows: 9,999 runs.
        const runs_list: ({ kind: 'source'; start: number; count: number } | { kind: 'pending'; ids: string[] })[] = [];
        const inserted_rows: PendingAppendedRow[] = [];
        for (let at = 0; at < 4_999; at++) {
            runs_list.push({ kind: 'source', start: at, count: 1 });
            runs_list.push({ kind: 'pending', ids: [`r${at}`] });
            inserted_rows.push({ ...appended(`r${at}`, at), origin: 'insert' });
        }
        runs_list.push({ kind: 'source', start: 4_999, count: 20_000 - 4_999 });
        const changes: PendingStructuralChanges = {
            ...with_appended(...inserted_rows),
            rowLayout: { runs: runs_list, removedSourceRows: [], discardedPendingRows: [] },
            structuralBasis: { ...BASIS, sourceRowCount: 20_000 },
        };
        expect(changes.rowLayout!.runs.length).toBe(9_999);
        expect(refusal(insert_rows(changes, runs, source(19_000), 'before', ['last'], template, 9_000)))
            .toEqual({ reason: 'too-many-runs', message: TOO_MANY_ROW_RUNS_MESSAGE });
        expect(refusal(insert_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context({ maxProspectiveRows: 7 }),
            source(0), 'before', ['a', 'b'], template, 1)).reason).toBe('too-many-rows');
        const full = with_appended(...Array.from({ length: 10_000 }, (_, index) => appended(`x${index}`, index)));
        expect(refusal(insert_rows(full, context(), source(0), 'before', ['a'], template, 20_000)).reason)
            .toBe('too-many-pending-rows');
    });
});

describe('column operations', () => {
    it('inserts, deletes, restores, and moves columns', () => {
        const inserted = ok(insert_columns(
            EMPTY_PENDING_STRUCTURAL_CHANGES, context(), column(1), 'before', [new_column('c', 1)]));
        expect(inserted.change.kind).toBe('columnLayout');
        expect(inserted.next.columnLayout?.columns).toEqual([
            column(0), pending_column('c'), column(1), column(2),
        ]);
        const deleted = ok(delete_columns(inserted.next, context(), [pending_column('c'), column(2)]));
        expect(deleted.next.columnLayout).toEqual({
            columns: [column(0), column(1), column(2)],
            removedSourceColumns: [2],
            discardedPendingColumns: [],
        });
        expect(deleted.next.pendingColumns).toBeUndefined();
        expect(deleted.discardedColumns).toEqual([inserted.next.pendingColumns![0]]);
        expect(deleted.removedSourceColumns).toEqual([2]);
        expect(source_cells_removed_by(deleted, ['0:2', '0:1'])).toEqual([
            { key: '0:2', sourceRow: 0, sourceColumn: 2 },
        ]);
        expect(ok(restore_columns(deleted.next, context(), [2])).next.columnLayout).toBeUndefined();
        expect(ok(move_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context(), [column(0)], 'end')).next.columnLayout?.columns)
            .toEqual([column(1), column(2), column(0)]);
    });

    it('drops Pending Row cells in removed columns into history', () => {
        const start = with_appended(appended('x', 1, { 0: { value: 'keep' }, 2: { value: 'gone' } }));
        const outcome = ok(delete_columns(start, context(), [column(2)]));
        expect(outcome.next.appendedRows[0]!.cells).toEqual({ 0: { value: 'keep' } });
        expect(outcome.change.delta.pendingRows).toEqual([
            { id: 'x', before: start.appendedRows[0], after: outcome.next.appendedRows[0] },
        ]);
        expect(outcome.change.delta.formatTemplates).toEqual([template]);
    });

    it('keeps at least one live column', () => {
        expect(refusal(delete_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context(), [column(0), column(1), column(2)])))
            .toEqual({ reason: 'last-live-column', message: LAST_LIVE_COLUMN_MESSAGE });
    });

    it('applies the column limits', () => {
        expect(refusal(insert_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context({ sourceColumnCount: 300 }),
            column(0), 'after', [new_column('c', 1)])).reason).toBe('too-wide-to-restructure');
        const many = Array.from({ length: 254 }, (_, index) => new_column(`c${index}`, index));
        expect(refusal(insert_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context(), column(0), 'after', many)).reason)
            .toBe('too-many-live-columns');
        const too_many = Array.from({ length: 257 }, (_, index) => new_column(`c${index}`, index));
        expect(refusal(insert_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context({ sourceColumnCount: 1 }),
            column(0), 'after', too_many)).reason).toBe('too-many-pending-columns');
    });
});

describe('committing an outcome', () => {
    it('applies an outcome planned against the current snapshot, and only that one', () => {
        const store = create_pending_row_store({ session_id: 's' });
        const outcome = ok(delete_rows(store.snapshot(), context(), [source(1)]));
        expect(store.apply_structure('other', outcome)).toBe(false);
        expect(store.apply_structure('s', outcome)).toBe(true);
        expect(store.snapshot()).toBe(outcome.next);
        // Planned against a snapshot the store no longer holds.
        expect(store.apply_structure('s', outcome)).toBe(false);
    });

    it('measures layout fields in the worksheet envelope exactly', () => {
        const store = create_pending_row_store({ session_id: 's' });
        store.set_envelope_context(worksheet, () => ({ cells: {}, encodedBytes: 2 }));
        const outcome = ok(delete_rows(store.snapshot(), context(), [source(1)]));
        const cells_for = (padding: number) => ({ '0:0': { value: 'x'.repeat(padding), base: '' } });
        const envelope = (changes: PendingStructuralChanges, padding: number) => new TextEncoder().encode(
            JSON.stringify({ ...worksheet, cells: cells_for(padding), ...changes }),
        ).byteLength;
        // Padding that lands each envelope exactly on the bound fits; one more byte does not.
        for (const changes of [store.snapshot(), outcome.next]) {
            const padding = MAX_PENDING_USER_CHANGES_ENCODED_BYTES - envelope(changes, 0);
            expect(envelope(changes, padding)).toBe(MAX_PENDING_USER_CHANGES_ENCODED_BYTES);
            expect(store.envelope_fits(cells_for(padding), changes)).toBe(true);
            expect(store.envelope_fits(cells_for(padding + 1), changes)).toBe(false);
        }
    });
});
