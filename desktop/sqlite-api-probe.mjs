import { DatabaseSync } from 'node:sqlite';

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
