import * as assert from 'assert';
import { DatabaseSync } from 'node:sqlite';
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
