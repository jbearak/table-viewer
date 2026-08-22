// Smoke test for File → Compare Files…: the dialog opens, takes two paths,
// and produces one read-only comparison window whose grid reports what the
// alignment found. Launched separately from desktop-smoke.spec.ts because it
// starts from the launcher (no file arguments) rather than from open files.
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { click_menu_item, isolated_user_data, launch_app } from './smoke-helpers';

const GRID_CANVAS = '[data-testid="data-grid-canvas"]';
const VIEWER_URL_PREFIX = 'tv-app://viewer';

// A row inserted in the middle, one cell edited, and one row deleted. The
// insertion is the point: compared by position it would make every row below
// it look changed, and the counts below are what proves it did not.
const ORIGINAL = 'Region,Units\nNorth,10\nSouth,20\nEast,30\nWest,40\n';
const MODIFIED = 'Region,Units\nNorth,10\nCentral,15\nSouth,21\nEast,30\n';

let app: ElectronApplication;
let user_data_dir: string;
let work_dir: string;
let original_path: string;
let modified_path: string;

const compare_dialog = (): Page | undefined =>
    app.windows().find((page) => page.url().endsWith('compare.html'));

const viewer_pages = (): Page[] =>
    app.windows().filter((page) => page.url().startsWith(VIEWER_URL_PREFIX));

const window_titles = (): Promise<string[]> =>
    app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => window.getTitle()));

test.beforeAll(async () => {
    user_data_dir = isolated_user_data('tv-compare-smoke-');
    work_dir = fs.mkdtempSync(path.join(user_data_dir, 'files-'));
    original_path = path.join(work_dir, 'before.csv');
    modified_path = path.join(work_dir, 'after.csv');
    fs.writeFileSync(original_path, ORIGINAL);
    fs.writeFileSync(modified_path, MODIFIED);
    app = await launch_app(user_data_dir);
    await expect
        .poll(() => app.windows().filter((page) => page.url().endsWith('welcome.html')).length,
            { timeout: 30_000 })
        .toBe(1);
});

test.afterAll(async () => {
    await app?.close();
    if (user_data_dir) fs.rmSync(user_data_dir, { recursive: true, force: true });
});

test('File → Compare Files… opens one read-only comparison window', async () => {
    await click_menu_item(app, 'File', 'Compare Files…');
    await expect.poll(compare_dialog, { timeout: 15_000 }).toBeTruthy();
    const dialog = compare_dialog()!;

    // Typed rather than browsed: the Browse… buttons open a native dialog,
    // which Playwright cannot drive.
    await dialog.fill('#originalPath', original_path);
    await dialog.fill('#modifiedPath', modified_path);
    const compare_button = dialog.locator('#compare');
    await expect(compare_button).toBeEnabled();
    await compare_button.click();

    await expect.poll(() => viewer_pages().length, { timeout: 30_000 }).toBe(1);
    const page = viewer_pages()[0];
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });

    // The dialog closes behind the comparison rather than lingering.
    await expect.poll(compare_dialog, { timeout: 15_000 }).toBeFalsy();
    // Both file names, so the window list says what is being compared.
    await expect
        .poll(async () => (await window_titles()).some((title) =>
            title.includes('before.csv') && title.includes('after.csv')))
        .toBe(true);
    // Read-only: a comparison has no working-tree file to write back to.
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('the comparison counts an inserted row as one addition', async () => {
    const page = viewer_pages()[0];
    const strip = page.locator('.compare-strip-counts');
    await expect(strip).toBeVisible();
    // Positionally the inserted "Central" row would make every row below it
    // look changed; aligned, it is one addition, one deletion, one changed cell.
    await expect(strip).toContainText('1 row added');
    await expect(strip).toContainText('1 row deleted');
    await expect(strip).toContainText('1 changed cell');
});

test('Only changed rows hides the rows that did not change', async () => {
    const page = viewer_pages()[0];
    const toggle = page.locator('.compare-strip-toggle');
    // Unchanged rows exist to hide: North and East match on both sides.
    await expect(page.locator('#glide-cell-1-3')).toBeAttached();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // Three rows survive — the addition, the deletion, and the edit — so the
    // fourth display row is gone.
    await expect(page.locator('#glide-cell-1-3')).toHaveCount(0);
    await expect(page.locator('#glide-cell-1-2')).toBeAttached();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#glide-cell-1-3')).toBeAttached();
});
