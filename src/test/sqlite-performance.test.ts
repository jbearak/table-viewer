// Packaged-desktop performance gates (plan: "Measure 10,000-entry metadata
// scans and large pending-edit FULL-sync writes").
//
// What is *asserted* here is bounded I/O and durability; what is *reported* is
// wall-clock. That split is deliberate. A time budget on a shared CI runner is a
// flake generator — the same code is fast on an idle machine and slow behind
// three other jobs — while the properties that actually keep a 10,000-file
// profile usable are structural: the metadata scan returns metadata-sized rows
// and executes a bounded number of statements regardless of entry count, and one
// multi-megabyte pending-edit map commits durably under a verified
// `journal_mode = DELETE` / `synchronous = FULL` connection and reads back
// byte-identical through a fresh, independent store. Those hold on any machine,
// at any load, and they are what a regression would actually break.
//
// Two things this file has repeatedly got wrong, both now fixed, both worth
// knowing before editing it:
//
//  * **A guard is only as good as the fixture it runs against.** Bounded-I/O is
//    measured in bytes returned, but a payload key the fixture never populates
//    costs zero bytes to extract, and a conditional load over rows the fixture
//    never marks dirty costs zero too. Twice a real regression measured nothing
//    because the seed data was too tidy. `scan_payload` documents what must stay
//    realistic and why.
//  * **Prepare-count is not round-trip count.** An N+1 loop reusing one prepared
//    statement is two statements and ten thousand executions, so executions are
//    what the gate asserts. See `MAX_SCAN_EXECUTIONS`.
//
// Payload loading is caught by measuring returned bytes, not by counting decodes
// and not by matching SQL text: a scan can pay the I/O without ever calling the
// decoder, and whether a given JSON path is cheap or expensive is a property of
// the data that no text predicate can decide. `watch_payload_io` records the
// three narrower checks that were tried and discarded, and the one evasion that
// remains outside its reach.
//
// Nothing here prints a path, a key, a cell value, or any part of a state
// payload: the reported numbers are counts and durations only.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    create_keyed_authority_store,
    type KeyedFileStatePersistence,
    type KeyedStateReadTransaction,
} from '../state';
import { open_sqlite_file_state_store } from '../sqlite-file-state-persistence';
import { create_sqlite_file_state_read_repository } from '../sqlite-file-state-repository';
import {
    open_sqlite_runtime,
    type SqlitePreparedStatement,
    type SqliteReadTransactionContext,
} from '../sqlite-runtime';
import type { CsvDirtyMap, PerFileState, StoredPerFileState } from '../types';
import { SqliteTestDatabase } from './helpers/sqlite-test-database';

/** The scan gate's fixture size — the figure the plan names. */
const SCAN_ENTRY_COUNT = 10_000;

/** Column-width entries per seeded payload; see `scan_payload`. */
const SCAN_PAYLOAD_COLUMNS = 60;

/** One entry in every N carries unsaved CSV work, as a real profile would. */
const SCAN_PENDING_EDIT_EVERY = 8;

/** Dirty cells in each such entry's `pendingEdits` map. */
const SCAN_PENDING_EDIT_CELLS = 40;

/**
 * The entry the single-entry gates read, chosen to be one that *carries* unsaved
 * work (`4320 % SCAN_PENDING_EDIT_EVERY === 0`).
 *
 * Not arbitrary. These gates previously read entry 4321, which is clean — the
 * same fixture blind spot that let the scan-level mutants through: a read cannot
 * be caught picking up a payload that is not there. Reading a dirty entry means
 * the largest structure in the schema is present on the row under test, so the
 * byte ceiling is measuring something real. Asserted below rather than trusted.
 */
const SCAN_DIRTY_ENTRY_INDEX = 4_320;
const SCAN_DIRTY_ENTRY_PATH = `/scan/entry-${SCAN_DIRTY_ENTRY_INDEX}.csv`;

/**
 * How many times one metadata scan may *execute* a statement.
 *
 * Executions, not preparations, and that distinction is the whole value of this
 * constant. A per-entry loop that prepares one statement and calls `.get()` ten
 * thousand times is the classic N+1 shape — ten thousand round trips — and it
 * prepares only two statements, so a preparation ceiling waved it straight
 * through while claiming to be the thing that pinned it. The measured shape is
 * one execution; the ceiling leaves room for a couple more without leaving room
 * for a loop.
 *
 * Kept alongside the preparation count rather than replacing it: they catch
 * different mistakes (a query built per row vs. a query run per row), and only
 * this one scales with the fixture if it regresses.
 */
const MAX_SCAN_EXECUTIONS = 4;

/**
 * How many statements one metadata scan may prepare.
 *
 * `scan_entry_metadata` is one `SELECT … FROM entries ORDER BY recency_order,
 * path` and nothing else. This catches a statement built per entry; see
 * `MAX_SCAN_EXECUTIONS` for the per-entry *execution* it cannot see.
 */
const MAX_SCAN_STATEMENTS = 4;

/**
 * How many bytes of row data a 10,000-entry metadata scan may hand back.
 *
 * Every figure here was measured on the fixture below, not guessed. A correct
 * metadata-only scan returns **1,127,780 bytes** — paths, revisions, counters and
 * the derived flags for 10,000 rows. Each regression shape, measured against the
 * same fixture:
 *
 * | shape | returned |
 * |---|---|
 * | whole payload projected or wildcarded | 5.74 MB |
 * | `json_extract(…, '$.columnWidths')` | 5.74 MB |
 * | `json_extract(…, '$.pendingEdits')` | 3.80 MB |
 * | payload loaded only for dirty entries | 4.44 MB |
 *
 * The cheapest of those is 3.4× the correct figure, and that is with deliberately
 * modest fixture payloads: a real profile's `pendingEdits` map runs to megabytes
 * *per entry* (this file's second gate builds one at 4.2 MB), so in production the
 * gap is far wider than the one this bound has to separate.
 *
 * 2 MB sits between them, with ~86% headroom above the correct figure and a ~1.9×
 * margin below the cheapest regression. Wide enough that ordinary growth — another
 * metadata column, longer paths — will not trip it; narrow enough that no
 * payload-loading scan measured so far fits underneath.
 *
 * Unlike the wall-clock ceilings, this is not load-sensitive: it counts bytes the
 * query returned, which is identical on an idle laptop and a saturated CI runner.
 */
const SCAN_RETURNED_BYTE_CEILING = 2 * 1024 * 1024;

/**
 * The same gate for a single-entry metadata read.
 *
 * Measured: a correct read of `SCAN_DIRTY_ENTRY_PATH` returns **113 bytes**, while
 * that entry's payload is **2,927 bytes** (of which its `pendingEdits` map alone is
 * 2,371). The bound sits between them, so a read that picked the payload up fails
 * even though both numbers are small — the ratio is what matters, and it is the
 * same ratio that becomes catastrophic across 10,000 rows.
 */
const SINGLE_ENTRY_RETURNED_BYTE_CEILING = 400;

/**
 * A generous order-of-magnitude ceiling on the scan, and nothing finer.
 *
 * The scan is milliseconds of work on any machine that can run the app at all;
 * this only catches a change that made it seconds — a per-entry query, a payload
 * decode, a full-table sort without the recency index. CI runners are shared, so
 * a tighter budget would measure the neighbours rather than this code. Failing
 * here means "something is categorically wrong", never "the runner was busy".
 */
const SCAN_WALL_CLOCK_CEILING_MS = 20_000;

/** Same reasoning, for one large FULL-sync commit plus its reopen and read-back. */
const PENDING_EDIT_WALL_CLOCK_CEILING_MS = 120_000;

/**
 * Per-test timeout for this file, above both ceilings above.
 *
 * Vitest's 5 s default is far below them, so without this the harness kills the
 * test long before its own assertion could speak — which is not a stricter
 * budget, it is an *incoherent* one: the failure says "timed out in 5000ms"
 * rather than naming the bounded-I/O property that broke, and the documented
 * "only catches an order-of-magnitude regression" ceilings were unreachable.
 *
 * Load-sensitivity is exactly why these gates assert on *bytes* rather than
 * time; this timeout only has to be generous enough that a busy runner cannot
 * turn a passing property into a red build.
 */
const PERFORMANCE_TEST_TIMEOUT_MS = 180_000;

/** Client kind recorded by the durability probe's runtime reference. */
const DURABILITY_PROBE_CLIENT = 'vitest-durability-probe';

/** Roughly how large the pending-edit map has to be to be "multi-megabyte". */
const MIN_PENDING_EDIT_JSON_BYTES = 4 * 1024 * 1024;

let tempDirectory: string;
let databaseCounter = 0;
let databases: SqliteTestDatabase[];

function freshDatabase(): SqliteTestDatabase {
    const database = new SqliteTestDatabase(
        path.join(tempDirectory, `perf-${databaseCounter++}`, 'file-state.sqlite3'),
    );
    databases.push(database);
    return database;
}

/**
 * Report one measurement.
 *
 * Counts and durations only — never a path, a key, or any part of a payload.
 * These land in the test output so a reviewer can see the numbers the plan asks
 * to be measured without any assertion depending on them.
 */
function report(label: string, milliseconds: number, detail: Record<string, number> = {}): void {
    const extra = Object.entries(detail).map(([name, value]) => ` ${name}=${value}`).join('');
    // eslint-disable-next-line no-console -- the measurement is the deliverable.
    console.log(`[sqlite-performance] ${label} ms=${Math.round(milliseconds)}${extra}`);
}

/**
 * Does the entry at `index` carry unsaved CSV work?
 *
 * A minority, as in a real profile: most open files have layout state and no
 * draft. The exact fraction matters less than it being neither zero nor all —
 * zero is what let a conditional-load regression measure nothing at all (see
 * `scan_payload`), and all of them would make the fixture unrepresentative in
 * the other direction.
 */
function scan_entry_has_pending_edits(index: number): boolean {
    return index % SCAN_PENDING_EDIT_EVERY === 0;
}

/**
 * One entry's stored state: a realistic per-file payload rather than a stub.
 *
 * Two things here are load-bearing for the byte gate, and both were originally
 * absent — each time letting a real regression measure zero:
 *
 * 1. **Substantial payloads.** With the one-field stubs this started as, loading
 *    every payload in the table still totalled less than the metadata columns,
 *    so the gate could not tell a bounded scan from an unbounded one.
 * 2. **A populated `pendingEdits` on a minority of entries.** `json_extract` of
 *    an *absent* path returns NULL — zero bytes — so a fixture that never writes
 *    the key cannot detect a scan that extracts it. That is the single most
 *    expensive key in the schema (this file's second gate builds one at 4.2 MB),
 *    and it was exactly the mutation the byte-gate restructure was motivated by,
 *    still passing because nothing seeded it. The same absence made every row's
 *    `has_pending_edits` zero, so a scan loading payloads only for dirty entries
 *    — the realistic, expensive shape — also cost nothing.
 *
 * Everything is built from genuine `PerFileState` leaves, so the rows are ones
 * the store could really have written and the structural validation on open
 * accepts them. The `has_pending_edits` column is kept consistent with the
 * payload by `seed_entries`, which the schema's CHECK constraint requires: the
 * flag is 1 if and only if `$.pendingEdits` is an object.
 */
function scan_payload(index: number): string {
    const widths: Record<string, number> = {};
    for (let column = 0; column < SCAN_PAYLOAD_COLUMNS; column += 1) {
        widths[String(column)] = 80 + ((index + column) % 40);
    }
    const state: Record<string, unknown> = {
        activeSheetIndex: index % 8,
        columnWidths: { 'Sheet1': widths },
    };
    if (scan_entry_has_pending_edits(index)) {
        // A real draft: canonical `row:column` keys with the exact
        // conflict-preserving `{ value, base }` pairs an edit session persists.
        const edits: Record<string, { value: string; base: string }> = {};
        for (let cell = 0; cell < SCAN_PENDING_EDIT_CELLS; cell += 1) {
            edits[`${cell}:${index % 16}`] = {
                value: `edited-${index}-${cell}`,
                base: `original-${index}-${cell}`,
            };
        }
        state.pendingEdits = edits;
    }
    return JSON.stringify(state);
}

/**
 * Seed `count` entries in one transaction.
 *
 * One transaction rather than `count` store writes: each `compare_and_set` is
 * its own `BEGIN IMMEDIATE` with a `synchronous = FULL` commit, and ten thousand
 * of those is minutes of fsync that measures the fixture rather than the scan.
 * The rows are written through the same schema the store writes through, so the
 * scan under test reads exactly what it would in production.
 *
 * Every payload is valid here, because the open path validates the whole
 * database structurally before handing back a connection. Undecodable payloads
 * are introduced afterwards by `corrupt_payloads`.
 *
 * The payloads are deliberately substantial, and a minority of them carry a real
 * `pendingEdits` map — see `scan_payload` for why both are load-bearing rather
 * than decorative. A real 10,000-file profile holds real state, so the fixture
 * does too.
 */
function seed_entries(databasePath: string, count: number): void {
    const database = new DatabaseSync(databasePath, { enableDoubleQuotedStringLiterals: false });
    try {
        database.exec(`PRAGMA foreign_keys = ON;
            PRAGMA trusted_schema = OFF;
            PRAGMA synchronous = FULL;
            PRAGMA secure_delete = ON;
            BEGIN IMMEDIATE`);
        const insert = database.prepare(`INSERT INTO entries (
            path, state_revision, state_json, has_pending_edits,
            authority_commit_sequence, authority_revision, physical_revision,
            projection_revision, physical_digest, recency_order, updated_at_ms,
            touched_at_ms, recovery_entry_id, recovery_record_id, copy_id,
            copy_source_path, copy_source_revision
        ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)`);
        for (let index = 0; index < count; index += 1) {
            insert.run(
                `/scan/entry-${index}.csv`,
                index + 1,
                scan_payload(index),
                // Kept in step with the payload rather than hardcoded: the schema
                // CHECKs that this flag is 1 exactly when `$.pendingEdits` is an
                // object, so a mismatch is rejected at insert — which is the right
                // place to find out, and why this cannot silently drift again.
                scan_entry_has_pending_edits(index) ? 1 : 0,
                index + 1,
                1_000 + index,
                `recovery-${index}`,
            );
        }
        database.prepare(`UPDATE state_meta SET next_revision = ?, next_recency_order = ?
            WHERE singleton = 1`).run(count + 1, count + 1);
        database.exec('COMMIT');
    } catch (error) {
        try {
            database.exec('ROLLBACK');
        } catch {
            // Preserve the seeding failure.
        }
        throw error;
    } finally {
        database.close();
    }
}

/**
 * Replace `count` payloads with structurally valid but logically undecodable
 * JSON, after the database has been opened.
 *
 * This is what makes the "no payload decode" assertion unfakeable: a scan that
 * decoded these would throw rather than merely be slow. It has to run after the
 * open, because `validate_sqlite_file_state_database` decodes every payload once
 * on open by design — a database that arrived on disk holding one of these is a
 * `malformed-state` condition, not a performance fixture.
 *
 * The replacement payload keeps a `pendingEdits` object, and `has_pending_edits`
 * is left alone, so the row still satisfies the schema CHECK tying the two
 * together. Dropping the key instead would make this UPDATE fail on every seeded
 * dirty entry — and clearing the flag to work around that would quietly undo the
 * conditional-load coverage the dirty entries exist to provide.
 */
function corrupt_payloads(databasePath: string, count: number): void {
    const database = new DatabaseSync(databasePath, { enableDoubleQuotedStringLiterals: false });
    try {
        database.exec('BEGIN IMMEDIATE');
        const update = database.prepare(`UPDATE entries
            SET state_json = CASE WHEN has_pending_edits = 1 THEN ? ELSE ? END
            WHERE path = ?`);
        for (let index = 0; index < count; index += 1) {
            update.run(
                '{"activeSheetIndex":"not-a-number","pendingEdits":{"0:0":"not-an-entry"}}',
                '{"activeSheetIndex":"not-a-number"}',
                `/scan/entry-${index}.csv`,
            );
        }
        database.exec('COMMIT');
    } finally {
        database.close();
    }
}

/** The one column that holds a logical state payload. */
const PAYLOAD_COLUMN = 'state_json';

/**
 * Approximate the bytes one SQLite value costs to hand back to JS.
 *
 * Approximate is enough, and deliberately so: the gate compares a metadata-only
 * scan against one that also drags payloads along, and those differ by orders of
 * magnitude. What the estimate must be is *monotone* in real bytes — bigger
 * value, bigger number — so no evasion can make a large payload measure small.
 * ASCII-ish JSON makes UTF-16 length a close enough stand-in for byte length.
 */
function value_bytes(value: unknown): number {
    if (typeof value === 'string') return value.length;
    if (value instanceof Uint8Array) return value.byteLength;
    if (typeof value === 'bigint' || typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 1;
    return 0;
}

/**
 * Watch a read transaction: statements prepared, statements executed, and — the
 * payload gate — how many bytes of row data it actually pulls back.
 *
 * The byte total is the assertion, and getting here took three failed attempts
 * that are worth recording, because each one looked sufficient:
 *
 * 1. A decode counter on the transaction *port*. Evaded by a scan that selected
 *    `state_json` inline and parsed it with a bare `JSON.parse`: it never called
 *    `read_entry`, so the counter stayed at zero while every payload was loaded.
 * 2. Matching the SQL text for the payload column. Evaded by `SELECT e.*`, which
 *    names nothing.
 * 3. Matching the SQL text with a path-aware carve-out for the one legitimate
 *    `json_extract(e.state_json, '$.…phase')` scalar. Evaded by
 *    `json_extract(e.state_json, '$.pendingEdits')` — leaf-*shaped*, so it was
 *    stripped as cheap, yet `pendingEdits` is the multi-megabyte map this file's
 *    own second gate builds at over 4 MB.
 *
 * The third failure is the instructive one: whether a JSON path is cheap or
 * expensive is a property of the *data*, not of the SQL text, so no text
 * predicate can decide it. Patching in `pendingEdits` would just move the target
 * to `'$.cellHighlights'`, then `'$.columnWidths'`. The whole regex apparatus was
 * therefore deleted rather than extended.
 *
 * Measuring returned bytes is immune to that entire class, because every evasion
 * has to return the bytes to be worth doing. Path expression, alias, wildcard,
 * subquery, table alias, or scalar function — they all land in the same total.
 * It is also the invariant the plan actually states: bounded I/O is the goal, and
 * "no `state_json` for authority read" was only ever the mechanism.
 *
 * Scope, stated rather than implied. Two conditions, both necessary:
 *
 *  * **The bytes must exist in the fixture.** This measures what a query returned,
 *    so a payload key the seed data never writes is free to extract and a
 *    conditional load over rows it never marks dirty is free to perform.
 *    `scan_payload` is therefore part of the gate, not scaffolding around it.
 *  * **The read must go through this transaction.** A scan that obtained a
 *    *different* transaction or connection handle would be invisible here.
 *    Closing that would mean instrumenting the SQLite connection itself; it is
 *    left open deliberately.
 *
 * Recorded so nobody mistakes this for a total guarantee. Everything else tried
 * — bare projection, `SELECT e.*`, whole-document and subtree `json_extract`,
 * self-join under another alias, `substr`, renaming subquery, conditional load,
 * and an N+1 loop — is verified to fail this file.
 */
function watch_payload_io(tx: SqliteReadTransactionContext): {
    readonly context: SqliteReadTransactionContext;
    readonly statements: () => number;
    readonly executions: () => number;
    readonly returned_bytes: () => number;
    readonly payload_rows: () => number;
} {
    let prepared = 0;
    let executed = 0;
    let returnedBytes = 0;
    let payloadRows = 0;
    const inspect_rows = (rows: readonly (Record<string, unknown> | undefined)[]): void => {
        executed += 1;
        for (const row of rows) {
            if (!row) continue;
            if (Object.prototype.hasOwnProperty.call(row, PAYLOAD_COLUMN)) payloadRows += 1;
            for (const value of Object.values(row)) returnedBytes += value_bytes(value);
        }
    };
    return {
        context: {
            prepare(sql: string): SqlitePreparedStatement {
                prepared += 1;
                const statement = tx.prepare(sql);
                return {
                    get(...parameters) {
                        const row = statement.get(...parameters);
                        inspect_rows([row]);
                        return row;
                    },
                    all(...parameters) {
                        const rows = statement.all(...parameters);
                        inspect_rows(rows);
                        return rows;
                    },
                    run: (...parameters) => statement.run(...parameters),
                };
            },
            safe_integer: (value, name, minimum, maximum) => (
                tx.safe_integer(value, name, minimum, maximum)
            ),
        },
        statements: () => prepared,
        executions: () => executed,
        returned_bytes: () => returnedBytes,
        payload_rows: () => payloadRows,
    };
}

/** Count logical payload decodes, the way the bounded-I/O suite already does. */
function count_payload_reads(persistence: KeyedFileStatePersistence) {
    const counts = { reads: 0 };
    const wrap = (tx: KeyedStateReadTransaction): KeyedStateReadTransaction => ({
        ...tx,
        read_entry(entryPath) {
            counts.reads += 1;
            return tx.read_entry(entryPath);
        },
    });
    return {
        counts,
        persistence: {
            ...persistence,
            read_transaction: (body) => persistence.read_transaction((tx) => body(wrap(tx))),
            write_transaction: (kind, body) => persistence.write_transaction(kind, (tx) => body({
                ...tx,
                read_entry(entryPath) {
                    counts.reads += 1;
                    return tx.read_entry(entryPath);
                },
            })),
        } satisfies KeyedFileStatePersistence,
    };
}

/**
 * A pending-edit map of at least `MIN_PENDING_EDIT_JSON_BYTES` of JSON.
 *
 * Keys are canonical `row:column` cell keys — the only shape
 * `decode_stored_per_file_state` accepts — and each entry carries the exact
 * `{ value, base }` pair the edit session persists, so this is a real map of the
 * kind a large paste produces rather than a synthetic blob.
 */
function large_pending_edits(): CsvDirtyMap {
    const edits: Record<string, { value: string; base: string }> = {};
    // Deterministic filler; the content is irrelevant, only its size is.
    const filler = 'x'.repeat(96);
    let bytes = 0;
    for (let row = 0; bytes < MIN_PENDING_EDIT_JSON_BYTES; row += 1) {
        for (let column = 0; column < 32; column += 1) {
            const key = `${row}:${column}`;
            const entry = {
                value: `${filler}-v-${row}-${column}`,
                base: `${filler}-b-${row}-${column}`,
            };
            edits[key] = entry;
            bytes += key.length + entry.value.length + entry.base.length + 24;
        }
    }
    return Object.freeze(edits);
}

/** The pending-edit map of a stored state, which may be a legacy envelope. */
function pending_edits_of(state: StoredPerFileState): PerFileState['pendingEdits'] {
    return 'pendingEdits' in state ? state.pendingEdits : undefined;
}

beforeEach(async () => {
    tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-sqlite-perf-'));
    databases = [];
});

afterEach(async () => {
    await Promise.allSettled(databases.map((database) => database.close()));
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
});

describe('SQLite performance gates', () => {
    it('scans 10,000 entries without decoding a payload or issuing a per-entry statement', async () => {
        const database = freshDatabase();
        await database.initialize();
        const seedStarted = performance.now();
        seed_entries(database.databasePath, SCAN_ENTRY_COUNT);
        report('seed 10k entries', performance.now() - seedStarted, { entries: SCAN_ENTRY_COUNT });

        const runtime = await open_sqlite_runtime(database.databasePath, {
            identity: database.options.identity,
            clientKind: 'vitest',
            clientVersion: 'sqlite-performance',
        });
        try {
            // A tenth of the fixture becomes logically undecodable, so a scan
            // that decoded payloads would throw rather than merely be slow.
            corrupt_payloads(database.databasePath, SCAN_ENTRY_COUNT / 10);
            const started = performance.now();
            const measured = await runtime.read_transaction((tx) => {
                const watched = watch_payload_io(tx);
                const repository = create_sqlite_file_state_read_repository(watched.context, {
                    writerSessionId: runtime.writer_session_id,
                });
                const metadata = repository.scan_entry_metadata();
                return {
                    count: metadata.length,
                    statements: watched.statements(),
                    executions: watched.executions(),
                    returnedBytes: watched.returned_bytes(),
                    payloadRows: watched.payload_rows(),
                };
            });
            const elapsed = performance.now() - started;
            report('scan 10k entry metadata', elapsed, {
                entries: measured.count,
                statements: measured.statements,
                executions: measured.executions,
                returnedBytes: measured.returnedBytes,
            });

            expect(measured.count).toBe(SCAN_ENTRY_COUNT);
            // The gate: the scan pulls back metadata-sized rows, not payloads.
            // Any way of dragging the payload along — projected, aliased,
            // wildcarded, extracted by any path, or computed through a scalar
            // function — has to return the bytes to be worth doing, and lands
            // here. See `watch_payload_io` for the three text-matching predicates
            // this replaced and why each was evadable.
            expect(measured.returnedBytes).toBeLessThan(SCAN_RETURNED_BYTE_CEILING);
            // A second, narrower signal: the payload column arriving under its own
            // name. Redundant with the byte gate for every mutant tried so far,
            // and kept because it names the specific mistake in the failure output.
            expect(measured.payloadRows).toBe(0);
            // Constant round trips over a 10,000-row scan, and constant statements.
            // The execution count is the one that catches an N+1 loop; the
            // preparation count alone let one through. See MAX_SCAN_EXECUTIONS.
            expect(measured.executions).toBeLessThanOrEqual(MAX_SCAN_EXECUTIONS);
            expect(measured.statements).toBeLessThanOrEqual(MAX_SCAN_STATEMENTS);
            // Recorded, not budgeted — see SCAN_WALL_CLOCK_CEILING_MS.
            expect(elapsed).toBeLessThan(SCAN_WALL_CLOCK_CEILING_MS);
        } finally {
            await runtime.close();
        }
    });

    // The single-entry counterpart of the scan gate, measured the same way and for
    // the same reason: an authority read that quietly dragged the payload along
    // would be invisible to a decode counter on the transaction port, because it
    // need never call `read_entry` to have already paid for the bytes.
    it('reads one entry\'s authority metadata without loading its payload', async () => {
        const database = freshDatabase();
        await database.initialize();
        seed_entries(database.databasePath, SCAN_ENTRY_COUNT);

        const runtime = await open_sqlite_runtime(database.databasePath, {
            identity: database.options.identity,
            clientKind: 'vitest',
            clientVersion: 'sqlite-performance',
        });
        try {
            corrupt_payloads(database.databasePath, SCAN_ENTRY_COUNT / 10);
            const measured = await runtime.read_transaction((tx) => {
                const watched = watch_payload_io(tx);
                const repository = create_sqlite_file_state_read_repository(watched.context, {
                    writerSessionId: runtime.writer_session_id,
                });
                const metadata = repository.read_entry_metadata(SCAN_DIRTY_ENTRY_PATH);
                return {
                    found: metadata !== undefined,
                    hasPendingEdits: metadata?.hasPendingEdits,
                    returnedBytes: watched.returned_bytes(),
                    payloadRows: watched.payload_rows(),
                };
            });

            expect(measured.found).toBe(true);
            // The precondition, asserted rather than assumed: this entry really
            // does hold a `pendingEdits` map, so "did not load the payload" is a
            // claim about bytes that were available to load. The flag itself is a
            // metadata column, which is exactly why reading it is cheap.
            expect(measured.hasPendingEdits).toBe(true);
            // One metadata row is a few hundred bytes; this entry's payload is
            // over a kilobyte once its pending-edit map is included. The ceiling
            // sits between the two, from the same measurement as the scan gate's.
            expect(measured.returnedBytes).toBeLessThan(SINGLE_ENTRY_RETURNED_BYTE_CEILING);
            expect(measured.payloadRows).toBe(0);
        } finally {
            await runtime.close();
        }
    });

    it('reads scanned metadata through the store without touching entry payloads', async () => {
        const database = freshDatabase();
        await database.initialize();
        seed_entries(database.databasePath, SCAN_ENTRY_COUNT);

        const persistence = await database.openPersistence();
        corrupt_payloads(database.databasePath, SCAN_ENTRY_COUNT / 10);
        const instrumented = count_payload_reads(persistence);
        // A max above the fixture size: retention is a separate concern, and
        // evicting mid-measurement would make this a test of the eviction path.
        const store = create_keyed_authority_store(
            instrumented.persistence,
            () => SCAN_ENTRY_COUNT * 2,
        );

        const started = performance.now();
        const authority = await store.read_authority(SCAN_DIRTY_ENTRY_PATH);
        const elapsed = performance.now() - started;
        report('metadata-only authority read over 10k entries', elapsed);

        expect(authority.commitSequence).toBe(0);
        // The store-path half: `read_authority` reaches for metadata and never
        // asks the transaction for a complete entry. Deliberately kept alongside
        // the SQL-level gate above rather than replaced by it — this one is about
        // which port the store calls, that one about what the call costs, and a
        // regression can be either.
        expect(instrumented.counts.reads).toBe(0);
    });

    it('commits a multi-megabyte pending-edit map durably under synchronous=FULL', async () => {
        const database = freshDatabase();
        await database.initialize();
        const pendingEdits = large_pending_edits();
        const payloadBytes = JSON.stringify(pendingEdits).length;
        expect(payloadBytes).toBeGreaterThanOrEqual(MIN_PENDING_EDIT_JSON_BYTES);

        const opened = await open_sqlite_file_state_store(
            database.databasePath,
            database.options,
        );
        let committedRevision: number;
        try {
            // The durability policy this gate is *named* for, read off the store's
            // own connection rather than assumed — and this gate used to assume
            // half of it. It checked `journal_mode` only, so setting
            // `PRAGMA synchronous = OFF` in the runtime left the "commits durably
            // under synchronous=FULL" test green.
            //
            // Both pragmas are read through a runtime handle on the *same* path,
            // which `open_sqlite_runtime` interns — so this is the very connection
            // the CAS below commits on, not a lookalike. That matters because the
            // two pragmas differ in kind: `journal_mode` is a durable property of
            // the file, but `synchronous` is per-connection and is *not* stored
            // anywhere. A fresh handle reports its own setting, and since SQLite's
            // own default is already FULL, asserting it on a separate connection
            // would pass no matter what the store did — a green check that is not
            // about its subject. Verified: this reads 2 with the runtime's PRAGMA
            // in place and 0 when it is set to OFF.
            const durability = await open_sqlite_runtime(database.databasePath, {
                identity: database.options.identity,
                clientKind: DURABILITY_PROBE_CLIENT,
                clientVersion: 'sqlite-performance',
            });
            try {
                const pragmas = await durability.read_transaction((tx) => ({
                    journalMode: tx.prepare('PRAGMA journal_mode').get()?.journal_mode,
                    // 2 is FULL; SQLite answers these numerically, and the runtime
                    // reads integers as bigints (see `SqliteReadTransactionContext`).
                    synchronous: Number(tx.prepare('PRAGMA synchronous').get()?.synchronous),
                }));
                expect(pragmas.journalMode).toBe('delete');
                expect(pragmas.synchronous).toBe(2);
            } finally {
                await durability.close();
            }

            const started = performance.now();
            const result = await opened.store.compare_and_set('/large-pending.csv', 0, {
                activeSheetIndex: 0,
                pendingEdits: { ...pendingEdits },
            });
            const elapsed = performance.now() - started;
            report('FULL-sync CAS of a large pending-edit map', elapsed, {
                cells: Object.keys(pendingEdits).length,
                payloadBytes,
            });
            expect(elapsed).toBeLessThan(PENDING_EDIT_WALL_CLOCK_CEILING_MS);

            if (result.type !== 'committed') throw new Error('large pending-edit CAS was refused');
            committedRevision = result.snapshot.revision;
            // Derived, not supplied: the store is what decides an entry holds
            // unsaved work, and the schema's CHECK enforces the pair.
            expect(pending_edits_of(result.snapshot.state)).toEqual(pendingEdits);
        } finally {
            await opened.close();
        }

        // A *fresh* store over a connection that has never seen the in-memory
        // value: this is the read-back that makes the commit durable rather than
        // merely returned. No rollback journal survives a clean close under
        // `journal_mode = DELETE`, so the bytes below came from the main file.
        expect(fs.existsSync(`${database.databasePath}-journal`)).toBe(false);
        const reopenStarted = performance.now();
        const reopened = await open_sqlite_file_state_store(
            database.databasePath,
            database.options,
        );
        try {
            const snapshot = await reopened.store.read('/large-pending.csv');
            report('reopen and read back the large map', performance.now() - reopenStarted, {
                cells: Object.keys(pendingEdits).length,
            });
            expect(snapshot.revision).toBe(committedRevision);
            // Exact, not merely present: a pending-edit map is unsaved user work,
            // and a lossy round trip through a multi-megabyte payload is the
            // failure this gate is here to catch.
            expect(pending_edits_of(snapshot.state)).toEqual(pendingEdits);
        } finally {
            await reopened.close();
        }
    });
}, PERFORMANCE_TEST_TIMEOUT_MS);
