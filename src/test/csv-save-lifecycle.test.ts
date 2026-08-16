import { describe, expect, it } from 'vitest';
import type { CsvSaveOperation, SheetPendingEditCells } from '../types';
import {
    csv_save_operations_equal,
    propose_csv_save,
    reduce_csv_save_projection,
    resolve_csv_save_hydration,
    type CsvSaveProjection,
} from '../webview/csv-save-lifecycle';

function hydrate(
    projection: Pick<CsvSaveProjection, 'authoritative' | 'operation'>,
    edit_session_id: string | undefined,
    pending_edits: SheetPendingEditCells | undefined,
    sheet_index = 0,
    sheet_name?: string,
    worksheet_id?: string,
): SheetPendingEditCells | undefined {
    return resolve_csv_save_hydration(
        projection,
        edit_session_id,
        sheet_index,
        sheet_name,
        worksheet_id,
        pending_edits,
    );
}

function worksheet(
    id: string,
    sheet_index = 0,
    sheet_name?: string,
    worksheet_id?: string,
): CsvSaveOperation['worksheets'][number] {
    return {
        sheetIndex: sheet_index,
        ...(sheet_name !== undefined ? { sheetName: sheet_name } : {}),
        ...(worksheet_id !== undefined ? { worksheetId: worksheet_id } : {}),
        edits: { '0:0': id },
        dirtyEdits: { '0:0': { value: id, base: `base:${id}` } },
    };
}

function operation(
    id: string,
    edit_session_id = 'edit-session',
    worksheets: CsvSaveOperation['worksheets'] = [worksheet(id)],
): CsvSaveOperation {
    return {
        editSessionId: edit_session_id,
        saveRequestId: id,
        worksheets,
    };
}

function dirty_edits(operation: CsvSaveOperation, index = 0) {
    return operation.worksheets[index].dirtyEdits;
}

describe('CSV save lifecycle projection', () => {
    it('does not let a same-revision immutable snapshot cancel a later proposal', () => {
        const before: CsvSaveProjection = {
            authoritative: { revision: 7, state: 'idle' },
        };
        const proposed = propose_csv_save(before, operation('local'));

        const replayed = reduce_csv_save_projection(proposed, {
            revision: 7,
            state: 'idle',
        });

        expect(replayed).toBe(proposed);
        expect(replayed.operation).toEqual(operation('local'));
    });

    it('orders exact active and terminal projections by lifecycle revision', () => {
        const local = operation('local');
        let projection = propose_csv_save({
            authoritative: { revision: 3, state: 'idle' },
        }, local);

        projection = reduce_csv_save_projection(projection, {
            revision: 4,
            state: 'active',
            operation: local,
        });
        expect(projection.operation).toEqual(local);

        const stale = reduce_csv_save_projection(projection, {
            revision: 3,
            state: 'failed',
            operation: local,
        });
        expect(stale).toBe(projection);

        const duplicate = reduce_csv_save_projection(projection, {
            revision: 4,
            state: 'active',
            operation: local,
        });
        expect(duplicate).toBe(projection);

        projection = reduce_csv_save_projection(projection, {
            revision: 5,
            state: 'failed',
            operation: local,
        });
        expect(projection.operation).toBeUndefined();
        expect(projection.authoritative.state).toBe('failed');
    });

    it('retains a local proposal across mismatched terminals and identity-free idle', () => {
        const local = operation('local');
        let projection = propose_csv_save({
            authoritative: { revision: 10, state: 'idle' },
        }, local);

        projection = reduce_csv_save_projection(projection, {
            revision: 11,
            state: 'succeeded',
            operation: operation('other'),
        });
        expect(projection.operation).toEqual(local);

        projection = reduce_csv_save_projection(projection, {
            revision: 12,
            state: 'idle',
        });
        expect(projection.operation).toEqual(local);
        expect(projection.authoritative).toEqual({ revision: 12, state: 'idle' });
    });

    it('keeps a proposal locked through failed r2, delayed idle r3, and exact active r4', () => {
        const failed = operation('failed');
        const local = operation('local');
        let projection = propose_csv_save({
            authoritative: { revision: 2, state: 'failed', operation: failed },
        }, local);

        projection = reduce_csv_save_projection(projection, {
            revision: 3,
            state: 'idle',
        });
        expect(projection.operation).toEqual(local);
        expect(hydrate(
            projection,
            local.editSessionId,
            undefined,
        )).toEqual(dirty_edits(local));

        projection = reduce_csv_save_projection(projection, {
            revision: 4,
            state: 'active',
            operation: local,
        });
        expect(projection.operation).toEqual(local);
    });

    it('hydrates failed operation edits only for their current session', () => {
        const newer = { '0:0': { value: 'newer', base: 'new-base' } };
        const failed = operation('failed', 'old-session');
        const projection = {
            authoritative: { revision: 4, state: 'failed', operation: failed } as const,
        };

        expect(hydrate(
            projection,
            'old-session',
            newer,
        )).toEqual(dirty_edits(failed));
        expect(hydrate(
            projection,
            'new-session',
            newer,
        )).toBe(newer);
        expect(hydrate(
            projection,
            'new-session',
            dirty_edits(failed),
        )).toBeUndefined();
    });

    it('tombstones succeeded-session edits without suppressing a newer session', () => {
        const pending = { '0:0': { value: 'newer', base: 'new-base' } };
        const succeeded = operation('saved', 'saved-session');
        const projection = {
            authoritative: { revision: 5, state: 'succeeded', operation: succeeded } as const,
        };

        expect(hydrate(
            projection,
            undefined,
            dirty_edits(succeeded),
        )).toBeUndefined();
        expect(hydrate(
            projection,
            'saved-session',
            dirty_edits(succeeded),
        )).toBeUndefined();
        expect(hydrate(
            projection,
            'new-session',
            pending,
        )).toBe(pending);
    });

    it('removes only completed-operation entries from a mixed succeeded map', () => {
        const succeeded = operation('saved', 'saved-session');
        const newer = { value: 'newer', base: 'new-base' };
        const projection = {
            authoritative: { revision: 6, state: 'succeeded', operation: succeeded } as const,
        };

        expect(hydrate(
            projection,
            undefined,
            {
                ...dirty_edits(succeeded),
                '1:0': newer,
            },
        )).toEqual({ '1:0': newer });
    });

    it('treats worksheet order, identity, and payload as save operation identity', () => {
        const people = worksheet('people', 0, 'People');
        const inventory = worksheet('inventory', 1, 'Inventory');
        const workbook = operation('same', 'edit-session', [people, inventory]);
        const reordered = operation('same', 'edit-session', [inventory, people]);
        const renamed = operation('same', 'edit-session', [
            { ...people, sheetName: 'Persons' },
            inventory,
        ]);
        const changed = operation('same', 'edit-session', [
            people,
            { ...inventory, edits: { '0:0': 'changed' } },
        ]);

        expect(csv_save_operations_equal(workbook, operation(
            'same',
            'edit-session',
            [people, inventory],
        ))).toBe(true);
        expect(csv_save_operations_equal(workbook, reordered)).toBe(false);
        expect(csv_save_operations_equal(workbook, renamed)).toBe(false);
        expect(csv_save_operations_equal(workbook, changed)).toBe(false);
    });

    it('treats runs as part of operation identity and tombstone matching', () => {
        const bold = { runs: [{ text: 'saved', style: { bold: true as const } }] };
        const plain_ws = worksheet('saved');
        const rich_ws = {
            ...plain_ws,
            dirtyEdits: { '0:0': { ...plain_ws.dirtyEdits['0:0'], valueRuns: bold } },
        };
        // A formatting-only difference is a different operation…
        expect(csv_save_operations_equal(
            operation('same', 'edit-session', [plain_ws]),
            operation('same', 'edit-session', [rich_ws]),
        )).toBe(false);

        // …and a pending entry whose formatting differs from what the
        // succeeded operation saved is a newer edit the tombstone must keep.
        const succeeded = operation('saved', 'saved-session', [plain_ws]);
        const projection = {
            authoritative: { revision: 8, state: 'succeeded', operation: succeeded } as const,
        };
        const newer_formatting = {
            '0:0': { ...plain_ws.dirtyEdits['0:0'], valueRuns: bold },
        };
        expect(hydrate(projection, 'new-session', newer_formatting))
            .toBe(newer_formatting);
        // An exact match (runs and all) is still removed.
        expect(hydrate(
            {
                authoritative: {
                    revision: 9,
                    state: 'succeeded',
                    operation: operation('saved', 'saved-session', [rich_ws]),
                } as const,
            },
            'new-session',
            { '0:0': { ...plain_ws.dirtyEdits['0:0'], valueRuns: bold } },
        )).toBeUndefined();
    });

    it('allows a legacy index-only operation to match richer current identity', () => {
        const saved = operation('legacy');
        const failed = {
            authoritative: { revision: 6, state: 'failed', operation: saved } as const,
        };

        expect(hydrate(
            failed,
            saved.editSessionId,
            undefined,
            0,
            'Data',
            'worksheet-id',
        )).toEqual(dirty_edits(saved));
    });

    it('uses worksheet ID before name when hydrating a save', () => {
        const saved = operation('identified', 'edit-session', [
            worksheet('identified', 0, 'Data', 'old'),
        ]);
        const failed = {
            authoritative: { revision: 7, state: 'failed', operation: saved } as const,
        };
        const replacement = { '0:0': { value: 'replacement', base: 'base' } };

        expect(hydrate(
            failed,
            saved.editSessionId,
            replacement,
            0,
            'Data',
            'new',
        )).toBe(replacement);
        expect(hydrate(
            failed,
            saved.editSessionId,
            undefined,
            1,
            'Renamed',
            'old',
        )).toEqual(dirty_edits(saved));
    });

    it('hydrates and tombstones each operation worksheet from its own payload', () => {
        const workbook = operation('workbook', 'edit-session', [
            worksheet('people', 0, 'People'),
            worksheet('inventory', 1, 'Inventory'),
        ]);
        const unrelated_pending = {
            '0:0': { value: 'stock', base: 'old-stock' },
        };
        const failed = {
            authoritative: { revision: 7, state: 'failed', operation: workbook } as const,
        };
        const succeeded = {
            authoritative: { revision: 8, state: 'succeeded', operation: workbook } as const,
        };

        expect(hydrate(
            failed,
            workbook.editSessionId,
            undefined,
            1,
            'Inventory',
        )).toEqual(dirty_edits(workbook, 1));
        expect(hydrate(
            succeeded,
            workbook.editSessionId,
            dirty_edits(workbook, 1),
            1,
            'Inventory',
        )).toBeUndefined();
        expect(hydrate(
            failed,
            workbook.editSessionId,
            undefined,
            0,
            'People',
        )).toEqual(dirty_edits(workbook));
        expect(hydrate(
            failed,
            workbook.editSessionId,
            unrelated_pending,
            2,
            'Other',
        )).toBe(unrelated_pending);
    });

    it('keeps a retained local proposal ahead of a mismatched terminal', () => {
        const local = operation('local', 'current-session');
        const projection: CsvSaveProjection = {
            authoritative: {
                revision: 8,
                state: 'succeeded',
                operation: operation('other', 'current-session'),
            },
            operation: local,
        };

        expect(hydrate(
            projection,
            'current-session',
            undefined,
        )).toEqual(dirty_edits(local));
    });
});
