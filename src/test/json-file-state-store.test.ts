import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    create_json_file_state_store,
    json_state_file_path,
    JSON_STATE_FILE_NAME,
} from '../json-file-state-store';

let temp_dir: string;
let counter = 0;

function fresh_blob_path(): string {
    // Each test uses a distinct path so the module-level per-path runtime
    // sharing never bleeds state between tests.
    return path.join(temp_dir, `store-${counter++}`, JSON_STATE_FILE_NAME);
}

function read_blob(blob_path: string): any {
    return JSON.parse(fs.readFileSync(blob_path, 'utf8'));
}

beforeEach(async () => {
    temp_dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-json-store-'));
});

afterEach(async () => {
    await fs.promises.rm(temp_dir, { recursive: true, force: true });
});

describe('JSON file state store backend', () => {
    it('derives the stable userData layout path', () => {
        expect(json_state_file_path('/data')).toBe(
            path.join('/data', 'state', 'tableViewer.fileState.v1.json'),
        );
    });

    it('reads an absent blob as an empty store', async () => {
        const store = create_json_file_state_store(fresh_blob_path());
        expect(await store.read('/a')).toEqual({ state: {}, revision: 0 });
    });

    it('commits a CAS write durably as the v1 envelope on disk', async () => {
        const blob_path = fresh_blob_path();
        const store = create_json_file_state_store(blob_path);

        const committed = await store.compare_and_set('/a', 0, { activeSheetIndex: 1 });

        expect(committed).toMatchObject({
            type: 'committed',
            snapshot: { revision: 1, state: { activeSheetIndex: 1 } },
        });
        const envelope = read_blob(blob_path);
        expect(envelope).toMatchObject({
            format: 'tableViewer.fileState.v1',
            nextRevision: 2,
            absenceRevision: 0,
            updatedAt: expect.any(Number),
            entries: {
                '/a': {
                    revision: 1,
                    state: { activeSheetIndex: 1 },
                    updatedAt: expect.any(Number),
                },
            },
        });
        expect(fs.readdirSync(path.dirname(blob_path))).toEqual([JSON_STATE_FILE_NAME]);
    });

    it('rejects a stale compare-and-set like the memento backend', async () => {
        const store = create_json_file_state_store(fresh_blob_path());
        await store.compare_and_set('/a', 0, { activeSheetIndex: 1 });

        const conflict = await store.compare_and_set('/a', 0, { activeSheetIndex: 2 });

        expect(conflict).toMatchObject({
            type: 'conflict',
            snapshot: { revision: 1, state: { activeSheetIndex: 1 } },
        });
    });

    it('loads an existing on-disk envelope written by another store instance', async () => {
        const blob_path = fresh_blob_path();
        await fs.promises.mkdir(path.dirname(blob_path), { recursive: true });
        await fs.promises.writeFile(blob_path, JSON.stringify({
            format: 'tableViewer.fileState.v1',
            nextRevision: 8,
            absenceRevision: 2,
            entries: {
                '/persisted': {
                    revision: 7,
                    state: { activeSheetIndex: 3 },
                    authority: {
                        commitSequence: 2,
                        authorityRevision: 1,
                        physicalRevision: 1,
                        projectionRevision: 0,
                        physicalDigest: 'digest',
                    },
                },
            },
        }), 'utf8');

        const store = create_json_file_state_store(blob_path);

        expect(await store.read('/persisted')).toEqual({
            state: { activeSheetIndex: 3 },
            revision: 7,
        });
        expect(await store.read_authority('/persisted')).toMatchObject({
            commitSequence: 2,
            physicalDigest: 'digest',
        });
        expect(await store.read('/absent')).toEqual({ state: {}, revision: 2 });
    });

    it('treats a corrupt blob as empty and atomically replaces it on write', async () => {
        const blob_path = fresh_blob_path();
        await fs.promises.mkdir(path.dirname(blob_path), { recursive: true });
        await fs.promises.writeFile(blob_path, '{not json', 'utf8');

        const store = create_json_file_state_store(blob_path);

        expect(await store.read('/a')).toEqual({ state: {}, revision: 0 });
        await store.compare_and_set('/a', 0, { activeSheetIndex: 1 });
        expect(read_blob(blob_path)).toMatchObject({
            format: 'tableViewer.fileState.v1',
            entries: { '/a': { revision: 1 } },
        });
    });

    it('stages, keeps invisible, and finalizes authority transactions durably', async () => {
        const blob_path = fresh_blob_path();
        const store = create_json_file_state_store(blob_path);
        await expect(store.stage_authority_transaction('/book', {
            id: 'physical:1',
            kind: 'physical',
            ordinal: 1,
            expectedStateRevision: 0,
            expectedCommitSequence: 0,
            nextState: { activeSheetIndex: 2 },
            physicalDigest: 'digest-a',
        })).resolves.toEqual({ type: 'staged' });
        expect(await store.read('/book')).toEqual({ state: {}, revision: 0 });

        const finalized = await store.finalize_authority_transaction('/book', 'physical:1');

        expect(finalized).toMatchObject({
            type: 'finalized',
            snapshot: { state: { activeSheetIndex: 2 }, revision: 1 },
            authority: {
                commitSequence: 1,
                authorityRevision: 1,
                physicalRevision: 1,
                projectionRevision: 0,
                physicalDigest: 'digest-a',
            },
        });
        expect(read_blob(blob_path).entries['/book']).toMatchObject({
            revision: 1,
            state: { activeSheetIndex: 2 },
            authority: { commitSequence: 1, physicalDigest: 'digest-a' },
        });
        expect(read_blob(blob_path).entries['/book'].stages).toBeUndefined();
    });

    it('applies the same LRU trimming policy as the memento backend', async () => {
        const blob_path = fresh_blob_path();
        const store = create_json_file_state_store(blob_path, () => 2);
        for (let index = 0; index < 5; index++) {
            const target = `/file-${index}`;
            const basis = await store.read(target);
            await store.compare_and_set(target, basis.revision, { activeSheetIndex: index });
        }

        const envelope = read_blob(blob_path);
        expect(Object.keys(envelope.entries)).toEqual(['/file-3', '/file-4']);
        expect(envelope.absenceRevision).toBeGreaterThan(0);
    });

    it('keeps live leased entries through LRU churn and evicts them after release', async () => {
        const blob_path = fresh_blob_path();
        const store = create_json_file_state_store(blob_path, () => 1);
        const lease = await store.lease_entry!('/live', (key) => key);
        await store.compare_and_set('/live', 0, { activeSheetIndex: 1 });
        await store.compare_and_set('/old', 0, { activeSheetIndex: 2 });
        const newest = await store.read('/new');
        await store.compare_and_set('/new', newest.revision, { activeSheetIndex: 3 });

        expect(Object.keys(read_blob(blob_path).entries)).toEqual(['/live', '/new']);
        await lease.release();
        expect(Object.keys(read_blob(blob_path).entries)).toEqual(['/new']);
    });

    it('shares serialization and leases across stores over the same blob path', async () => {
        const blob_path = fresh_blob_path();
        const first = create_json_file_state_store(blob_path);
        const second = create_json_file_state_store(blob_path);

        const [left, right] = await Promise.all([
            first.compare_and_set('/a', 0, { activeSheetIndex: 1 }),
            second.compare_and_set('/a', 0, { activeSheetIndex: 2 }),
        ]);

        expect([left.type, right.type].sort()).toEqual(['committed', 'conflict']);
    });

    it('exposes the exact AuthorityFileStateStore surface', () => {
        const store = create_json_file_state_store(fresh_blob_path());
        expect(Object.keys(store).sort()).toEqual([
            'canonicalize_path',
            'cleanup_authority_transactions',
            'compare_and_set',
            'copy_entry_if_absent',
            'discard_authority_transaction',
            'finalize_authority_transaction',
            'inspect_authority_transaction',
            'lease_entry',
            'read',
            'read_authority',
            'stage_authority_transaction',
            'touch',
        ]);
    });

    it('surfaces a write failure and leaves visible state untouched', async () => {
        const blob_path = fresh_blob_path();
        const store = create_json_file_state_store(blob_path);
        await store.compare_and_set('/a', 0, { activeSheetIndex: 1 });
        // Turn the blob path's parent directory into a file so the temp-file
        // write inside it fails.
        const directory = path.dirname(blob_path);
        await fs.promises.rm(directory, { recursive: true, force: true });
        await fs.promises.writeFile(directory, 'not a directory', 'utf8');

        await expect(store.compare_and_set('/a', 1, { activeSheetIndex: 2 }))
            .rejects.toThrow();
        expect(await store.read('/a')).toEqual({
            state: { activeSheetIndex: 1 },
            revision: 1,
        });
    });
});
