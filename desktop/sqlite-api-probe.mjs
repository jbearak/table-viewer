import {
    closeSync,
    existsSync,
    fsyncSync,
    linkSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

function invariant(condition, message) {
    if (!condition) throw new Error(`node:sqlite runtime probe failed: ${message}`);
}

/**
 * Exercises the exact node:sqlite surface shared production code is allowed to use.
 * The probe is imported by both standalone Node and a bundled Electron main process.
 */
export function run_sqlite_api_probe(runtime) {
    invariant(typeof DatabaseSync === 'function', 'DatabaseSync is unavailable');

    const database = new DatabaseSync(':memory:');
    try {
        database.exec(`
            CREATE TABLE probe (
                id INTEGER PRIMARY KEY,
                large_value INTEGER NOT NULL,
                label TEXT NOT NULL UNIQUE
            ) STRICT;
        `);

        const insert = database.prepare(
            'INSERT INTO probe (large_value, label) VALUES (?, ?)',
        );
        const first = insert.run(9007199254740993n, 'alpha');
        invariant(first.changes === 1, 'StatementSync.run did not report one change');

        const by_name = database.prepare(
            'SELECT id, large_value, label FROM probe WHERE label = :label',
        );
        by_name.setReadBigInts(true);
        const row = by_name.get({ label: 'alpha' });
        invariant(row?.large_value === 9007199254740993n, 'bigint read was not exact');
        invariant(row?.label === 'alpha', 'named binding or get failed');

        const all = by_name.all({ label: 'alpha' });
        invariant(all.length === 1 && all[0]?.label === 'alpha', 'all failed');

        database.exec('BEGIN IMMEDIATE');
        insert.run(7, 'rolled-back');
        database.exec('ROLLBACK');
        const rolled_back = database.prepare(
            'SELECT label FROM probe WHERE label = ?',
        ).get('rolled-back');
        invariant(rolled_back === undefined, 'ROLLBACK did not restore the transaction');

        const sqlite_version = database.prepare(
            'SELECT sqlite_version() AS version',
        ).get()?.version;
        invariant(typeof sqlite_version === 'string' && sqlite_version.length > 0,
            'sqlite_version() returned no version');

        const json = database.prepare(`SELECT json_valid(?) AS valid,
            json_type(?) AS type`).get('{"value":1}', '{"value":1}');
        invariant(json?.valid === 1 && json?.type === 'object',
            'SQLite JSON functions are unavailable');

        database.exec('PRAGMA query_only = ON');
        let query_only_error;
        try {
            insert.run(8, 'query-only-write');
        } catch (error) {
            query_only_error = error;
        } finally {
            database.exec('PRAGMA query_only = OFF');
        }
        invariant(query_only_error instanceof Error, 'query_only did not reject a write');
        invariant(insert.run(9, 'query-only-restored').changes === 1,
            'query_only could not be restored for the writer connection');

        const probe_directory = mkdtempSync(join(tmpdir(), 'table-viewer-sqlite-probe-'));
        let directory_fsync;
        try {
            const existing_path = join(probe_directory, 'existing.sqlite3');
            new DatabaseSync(existing_path).close();
            const existing_uri = pathToFileURL(existing_path);
            existing_uri.searchParams.set('mode', 'rw');
            new DatabaseSync(existing_uri).close();

            const missing_path = join(probe_directory, 'missing.sqlite3');
            const missing_uri = pathToFileURL(missing_path);
            missing_uri.searchParams.set('mode', 'rw');
            let missing_error;
            try {
                new DatabaseSync(missing_uri).close();
            } catch (error) {
                missing_error = error;
            }
            invariant(missing_error instanceof Error,
                'URI mode=rw unexpectedly created a missing database');
            invariant(!existsSync(missing_path),
                'URI mode=rw left a missing database behind');

            const link_source = join(probe_directory, 'link-source');
            const link_target = join(probe_directory, 'link-target');
            writeFileSync(link_source, 'source', { mode: 0o600 });
            writeFileSync(link_target, 'target', { mode: 0o600 });
            let link_error;
            try {
                linkSync(link_source, link_target);
            } catch (error) {
                link_error = error;
            }
            invariant(link_error instanceof Error && link_error.code === 'EEXIST',
                'hard-link installation did not fail closed on an existing target');
            invariant(readFileSync(link_target, 'utf8') === 'target',
                'hard-link no-clobber changed the existing target');

            let directory_error;
            try {
                const directory = openSync(probe_directory, 'r');
                try {
                    fsyncSync(directory);
                } finally {
                    closeSync(directory);
                }
            } catch (error) {
                directory_error = error;
            }
            // Reported as an observation, never as a policy. This module is plain
            // `.mjs` run directly by `host-sqlite-runtime-probe.mjs`, so it cannot
            // import the production rule the way the Electron and durability probes
            // do — and a hardcoded platform verdict here is exactly the second copy
            // of a predicate that keeps answering after the original changes. It used
            // to say `fail-closed` on win32 and threw the observed error away, which
            // survived the removal of that refusal by construction.
            //
            // A platform with no reachable primitive is a *result*, not a probe
            // malfunction: production skips the flush there (see
            // `assert_sqlite_directory_durability_supported`), so the honest report is
            // what this runtime could actually do, with the error code that says why.
            directory_fsync = directory_error === undefined
                ? { outcome: 'supported', errorCode: null }
                : { outcome: 'unavailable', errorCode: directory_error.code ?? null };
        } finally {
            rmSync(probe_directory, { recursive: true, force: true });
        }

        invariant(directory_fsync !== undefined,
            'directory durability capability was not resolved');

        let representative_error;
        try {
            insert.run(8, 'alpha');
        } catch (error) {
            representative_error = error;
        }
        invariant(representative_error instanceof Error, 'constraint violation did not throw Error');
        invariant(representative_error.code === 'ERR_SQLITE_ERROR',
            'constraint error code is not ERR_SQLITE_ERROR');
        invariant(Number.isInteger(representative_error.errcode),
            'constraint error has no integer errcode');
        invariant(typeof representative_error.errstr === 'string'
            && representative_error.errstr.length > 0,
        'constraint error has no errstr');

        return {
            runtime,
            node: process.versions.node,
            electron: process.versions.electron ?? null,
            sqlite: sqlite_version,
            capabilities: {
                jsonFunctions: true,
                uriReadWriteNonCreating: true,
                queryOnly: true,
                hardLinkNoClobber: true,
                directoryFsync: directory_fsync,
            },
            error: {
                code: representative_error.code,
                errcode: representative_error.errcode,
                errstr: representative_error.errstr,
            },
        };
    } finally {
        database.close();
    }
}
