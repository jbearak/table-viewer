// Smoke test for `~` paths in the Compare Files… dialog.
//
// The fixtures go in a temp directory inside the app's real home, removed in
// afterAll. Pointing HOME at a temp directory instead does not work:
// `app.getPath('home')` is a native call that ignores the environment, so the
// dialog's own validation would fail to expand too and the test would prove
// nothing about submission.
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { click_menu_item, isolated_user_data, launch_app } from './smoke-helpers';

const GRID_CANVAS = '[data-testid="data-grid-canvas"]';
const VIEWER_URL_PREFIX = 'tv-app://viewer';

let app: ElectronApplication;
let user_data_dir: string;
let home_dir: string;
/** The `~/…` prefix the fixtures live under, e.g. `~/tv-tilde-smoke-ab12`. */
let tilde_dir: string;

const compare_dialog = (): Page | undefined =>
    app.windows().find((page) => page.url().endsWith('compare.html'));

const viewer_pages = (): Page[] =>
    app.windows().filter((page) => page.url().startsWith(VIEWER_URL_PREFIX));

test.beforeAll(async () => {
    user_data_dir = isolated_user_data('tv-compare-tilde-');
    app = await launch_app(user_data_dir);
    const real_home = await app.evaluate(({ app: electron_app }) =>
        electron_app.getPath('home'));
    home_dir = fs.mkdtempSync(path.join(real_home, 'tv-tilde-smoke-'));
    tilde_dir = `~/${path.basename(home_dir)}`;
    fs.writeFileSync(path.join(home_dir, 'before.csv'), 'Region,Units\nNorth,10\n');
    fs.writeFileSync(path.join(home_dir, 'after.csv'), 'Region,Units\nNorth,11\n');
    await expect
        .poll(() => app.windows().filter((page) => page.url().endsWith('welcome.html')).length,
            { timeout: 30_000 })
        .toBe(1);
});

test.afterAll(async () => {
    await app?.close();
    if (user_data_dir) fs.rmSync(user_data_dir, { recursive: true, force: true });
    if (home_dir) fs.rmSync(home_dir, { recursive: true, force: true });
});

test('a comparison typed with ~ opens the files it validated', async () => {
    // The dialog validates against the expanded path, so `~/before.csv`
    // enables Compare. Submitting used to pass the raw string on, opening a
    // window for a literal `~` directory under the process working directory:
    // a file the user had just been told exists, failing to load.
    await click_menu_item(app, 'File', 'Compare Files…');
    await expect.poll(compare_dialog, { timeout: 15_000 }).toBeTruthy();
    const dialog = compare_dialog()!;
    await dialog.fill('#originalPath', `${tilde_dir}/before.csv`);
    await dialog.fill('#modifiedPath', `${tilde_dir}/after.csv`);
    const compare_button = dialog.locator('#compare');
    await expect(compare_button).toBeEnabled();
    await compare_button.click();

    await expect.poll(() => viewer_pages().length, { timeout: 30_000 }).toBe(1);
    const page = viewer_pages()[0];
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
    // Loaded, and loaded as a comparison: the one edited cell is found.
    await expect(page.locator('.compare-strip-counts')).toContainText('1 changed cell');
});
