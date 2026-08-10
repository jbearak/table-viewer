// Packaged desktop relaunch gates (plan: "Packaged macOS/Windows clean relaunch
// and forced termination recover exact state under rollback journal").
//
// Each case launches twice over one userData directory. The clean cases prove
// that windows and view state survive a normal restart while vanished files are
// skipped; the killed case proves that a process that never got to run its
// shutdown leaves a database the next launch can open, under the rollback
// journal, without a recovery blockade and without any operator action.
//
// Each launch gets its own app but shares the directory, because the directory
// *is* the thing under test. Every wait is a poll on an observable — a window,
// a grid, a file — never a delay: the point of these gates is what survives a
// restart, and a fixed sleep would turn a slow launch into a green run that
// asserted nothing.
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
    hot_journal_present,
    isolated_user_data,
    launch_app,
    reader_tokens,
    recovery_residue,
    repo_dir,
    state_database_path,
} from './smoke-helpers';

const csv_fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.csv');
const VIEWER_URL_PREFIX = 'tv-app://viewer';
const GRID_CANVAS = '[data-testid="data-grid-canvas"]';

/** The viewer page of an app launched with exactly one file. */
async function viewer_page(app: ElectronApplication): Promise<Page> {
    const pages = () => app.windows().filter((page) => page.url().startsWith(VIEWER_URL_PREFIX));
    await expect.poll(() => pages().length, { timeout: 30_000 }).toBe(1);
    const page = pages()[0];
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
    return page;
}

/**
 * Click the grid cell at `offset` and wait for the grid to agree it is selected.
 *
 * The same two waits desktop-smoke.spec.ts uses, and for the same reason: the
 * grid is a canvas, so a click is a raw coordinate that only means a cell once
 * the row has laid out (`#glide-cell-<col>-<row>` exists) and only counts once
 * it is picked (`aria-selected`). Without both, the keystroke that follows goes
 * nowhere and the failure surfaces several assertions later.
 */
async function click_grid_cell(
    page: Page,
    cell: { column: number; row: number },
    offset: { x: number; y: number },
): Promise<void> {
    const target = page.locator(`#glide-cell-${cell.column}-${cell.row}`);
    await target.waitFor({ state: 'attached' });
    const box = (await page.locator(GRID_CANVAS).first().boundingBox())!;
    await page.mouse.click(box.x + offset.x, box.y + offset.y);
    await expect(target).toHaveAttribute('aria-selected', 'true');
}

/**
 * Produce one piece of durable view state: a sort on the first data column.
 *
 * A sort rather than an edit, deliberately. This CI gate isolates generic view
 * state and SQLite restart recovery from edit-session behavior, and a sort
 * exercises the same CAS, revision, and commit path without changing the fixture.
 */
async function apply_sort(page: Page): Promise<void> {
    await click_grid_cell(page, { column: 1, row: 0 }, { x: 120, y: 50 });
    await page.keyboard.press('Shift+Alt+A');
    await expect(page.locator('.sort-strip .sort-chip')).toHaveCount(1);
}

/**
 * Quit through the real before-quit → close fence → drain path, and wait until
 * both the process exits and this app's own connection is released.
 *
 * `remaining` is how many tokens legitimately survive the quit: zero normally,
 * and one after a launch was killed, because that launch's token is deliberately
 * never reclaimed without an explicit all-processes-closed attestation. A
 * released token is what "the connection was closed" looks like from outside the
 * process — the same signal welcome-smoke.spec.ts asserts on.
 */
async function quit_cleanly(
    app: ElectronApplication,
    user_data_dir: string,
    remaining = 0,
): Promise<void> {
    const process_handle = app.process();
    await app.evaluate(({ app: electron_app }) => electron_app.quit()).catch(() => {
        // The quit can tear the harness connection down before the call
        // resolves; the observable polls below are the real signals.
    });
    await expect
        .poll(() => process_handle.exitCode !== null || process_handle.signalCode !== null,
            { timeout: 30_000 })
        .toBe(true);
    await expect
        .poll(() => reader_tokens(user_data_dir).length, { timeout: 30_000 })
        .toBe(remaining);
}

/**
 * Kill the Electron process outright, the way a power loss or a Force Quit does.
 *
 * SIGKILL, not `app.close()` and not `app.quit()`: the whole point is that no
 * before-quit handler, no close fence, and no drain runs, so whatever the
 * database is left holding is left held.
 */
async function force_terminate(app: ElectronApplication): Promise<void> {
    const process_handle = app.process();
    process_handle.kill('SIGKILL');
    await expect
        .poll(() => process_handle.exitCode !== null || process_handle.signalCode !== null,
            { timeout: 30_000 })
        .toBe(true);
}

test.describe('desktop state relaunch gates', () => {
    let user_data_dir: string;

    test.beforeEach(() => {
        user_data_dir = isolated_user_data('tv-relaunch-smoke-');
    });

    test.afterEach(() => {
        if (user_data_dir) fs.rmSync(user_data_dir, { recursive: true, force: true });
    });

    test('a clean relaunch restores view state from the same user-data directory', async () => {
        const first = await launch_app(user_data_dir, [csv_fixture]);
        try {
            await apply_sort(await viewer_page(first));
            // Polled, not assumed: the sort is persisted through a CAS that the
            // renderer does not wait for, so the chip appearing above is the
            // renderer's word and the database is the durable one.
            await expect
                .poll(() => fs.existsSync(state_database_path(user_data_dir)), { timeout: 30_000 })
                .toBe(true);
            await quit_cleanly(first, user_data_dir);
        } finally {
            await first.close().catch(() => {
                // Already gone: the clean quit above is how this app ends.
            });
        }

        // A clean close under `journal_mode = DELETE` leaves no journal at all.
        expect(hot_journal_present(user_data_dir)).toBe(false);
        expect(recovery_residue(user_data_dir)).toEqual({
            exclusiveIntent: false,
            recoveryBlocked: false,
        });

        // No file argument: the viewer window itself is restored from the clean
        // quit above, along with the file's durable view state.
        const second = await launch_app(user_data_dir);
        try {
            const page = await viewer_page(second);
            // The state the first launch produced is on screen again, restored
            // from the database rather than recomputed: a fresh view of this
            // fixture is unsorted.
            await expect(page.locator('.sort-strip .sort-chip')).toHaveCount(1);
            // And exactly one live connection — the relaunch neither leaked the
            // previous one's token nor opened twice. Polled, not read once: the
            // grid painting and the main process writing its reader token are
            // separate paths, so on a slow launch the token can appear after
            // `viewer_page` resolves.
            await expect
                .poll(() => reader_tokens(user_data_dir).length, { timeout: 30_000 })
                .toBe(1);

            // Left clean for the next test, and so the sort does not persist into
            // an unrelated fixture run.
            await page.locator('.sort-strip-clear').click();
            await expect(page.locator('.sort-strip .sort-chip')).toHaveCount(0);
            await quit_cleanly(second, user_data_dir);
        } finally {
            await second.close().catch(() => {
                // Already gone.
            });
        }
    });

    test('a clean relaunch skips a restored file that no longer exists', async () => {
        const temporary_csv = path.join(user_data_dir, 'removed-after-quit.csv');
        fs.copyFileSync(csv_fixture, temporary_csv);
        const first = await launch_app(user_data_dir, [temporary_csv]);
        try {
            await viewer_page(first);
            await quit_cleanly(first, user_data_dir);
        } finally {
            await first.close().catch(() => {});
        }

        fs.rmSync(temporary_csv);
        const second = await launch_app(user_data_dir);
        try {
            await expect.poll(() => ({
                viewers: second.windows().filter(
                    (page) => page.url().startsWith(VIEWER_URL_PREFIX),
                ).length,
                launchers: second.windows().filter(
                    (page) => page.url().endsWith('welcome.html'),
                ).length,
            }), { timeout: 30_000 }).toEqual({ viewers: 0, launchers: 1 });
            await quit_cleanly(second, user_data_dir);
        } finally {
            await second.close().catch(() => {});
        }
    });

    test('a forced termination recovers under the rollback journal on the next launch', async () => {
        const first = await launch_app(user_data_dir, [csv_fixture]);
        let killed = false;
        try {
            await apply_sort(await viewer_page(first));
            await expect
                .poll(() => reader_tokens(user_data_dir).length, { timeout: 30_000 })
                .toBe(1);

            await force_terminate(first);
            killed = true;
        } finally {
            if (!killed) await first.close().catch(() => {});
        }

        // What a killed process leaves behind: its reader token, because only
        // `close()` removes one. Asserted rather than assumed, because it is the
        // precondition that makes the relaunch below a real recovery — if the
        // token were somehow already gone, the next launch would be opening a
        // database nobody had ever crashed on.
        expect(reader_tokens(user_data_dir)).toHaveLength(1);
        // A crash never claims a recovery: an exclusive intent or a blockade here
        // would mean a *recovery* was interrupted, which is a different condition
        // with a different (user-confirmed) resolution — and would make the next
        // launch refuse to open rather than recover.
        expect(recovery_residue(user_data_dir)).toEqual({
            exclusiveIntent: false,
            recoveryBlocked: false,
        });

        const second = await launch_app(user_data_dir, [csv_fixture]);
        try {
            // The gate: the app opens the crashed-on database and paints. Any
            // rollback journal the kill left is replayed by SQLite as part of that
            // open, so a visible grid *is* the recovery having succeeded.
            //
            // What this does NOT claim is that a hot journal was present. It usually
            // is not: `apply_sort` waits for the transform's terminal acknowledgement,
            // which is posted after the durable commit, and a DELETE-mode commit
            // removes its own journal — so the kill most often lands on an idle
            // connection. Racing the commit from up here would be a timing-dependent
            // GUI test, which is exactly the kind this suite refuses to write, and it
            // is unnecessary: the journal-replay property is proven deterministically
            // by `packaged-recovery-gate.mjs`'s `rollback_journal_gate`, which aborts
            // *inside* an open write transaction with a shrunken page cache and then
            // asserts the journal existed, that the main file grew, and that the
            // uncommitted mark and scratch table were both undone. That gate runs in
            // CI on every push.
            //
            // The property under test here is the complementary one, and it is
            // genuinely unproven anywhere else: the whole packaged startup path — the
            // reader gate, the connection, the drain, and whatever replay the open
            // performs — survives a SIGKILL and reaches a painted grid without
            // claiming a recovery it did not perform.
            const page = await viewer_page(second);
            // The crashed launch's token is still there and the relaunch opened
            // anyway. That combination is the design, not a leak: a shared reader
            // token never blocks another reader, and reclaiming it would mean
            // deciding by PID, age, or heartbeat that its process is gone — which
            // is precisely what would let a momentarily slow live peer have its
            // database recovered out from under it. It is cleared only by the
            // attested all-processes-closed recovery path.
            await expect
                .poll(() => reader_tokens(user_data_dir).length, { timeout: 30_000 })
                .toBe(2);
            // Inspect recovery residue only after the token proves that the database
            // open settled; a painted page alone can precede that token appearing.
            expect(hot_journal_present(user_data_dir)).toBe(false);
            expect(recovery_residue(user_data_dir)).toEqual({
                exclusiveIntent: false,
                recoveryBlocked: false,
            });
            // Committed state survived the kill: the sort was durable before the
            // process died, so it comes back.
            await expect(page.locator('.sort-strip .sort-chip')).toHaveCount(1);

            await page.locator('.sort-strip-clear').click();
            await expect(page.locator('.sort-strip .sort-chip')).toHaveCount(0);
            // One token left: this launch released its own, and the killed
            // launch's is retained for exactly the reason above.
            await quit_cleanly(second, user_data_dir, 1);
        } finally {
            await second.close().catch(() => {
                // Already gone.
            });
        }

        // No recovery was ever claimed and no journal survived, so a third launch
        // would open just as this one did.
        expect(recovery_residue(user_data_dir)).toEqual({
            exclusiveIntent: false,
            recoveryBlocked: false,
        });
        expect(hot_journal_present(user_data_dir)).toBe(false);
    });
});
