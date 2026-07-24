// Smoke test for the standalone desktop app: launches the built Electron
// bundle (dist/desktop/main.js) with a csv and an xlsx fixture, asserts each
// viewer tab renders the data grid, and exercises one interaction (sort).
//
// Each viewer tab is a WebContentsView; Playwright surfaces its webContents as
// an additional "window" page alongside the shell window.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const repo_dir = path.resolve(__dirname, '..', '..');
const main_js = path.join(repo_dir, 'dist', 'desktop', 'main.js');
const csv_fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.csv');
const xlsx_fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx');

const VIEWER_URL_PREFIX = 'tv-app://viewer';
const GRID_CANVAS = '[data-testid="data-grid-canvas"]';

let app: ElectronApplication;
let user_data_dir: string;

function viewer_pages(): Page[] {
    return app.windows().filter((page) => page.url().startsWith(VIEWER_URL_PREFIX));
}

test.beforeAll(async () => {
    expect(fs.existsSync(main_js), 'run npm run bundle:desktop first').toBe(true);
    user_data_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-smoke-'));
    app = await electron.launch({
        args: [main_js, csv_fixture, xlsx_fixture],
        cwd: repo_dir,
        env: {
            ...process.env,
            TABLE_VIEWER_USER_DATA_DIR: user_data_dir,
        },
    });
});

test.afterAll(async () => {
    await app?.close();
    if (user_data_dir) fs.rmSync(user_data_dir, { recursive: true, force: true });
});

test('opens csv and xlsx tabs and renders both grids', async () => {
    // One viewer page per opened file (plus the shell window).
    await expect.poll(() => viewer_pages().length, { timeout: 30_000 }).toBe(2);

    for (const page of viewer_pages()) {
        await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
    }

    // The shell tab bar knows both files by name.
    const shell = app.windows().find((page) => !page.url().startsWith(VIEWER_URL_PREFIX));
    expect(shell).toBeTruthy();
    await expect(shell!.getByText('basic.csv')).toBeVisible();
    await expect(shell!.getByText('basic.xlsx')).toBeVisible();
});

test('sorting a column shows a sort chip', async () => {
    // Activate the csv tab in the shell so its WebContentsView is the visible,
    // focusable one (the xlsx tab, opened last, is active on startup).
    const shell = app.windows().find((entry) => !entry.url().startsWith(VIEWER_URL_PREFIX));
    expect(shell).toBeTruthy();
    await shell!.locator('.tab', { hasText: 'basic.csv' }).click();

    // The csv viewer is the page whose toolbar offers the Edit toggle
    // (Excel viewers have no edit mode).
    let page: Page | undefined;
    await expect
        .poll(async () => {
            for (const candidate of viewer_pages()) {
                if ((await candidate.getByRole('button', { name: 'Edit' }).count()) > 0) {
                    page = candidate;
                    return true;
                }
            }
            return false;
        }, { timeout: 15_000 })
        .toBe(true);

    const canvas = page!.locator(GRID_CANVAS).first();
    await canvas.waitFor({ state: 'visible' });

    // Focus a data cell (past the row-marker gutter and the header row), then
    // sort the focused column ascending via the keyboard shortcut. Glide
    // overlays a scroller element on the canvas, so click via raw coordinates.
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    await page!.mouse.click(
        box!.x + Math.min(140, box!.width - 10),
        box!.y + Math.min(60, box!.height - 10),
    );
    await page!.keyboard.press('Shift+Alt+A');

    await expect(page!.locator('.sort-strip .sort-chip')).toHaveCount(1);

    // Clear the sort again (via the sort strip's clear button) so the
    // persisted per-file state stays clean.
    await page!.locator('.sort-strip-clear').click();
    await expect(page!.locator('.sort-strip .sort-chip')).toHaveCount(0);
});
