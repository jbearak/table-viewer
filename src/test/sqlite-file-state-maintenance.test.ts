import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    open_sqlite_file_state_store,
    type OpenedSqliteFileStateStore,
} from '../sqlite-file-state-persistence';
import type { StoredFileStateMaintenancePorts } from '../sqlite-file-state-maintenance';
import type { PerFileState } from '../types';
import { SqliteTestDatabase } from './helpers/sqlite-test-database';
import { sheet_edits } from './pending-edits-helper';

let tempDirectory: string;
let counter = 0;
let opened: OpenedSqliteFileStateStore[];

/** A state payload that grows with `columns`, so sizes are comparable. */
function state(columns = 1): PerFileState {
    const widths: Record<number, number> = {};
    for (let index = 0; index < columns; index++) widths[index] = 100 + index;
    return { columnWidths: [widths] };
}

async function openStore(
    ports: StoredFileStateMaintenancePorts = {},
    now?: () => number,
): Promise<OpenedSqliteFileStateStore> {
    const database = new SqliteTestDatabase(
        path.join(tempDirectory, `maintenance-${counter++}`, 'file-state.sqlite3'),
        now ? { now } : {},
    );
    const store = await open_sqlite_file_state_store(
        database.databasePath,
        database.options,
        undefined,
        ports,
    );
    opened.push(store);
    return store;
}

/** Write state for `filePath` through the real store, as the viewer would. */
async function write(
    store: OpenedSqliteFileStateStore,
    filePath: string,
    value: PerFileState,
): Promise<void> {
    const snapshot = await store.store.read(filePath);
    const result = await store.store.compare_and_set(filePath, snapshot.revision, value);
    expect(result.type).toBe('committed');
}

async function seed(
    store: OpenedSqliteFileStateStore,
    filePath: string,
    columns = 1,
): Promise<void> {
    await write(store, filePath, state(columns));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Set an entry's activity timestamps directly.
 *
 * The store stamps entries from the wall clock rather than from any injectable
 * one, so age has to be established by writing the timestamps rather than by
 * pretending time passed.
 */
async function restamp(
    store: OpenedSqliteFileStateStore,
    filePath: string,
    updatedAtMs?: number,
    touchedAtMs?: number,
): Promise<void> {
    await store.persistence.write_transaction('compareAndSet', (tx) => {
        const metadata = tx.read_entry_metadata(filePath)!;
        tx.write_entry_metadata({ ...metadata, updatedAtMs, touchedAtMs });
    });
}

beforeEach(async () => {
    opened = [];
    tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-maintenance-'));
});

afterEach(async () => {
    for (const store of opened) await store.close().catch(() => undefined);
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
});

describe('stored file state inspection', () => {
    it('reports every entry with its size and the database file size', async () => {
        const store = await openStore();
        await seed(store, '/files/small.csv', 1);
        await seed(store, '/files/large.csv', 5_000);

        const inventory = await store.maintenance.inspect();

        expect(inventory.totalEntryCount).toBe(2);
        expect(inventory.entries.map((entry) => entry.path))
            .toEqual(['/files/large.csv', '/files/small.csv']);
        const large = inventory.entries.find((entry) => entry.path === '/files/large.csv');
        const small = inventory.entries.find((entry) => entry.path === '/files/small.csv');
        expect(large!.sizeBytes).toBeGreaterThan(small!.sizeBytes + 4_000);
        expect(inventory.databaseSizeBytes).toBeGreaterThan(0);
    });

    it('measures size in bytes rather than characters', async () => {
        const store = await openStore();
        // Two payloads of identical character length, one of them multi-byte. A
        // character count would report these as the same size.
        await write(store, '/files/ascii.csv', {
            pendingEdits: sheet_edits({ '0:0': 'a'.repeat(100) }),
        });
        await write(store, '/files/wide.csv', {
            pendingEdits: sheet_edits({ '0:0': '→'.repeat(100) }),
        });

        const inventory = await store.maintenance.inspect();
        const ascii = inventory.entries.find((entry) => entry.path === '/files/ascii.csv')!;
        const wide = inventory.entries.find((entry) => entry.path === '/files/wide.csv')!;

        // '→' is three bytes in UTF-8, so 100 of them weigh 300 against 100.
        expect(wide.sizeBytes - ascii.sizeBytes).toBe(200);
    });
});

describe('stored file state trimming', () => {
    it('deletes the selected entries and leaves the rest', async () => {
        const store = await openStore();
        await seed(store, '/files/a.csv');
        await seed(store, '/files/b.csv');
        await seed(store, '/files/c.csv');

        const result = await store.maintenance.trim({
            paths: ['/files/a.csv', '/files/c.csv'],
            confirmedPendingEditPaths: [],
        });

        expect([...result.deletedPaths].sort()).toEqual(['/files/a.csv', '/files/c.csv']);
        const inventory = await store.maintenance.inspect();
        expect(inventory.entries.map((entry) => entry.path)).toEqual(['/files/b.csv']);
    });

    it('reclaims disk space, which deleting alone does not', async () => {
        const store = await openStore();
        // Enough payload to make the freed pages obvious, spread over few enough
        // entries to keep the durable per-write fsyncs off the critical path.
        for (let index = 0; index < 40; index++) {
            await seed(store, `/files/bulk-${index}.csv`, 4_000);
        }
        const before = (await store.maintenance.inspect()).databaseSizeBytes;

        const result = await store.maintenance.trim({
            paths: (await store.maintenance.inspect()).entries.map((entry) => entry.path),
            confirmedPendingEditPaths: [],
        });

        expect(result.vacuum).toBe('vacuumed');
        expect(result.deletedPaths).toHaveLength(40);
        const after = (await store.maintenance.inspect()).databaseSizeBytes;
        expect(after).toBeLessThan(before);
        expect(result.reclaimedBytes).toBeGreaterThan(0);
    });

    it('does not vacuum when nothing was deleted', async () => {
        const store = await openStore();
        await seed(store, '/files/a.csv');

        const result = await store.maintenance.trim({
            paths: ['/files/never-stored.csv'],
            confirmedPendingEditPaths: [],
        });

        expect(result.deletedPaths).toEqual([]);
        expect(result.vacuum).toBe('not-needed');
    });

    it('refuses to delete an entry that is leased, with or without confirmation', async () => {
        const store = await openStore();
        await seed(store, '/files/open.csv');
        await store.store.lease_entry!('/files/open.csv', (file_path) => file_path);

        const preview = await store.maintenance.preview({ kind: 'all' });
        expect(preview.targets).toEqual([]);
        expect(preview.protectedPaths).toEqual(['/files/open.csv']);

        const result = await store.maintenance.trim({
            paths: ['/files/open.csv'],
            confirmedPendingEditPaths: ['/files/open.csv'],
        });

        expect(result.deletedPaths).toEqual([]);
        expect(result.skippedProtectedPaths).toEqual(['/files/open.csv']);
        expect((await store.maintenance.inspect()).totalEntryCount).toBe(1);
    });
});

describe('unsaved edits', () => {
    async function seedPendingEdit(
        store: OpenedSqliteFileStateStore,
        filePath: string,
    ): Promise<void> {
        await write(store, filePath, {
            pendingEdits: sheet_edits({ '0:0': { value: 'unsaved', base: 'saved' } }),
        });
        const inventory = await store.maintenance.inspect();
        expect(inventory.entries.find((entry) => entry.path === filePath)?.hasPendingEdits)
            .toBe(true);
    }

    it('flags them in a preview so they can be named in a confirmation', async () => {
        const store = await openStore();
        await seed(store, '/files/plain.csv');
        await seedPendingEdit(store, '/files/unsaved.csv');

        const preview = await store.maintenance.preview({ kind: 'all' });

        expect(preview.pendingEditPaths).toEqual(['/files/unsaved.csv']);
        expect(preview.targets).toHaveLength(2);
    });

    it('keeps them when the caller did not confirm that exact path', async () => {
        const store = await openStore();
        await seedPendingEdit(store, '/files/unsaved.csv');
        await seed(store, '/files/plain.csv');

        const result = await store.maintenance.trim({
            paths: ['/files/unsaved.csv', '/files/plain.csv'],
            // A different path is confirmed; the unsaved one must survive.
            confirmedPendingEditPaths: ['/files/plain.csv'],
        });

        expect(result.deletedPaths).toEqual(['/files/plain.csv']);
        expect(result.skippedUnconfirmedPaths).toEqual(['/files/unsaved.csv']);
    });

    it('deletes them once that exact path is confirmed', async () => {
        const store = await openStore();
        await seedPendingEdit(store, '/files/unsaved.csv');

        const result = await store.maintenance.trim({
            paths: ['/files/unsaved.csv'],
            confirmedPendingEditPaths: ['/files/unsaved.csv'],
        });

        expect(result.deletedPaths).toEqual(['/files/unsaved.csv']);
        expect((await store.maintenance.inspect()).totalEntryCount).toBe(0);
    });

    it('protects an entry that gained unsaved edits after the preview was taken', async () => {
        const store = await openStore();
        await seed(store, '/files/race.csv');

        // Preview sees a plain entry, so nothing needs confirming.
        const preview = await store.maintenance.preview({ kind: 'all' });
        expect(preview.pendingEditPaths).toEqual([]);

        // The user starts editing before they press delete.
        await seedPendingEdit(store, '/files/race.csv');

        const result = await store.maintenance.trim({
            paths: preview.targets.map((entry) => entry.path),
            confirmedPendingEditPaths: preview.pendingEditPaths,
        });

        expect(result.deletedPaths).toEqual([]);
        expect(result.skippedUnconfirmedPaths).toEqual(['/files/race.csv']);
    });
});

describe('bulk selections', () => {
    it('selects entries older than the cutoff and keeps recent ones', async () => {
        const now = 1_000 * DAY_MS;
        const store = await openStore({ now: () => now });
        await seed(store, '/files/ancient.csv');
        await seed(store, '/files/recent.csv');

        await restamp(store, '/files/ancient.csv', now - 30 * DAY_MS);
        await restamp(store, '/files/recent.csv', now - 2 * DAY_MS);

        const preview = await store.maintenance.preview({ kind: 'olderThanDays', days: 10 });

        expect(preview.targets.map((entry) => entry.path)).toEqual(['/files/ancient.csv']);
    });

    it('counts the most recent of the two timestamps as the activity date', async () => {
        const now = 1_000 * DAY_MS;
        const store = await openStore({ now: () => now });
        await seed(store, '/files/reopened.csv');

        // Written long ago, but opened yesterday: it is not stale.
        await restamp(store, '/files/reopened.csv', now - 90 * DAY_MS, now - 1 * DAY_MS);

        const preview = await store.maintenance.preview({ kind: 'olderThanDays', days: 10 });

        expect(preview.targets).toEqual([]);
    });

    it('never age-trims an entry whose timestamps are both absent', async () => {
        const store = await openStore({ now: () => 1_000 * DAY_MS });
        await seed(store, '/files/undated.csv');

        // Strip both timestamps, as a legacy import can leave them.
        await restamp(store, '/files/undated.csv');

        const preview = await store.maintenance.preview({
            kind: 'olderThanDays',
            days: 0,
        });

        expect(preview.targets).toEqual([]);
    });

    it('selects entries whose files are gone from disk', async () => {
        const present = path.join(tempDirectory, 'present.csv');
        await fs.promises.writeFile(present, 'a,b\n');
        const store = await openStore();
        await seed(store, present);
        await seed(store, path.join(tempDirectory, 'deleted.csv'));

        const preview = await store.maintenance.preview({ kind: 'missingOnDisk' });

        expect(preview.targets.map((entry) => entry.path))
            .toEqual([path.join(tempDirectory, 'deleted.csv')]);
    });

    it('never treats a provider-backed entry as missing from disk', async () => {
        const store = await openStore();
        // Virtual providers and untitled buffers are stored under synthetic keys
        // that no stat could find. Nominating them would delete live state.
        const providerKey = 'tableViewer.resource.v1:untitled Untitled-1';
        await seed(store, providerKey);
        await seed(store, path.join(tempDirectory, 'deleted.csv'));

        const preview = await store.maintenance.preview({ kind: 'missingOnDisk' });

        expect(preview.targets.map((entry) => entry.path))
            .toEqual([path.join(tempDirectory, 'deleted.csv')]);
    });

    it('clears everything when asked', async () => {
        const store = await openStore();
        await seed(store, '/files/a.csv');
        await seed(store, '/files/b.csv');

        const preview = await store.maintenance.preview({ kind: 'all' });
        const result = await store.maintenance.trim({
            paths: preview.targets.map((entry) => entry.path),
            confirmedPendingEditPaths: preview.pendingEditPaths,
        });

        expect(result.deletedPaths).toHaveLength(2);
        expect((await store.maintenance.inspect()).totalEntryCount).toBe(0);
    });
});

describe('the store after a trim', () => {
    it('still opens and serves reads, with the fences intact', async () => {
        const store = await openStore();
        await seed(store, '/files/gone.csv', 2_000);
        await seed(store, '/files/kept.csv', 2_000);

        await store.maintenance.trim({
            paths: ['/files/gone.csv'],
            confirmedPendingEditPaths: [],
        });

        // A vacuum rewrites the whole file; the identity checks every open
        // performs have to survive that rewrite.
        const kept = await store.store.read('/files/kept.csv');
        expect(kept.revision).toBeGreaterThan(0);
        const gone = await store.store.read('/files/gone.csv');
        expect(gone.state).toEqual({});
    });
});

describe('a renderer that lies', () => {
    it('cannot delete unsaved work by confirming a path it was never shown', async () => {
        const store = await openStore();
        for (const file of ['/a.csv', '/b.csv']) {
            await write(store, file, {
                pendingEdits: sheet_edits({ '0:0': { value: 'unsaved', base: 'saved' } }),
            });
        }
        await store.store.lease_entry!('/b.csv', (file_path) => file_path);

        // Naming a path as confirmed is the only thing that unlocks it, and it
        // does not unlock a different one.
        const result = await store.maintenance.trim({
            paths: ['/a.csv', '/b.csv'],
            confirmedPendingEditPaths: ['/a.csv'],
        });

        expect(result.deletedPaths).toEqual(['/a.csv']);
        expect(result.skippedProtectedPaths).toEqual(['/b.csv']);
    });

    it('cannot delete a leased entry by confirming everything', async () => {
        const store = await openStore();
        await write(store, '/b.csv', {
            pendingEdits: sheet_edits({ '0:0': { value: 'unsaved', base: 'saved' } }),
        });
        await store.store.lease_entry!('/b.csv', (file_path) => file_path);

        // A lease is not confirmable at any price: no request shape reaches it.
        const result = await store.maintenance.trim({
            paths: ['/b.csv'],
            confirmedPendingEditPaths: ['/b.csv'],
        });

        expect(result.deletedPaths).toEqual([]);
        expect((await store.maintenance.inspect()).totalEntryCount).toBe(1);
    });
});
