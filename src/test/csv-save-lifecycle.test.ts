import { describe, expect, it } from 'vitest';
import type { CsvSaveOperation } from '../types';
import {
    propose_csv_save,
    reduce_csv_save_projection,
    resolve_csv_save_hydration,
    type CsvSaveProjection,
} from '../webview/csv-save-lifecycle';

function operation(id: string, edit_session_id = 'edit-session'): CsvSaveOperation {
    return {
        editSessionId: edit_session_id,
        saveRequestId: id,
        edits: { '0:0': id },
        dirtyEdits: { '0:0': { value: id, base: `base:${id}` } },
    };
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
        expect(resolve_csv_save_hydration(
            projection,
            local.editSessionId,
            undefined,
        )).toEqual(local.dirtyEdits);

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

        expect(resolve_csv_save_hydration(
            projection,
            'old-session',
            newer,
        )).toEqual(failed.dirtyEdits);
        expect(resolve_csv_save_hydration(
            projection,
            'new-session',
            newer,
        )).toBe(newer);
        expect(resolve_csv_save_hydration(
            projection,
            'new-session',
            failed.dirtyEdits,
        )).toBeUndefined();
    });

    it('tombstones succeeded-session edits without suppressing a newer session', () => {
        const pending = { '0:0': { value: 'newer', base: 'new-base' } };
        const succeeded = operation('saved', 'saved-session');
        const projection = {
            authoritative: { revision: 5, state: 'succeeded', operation: succeeded } as const,
        };

        expect(resolve_csv_save_hydration(
            projection,
            undefined,
            succeeded.dirtyEdits,
        )).toBeUndefined();
        expect(resolve_csv_save_hydration(
            projection,
            'saved-session',
            succeeded.dirtyEdits,
        )).toBeUndefined();
        expect(resolve_csv_save_hydration(
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

        expect(resolve_csv_save_hydration(
            projection,
            undefined,
            {
                ...succeeded.dirtyEdits,
                '1:0': newer,
            },
        )).toEqual({ '1:0': newer });
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

        expect(resolve_csv_save_hydration(
            projection,
            'current-session',
            undefined,
        )).toEqual(local.dirtyEdits);
    });
});
