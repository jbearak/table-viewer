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

    // The buttons are static markup, so their presence alone would also pass with
    // the renderer dead. Check that it ran: the preload API is exposed, and the
    // theme it applies has reached the document.
    expect(await page.evaluate(
        () => typeof (window as { welcomeApi?: { open_files?: unknown } })
            .welcomeApi?.open_files,
    )).toBe('function');
    expect(await page.evaluate(
        () => document.documentElement.style.getPropertyValue('--welcome-bg'),
    )).not.toBe('');
});

// Proves the renderer's click handlers are wired, which the assertions above
// cannot: Preferences… is the one button whose effect is observable without a
// native file dialog.
test('the launcher opens Preferences', async () => {
    const page = welcome_pages()[0];
    await page.getByRole('button', { name: 'Preferences…' }).click();
    await expect
        .poll(() => app.windows().filter((entry) => entry.url().endsWith('prefs.html')).length,
            { timeout: 15_000 })
        .toBe(1);

    await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
            .find((window) => window.getTitle().includes('Preferences'))
            ?.close();
    });
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
});

// The new-window-size mode is the one preference whose two states change what
// the *other* controls do, so the enable/disable wiring is worth a real run.
test('the new-window-size mode enables the size fields and persists', async () => {
    await welcome_pages()[0].getByRole('button', { name: 'Preferences…' }).click();
    let prefs: import('@playwright/test').Page | undefined;
    await expect.poll(
        () => (prefs = app.windows().find((entry) => entry.url().endsWith('prefs.html'))),
        { timeout: 15_000 },
    ).toBeTruthy();
    const page = prefs!;
    await page.waitForSelector('#newWindowSize');

    // Default: tracked by the app, so the numbers are a readout, not fields.
    await expect(page.locator('#newWindowSize')).toHaveValue('match-last');
    await expect(page.locator('#windowWidth')).toBeDisabled();
    await expect(page.locator('#windowHeight')).toBeDisabled();

    await page.selectOption('#newWindowSize', 'fixed');
    await expect(page.locator('#windowWidth')).toBeEnabled();
    await page.fill('#windowWidth', '1440');
    await page.locator('#windowWidth').blur();
    // Below the usable minimum: the store raises it and the field shows what it
    // settled on rather than what was typed.
    await page.fill('#windowHeight', '50');
    await page.locator('#windowHeight').blur();
    await expect(page.locator('#windowHeight')).toHaveValue('320');

    await expect.poll(() => {
        const file = path.join(user_data_dir, 'settings.v1.json');
        if (!fs.existsSync(file)) return null;
        const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
        return [settings.newWindowSize, settings.windowWidth, settings.windowHeight];
    }, { timeout: 15_000 }).toEqual(['fixed', 1440, 320]);

    // Leave the store as the other tests expect to find it.
    await page.selectOption('#newWindowSize', 'match-last');
    await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
            .find((window) => window.getTitle().includes('Preferences'))
            ?.close();
    });
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
});

test('File → New Window opens another launcher', async () => {
    await click_menu_item(app, 'File', 'New Window');
    await expect.poll(() => welcome_pages().length, { timeout: 15_000 }).toBe(2);

    // Each is an independent top-level window, so closing one leaves the other.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[1].close());
    await expect.poll(() => welcome_pages().length, { timeout: 15_000 }).toBe(1);
});
