// Downgrade safety for durable Pending Changes version 2 (row and column
// structure design, "Durable versioning"). A release that predates layouts
// rebuilds each slot from the fields it knows, so reading a version-2 entry
// would drop its layout and keep rows at the wrong coordinates. That release
// rejects every envelope version but 1, so its SQLite repository must report a
// version-2 entry malformed and never write over it.
//
// The previous release's decoder is reconstructed by wrapping this release's:
// on every input the previous release accepted (version-1, unversioned, flat,
// and in-memory shapes) the two agree, which the "decodes every legacy slot
// shape identically under both versions" test pins, and its only difference on
// a versioned envelope is the check snapshotted below, verbatim, from
// `decode_pending_edits` before version 2 existed:
//
//     if (!Array.isArray(value.sheets) || (versioned
//         ? value.version !== 1 || Object.keys(value).length !== 2
//         : Object.keys(value).length !== 1)) invalid_leaf('pendingEdits');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create_keyed_authority_store } from '../state';
import { stringify_stored_per_file_state, type PerFileState } from '../types';
import { SqliteTestDatabase } from './helpers/sqlite-test-database';

const decoder = vi.hoisted(() => ({ previous_release: true }));

vi.mock('../types', async (import_original) => {
    const actual = await import_original<typeof import('../types')>();
    const previous_release_decode: typeof actual.decode_stored_per_file_state = (value) => {
        if (decoder.previous_release && actual.is_plain_record(value)) {
            const pending = value.pendingEdits;
            if (actual.is_plain_record(pending) && Object.hasOwn(pending, 'sheets')) {
                const versioned = Object.hasOwn(pending, 'version');
                if (!Array.isArray(pending.sheets) || (versioned
                    ? pending.version !== 1 || Object.keys(pending).length !== 2
                    : Object.keys(pending).length !== 1)) {
                    throw new TypeError('Persisted file state has an invalid pendingEdits leaf.');
                }
            }
        }
        return actual.decode_stored_per_file_state(value);
    };
    return { ...actual, decode_stored_per_file_state: previous_release_decode };
});

let temp_directory: string;
const databases: SqliteTestDatabase[] = [];

beforeEach(() => {
    decoder.previous_release = true;
    temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-v2-'));
});

afterEach(async () => {
    for (const database of databases.splice(0)) await database.close();
    fs.rmSync(temp_directory, { recursive: true, force: true });
});

const VERSION_2_STATE: PerFileState = {
    activeSheetIndex: 0,
    pendingEdits: [{
        sheetName: 'Sheet1',
        cells: { '0:0': { value: 'kept', base: 'a' } },
        rowLayout: {
            runs: [{ kind: 'source', start: 0, count: 3 }],
            removedSourceRows: [{ start: 1, count: 1 }],
            discardedPendingRows: [],
        },
        structuralBasis: {
            kind: 'delimited',
            byteLength: 12,
            digest: 'sha256:abc',
            sourceRowCount: 3,
            sourceColumnCount: 1,
        },
    }],
};

describe('a version-2 Pending Changes entry under the previous release', () => {
    it('is reported malformed, and the repository writes nothing over it', async () => {
        const database = new SqliteTestDatabase(path.join(temp_directory, 'file-state.sqlite3'));
        databases.push(database);
        const persistence = await database.openPersistence();
        const store = create_keyed_authority_store(persistence);
        const file = '/data.csv';
        // An ordinary version-1 entry first, so the row and its pending flag exist.
        await store.compare_and_set(file, 0, {
            pendingEdits: [{ sheetName: 'Sheet1', cells: { '0:0': { value: 'v1', base: 'a' } } }],
        } as PerFileState);

        const version_2_json = stringify_stored_per_file_state(VERSION_2_STATE);
        expect(JSON.parse(version_2_json).pendingEdits.version).toBe(2);
        const direct = new DatabaseSync(database.databasePath);
        direct.prepare('UPDATE entries SET state_json = ? WHERE path = ?').run(version_2_json, file);
        const stored_json = (): unknown => direct
            .prepare('SELECT state_json FROM entries WHERE path = ?')
            .get(file)?.state_json;

        await expect(persistence.read_transaction((tx) => tx.read_entry(file)))
            .rejects.toMatchObject({ category: 'malformed-state' });
        await expect(store.read(file)).rejects.toMatchObject({ category: 'malformed-state' });
        await expect(store.compare_and_set(file, 1, { activeSheetIndex: 2 } as PerFileState))
            .rejects.toMatchObject({ category: 'malformed-state' });
        expect(stored_json()).toBe(version_2_json);

        // This release reads the same bytes whole.
        decoder.previous_release = false;
        const current = await store.read(file);
        expect((current.state as PerFileState).pendingEdits?.[0]).toEqual(VERSION_2_STATE.pendingEdits![0]);
        direct.close();
        await persistence.close();
    });
});
