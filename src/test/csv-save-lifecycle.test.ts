import { describe, expect, it } from 'vitest';
import type {
    CsvSaveOperation,
    SheetPendingEditCells,
    TerminalCsvSaveLifecycle,
} from '../types';
import {
    csv_save_operations_equal,
    is_valid_csv_save_lifecycle,
    propose_csv_save,
    reduce_csv_save_projection,
    resolve_csv_save_hydration,
    save_lifecycle_correlation,
    save_operation_worksheet,
    terminal_csv_save_settles_operation,
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

    it.each([
        ['no operation', { revision: 4, state: 'active' }],
        ['no worksheets', {
            revision: 4,
            state: 'active',
            operation: operation('empty-workbook', 'edit-session', []),
        }],
        ['an unusable worksheet member', {
            revision: 4,
            state: 'active',
            operation: {
                ...operation('malformed-workbook'),
                worksheets: [null],
            },
        }],
        ['a sparse worksheet list', {
            revision: 4,
            state: 'active',
            operation: {
                ...operation('sparse-workbook'),
                worksheets: new Array(1),
            },
        }],
        ['duplicate sheet indices', {
            revision: 4,
            state: 'active',
            operation: operation('duplicate-indices', 'edit-session', [
                worksheet('first', 0, 'First'),
                worksheet('second', 0, 'Second'),
            ]),
        }],
        ['duplicate strongest target keys', {
            revision: 4,
            state: 'active',
            operation: operation('duplicate-targets', 'edit-session', [
                worksheet('first', 0, 'First', 'same-id'),
                worksheet('second', 1, 'Second', 'same-id'),
            ]),
        }],
    ])('rejects an active lifecycle with %s', (_label, lifecycle) => {
        expect(is_valid_csv_save_lifecycle(lifecycle)).toBe(false);
    });

    it('keeps malformed worksheet maps recoverable by lifecycle correlation', () => {
        const malformed_maps = {
            ...operation('malformed-maps'),
            worksheets: [{
                ...worksheet('malformed'),
                dirtyEdits: { '0:0': null },
            }],
        };

        expect(is_valid_csv_save_lifecycle({
            revision: 4,
            state: 'active',
            operation: malformed_maps,
        })).toBe(true);
    });

    it('ignores an active projection without an operation', () => {
        const current = propose_csv_save({
            authoritative: { revision: 3, state: 'idle' },
        }, operation('local'));

        const reduced = reduce_csv_save_projection(current, {
            revision: 4,
            state: 'active',
        } as never);

        expect(reduced).toBe(current);
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

    it('settles only the correlated proposal for a malformed-request failure', () => {
        const local = operation('local');
        const sanitized = operation('local', local.editSessionId, [{
            ...local.worksheets[0],
            dirtyEdits: {},
        }]);
        const malformed_failure = {
            revision: 11,
            state: 'failed',
            failure: 'malformedRequest',
            correlation: {
                editSessionId: sanitized.editSessionId,
                saveRequestId: sanitized.saveRequestId,
            },
        } as const;

        expect(terminal_csv_save_settles_operation(malformed_failure, local)).toBe(true);
        expect(terminal_csv_save_settles_operation(
            malformed_failure,
            operation('other-request'),
        )).toBe(false);
        expect(terminal_csv_save_settles_operation(
            malformed_failure,
            operation('local', 'other-session'),
        )).toBe(false);

        const changed_payload = operation('local', local.editSessionId, [worksheet('changed')]);
        expect(terminal_csv_save_settles_operation({
            revision: 11,
            state: 'failed',
            operation: sanitized,
        }, changed_payload)).toBe(false);

        const ordinary_with_stray_correlation = {
            revision: 11,
            state: 'failed',
            operation: local,
            correlation: {
                editSessionId: 'stray-session',
                saveRequestId: 'stray-request',
            },
        } as unknown as TerminalCsvSaveLifecycle;
        expect(terminal_csv_save_settles_operation(
            ordinary_with_stray_correlation,
            local,
        )).toBe(true);
        expect(save_lifecycle_correlation(ordinary_with_stray_correlation)).toEqual({
            editSessionId: local.editSessionId,
            saveRequestId: local.saveRequestId,
        });
        expect(terminal_csv_save_settles_operation({
            revision: 11,
            state: 'succeeded',
            operation: sanitized,
        }, local)).toBe(false);

        const proposed = propose_csv_save({
            authoritative: { revision: 10, state: 'idle' },
        }, local);
        expect(reduce_csv_save_projection(proposed, malformed_failure).operation)
            .toBeUndefined();
    });

    it('settles a canonical success against malformed optional local metadata', () => {
        const canonical = operation('local');
        const local = {
            ...canonical,
            worksheets: [{
                ...canonical.worksheets[0],
                dirtyEdits: {
                    '0:0': {
                        ...canonical.worksheets[0].dirtyEdits['0:0'],
                        valueRuns: 'malformed',
                    },
                },
            }],
        } as unknown as CsvSaveOperation;
        const success = {
            revision: 11,
            state: 'succeeded',
            operation: canonical,
        } as const;

        expect(csv_save_operations_equal(local, canonical)).toBe(true);
        expect(terminal_csv_save_settles_operation(success, local)).toBe(true);

        const proposed = propose_csv_save({
            authoritative: { revision: 10, state: 'idle' },
        }, local);
        expect(reduce_csv_save_projection(proposed, success).operation)
            .toBeUndefined();
    });

    it('treats malformed local operation structure as non-equal and hydrates safely', () => {
        const valid = operation('local');
        const pending = { '9:9': { value: 'safe', base: 'base' } };
        const malformed_maps = {
            ...valid,
            worksheets: [{
                ...valid.worksheets[0],
                dirtyEdits: { '0:0': null },
            }],
        } as unknown as CsvSaveOperation;
        const malformed_relation = {
            ...valid,
            worksheets: [{
                ...valid.worksheets[0],
                edits: { '0:0': 'local', '1:0': 'unvalidated' },
            }],
        } as unknown as CsvSaveOperation;
        const malformed_envelope = {
            ...valid,
            worksheets: null,
        } as unknown as CsvSaveOperation;

        expect(csv_save_operations_equal(malformed_maps, valid)).toBe(false);
        expect(csv_save_operations_equal(malformed_maps, malformed_maps)).toBe(false);
        expect(csv_save_operations_equal(malformed_relation, malformed_relation)).toBe(false);
        expect(csv_save_operations_equal(malformed_envelope, malformed_envelope)).toBe(false);
        expect(save_operation_worksheet(malformed_maps, 0, undefined, undefined))
            .toBeUndefined();
        expect(save_operation_worksheet(malformed_relation, 0, undefined, undefined))
            .toBeUndefined();
        expect(save_operation_worksheet(malformed_envelope, 0, undefined, undefined))
            .toBeUndefined();
        expect(hydrate({
            authoritative: { revision: 10, state: 'idle' },
            operation: malformed_maps,
        }, valid.editSessionId, pending)).toBe(pending);
    });

    it('does not recover a valid worksheet from a partially malformed workbook', () => {
        const malformed_workbook = {
            ...operation('workbook'),
            worksheets: [
                worksheet('recoverable', 0, 'People'),
                {
                    ...worksheet('broken', 1, 'Inventory'),
                    dirtyEdits: { '0:0': null },
                },
            ],
        } as unknown as CsvSaveOperation;
        const pending = {
            '9:9': { value: 'safe', base: 'base' },
        };

        expect(save_operation_worksheet(
            malformed_workbook,
            0,
            'People',
            undefined,
        )).toBeUndefined();
        expect(hydrate({
            authoritative: { revision: 10, state: 'idle' },
            operation: malformed_workbook,
        }, malformed_workbook.editSessionId, pending, 0, 'People'))
            .toBe(pending);
    });

    it('rejects captured targets that alias the same live worksheet', () => {
        const aliased = operation('aliased', 'edit-session', [
            worksheet('by-id', 0, 'Former Name', 'sheet-id'),
            worksheet('by-name', 1, 'Current Name'),
        ]);
        const pending = { '9:9': { value: 'safe', base: 'base' } };

        expect(save_operation_worksheet(
            aliased,
            1,
            'Current Name',
            'sheet-id',
        )).toBeUndefined();
        expect(hydrate({
            authoritative: { revision: 10, state: 'failed', operation: aliased },
        }, aliased.editSessionId, pending, 1, 'Current Name', 'sheet-id'))
            .toBe(pending);
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

    it('retains structural changes as part of canonical operation identity', () => {
        const structural = {
            formatTemplates: [{ id: 'plain', format: { kind: 'none' as const } }],
            appendedRows: [{
                id: 'pending-row-1',
                cells: {},
                formatTemplateId: 'plain',
                createdOrder: 1,
            }],
            tailRemovals: [],
            appendBasis: {
                sourceRowCount: 1,
                provisionalStartRow: 1,
                provisionalRowCount: 1,
                columnCount: 1,
                schemaFingerprint: 'schema',
            },
            conflicts: [],
        };
        const with_structural = operation('structural', 'edit-session', [{
            ...worksheet('saved'),
            structuralChanges: structural,
        }]);
        const changed = operation('structural', 'edit-session', [{
            ...worksheet('saved'),
            structuralChanges: {
                ...structural,
                appendedRows: [{
                    ...structural.appendedRows[0],
                    id: 'pending-row-2',
                }],
            },
        }]);

        expect(save_operation_worksheet(with_structural, 0, undefined, undefined)
            ?.structuralChanges).toEqual(structural);
        expect(csv_save_operations_equal(
            with_structural,
            operation('structural', 'edit-session', [{
                ...worksheet('saved'),
                structuralChanges: structuredClone(structural),
            }]),
        )).toBe(true);
        expect(csv_save_operations_equal(with_structural, changed)).toBe(false);
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

    it('retains malformed optional pending metadata during tombstone cleanup', () => {
        const saved = operation('saved', 'saved-session');
        const pending = {
            '0:0': {
                ...saved.worksheets[0].dirtyEdits['0:0'],
                valueRuns: { runs: null },
            },
        } as unknown as SheetPendingEditCells;

        expect(hydrate({
            authoritative: {
                revision: 10,
                state: 'succeeded',
                operation: saved,
            },
        }, saved.editSessionId, pending)).toBe(pending);
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
