// Smoke test for the launcher: with no file to open the app shows a welcome
// window, and File → New Window opens another one. Launched separately from
// desktop-smoke.spec.ts because the file arguments are what differ.
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import {
    click_menu_item,
    close_preferences,
    isolated_user_data,
    launch_app,
    reader_tokens,
    state_database_path,
} from './smoke-helpers';

let app: ElectronApplication;
let user_data_dir: string;

function welcome_pages() {
    return app.windows().filter((page) => page.url().endsWith('welcome.html'));
}

test.beforeAll(async () => {
    user_data_dir = isolated_user_data('tv-welcome-smoke-');
    app = await launch_app(user_data_dir);
    await expect.poll(() => welcome_pages().length, { timeout: 30_000 }).toBe(1);
});

test.afterAll(async () => {
    await app?.close();
    if (user_data_dir) fs.rmSync(user_data_dir, { recursive: true, force: true });
});

test('launching with no file shows the launcher', async () => {
    const page = welcome_pages()[0];
    await expect(page.getByRole('button', { name: 'Open File…' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compare Files…' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preferences…' })).toBeVisible();
    // Nothing has been opened under this isolated userData directory, so the
    // Recent rail has nothing to show and must stay out of the way.
    await expect(page.locator('#recent')).toBeHidden();
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

// Compare Files… is why the launcher has a Recent rail and a third button at
// all: the feature was previously reachable only from the File menu. Its dialog
// is observable without a native file picker, exactly as Preferences is.
test('the launcher opens the Compare Files dialog', async () => {
    const page = welcome_pages()[0];
    await page.getByRole('button', { name: 'Compare Files…' }).click();
    await expect
        .poll(() => app.windows().filter((entry) => entry.url().endsWith('compare.html')).length,
            { timeout: 15_000 })
        .toBe(1);

    await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
            .find((window) => window.getTitle().includes('Compare'))
            ?.close();
    });
    // The launcher is still there: only the dialog went away. It steps aside
    // when a comparison actually opens, which is not what happened here.
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
});

// The Recent rail, end to end: opening a file has to reach the store, and a
// launcher opened afterwards has to render it. Its own app with its own
// userData, because every other test in this file asserts against an empty
// rail and a shared launcher window.
test('the Recent rail lists a file this app opened', async () => {
    const own_user_data = isolated_user_data('tv-recent-smoke-');
    const work_dir = fs.mkdtempSync(path.join(own_user_data, 'files-'));
    const csv_path = path.join(work_dir, 'survey.csv');
    fs.writeFileSync(csv_path, 'Region,Units\nNorth,10\n');
    const own_app = await launch_app(own_user_data, [csv_path]);
    try {
        // The file's own viewer window, which is what writes the entry.
        await expect
            .poll(
                () => own_app.windows().filter((page) => page.url().startsWith('tv-app://viewer'))
                    .length,
                { timeout: 30_000 },
            )
            .toBe(1);
        // The store is written by the open, not by the launcher's render.
        await expect
            .poll(
                () => {
                    const file = path.join(own_user_data, 'recent-documents.json');
                    if (!fs.existsSync(file)) return null;
                    return JSON.parse(fs.readFileSync(file, 'utf8'));
                },
                { timeout: 30_000 },
            )
            .toEqual([{ kind: 'file', path: csv_path, openedAt: expect.any(Number) }]);

        await click_menu_item(own_app, 'File', 'New Window');
        let launcher: import('@playwright/test').Page | undefined;
        await expect.poll(
            () => (launcher = own_app.windows()
                .find((page) => page.url().endsWith('welcome.html'))),
            { timeout: 15_000 },
        ).toBeTruthy();

        const rail = launcher!.locator('#recent');
        await expect(rail).toBeVisible();
        await expect(rail.locator('.recent-entry')).toHaveCount(1);
        await expect(rail.locator('.recent-entry .name')).toHaveText('survey.csv');
        // The row is the real thing, not a label: clicking it routes through the
        // same open path as everything else, so the launcher steps aside. This
        // file is already open, so that path focuses the window it is in rather
        // than making a second one — the launcher closing is the signal.
        await rail.locator('.recent-entry').click();
        await expect
            .poll(
                () => own_app.windows().filter((page) => page.url().endsWith('welcome.html'))
                    .length,
                { timeout: 15_000 },
            )
            .toBe(0);
    } finally {
        await own_app.close().catch(() => {
            // Already gone.
        });
        fs.rmSync(own_user_data, { recursive: true, force: true });
    }
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
        const file = path.join(user_data_dir, 'settings.json');
        if (!fs.existsSync(file)) return null;
        const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
        return [settings.newWindowSize, settings.windowWidth, settings.windowHeight];
    }, { timeout: 15_000 }).toEqual(['fixed', 1440, 320]);

    // Leave the store as the other tests expect to find it.
    await page.selectOption('#newWindowSize', 'match-last');
    await close_preferences(app);
    // The launcher is still there: only Preferences went away.
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
});

test('File → New Window opens another launcher', async () => {
    await click_menu_item(app, 'File', 'New Window');
    await expect.poll(() => welcome_pages().length, { timeout: 15_000 }).toBe(2);

    // Each is an independent top-level window, so closing one leaves the other.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[1].close());
    await expect.poll(() => welcome_pages().length, { timeout: 15_000 }).toBe(1);
});

// Quitting from the launcher — no viewer window open at all — still has to drain
// and close the SQLite connection: the state backend holds a writer-session row
// and its leases whether or not a file is open.
//
// The observable signature is the shared reader token, not a journal. Under
// `journal_mode = DELETE` a rollback journal exists only for the duration of a
// write transaction, so an idle launcher-only session never has one at all — an
// absent-journal assertion would pass with the drain deleted outright, and pass
// after a hard kill too. The gate's reader token is the thing that actually
// distinguishes a clean close: `open_sqlite_file_state_store` writes a
// `<uuid>.reader` into `state/.file-state.sqlite3.recovery-gate/readers/` for the
// life of the connection (the gate layout is built by `gate_paths` in
// src/sqlite-open-recovery.ts), and only `close()` removes it. A killed process
// leaves it behind, where it becomes the residue that makes the next launch's
// recovery wait — which is precisely the outcome the drain exists to avoid.
//
// Its own short-lived app with its own userData rather than the shared one above:
// this test has to quit the app it is asserting about, and `afterAll` runs after
// every test in the file.
test('quitting drains and releases the state database reader token', async () => {
    const own_user_data = isolated_user_data('tv-quit-smoke-');
    const own_app = await launch_app(own_user_data);
    try {
        const database = state_database_path(own_user_data);
        // The launcher is up and the database is open with its token held, so the
        // release asserted below is about a clean shutdown rather than about
        // nothing having run.
        await expect
            .poll(
                () => own_app.windows().filter((page) => page.url().endsWith('welcome.html')).length,
                { timeout: 30_000 },
            )
            .toBe(1);
        await expect
            .poll(() => fs.existsSync(database), { timeout: 30_000 })
            .toBe(true);
        await expect
            .poll(() => reader_tokens(own_user_data).length, { timeout: 30_000 })
            .toBe(1);

        // The real quit path (before-quit → close fence → drain), not a window
        // close: `app.close()` alone would not exercise the guarded quit.
        const own_process = own_app.process();
        await own_app.evaluate(({ app }) => app.quit()).catch(() => {
            // The quit can tear the harness connection down before the call
            // resolves; the process and token assertions below are the signals.
        });
        // A released reader token alone is insufficient: the macOS double-Quit
        // regression drained successfully and closed its windows, but left a
        // windowless Electron process alive until the user chose Quit again.
        await expect
            .poll(
                () => own_process.exitCode !== null || own_process.signalCode !== null,
                { timeout: 30_000 },
            )
            .toBe(true);
        await expect
            .poll(() => reader_tokens(own_user_data), { timeout: 30_000 })
            .toEqual([]);
        // And the database itself is still there — a drain, never a delete.
        expect(fs.existsSync(database)).toBe(true);
    } finally {
        await own_app.close().catch(() => {
            // Already gone: app.quit() above is the expected way this app ends.
        });
        fs.rmSync(own_user_data, { recursive: true, force: true });
    }
});
