import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CompanionStore,
    COMPANION_MAX_CAPSULE_JSON_UTF8_BYTES,
    COMPANION_MAX_ID_UTF8_BYTES,
    COMPANION_MAX_RECEIPT_JSON_UTF8_BYTES,
    COMPANION_MAX_RECOVERY_JSON_UTF8_BYTES,
} from '../src/companion-store';
import {
    COMPANION_APPLICATION_ID,
    COMPANION_MAX_METADATA_UTF8_BYTES,
    COMPANION_USER_VERSION,
    initialize_companion_schema,
    validate_companion_schema,
} from '../src/companion-schema';

const roots: string[] = [];

function root(): string {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-companion-'));
    roots.push(value);
    return value;
}

function source(width = 120): string {
    return JSON.stringify({
        format: 'tableViewer.fileState.v1',
        nextRevision: 3,
        absenceRevision: 1,
        updatedAt: 10,
        entries: {
            '/private/example.csv': {
                revision: 2,
                state: { columnWidths: [{ 0: width }] },
            },
        },
    });
}

async function poll_for(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

function exact_json_bytes(value: Record<string, unknown>, bytes: number): string {
    const empty = JSON.stringify({ ...value, padding: '' });
    if (Buffer.byteLength(empty, 'utf8') > bytes) throw new Error('Requested JSON boundary is too small.');
    const result = JSON.stringify({ ...value, padding: 'x'.repeat(bytes - Buffer.byteLength(empty, 'utf8')) });
    expect(Buffer.byteLength(result, 'utf8')).toBe(bytes);
    return result;
}

function database_path(directory: string): string {
    return path.join(directory, 'state', 'namespace-recovery.sqlite3');
}

function recovery_input(operationId = randomUUID()) {
    return {
        storageEnvironmentId: 'environment-a',
        databaseId: 'database-a',
        recoveryEntryId: 'entry-a',
        operationId,
        kind: 'snapshot' as const,
        pendingEditsJson: JSON.stringify({ '0:0': { value: 'new', base: 'old' } }),
        resourceIdentityJson: JSON.stringify({ scheme: 'vscode-remote', authority: 'ssh-remote', path: '/workspace/file.csv' }),
        authorityRevision: 4,
        physicalRevision: 3,
        projectionRevision: 2,
        physicalDigest: 'a'.repeat(64),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('profile-scoped companion SQLite store', () => {
    it.skipIf(process.platform === 'win32')('hardens every created storage directory independently of umask', async () => {
        const ancestor = root();
        const globalStorage = path.join(ancestor, 'profile', 'extension-storage');
        const previousUmask = process.umask(0o100);
        let store: CompanionStore | undefined;
        try {
            store = await CompanionStore.open(globalStorage, '0.7.0');
        } finally {
            process.umask(previousUmask);
        }
        try {
            for (const directory of [
                path.join(ancestor, 'profile'),
                globalStorage,
                path.join(globalStorage, 'state'),
            ]) {
                expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
            }
        } finally {
            await store?.close();
        }
    });

    it.skipIf(process.platform === 'win32')('accepts a directory concurrently created by another companion host', async () => {
        const ancestor = root();
        const globalStorage = path.join(ancestor, 'profile', 'extension-storage');
        const racedDirectory = path.join(ancestor, 'profile');
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
        const mkdirSync = mutableFs.mkdirSync;
        let injectedRace = false;
        mutableFs.mkdirSync = ((directory, options) => {
            if (!injectedRace && path.resolve(String(directory)) === racedDirectory) {
                injectedRace = true;
                mkdirSync(directory, options as never);
                throw Object.assign(new Error('created concurrently'), { code: 'EEXIST' });
            }
            return mkdirSync(directory, options as never);
        }) as typeof fs.mkdirSync;
        syncBuiltinESMExports();

        let store: CompanionStore | undefined;
        try {
            store = await CompanionStore.open(globalStorage, '0.7.0');
        } finally {
            mutableFs.mkdirSync = mkdirSync;
            syncBuiltinESMExports();
        }
        expect(injectedRace).toBe(true);
        expect(fs.statSync(racedDirectory).mode & 0o777).toBe(0o700);
        await store?.close();
    });

    it('decodes frozen envelopes through the live Memento compatibility rules', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        const orderedSourceJson = JSON.stringify({
            format: 'tableViewer.fileState.v1',
            tombstones: { removed: 7 },
            entries: {
                '/private/example.csv': {
                    revision: 2,
                    state: { columnWidths: [{ 0: 120 }] },
                },
            },
        });

        await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson });
        await expect(store.activeCapsule()).resolves.toMatchObject({
            sourceFormat: 'tableViewer.fileState.v1',
            entryCount: 1,
            meta: { nextRevision: 8, absenceRevision: 7 },
        });
        await store.close();
    });

    it('accepts legacy non-object Memento values as the empty readable store', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: 'null' });
        await expect(store.activeCapsule()).resolves.toMatchObject({
            sourceFormat: 'tableViewer.fileState.legacy',
            entryCount: 0,
            meta: { nextRevision: 1, absenceRevision: 0 },
        });
        await store.close();
    });

    it('creates the fixed-root branded database without creating a canonical environment database', async () => {
        const directory = root();
        const store = await CompanionStore.open(directory, '0.7.0');
        await store.close();

        const databasePath = path.join(directory, 'state', 'namespace-recovery.sqlite3');
        expect(fs.existsSync(databasePath)).toBe(true);
        expect(fs.existsSync(path.join(directory, 'state', 'file-state.sqlite3'))).toBe(false);
        const database = new DatabaseSync(databasePath, { readOnly: true });
        expect(database.prepare('PRAGMA application_id').get()?.application_id).toBe(COMPANION_APPLICATION_ID);
        expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(COMPANION_USER_VERSION);
        expect(database.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
        expect(database.prepare('SELECT format FROM companion_meta').get()?.format)
            .toBe('tableViewer.namespaceRecovery.sqlite.v1');
        database.close();
    });

    it('rolls the complete schema and branding back when migration is interrupted before publication', () => {
        const databasePath = path.join(root(), 'interrupted.sqlite3');
        const database = new DatabaseSync(databasePath);
        expect(() => initialize_companion_schema(database, {
            appliedAtMs: 1,
            appVersion: '0.7.0',
            beforeSetUserVersion() { throw new Error('injected interruption'); },
        })).toThrow(/injected interruption/);
        expect(database.prepare('PRAGMA application_id').get()?.application_id).toBe(0);
        expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
        expect(database.prepare(`SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'`).get()?.count).toBe(0);
        database.close();
    });

    it('bounds persisted schema metadata by UTF-8 bytes at the exact boundary', () => {
        const exact = 'é'.repeat(COMPANION_MAX_METADATA_UTF8_BYTES / 2);
        const accepted = new DatabaseSync(path.join(root(), 'metadata-boundary.sqlite3'));
        initialize_companion_schema(accepted, {
            appliedAtMs: 1,
            appVersion: exact,
            profileDatabaseId: exact,
        });
        expect(accepted.prepare('SELECT profile_database_id FROM companion_meta').get()?.profile_database_id).toBe(exact);
        accepted.close();

        for (const field of ['appVersion', 'profileDatabaseId'] as const) {
            const rejected = new DatabaseSync(path.join(root(), `${field}.sqlite3`));
            expect(() => initialize_companion_schema(rejected, {
                appliedAtMs: 1,
                appVersion: field === 'appVersion' ? `${exact}x` : '0.7.0',
                profileDatabaseId: field === 'profileDatabaseId' ? `${exact}x` : randomUUID(),
            })).toThrow(/Invalid companion/);
            expect(rejected.prepare(`SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'`).get()?.count).toBe(0);
            rejected.close();
        }
    });

    it('opens concurrently without clobbering the single permanent profile identity', async () => {
        const directory = root();
        const [first, second] = await Promise.all([
            CompanionStore.open(directory, '0.7.0'),
            CompanionStore.open(directory, '0.7.0'),
        ]);
        const [firstNamespace, secondNamespace] = await Promise.all([
            first.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() }),
            second.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() }),
        ]);
        expect(secondNamespace).toEqual(firstNamespace);
        await Promise.all([first.close(), second.close()]);
    });

    it('refuses foreign, unbranded nonempty, and sidecar-contaminated roots without replacing their bytes', async () => {
        for (const kind of ['foreign', 'unbranded', 'sidecar'] as const) {
            const directory = root();
            const stateDirectory = path.join(directory, 'state');
            fs.mkdirSync(stateDirectory, { recursive: true });
            const databasePath = path.join(stateDirectory, 'namespace-recovery.sqlite3');
            if (kind !== 'sidecar') {
                const database = new DatabaseSync(databasePath);
                database.exec('CREATE TABLE foreign_table(value TEXT)');
                if (kind === 'foreign') database.exec('PRAGMA application_id = 12345');
                database.close();
            } else {
                fs.writeFileSync(`${databasePath}-wal`, 'foreign-sidecar');
            }
            const before = fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : undefined;
            await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow();
            expect(fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : undefined).toEqual(before);
            if (kind === 'sidecar') expect(fs.readFileSync(`${databasePath}-wal`, 'utf8')).toBe('foreign-sidecar');
        }
    });

    it('rejects structural schema drift even when branding and versions still match', async () => {
        const directory = root();
        const store = await CompanionStore.open(directory, '0.7.0');
        await store.close();
        const databasePath = path.join(directory, 'state', 'namespace-recovery.sqlite3');
        const database = new DatabaseSync(databasePath);
        database.exec(`DROP INDEX recovery_records_by_status;
            CREATE INDEX recovery_records_by_status
            ON pending_edit_recovery_records(prepared_at_ms, status)`);
        expect(() => validate_companion_schema(database)).toThrow(/schema object mismatch/);
        database.close();
        await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow(/explicit recovery/);
    });

    it('recovers a branded hot rollback journal before validating and reopening the companion', async () => {
        const directory = root();
        let store = await CompanionStore.open(directory, '0.7.0');
        const namespace = await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() });
        await store.close();
        const databasePath = path.join(directory, 'state', 'namespace-recovery.sqlite3');
        const script = `
            const { DatabaseSync } = require('node:sqlite');
            const database = new DatabaseSync(process.argv[1]);
            database.exec('BEGIN IMMEDIATE; UPDATE companion_meta SET coordination_generation=2 WHERE singleton=1');
            if (process.send) process.send('ready');
            setInterval(() => {}, 1000);
        `;
        const child = spawn(process.execPath, ['-e', script, databasePath], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        try {
            await new Promise<void>((resolve, reject) => {
                child.once('message', () => resolve());
                child.once('error', reject);
                child.once('exit', (code, signal) => reject(new Error(`Child exited before ready: ${String(code ?? signal)}`)));
            });
            await poll_for(() => fs.existsSync(`${databasePath}-journal`), 'hot companion journal');
            const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
            child.kill('SIGKILL');
            await exited;

            store = await CompanionStore.open(directory, '0.7.0');
            await expect(store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() }))
                .resolves.toEqual(namespace);
            await store.close();
            const database = new DatabaseSync(databasePath, { readOnly: true });
            expect(database.prepare('SELECT coordination_generation FROM companion_meta').get()?.coordination_generation).toBe(1);
            database.close();
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
    });

    it('reopens the permanent profile and namespace registry after process-local cache loss', async () => {
        const directory = root();
        let store = await CompanionStore.open(directory, '0.7.0');
        const first = await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() });
        await store.close();

        store = await CompanionStore.open(directory, '0.7.0');
        const reopened = await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() });
        const other = await store.namespace({ placementKeyDigest: 'b'.repeat(64), operationId: randomUUID() });
        await store.close();

        expect(reopened).toEqual(first);
        expect(other.profileDatabaseId).toBe(first.profileDatabaseId);
        expect(other.storageEnvironmentId).not.toBe(first.storageEnvironmentId);
    });

    it('stores a global receipt for exact replay and rejects changed-input or cross-kind operation reuse', async () => {
        const directory = root();
        const store = await CompanionStore.open(directory, '0.7.0');
        const operationId = randomUUID();
        const first = await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId });
        await expect(store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId })).resolves.toEqual(first);
        await expect(store.namespace({ placementKeyDigest: 'b'.repeat(64), operationId })).rejects.toThrow(/reused/);
        await expect(store.submitCapsuleCandidate({ operationId, orderedSourceJson: source() })).rejects.toThrow(/reused/);
        await store.close();

        const database = new DatabaseSync(path.join(directory, 'state', 'namespace-recovery.sqlite3'), { readOnly: true });
        expect(database.prepare('SELECT count(*) AS count FROM companion_rpc_operations').get()?.count).toBe(1);
        database.close();
    });

    it('strictly validates a stored receipt result again on replay', async () => {
        const directory = root();
        const store = await CompanionStore.open(directory, '0.7.0');
        const operationId = randomUUID();
        await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId });
        const database = new DatabaseSync(database_path(directory));
        database.prepare(`UPDATE companion_rpc_operations SET result_json=json_set(result_json,'$.extra',1) WHERE operation_id=?`).run(operationId);
        database.close();
        await expect(store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId })).rejects.toThrow(/invalid property set/);
        await store.close();
    });

    it('gives a new operation resolving to an existing namespace its own permanent receipt', async () => {
        const directory = root();
        const store = await CompanionStore.open(directory, '0.7.0');
        const first = await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() });
        const second = await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() });
        expect(second).toEqual(first);
        await store.close();
        const database = new DatabaseSync(path.join(directory, 'state', 'namespace-recovery.sqlite3'), { readOnly: true });
        expect(database.prepare('SELECT count(*) AS count FROM companion_rpc_operations').get()?.count).toBe(2);
        database.close();
    });

    it('validates the complete Memento envelope before arming and returns metadata without payload or paths', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        await expect(store.submitCapsuleCandidate({
            operationId: randomUUID(),
            orderedSourceJson: JSON.stringify({ format: 'tableViewer.fileState.v1', nextRevision: 1, absenceRevision: 0, entries: { secret: { revision: 0, state: { pendingEdits: { bad: 'x' } } } } }),
        })).rejects.toThrow();

        const submitted = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() });
        const active = await store.activeCapsule();
        expect(active).toMatchObject({ ...submitted, sourceFormat: 'tableViewer.fileState.v1', entryCount: 1, status: 'armed' });
        expect(JSON.stringify(active)).not.toContain('/private/example.csv');
        expect(JSON.stringify(active)).not.toContain('columnWidths');
        await expect(store.listCapsulesForRecovery()).resolves.toEqual([
            expect.objectContaining({
                capsuleId: submitted.capsuleId,
                orderedSourceJson: source(),
                sourceResourceKeys: ['/private/example.csv'],
                status: 'armed',
            }),
        ]);
        await store.close();
    });

    it('reopens after cross-kind no-op capsule receipts in either creation order', async () => {
        {
            const directory = root();
            const store = await CompanionStore.open(directory, '0.7.0');
            const submitted = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() });
            await store.archiveDrift({ operationId: randomUUID(), orderedSourceJson: source() });
            await store.close();
            const reopened = await CompanionStore.open(directory, '0.7.0');
            await expect(reopened.activeCapsule()).resolves.toMatchObject(submitted);
            await reopened.close();
        }

        {
            const directory = root();
            const store = await CompanionStore.open(directory, '0.7.0');
            await store.archiveDrift({ operationId: randomUUID(), orderedSourceJson: source() });
            const submitted = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() });
            await store.close();
            const reopened = await CompanionStore.open(directory, '0.7.0');
            await expect(reopened.activeCapsule()).resolves.toMatchObject(submitted);
            await reopened.close();
        }
    });

    it('rotates an armed capsule only through drift archival and requires the new bytes to become the cold winner', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        const first = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source(120) });
        await expect(store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source(240) }))
            .rejects.toThrow(/archive source drift/);
        await store.archiveDrift({ operationId: randomUUID(), orderedSourceJson: source(240) });
        const active = await store.activeCapsule();
        expect(active.capsuleId).not.toBe(first.capsuleId);
        expect(active.sourceDigest).not.toBe(first.sourceDigest);
        expect(await store.listCapsulesForRetirement()).toEqual([
            expect.objectContaining({ capsuleId: first.capsuleId, status: 'drifted' }),
        ]);
        await expect(store.retireCapsule({
            operationId: randomUUID(),
            capsuleId: first.capsuleId,
            noNeverClaimedEnvironmentAttested: true,
        })).resolves.toEqual({});
        expect(await store.listCapsulesForRetirement()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ capsuleId: first.capsuleId }),
        ]));
        await store.close();
    });

    it('preserves an armed capsule while an environment import is preparing', async () => {
        const directory = root();
        const store = await CompanionStore.open(directory, '0.7.0');
        const capsule = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source(120) });
        const claim = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });

        await store.archiveDrift({ operationId: randomUUID(), orderedSourceJson: source(240) });
        await expect(store.activeCapsule()).resolves.toMatchObject({ ...capsule, status: 'armed' });
        await store.confirmEnvironment({ operationId: randomUUID(), ...claim, ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });
        await store.close();

        const reopened = await CompanionStore.open(directory, '0.7.0');
        await expect(reopened.activeCapsule()).resolves.toMatchObject({ ...capsule, status: 'cutover' });
        await reopened.close();
        const database = new DatabaseSync(database_path(directory), { readOnly: true });
        expect(database.prepare(`SELECT count(*) AS count FROM capsules WHERE status='drifted'`).get()?.count).toBe(1);
        database.close();
    });

    it('archives post-cutover drift without replacing the cutover winner', async () => {
        const directory = root();
        const store = await CompanionStore.open(directory, '0.7.0');
        const capsule = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source(120) });
        const claim = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });
        await store.confirmEnvironment({ operationId: randomUUID(), ...claim, ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });

        const driftSource = source(240);
        await store.archiveDrift({ operationId: randomUUID(), orderedSourceJson: driftSource });
        await expect(store.activeCapsule()).resolves.toMatchObject({ ...capsule, status: 'cutover' });
        await store.close();

        const reopened = await CompanionStore.open(directory, '0.7.0');
        await expect(reopened.activeCapsule()).resolves.toMatchObject({ ...capsule, status: 'cutover' });
        await reopened.close();
        const database = new DatabaseSync(database_path(directory), { readOnly: true });
        expect(database.prepare(`SELECT ordered_source_json FROM capsules WHERE status='drifted'`).get()?.ordered_source_json).toBe(driftSource);
        database.close();
    });

    it('supports preparing, confirming, retiring, and finally tombstoning an environment source lifecycle', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        const capsule = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() });
        expect(await store.listCapsulesForRetirement()).toEqual([]);
        await expect(store.retireCapsule({
            operationId: randomUUID(),
            capsuleId: capsule.capsuleId,
            noNeverClaimedEnvironmentAttested: true,
        })).rejects.toThrow(/no longer eligible/);
        const claim = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });
        expect(await store.environmentImportStatus({ ...claim, capsuleId: capsule.capsuleId, storageEnvironmentId: 'environment-a', databaseId: 'database-a' })).toBe('preparing');
        await expect(store.retireCapsule({ operationId: randomUUID(), capsuleId: capsule.capsuleId, noNeverClaimedEnvironmentAttested: true })).rejects.toThrow(/Preparing imports/);

        await store.confirmEnvironment({ operationId: randomUUID(), ...claim, ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });
        expect(await store.environmentImportStatus({ ...claim, capsuleId: capsule.capsuleId, storageEnvironmentId: 'environment-a', databaseId: 'database-a' })).toBe('confirmed');
        expect(await store.listCapsulesForRetirement()).toEqual([]);
        await expect(store.retireCapsule({ operationId: randomUUID(), capsuleId: capsule.capsuleId, noNeverClaimedEnvironmentAttested: true })).rejects.toThrow(/Unretired/);

        await store.confirmEnvironmentSourceRetirement({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a', retirementKind: 'naturallyComplete', sourceStateDigest: 'c'.repeat(64) });
        expect(await store.listCapsulesForRetirement()).toEqual([
            expect.objectContaining({ capsuleId: capsule.capsuleId, status: 'cutover' }),
        ]);
        await expect(store.retireCapsule({ operationId: randomUUID(), capsuleId: capsule.capsuleId, noNeverClaimedEnvironmentAttested: true })).resolves.toEqual({});
        await expect(store.activeCapsule()).rejects.toThrow(/No active/);
        await expect(store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() })).rejects.toThrow(/retired/);
        await store.close();
    });

    it('keeps lifecycle timestamps valid when the wall clock moves backward', async () => {
        const directory = root();
        const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
        const store = await CompanionStore.open(directory, '0.7.0');
        const capsule = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() });
        const claim = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });
        const abandonedClaim = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-b', databaseId: 'database-b' });
        const recovery = await store.preparePendingEditRecovery(recovery_input());
        now.mockReturnValue(1_000);
        await store.abandonEnvironmentImport({ operationId: randomUUID(), ...abandonedClaim, capsuleId: capsule.capsuleId, storageEnvironmentId: 'environment-b', databaseId: 'database-b', abandonmentEvidenceDigest: 'e'.repeat(64) });
        await store.confirmEnvironment({ operationId: randomUUID(), ...claim, ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });
        await store.confirmEnvironmentSourceRetirement({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a', retirementKind: 'naturallyComplete', sourceStateDigest: 'c'.repeat(64) });
        await store.confirmPendingEditRecovery({ operationId: randomUUID(), ...recovery, committedStateRevision: 1 });
        await store.retireCapsule({ operationId: randomUUID(), capsuleId: capsule.capsuleId, noNeverClaimedEnvironmentAttested: true });
        await store.close();

        const reopened = await CompanionStore.open(directory, '0.7.0');
        await reopened.close();
    });

    it('abandons only a preparing claim with explicit evidence and never abandons a confirmed claim', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        const capsule = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() });
        const first = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });
        await store.abandonEnvironmentImport({ operationId: randomUUID(), ...first, capsuleId: capsule.capsuleId, storageEnvironmentId: 'environment-a', databaseId: 'database-a', abandonmentEvidenceDigest: 'e'.repeat(64) });
        expect(await store.environmentImportStatus({ ...first, capsuleId: capsule.capsuleId, storageEnvironmentId: 'environment-a', databaseId: 'database-a' })).toBe('abandoned');

        const second = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-b', databaseId: 'database-b' });
        await store.confirmEnvironment({ operationId: randomUUID(), ...second, ...capsule, storageEnvironmentId: 'environment-b', databaseId: 'database-b' });
        await expect(store.abandonEnvironmentImport({ operationId: randomUUID(), ...second, capsuleId: capsule.capsuleId, storageEnvironmentId: 'environment-b', databaseId: 'database-b', abandonmentEvidenceDigest: 'e'.repeat(64) })).rejects.toThrow(/confirmed/);
        await store.close();
    });

    it('prepares immutable basis-aware pending edits, replays exactly, and confirms idempotently', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        const operationId = randomUUID();
        const input = recovery_input(operationId);
        const prepared = await store.preparePendingEditRecovery(input);
        await expect(store.preparePendingEditRecovery(input)).resolves.toEqual(prepared);
        await expect(store.preparePendingEditRecovery({ ...input, physicalRevision: 4 })).rejects.toThrow(/reused/);
        const records = await store.listRecoveryRecords();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            ...prepared,
            status: 'prepared',
            resourceIdentity: { scheme: 'vscode-remote', authority: 'ssh-remote', path: '/workspace/file.csv' },
            pendingEdits: { '0:0': { value: 'new', base: 'old' } },
            physicalDigest: 'a'.repeat(64),
        });
        const confirmationId = randomUUID();
        await store.confirmPendingEditRecovery({ operationId: confirmationId, ...prepared, committedStateRevision: 8 });
        await expect(store.confirmPendingEditRecovery({ operationId: confirmationId, ...prepared, committedStateRevision: 8 })).resolves.toEqual({});
        expect((await store.listRecoveryRecords())[0]).toMatchObject({ status: 'committed', committedStateRevision: 8 });
        await store.close();
    });

    it('creates a fresh recovery record when identical state recurs in a new prepare operation', async () => {
        const directory = root();
        const store = await CompanionStore.open(directory, '0.7.0');
        const input = recovery_input();
        const first = await store.preparePendingEditRecovery(input);
        await store.confirmPendingEditRecovery({
            operationId: randomUUID(),
            ...first,
            committedStateRevision: 8,
        });

        const second = await store.preparePendingEditRecovery({
            ...input,
            operationId: randomUUID(),
        });
        expect(second.recoveryRecordId).not.toBe(first.recoveryRecordId);
        await expect(store.confirmPendingEditRecovery({
            operationId: randomUUID(),
            ...second,
            committedStateRevision: 9,
        })).resolves.toEqual({});
        expect(await store.listRecoveryRecords()).toEqual(expect.arrayContaining([
            expect.objectContaining({ ...first, status: 'committed', committedStateRevision: 8 }),
            expect.objectContaining({ ...second, status: 'committed', committedStateRevision: 9 }),
        ]));
        await store.close();

        const reopened = await CompanionStore.open(directory, '0.7.0');
        expect(await reopened.listRecoveryRecords()).toHaveLength(2);
        await reopened.close();
    });

    it('accepts a valid legacy secondary recovery receipt for the same request digest', async () => {
        const directory = root();
        const input = recovery_input();
        const store = await CompanionStore.open(directory, '0.7.0');
        const prepared = await store.preparePendingEditRecovery(input);
        await store.close();

        const database = new DatabaseSync(database_path(directory));
        const row = database.prepare(`SELECT request_digest FROM pending_edit_recovery_records WHERE recovery_record_id=?`).get(prepared.recoveryRecordId) as { request_digest: string };
        const legacyOperationId = randomUUID();
        database.prepare(`INSERT INTO companion_rpc_operations(operation_id,operation_kind,request_digest,result_json,completed_at_ms) VALUES(?,'prepare_pending_edit_recovery',?,?,?)`).run(
            legacyOperationId,
            row.request_digest,
            JSON.stringify(prepared),
            Date.now(),
        );
        database.close();

        const reopened = await CompanionStore.open(directory, '0.7.0');
        await expect(reopened.preparePendingEditRecovery({
            ...input,
            operationId: legacyOperationId,
        })).resolves.toEqual(prepared);
        await reopened.close();

        const corrupted = new DatabaseSync(database_path(directory));
        corrupted.prepare(`UPDATE companion_rpc_operations SET result_json=? WHERE operation_id=?`).run(
            JSON.stringify({ recoveryRecordId: randomUUID() }),
            legacyOperationId,
        );
        corrupted.close();
        await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow(/does not match its domain request/);
    });

    it('rejects malformed/empty snapshots and accepts an explicit clear without a payload', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        await expect(store.preparePendingEditRecovery({ ...recovery_input(), pendingEditsJson: '{}' })).rejects.toThrow(/must not be empty/);
        await expect(store.preparePendingEditRecovery({ ...recovery_input(), pendingEditsJson: JSON.stringify({ invalid: 'x' }) })).rejects.toThrow();
        const clear = await store.preparePendingEditRecovery({
            ...recovery_input(),
            operationId: randomUUID(),
            kind: 'clear',
            pendingEditsJson: undefined,
        });
        expect(clear.recoveryRecordId).toBeTruthy();
        expect((await store.listRecoveryRecords())[0]).toMatchObject({ kind: 'clear' });
        await store.close();
    });

    it('memoizes and returns the exact close promise', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        const first = store.close();
        expect(store.close()).toBe(first);
        await first;
        expect(store.close()).toBe(first);
    });

    it('requires retries of an abandoned claim to present the exact prior evidence', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        const capsule = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() });
        const claim = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });
        const abandonment = { ...claim, capsuleId: capsule.capsuleId, storageEnvironmentId: 'environment-a', databaseId: 'database-a' };
        await store.abandonEnvironmentImport({ operationId: randomUUID(), ...abandonment, abandonmentEvidenceDigest: 'a'.repeat(64) });
        await expect(store.abandonEnvironmentImport({ operationId: randomUUID(), ...abandonment, abandonmentEvidenceDigest: 'a'.repeat(64) })).resolves.toEqual({});
        await expect(store.abandonEnvironmentImport({ operationId: randomUUID(), ...abandonment, abandonmentEvidenceDigest: 'b'.repeat(64) })).rejects.toThrow(/evidence mismatch/);
        await store.close();
    });

    it('enforces identifier UTF-8 byte bounds at the exact boundary before request hashing', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        const exact = 'é'.repeat(COMPANION_MAX_ID_UTF8_BYTES / 2);
        await expect(store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: exact })).resolves.toMatchObject({ protocolVersion: 1 });
        expect(() => store.namespace({ placementKeyDigest: 'b'.repeat(64), operationId: `${exact}x` })).toThrow(/1024-byte UTF-8 limit/);
        await store.close();
    });

    it('accepts capsule and recovery JSON at their UTF-8 byte boundaries and rejects one byte over before parsing or hashing', async () => {
        const store = await CompanionStore.open(root(), '0.7.0');
        const capsuleRoot = JSON.parse(source()) as Record<string, unknown>;
        const exactCapsule = exact_json_bytes(capsuleRoot, COMPANION_MAX_CAPSULE_JSON_UTF8_BYTES);
        await expect(store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: exactCapsule })).resolves.toMatchObject({ sourceDigest: expect.any(String) });
        expect(() => store.archiveDrift({ operationId: randomUUID(), orderedSourceJson: `${exactCapsule} ` })).toThrow(new RegExp(`${COMPANION_MAX_CAPSULE_JSON_UTF8_BYTES}-byte UTF-8 limit`));

        const exactIdentity = exact_json_bytes({ scheme: 'file' }, COMPANION_MAX_RECOVERY_JSON_UTF8_BYTES);
        await expect(store.preparePendingEditRecovery({ ...recovery_input(), operationId: randomUUID(), resourceIdentityJson: exactIdentity })).resolves.toMatchObject({ recoveryRecordId: expect.any(String) });
        await expect(store.preparePendingEditRecovery({ ...recovery_input(), operationId: randomUUID(), resourceIdentityJson: `${exactIdentity} ` })).rejects.toThrow(new RegExp(`${COMPANION_MAX_RECOVERY_JSON_UTF8_BYTES}-byte UTF-8 limit`));
        await store.close();
    });

    it('checks receipt UTF-8 size before parsing and applies exact result schemas at the boundary', async () => {
        for (const overBy of [0, 1]) {
            const directory = root();
            const store = await CompanionStore.open(directory, '0.7.0');
            await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() });
            await store.close();
            const database = new DatabaseSync(database_path(directory));
            const resultJson = exact_json_bytes({}, COMPANION_MAX_RECEIPT_JSON_UTF8_BYTES + overBy);
            database.prepare(`UPDATE companion_rpc_operations SET result_json=?`).run(resultJson);
            database.close();
            if (overBy === 0) {
                await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow(/invalid property set/);
            } else {
                await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow(new RegExp(`${COMPANION_MAX_RECEIPT_JSON_UTF8_BYTES}-byte UTF-8 limit`));
            }
        }
    });

    it('rejects extra or sensitive fields in every operation receipt schema', async () => {
        const seedDirectory = root();
        const store = await CompanionStore.open(seedDirectory, '0.7.0');
        await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() });
        await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source(120) });
        await store.archiveDrift({ operationId: randomUUID(), orderedSourceJson: source(240) });
        const capsule = await store.activeCapsule();
        const abandoned = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });
        await store.abandonEnvironmentImport({ operationId: randomUUID(), ...abandoned, capsuleId: capsule.capsuleId, storageEnvironmentId: 'environment-a', databaseId: 'database-a', abandonmentEvidenceDigest: 'e'.repeat(64) });
        const confirmed = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-b', databaseId: 'database-b' });
        await store.confirmEnvironment({ operationId: randomUUID(), ...confirmed, ...capsule, storageEnvironmentId: 'environment-b', databaseId: 'database-b' });
        await store.confirmEnvironmentSourceRetirement({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-b', databaseId: 'database-b', retirementKind: 'naturallyComplete', sourceStateDigest: 'c'.repeat(64) });
        const recovery = await store.preparePendingEditRecovery(recovery_input());
        await store.confirmPendingEditRecovery({ operationId: randomUUID(), ...recovery, committedStateRevision: 8 });
        await store.retireCapsule({ operationId: randomUUID(), capsuleId: capsule.capsuleId, noNeverClaimedEnvironmentAttested: true });
        await store.close();

        const operationKinds = [
            'namespace', 'submit_capsule_candidate', 'archive_drift', 'begin_environment_import',
            'abandon_environment_import', 'confirm_environment', 'confirm_environment_source_retirement',
            'retire_capsule', 'prepare_pending_edit_recovery', 'confirm_pending_edit_recovery',
        ];
        for (const operationKind of operationKinds) {
            const directory = root();
            fs.mkdirSync(path.dirname(database_path(directory)), { recursive: true });
            fs.copyFileSync(database_path(seedDirectory), database_path(directory));
            const database = new DatabaseSync(database_path(directory));
            database.prepare(`UPDATE companion_rpc_operations SET result_json=json_set(result_json,'$.orderedSourceJson','secret') WHERE operation_kind=?`).run(operationKind);
            database.close();
            await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow(/invalid property set/);
        }
    });

    it('binds every secondary result receipt to the exact request-domain result', async () => {
        {
            const directory = root();
            const store = await CompanionStore.open(directory, '0.7.0');
            const first = await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() });
            const secondaryOperationId = randomUUID();
            await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: secondaryOperationId });
            const other = await store.namespace({ placementKeyDigest: 'b'.repeat(64), operationId: randomUUID() });
            await store.close();
            const database = new DatabaseSync(database_path(directory));
            database.prepare(`UPDATE companion_rpc_operations SET result_json=? WHERE operation_id=?`).run(
                JSON.stringify({ ...first, storageEnvironmentId: other.storageEnvironmentId }),
                secondaryOperationId,
            );
            database.close();
            await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow(/does not match its domain request/);
        }

        {
            const directory = root();
            const store = await CompanionStore.open(directory, '0.7.0');
            const firstInput = { operationId: randomUUID(), orderedSourceJson: source() };
            await store.submitCapsuleCandidate(firstInput);
            const secondaryOperationId = randomUUID();
            await store.submitCapsuleCandidate({ ...firstInput, operationId: secondaryOperationId });
            await store.archiveDrift({ operationId: randomUUID(), orderedSourceJson: source(240) });
            const other = await store.activeCapsule();
            await store.close();
            const database = new DatabaseSync(database_path(directory));
            database.prepare(`UPDATE companion_rpc_operations SET result_json=? WHERE operation_id=?`).run(
                JSON.stringify({ capsuleId: other.capsuleId, sourceDigest: other.sourceDigest }),
                secondaryOperationId,
            );
            database.close();
            await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow(/does not match its domain request/);
        }

        {
            const directory = root();
            const store = await CompanionStore.open(directory, '0.7.0');
            const capsule = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() });
            const firstInput = {
                ...capsule,
                storageEnvironmentId: 'environment-a',
                databaseId: 'database-a',
            };
            await store.beginEnvironmentImport({ operationId: randomUUID(), ...firstInput });
            const secondaryOperationId = randomUUID();
            await store.beginEnvironmentImport({ operationId: secondaryOperationId, ...firstInput });
            const other = await store.beginEnvironmentImport({
                operationId: randomUUID(),
                ...capsule,
                storageEnvironmentId: 'environment-b',
                databaseId: 'database-b',
            });
            await store.close();
            const database = new DatabaseSync(database_path(directory));
            database.prepare(`UPDATE companion_rpc_operations SET result_json=? WHERE operation_id=?`).run(
                JSON.stringify({ importClaimId: other.importClaimId }),
                secondaryOperationId,
            );
            database.close();
            await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow(/does not match its domain request/);
        }

        {
            const directory = root();
            const store = await CompanionStore.open(directory, '0.7.0');
            const firstInput = recovery_input();
            await store.preparePendingEditRecovery(firstInput);
            const secondaryOperationId = randomUUID();
            await store.preparePendingEditRecovery({ ...firstInput, operationId: secondaryOperationId });
            const other = await store.preparePendingEditRecovery({
                ...recovery_input(),
                operationId: randomUUID(),
                recoveryEntryId: 'entry-b',
            });
            await store.close();
            const database = new DatabaseSync(database_path(directory));
            database.prepare(`UPDATE companion_rpc_operations SET result_json=? WHERE operation_id=?`).run(
                JSON.stringify({ recoveryRecordId: other.recoveryRecordId }),
                secondaryOperationId,
            );
            database.close();
            await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow(/does not match its domain request|result relationship is invalid/);
        }
    });

    it('fails startup when claim, recovery, capsule, or receipt relationships are independently mutated', async () => {
        const seedDirectory = root();
        const store = await CompanionStore.open(seedDirectory, '0.7.0');
        const capsule = await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() });
        const abandoned = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-a', databaseId: 'database-a' });
        await store.abandonEnvironmentImport({ operationId: randomUUID(), ...abandoned, capsuleId: capsule.capsuleId, storageEnvironmentId: 'environment-a', databaseId: 'database-a', abandonmentEvidenceDigest: 'e'.repeat(64) });
        const confirmed = await store.beginEnvironmentImport({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-b', databaseId: 'database-b' });
        await store.confirmEnvironment({ operationId: randomUUID(), ...confirmed, ...capsule, storageEnvironmentId: 'environment-b', databaseId: 'database-b' });
        await store.confirmEnvironmentSourceRetirement({ operationId: randomUUID(), ...capsule, storageEnvironmentId: 'environment-b', databaseId: 'database-b', retirementKind: 'naturallyComplete', sourceStateDigest: 'c'.repeat(64) });
        await store.retireCapsule({ operationId: randomUUID(), capsuleId: capsule.capsuleId, noNeverClaimedEnvironmentAttested: true });
        await store.archiveDrift({ operationId: randomUUID(), orderedSourceJson: source(240) });
        const recovery = await store.preparePendingEditRecovery(recovery_input());
        await store.confirmPendingEditRecovery({ operationId: randomUUID(), ...recovery, committedStateRevision: 8 });
        await store.close();

        const mutations: Array<(database: DatabaseSync) => void> = [
            (database) => database.exec(`PRAGMA foreign_keys=OFF; DELETE FROM environment_confirmations`),
            (database) => database.exec(`DELETE FROM environment_source_retirements`),
            (database) => database.exec(`UPDATE environment_import_claims SET status='preparing',confirmed_at_ms=NULL WHERE status='confirmed'`),
            (database) => database.exec(`UPDATE pending_edit_recovery_records SET status='prepared',confirmation_operation_id=NULL,confirmation_request_digest=NULL,committed_state_revision=NULL,committed_at_ms=NULL`),
            (database) => database.exec(`UPDATE capsules SET source_entry_count=source_entry_count+1`),
            (database) => database.prepare(`INSERT INTO companion_rpc_operations(operation_id,operation_kind,request_digest,result_json,completed_at_ms) VALUES(?,'archive_drift',?,'{}',1)`).run(randomUUID(), '0'.repeat(64)),
            (database) => database.exec(`UPDATE companion_rpc_operations SET request_digest='${'0'.repeat(64)}' WHERE operation_id=(SELECT abandonment_operation_id FROM environment_import_claims WHERE status='abandoned')`),
        ];
        for (const mutate of mutations) {
            const directory = root();
            fs.mkdirSync(path.dirname(database_path(directory)), { recursive: true });
            fs.copyFileSync(database_path(seedDirectory), database_path(directory));
            const database = new DatabaseSync(database_path(directory));
            mutate(database);
            database.close();
            await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow();
        }
    });

    it('fails startup on representative domain, enum, payload, and receipt relationship corruption', async () => {
        const corruptions: Array<(database: DatabaseSync) => void> = [
            (database) => database.exec(`UPDATE capsules SET source_digest='corrupt'`),
            (database) => database.exec(`PRAGMA ignore_check_constraints=ON; UPDATE capsules SET status='unknown'`),
            (database) => database.exec(`UPDATE companion_rpc_operations SET result_json=json_set(result_json,'$.extra',1)`),
            (database) => database.exec(`UPDATE environment_namespaces SET request_digest='corrupt'; UPDATE companion_rpc_operations SET request_digest='corrupt' WHERE operation_kind='namespace'`),
        ];
        for (const corrupt of corruptions) {
            const directory = root();
            const store = await CompanionStore.open(directory, '0.7.0');
            await store.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: randomUUID() });
            await store.submitCapsuleCandidate({ operationId: randomUUID(), orderedSourceJson: source() });
            await store.close();
            const database = new DatabaseSync(database_path(directory));
            corrupt(database);
            database.close();
            await expect(CompanionStore.open(directory, '0.7.0')).rejects.toThrow();
        }
    });
});
