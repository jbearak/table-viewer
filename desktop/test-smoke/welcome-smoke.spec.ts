// Smoke test for the launcher: with no file to open the app shows a welcome
// window, and File → New Window opens another one. Launched separately from
// desktop-smoke.spec.ts because the file arguments are what differ.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { click_menu_item, main_js, repo_dir } from './smoke-helpers';

let app: ElectronApplication;
let user_data_dir: string;

function welcome_pages() {
    return app.windows().filter((page) => page.url().endsWith('welcome.html'));
}

test.beforeAll(async () => {
    expect(fs.existsSync(main_js), 'run npm run bundle:desktop first').toBe(true);
    user_data_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-welcome-smoke-'));
    app = await electron.launch({
        args: [main_js],
        cwd: repo_dir,
        env: { ...process.env, TABLE_VIEWER_USER_DATA_DIR: user_data_dir },
    });
    await expect.poll(() => welcome_pages().length, { timeout: 30_000 }).toBe(1);
});

test.afterAll(async () => {
    await app?.close();
    if (user_data_dir) fs.rmSync(user_data_dir, { recursive: true, force: true });
});

test('launching with no file shows the launcher', async () => {
    const page = welcome_pages()[0];
    await expect(page.getByRole('button', { name: 'Open File…' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preferences…' })).toBeVisible();
    expect(app.windows()).toHaveLength(1);
});

test('File → New Window opens another launcher', async () => {
    await click_menu_item(app, 'File', 'New Window');
    await expect.poll(() => welcome_pages().length, { timeout: 15_000 }).toBe(2);

    // Each is an independent top-level window, so closing one leaves the other.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[1].close());
    await expect.poll(() => welcome_pages().length, { timeout: 15_000 }).toBe(1);
});
