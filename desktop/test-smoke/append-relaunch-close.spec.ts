// Regression gate for the unsafe-close dialog on restored structural state.
//
// The scenario a user actually hit: stage appended rows (never save), lose the
// process to a force quit, relaunch, and close the window without touching
// anything. The durable pending rows are rehydrated on relaunch, the close
// fence republishes them for acknowledgment, and any silent drop on that
// republication path times the fence out into "Table Viewer could not safely
// close this window" — forever, because the durable rows come back on every
// launch. This spec pins the whole seam: persist → SIGKILL → hydrate → close.
//
// Every wait polls an observable (the grid, the database bytes, the window
// count), never a delay, per the suite's rules.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
    isolated_user_data,
    launch_app,
    repo_dir,
    state_database_path,
} from './smoke-helpers';

const VIEWER_URL_PREFIX = 'tv-app://viewer';
const GRID_CANVAS = '[data-testid="data-grid-canvas"]';
const fixture = path.join(repo_dir, 'docs', 'examples', 'garden-cafe-sample.xlsx');

/** Main-process console output, for naming the drop path when the gate fails. */
function capture_output(app: ElectronApplication): () => string {
    const chunks: string[] = [];
    app.process().stdout?.on('data', (chunk) => chunks.push(String(chunk)));
    app.process().stderr?.on('data', (chunk) => chunks.push(String(chunk)));
    return () => chunks.join('');
}

async function viewer_page(app: ElectronApplication): Promise<Page> {
    const pages = () => app.windows().filter((page) =>
        page.url().startsWith(VIEWER_URL_PREFIX));
    await expect.poll(() => pages().length, { timeout: 30_000 }).toBe(1);
    const page = pages()[0];
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
    return page;
}

/** Capture every message dialog instead of showing it, so an unexpected
 *  unsafe-close dialog is an assertable value rather than a stuck window. */
async function install_dialog_capture(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ dialog }) => {
        const main = globalThis as typeof globalThis & {
            __tableViewerSmokeDialogs?: Array<{ message?: string }>;
        };
        main.__tableViewerSmokeDialogs = [];
        const replacement = async (...args: unknown[]) => {
            const options = (args.length === 1 ? args[0] : args[1]) as {
                message?: string;
            };
            main.__tableViewerSmokeDialogs?.push({ message: options.message });
            return { response: 0, checkboxChecked: false };
        };
        dialog.showMessageBox = replacement as typeof dialog.showMessageBox;
    });
}

async function take_dialogs(app: ElectronApplication): Promise<Array<{ message?: string }>> {
    return app.evaluate(() => {
        const main = globalThis as typeof globalThis & {
            __tableViewerSmokeDialogs?: Array<{ message?: string }>;
        };
        return main.__tableViewerSmokeDialogs?.splice(0) ?? [];
    });
}

/** Whether the durable store already holds staged appended rows. Read as
 *  bytes: the pending-changes JSON is stored inline in the SQLite page data,
 *  so the row ids' distinctive prefix appearing is the persistence signal
 *  without linking the app's own SQLite stack into the test. */
function durable_appended_rows_present(user_data_dir: string): boolean {
    try {
        return fs.readFileSync(state_database_path(user_data_dir))
            .includes('append-row:');
    } catch {
        return false;
    }
}

async function force_terminate(app: ElectronApplication): Promise<void> {
    const process_handle = app.process();
    process_handle.kill('SIGKILL');
    await expect
        .poll(() => process_handle.exitCode !== null || process_handle.signalCode !== null,
            { timeout: 30_000 })
        .toBe(true);
}

test('a window with force-quit-surviving pending rows closes cleanly after relaunch', async () => {
    test.setTimeout(240_000);
    const test_root = isolated_user_data('tv-append-relaunch-close-');
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir);
    const workbook_path = path.join(test_root, 'garden-cafe-sample.xlsx');
    fs.copyFileSync(fixture, workbook_path);

    try {
        // --- First launch: stage rows, never save, die hard. -----------------
        const first = await launch_app(user_data_dir, [workbook_path]);
        let killed = false;
        try {
            const page = await viewer_page(first);
            const edit_toggle = page.getByRole('button', { name: 'Edit' });
            await edit_toggle.click();
            await expect(edit_toggle).toHaveAttribute('aria-pressed', 'true');
            const rows = page.locator('tbody tr');
            // The accessibility rows mount after the toggle flips; counting
            // before they exist would record 0 and misread the append below.
            await expect.poll(() => rows.count(), { timeout: 30_000 })
                .toBeGreaterThan(0);
            const before = await rows.count();

            await page.getByRole('button', { name: 'Add rows' }).click();
            await page.getByRole('button', { name: 'Add row', exact: true }).click();
            await expect(rows).toHaveCount(before + 1);

            // The staged row is durable once its id reaches the database; the
            // grid showing it only proves the renderer's word.
            await expect
                .poll(() => durable_appended_rows_present(user_data_dir), { timeout: 30_000 })
                .toBe(true);

            await force_terminate(first);
            killed = true;
        } finally {
            if (!killed) await first.close().catch(() => {});
        }

        // --- Second launch: hydrate, then close without touching anything. ---
        const second = await launch_app(user_data_dir, [workbook_path]);
        const output_of_second = capture_output(second);
        try {
            const page = await viewer_page(second);
            // The pending row hydrated: edit mode restores as dirty.
            const edit_toggle = page.getByRole('button', { name: 'Edit' });
            await expect(edit_toggle).toHaveClass(/has-unsaved/, { timeout: 30_000 });
            await install_dialog_capture(second);

            // Native close, exactly as the traffic-light button would.
            await second.evaluate(({ BrowserWindow }) => {
                for (const window of BrowserWindow.getAllWindows()) window.close();
            });

            // The gate: the window actually goes away. On the bug, the close
            // fence times out, the unsafe-close dialog fires, and the window
            // stays; the main-process output then names the drop path.
            await expect
                .poll(async () => ({
                    viewers: second.windows().filter((candidate) =>
                        candidate.url().startsWith(VIEWER_URL_PREFIX)).length,
                    dialogs: await take_dialogs(second).catch(() => []),
                }), { timeout: 90_000 })
                .toEqual({ viewers: 0, dialogs: [] })
                .catch((error: unknown) => {
                    throw new Error(
                        `${String(error)}\n\nmain-process output:\n${output_of_second()}`,
                    );
                });
        } finally {
            await second.evaluate(({ app: electron_app }) => electron_app.exit(0))
                .catch(() => {});
            await second.close().catch(() => {});
        }
    } finally {
        fs.rmSync(test_root, { recursive: true, force: true });
    }
});
