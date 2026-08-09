import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';

interface SqliteError extends Error {
    code?: unknown;
    errcode?: unknown;
    errstr?: unknown;
}

describe('embedded node:sqlite runtime', () => {
    it('supports the shared API intersection and representative errors', () => {
        assert.ok(
            vscode.version === '1.127.0' || vscode.version === '1.131.0',
            `runtime probe must run in VS Code 1.127.0 or 1.131.0, received ${vscode.version}`,
        );
        assert.strictEqual(typeof DatabaseSync, 'function');

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
            assert.strictEqual(insert.run(9007199254740993n, 'alpha').changes, 1);

            const by_name = database.prepare(
                'SELECT id, large_value, label FROM probe WHERE label = :label',
            );
            by_name.setReadBigInts(true);
            const row = by_name.get({ label: 'alpha' });
            assert.strictEqual(row?.large_value, 9007199254740993n);
            assert.strictEqual(row?.label, 'alpha');
            assert.deepStrictEqual(
                by_name.all({ label: 'alpha' }).map((value) => value.label),
                ['alpha'],
            );

            database.exec('BEGIN IMMEDIATE');
            insert.run(7, 'rolled-back');
            database.exec('ROLLBACK');
            assert.strictEqual(
                database.prepare('SELECT label FROM probe WHERE label = ?')
                    .get('rolled-back'),
                undefined,
            );

            const sqlite_version = database.prepare(
                'SELECT sqlite_version() AS version',
            ).get()?.version;
            assert.strictEqual(typeof sqlite_version, 'string');
            assert.ok((sqlite_version as string).length > 0);

            const json = database.prepare(`SELECT json_valid(?) AS valid,
                json_type(?) AS type`).get('{"value":1}', '{"value":1}');
            assert.strictEqual(json?.valid, 1);
            assert.strictEqual(json?.type, 'object');

            database.exec('PRAGMA query_only = ON');
            assert.throws(() => insert.run(8, 'query-only-write'));
            database.exec('PRAGMA query_only = OFF');
            assert.strictEqual(insert.run(9, 'query-only-restored').changes, 1);

            const probeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-vscode-sqlite-probe-'));
            try {
                const existingPath = path.join(probeDirectory, 'existing.sqlite3');
                new DatabaseSync(existingPath).close();
                const existingUri = pathToFileURL(existingPath);
                existingUri.searchParams.set('mode', 'rw');
                new DatabaseSync(existingUri).close();

                const missingPath = path.join(probeDirectory, 'missing.sqlite3');
                const missingUri = pathToFileURL(missingPath);
                missingUri.searchParams.set('mode', 'rw');
                assert.throws(() => new DatabaseSync(missingUri));
                assert.strictEqual(fs.existsSync(missingPath), false);

                const linkSource = path.join(probeDirectory, 'link-source');
                const linkTarget = path.join(probeDirectory, 'link-target');
                fs.writeFileSync(linkSource, 'source', { mode: 0o600 });
                fs.writeFileSync(linkTarget, 'target', { mode: 0o600 });
                assert.throws(
                    () => fs.linkSync(linkSource, linkTarget),
                    (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
                );
                assert.strictEqual(fs.readFileSync(linkTarget, 'utf8'), 'target');

                let directoryError: NodeJS.ErrnoException | undefined;
                try {
                    const directory = fs.openSync(probeDirectory, 'r');
                    try {
                        fs.fsyncSync(directory);
                    } finally {
                        fs.closeSync(directory);
                    }
                } catch (error) {
                    directoryError = error as NodeJS.ErrnoException;
                }
                // What this runtime can actually do, asserted as such. The old form
                // computed 'fail-closed' from `platform === 'win32'` and then compared
                // it against `platform === 'win32'`, so it asserted nothing and
                // discarded `directoryError` — and it outlived the refusal it was
                // describing. Production no longer refuses a platform: where no
                // directory-flush primitive is reachable the flush is skipped, as
                // SQLite's own Windows VFS skips it.
                //
                // A skipped flush is therefore a permitted outcome here, but only for
                // the reason that permits it — a directory handle Node cannot open or
                // sync. Any other error is a real finding about this runtime.
                if (process.platform === 'win32') {
                    assert.ok(
                        directoryError === undefined
                        || ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR', 'EACCES']
                            .includes(String(directoryError.code)),
                        `unexpected directory fsync failure: ${String(directoryError?.code)}`,
                    );
                } else {
                    assert.strictEqual(
                        directoryError,
                        undefined,
                        `directory fsync failed: ${String(directoryError?.code)}`,
                    );
                }
            } finally {
                fs.rmSync(probeDirectory, { recursive: true, force: true });
            }

            let representative_error: SqliteError | undefined;
            try {
                insert.run(8, 'alpha');
            } catch (error) {
                representative_error = error as SqliteError;
            }
            assert.ok(representative_error instanceof Error);
            assert.strictEqual(representative_error.code, 'ERR_SQLITE_ERROR');
            assert.ok(Number.isInteger(representative_error.errcode));
            assert.strictEqual(typeof representative_error.errstr, 'string');
        } finally {
            database.close();
        }
    });
});
