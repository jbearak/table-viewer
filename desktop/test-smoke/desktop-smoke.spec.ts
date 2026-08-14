// Smoke test for the standalone desktop app: launches the built Electron
// bundle (dist/desktop/main.js) with a csv and an xlsx fixture, asserts each
// file opened in its own window and rendered the data grid, and exercises
// editing and saving, sorting, and the Edit menu's grid-routed Copy / Select All.
//
// One window per file, so Playwright surfaces one page per opened file; the
// welcome window only appears when the app is launched with no file.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
    click_menu_item as click_menu,
    close_preferences,
    main_js,
    open_preferences,
    repo_dir,
} from './smoke-helpers';
// The theme registry, not a copy of it: the dropdown assertions below are about
// the catalog reaching the window intact, and a hardcoded count would have to be
// bumped by every theme that ships. Safe to import — theme-definitions.ts is a
// pure module, so pulling it in here starts no second Electron.
import { list_themes } from '../main/theme-definitions';

const csv_fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.csv');
const xlsx_fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx');

/** The app's real version — the same file desktop/build.mjs injects from. */
const app_version = (
    JSON.parse(fs.readFileSync(path.join(repo_dir, 'package.json'), 'utf8')) as { version: string }
).version;

const VIEWER_URL_PREFIX = 'tv-app://viewer';
const GRID_CANVAS = '[data-testid="data-grid-canvas"]';

let app: ElectronApplication;
let smoke_root: string;
let user_data_dir: string;
let editable_csv: string;

function viewer_pages(): Page[] {
    return app.windows().filter((page) => page.url().startsWith(VIEWER_URL_PREFIX));
}

/**
 * The file a window title names. Off macOS a window holding unsaved edits is
 * titled `• name`, so every title-based lookup here strips that marker — without
 * it, any test running after the unsaved-edits one fails on Windows/Linux with a
 * confusing "no viewer page" error.
 */
function file_of(title: string): string {
    return title.replace(/^• /, '');
}

/** Titles of the app's open windows (each viewer window is titled by file). */
function window_titles(): Promise<string[]> {
    return app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => window.getTitle()));
}

/**
 * Focus the window showing `file_name` and return its page. Menu commands act
 * on the focused window, so this is how the test picks a target.
 *
 * Every viewer page serves the same URL and the same document title (the window
 * title is set on the BrowserWindow, not the page), so the main process stamps
 * each window's title into its own page to pair the two up.
 */
async function focus_viewer(file_name: string): Promise<Page> {
    const target_id = await app.evaluate(async ({ BrowserWindow }, name) => {
        let id: number | null = null;
        for (const window of BrowserWindow.getAllWindows()) {
            const title = window.getTitle();
            await window.webContents.executeJavaScript(
                `window.__tvWindowTitle = ${JSON.stringify(title)};`,
            );
            if (title.replace(/^• /, '') !== name) continue;
            window.show();
            window.focus();
            id = window.id;
        }
        return id;
    }, file_name);
    expect(target_id, `window for ${file_name} exists`).not.toBeNull();

    // Focus lands asynchronously, and the Edit and View menu commands route on
    // `BrowserWindow.getFocusedWindow()` (see `route_edit_command`). Acting
    // before it arrives sends them to whichever window still holds it, where
    // the native fallback silently does nothing to a canvas grid — which is how
    // these tests failed under load, several assertions later.
    await expect
        .poll(
            () => app.evaluate(
                ({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null,
            ),
            { timeout: 15_000 },
        )
        .toBe(target_id);

    for (const page of viewer_pages()) {
        const title = await page.evaluate(
            () => (window as { __tvWindowTitle?: string }).__tvWindowTitle,
        );
        if (!title || file_of(title) !== file_name) continue;
        await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
        return page;
    }
    throw new Error(`no viewer page for ${file_name}`);
}

const click_menu_item = (menu_label: string, item_label: string) =>
    click_menu(app, menu_label, item_label);

/**
 * Click the grid cell at `offset` and wait for the grid to agree it is selected.
 *
 * The grid draws to a canvas, so a click is a raw coordinate — and a coordinate
 * only means a cell once the data has laid out. Glide also mirrors the grid into
 * a hidden accessibility table, which is what makes both halves of that possible
 * to wait for: `#glide-cell-<col>-<row>` exists once the row is laid out, and
 * carries `aria-selected` once it is picked.
 *
 * Without the first wait a click can land on the header instead, and without the
 * second nothing distinguishes that from a click that worked — the keystrokes
 * that follow simply go nowhere, which is how these tests used to fail under
 * load.
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

test.beforeAll(async () => {
    expect(fs.existsSync(main_js), 'run npm run bundle:desktop first').toBe(true);
    smoke_root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tv-smoke-')));
    user_data_dir = path.join(smoke_root, 'user-data');
    fs.mkdirSync(user_data_dir);
    editable_csv = path.join(smoke_root, 'basic.csv');
    fs.copyFileSync(csv_fixture, editable_csv);
    app = await electron.launch({
        args: [main_js, editable_csv, xlsx_fixture],
        cwd: repo_dir,
        env: {
            ...process.env,
            TABLE_VIEWER_USER_DATA_DIR: user_data_dir,
        },
    });
});

// One viewer window per file on the command line, each with its grid painted.
// Waited for once here so every test can assume both windows exist.
test.beforeAll(async () => {
    await expect.poll(() => viewer_pages().length, { timeout: 30_000 }).toBe(2);
    for (const page of viewer_pages()) {
        await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
    }
});

test.afterAll(async () => {
    await app?.close();
    if (smoke_root) fs.rmSync(smoke_root, { recursive: true, force: true });
});

test('opens each file in its own window and renders both grids', async () => {
    // No launcher window alongside the two viewer windows.
    expect(app.windows()).toHaveLength(2);
    // Each window is titled by its file, so the OS window list names them.
    expect((await window_titles()).map(file_of).sort()).toEqual(['basic.csv', 'basic.xlsx']);
});

// The viewer's state authority is a real SQLite database now, and it is opened
// *before* the window manager exists — so by the time a grid has painted, the file
// must already be on disk with a v1 header in it. An empty or missing file here
// would mean a viewer window got attached to something other than the database.
// (Both windows are waited for in beforeAll, so the painting is already done.)
test('the SQLite file-state database is created before any viewer content', async () => {
    const database = path.join(user_data_dir, 'state', 'file-state.sqlite3');
    await expect
        .poll(() => (fs.existsSync(database) ? fs.statSync(database).size : 0), { timeout: 15_000 })
        .toBeGreaterThan(0);
    // A SQLite file, not merely a non-empty one the app happened to touch.
    expect(fs.readFileSync(database).subarray(0, 15).toString('latin1'))
        .toBe('SQLite format 3');
});

test('windows are separately sized and positioned', async () => {
    const bounds = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => window.getBounds()));
    expect(bounds).toHaveLength(2);
    // The second window cascaded rather than landing exactly on the first. Only
    // one axis is guaranteed to differ: on a display with no vertical slack the
    // cascade wraps y and walks along x (see window-geometry.ts).
    expect(`${bounds[1].x},${bounds[1].y}`).not.toBe(`${bounds[0].x},${bounds[0].y}`);

    // Resizing one window leaves the other alone (the point of windows).
    await app.evaluate(({ BrowserWindow }) => {
        const [first] = BrowserWindow.getAllWindows();
        first.setBounds({ ...first.getBounds(), width: 700, height: 500 });
    });
    const after = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => window.getBounds()));
    expect([after[0].width, after[0].height]).toEqual([700, 500]);
    expect(after[1].width).toBe(bounds[1].width);

    // Under the default `match-last`, that resize is what the next window will
    // open at — tracked from the resize itself, without waiting for a close.
    await expect.poll(() => {
        const file = path.join(user_data_dir, 'settings.json');
        if (!fs.existsSync(file)) return null;
        const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
        return [settings.windowWidth, settings.windowHeight];
    }, { timeout: 15_000 }).toEqual([700, 500]);
});

// Opening a file that is already open must focus its window, not load the file a
// second time — two controllers on one file fight over the edit session. Driven
// through the same `open-file` event Finder's "Open with…" delivers.
test('reopening an open file focuses its window instead of duplicating it', async () => {
    await focus_viewer('basic.xlsx');
    const reopened = await app.evaluate((electron, file) => {
        electron.app.emit('open-file', { preventDefault() {} }, file);
        return electron.BrowserWindow.getAllWindows().length;
    }, editable_csv);
    expect(reopened).toBe(2);

    // Still two windows a moment later (a duplicate would appear async), and the
    // reopened file's window is the focused one.
    await expect.poll(() => app.windows().length, { timeout: 5_000 }).toBe(2);
    const focused_title = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getFocusedWindow()?.getTitle());
    expect(file_of(focused_title ?? '')).toBe('basic.csv');
});

// The grid is a canvas, so the stock `role: 'copy'` / `role: 'selectAll'` menu
// items have no DOM selection to act on — and their accelerators would keep the
// keystrokes from ever reaching Glide. The menu forwards the intent to the
// focused viewer window instead; this guards that wiring end to end.
test('Edit menu Copy and Select All act on the grid', async () => {
    const page = await focus_viewer('basic.csv');
    await app.evaluate(({ clipboard }) => clipboard.writeText('untouched'));

    // Select the first body cell, then copy it through the menu.
    await click_grid_cell(page, { column: 1, row: 0 }, { x: 120, y: 50 });
    await click_menu_item('Edit', 'Copy');
    await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
        .toBe('Alice');

    // Select All must widen the grid selection, not the (empty) DOM selection.
    await click_menu_item('Edit', 'Select All');
    await click_menu_item('Edit', 'Copy');
    await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
        .toContain('Charlie');
});

test('sorting a column shows a sort chip', async () => {
    const page = await focus_viewer('basic.csv');

    // Focus a data cell (past the row-marker gutter and the header row), then
    // sort the focused column ascending via the keyboard shortcut. Glide
    // overlays a scroller element on the canvas, so click via raw coordinates.
    await click_grid_cell(page, { column: 1, row: 0 }, { x: 120, y: 50 });
    await page.keyboard.press('Shift+Alt+A');

    await expect(page.locator('.sort-strip .sort-chip')).toHaveCount(1);

    // Clear the sort again (via the sort strip's clear button) so the
    // persisted per-file state stays clean.
    await page.locator('.sort-strip-clear').click();
    await expect(page.locator('.sort-strip .sort-chip')).toHaveCount(0);
});

// Per-window zoom: each viewer window is one webContents, so View → Zoom acts
// on the focused window and leaves the others where they were.
test('View menu zoom applies to the focused window only', async () => {
    await focus_viewer('basic.csv');
    await click_menu_item('View', 'Zoom In');

    const levels = async () => Object.fromEntries(
        (await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((window): [string, number] =>
                [window.getTitle(), window.webContents.getZoomLevel()])))
            .map(([title, level]) => [file_of(title), level]),
    );
    await expect.poll(levels, { timeout: 5_000 })
        .toEqual({ 'basic.csv': 1, 'basic.xlsx': 0 });

    await click_menu_item('View', 'Actual Size');
    await expect.poll(levels, { timeout: 5_000 })
        .toEqual({ 'basic.csv': 0, 'basic.xlsx': 0 });
});

// Regression: the viewer theme is baked into the page HTML and refreshed over
// IPC. It used to be pushed in by the preload, which threw on the not-yet-parsed
// document and so applied nothing — the grid stayed dark in light mode forever.
test('viewer windows follow the OS light/dark setting', async () => {
    const page = viewer_pages()[0];
    expect(page).toBeTruthy();
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });

    const editor_background = () =>
        page.evaluate(() =>
            getComputedStyle(document.documentElement)
                .getPropertyValue('--vscode-editor-background')
                .trim());

    try {
        for (const [source, expected] of [
            ['light', '#ffffff'],
            ['dark', '#1e1e1e'],
            ['light', '#ffffff'],
        ] as const) {
            await app.evaluate(({ nativeTheme }, value) => {
                nativeTheme.themeSource = value;
            }, source);
            await expect.poll(editor_background, { timeout: 5_000 }).toBe(expected);
            expect(await page.evaluate(() => document.documentElement.style.colorScheme))
                .toBe(source);
        }
    } finally {
        await app.evaluate(({ nativeTheme }) => {
            nativeTheme.themeSource = 'system';
        });
    }
});

// The color scheme preference overrides the OS setting, so this exercises the
// whole path: the Preferences select → settings file → nativeTheme.themeSource →
// the palette every open window is holding.
test('the color scheme preference pins light/dark, and System restores OS following', async () => {
    const viewer = viewer_pages()[0];
    expect(viewer).toBeTruthy();
    await viewer.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });

    const prefs = await open_preferences(app);
    const appearance = prefs.locator('#theme');
    const color_theme = prefs.locator('#colorTheme');
    await expect(appearance).toHaveValue('system');

    const editor_background = () =>
        viewer.evaluate(() =>
            getComputedStyle(document.documentElement)
                .getPropertyValue('--vscode-editor-background')
                .trim());

    try {
        // Start from a known appearance: on a dark-mode runner the first pin below
        // would otherwise assert a palette the app was already showing.
        await app.evaluate(({ nativeTheme }) => {
            nativeTheme.themeSource = 'light';
        });
        await expect.poll(editor_background, { timeout: 5_000 }).toBe('#ffffff');

        // Light mode offers exactly the light themes, selected on the default.
        const option_ids = () => color_theme.locator('option')
            .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
        await expect.poll(option_ids, { timeout: 15_000 })
            .toEqual(list_themes('light').map((theme) => theme.id));
        await expect(color_theme).toHaveValue('light');

        // Flipping the OS while Preferences is open must retarget the dropdown
        // live — under Color scheme=System its meaning *is* the current mode.
        // No reload: the list is rebuilt from the theme payload it already gets.
        await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
        await expect.poll(option_ids, { timeout: 15_000 })
            .toEqual(list_themes('dark').map((theme) => theme.id));
        await expect(color_theme).toHaveValue('dark');

        // Picking a non-default theme repaints the open viewer windows.
        await color_theme.selectOption('solarized-dark');
        await expect.poll(editor_background, { timeout: 5_000 }).toBe('#002b36');

        // The other mode keeps its own theme, and coming back restores this one.
        await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
        await expect(color_theme).toHaveValue('light');
        await expect.poll(editor_background, { timeout: 5_000 }).toBe('#ffffff');
        await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
        await expect(color_theme).toHaveValue('solarized-dark');
        await expect.poll(editor_background, { timeout: 5_000 }).toBe('#002b36');

        // Restore the dark default before the appearance assertions below, which
        // expect Dark's #1e1e1e.
        await color_theme.selectOption('dark');
        await expect.poll(editor_background, { timeout: 5_000 }).toBe('#1e1e1e');
        await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
        await expect.poll(editor_background, { timeout: 5_000 }).toBe('#ffffff');

        // Each pin flips the palette away from what the previous step left.
        for (const [choice, expected] of [
            ['dark', '#1e1e1e'],
            ['light', '#ffffff'],
        ] as const) {
            await appearance.selectOption(choice);
            await expect.poll(editor_background, { timeout: 5_000 }).toBe(expected);
            expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
                .toBe(choice);
        }

        // Back to System: the palette tracks nativeTheme again.
        await appearance.selectOption('system');
        for (const [source, expected] of [['dark', '#1e1e1e'], ['light', '#ffffff']] as const) {
            await app.evaluate(({ nativeTheme }, value) => {
                nativeTheme.themeSource = value;
            }, source);
            await expect.poll(editor_background, { timeout: 5_000 }).toBe(expected);
        }
    } finally {
        await appearance.selectOption('system');
        await app.evaluate(({ nativeTheme }) => {
            nativeTheme.themeSource = 'system';
        });
        await close_preferences(app);
    }
});

/** One setting as it is on disk — the only place a preference is really saved.
 *  `null` until the app has had reason to write the file at all. */
function stored_setting(key: string): unknown {
    const file = path.join(user_data_dir, 'settings.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'))[key];
}

test('automatic update checking is explained and saved immediately', async () => {
    const prefs = await open_preferences(app);
    const control = prefs.locator('#automaticallyCheckForUpdates');
    try {
        await expect(control).toBeChecked();
        await expect(control.locator('xpath=following-sibling::div').locator('.hint'))
            .toContainText('Checks once when you open Table Viewer');
        await control.uncheck();
        await expect.poll(
            () => stored_setting('automaticallyCheckForUpdates'),
            { timeout: 15_000 },
        ).toBe(false);
        await control.check();
        await expect.poll(
            () => stored_setting('automaticallyCheckForUpdates'),
            { timeout: 15_000 },
        ).toBe(true);
    } finally {
        await close_preferences(app);
    }
});

// Switching to Match last window has to adopt whatever is on screen: while Fixed
// size was selected the app deliberately ignored every resize, so without this
// the stored size is the number last typed, and the first window opened after
// the switch would still use it.
test('switching to Match last window adopts the current window size', async () => {
    const settings = () => {
        const file = path.join(user_data_dir, 'settings.json');
        if (!fs.existsSync(file)) return null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return [parsed.newWindowSize, parsed.windowWidth, parsed.windowHeight];
    };
    const prefs = await open_preferences(app);
    try {
        await prefs.selectOption('#newWindowSize', 'fixed');
        for (const [field, value] of [['#windowWidth', '820'], ['#windowHeight', '560']]) {
            await prefs.fill(field, value);
            await prefs.locator(field).blur();
        }
        await expect.poll(settings, { timeout: 15_000 }).toEqual(['fixed', 820, 560]);

        // Resizing under Fixed size must leave the typed numbers alone. The
        // most recently opened viewer, since that is the one the switch below
        // adopts from.
        await app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()
                .find((window) => window.getTitle().includes('basic.xlsx'))
                ?.setBounds({ x: 60, y: 60, width: 640, height: 480 });
        });
        await prefs.waitForTimeout(1_000);
        expect(settings()).toEqual(['fixed', 820, 560]);

        // Switching back adopts the window that was resized in the meantime —
        // in the file and in the readout, which must not be left showing the
        // size the switch replaced.
        await prefs.selectOption('#newWindowSize', 'match-last');
        await expect.poll(settings, { timeout: 15_000 }).toEqual(['match-last', 640, 480]);
        await expect(prefs.locator('#windowWidth')).toHaveValue('640');
        await expect(prefs.locator('#windowHeight')).toHaveValue('480');
    } finally {
        await close_preferences(app);
    }
});

/**
 * Take the Preferences window's save debounce off the clock.
 *
 * The tests that assert a value was *not* saved otherwise have to sleep past the
 * debounce and hope — the one thing this repo's test guidance rules out, and a
 * false pass on a loaded machine, since a renderer that has not run its timer yet
 * looks exactly like one that correctly declined to save. So the timer is
 * captured instead of started, and `run_pending_saves` runs it on demand.
 */
async function seize_debounce(prefs: Page): Promise<void> {
    // 500 mirrors SAVE_DEBOUNCE_MS in desktop/renderer/prefs.ts — matching on it
    // leaves any other timer in the page running normally.
    await prefs.evaluate((debounce_ms) => {
        const real_set_timeout = window.setTimeout.bind(window);
        const queued: Array<() => void> = [];
        const page = window as unknown as {
            __run_pending_saves: () => Promise<unknown>;
            prefsApi: { get_settings: () => Promise<unknown> };
        };
        const escaped: number[] = [];
        page.__run_pending_saves = async () => {
            // Drift guard. The interval below is a copy of the renderer's, and if
            // the renderer's changes this stops matching — every timer would go to
            // the real clock, this would drain nothing, and the "not saved yet"
            // assertions would start passing for the wrong reason. A long timer
            // getting past the filter is what that looks like from here.
            if (escaped.length > 0) {
                throw new Error(
                    `a ${escaped[0]}ms timer escaped the seized debounce — has `
                    + 'SAVE_DEBOUNCE_MS changed in desktop/renderer/prefs.ts?',
                );
            }
            while (queued.length > 0) queued.shift()!();
            // A round trip on the same IPC as the saves, and so ordered behind
            // anything they just sent: once it answers, whatever was going to be
            // written to the settings file has been.
            return page.prefsApi.get_settings();
        };
        window.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
            if (ms === debounce_ms) {
                queued.push(handler);
                return -1;
            }
            // Anything else long enough to be a debounce is not one this shim
            // knows about; see the guard above.
            if (typeof ms === 'number' && ms >= 100) escaped.push(ms);
            return real_set_timeout(handler, ms, ...rest);
        }) as typeof window.setTimeout;
    }, 500);
}

/** Run whatever the debounce is holding, and wait for the writes to land. */
function run_pending_saves(prefs: Page): Promise<unknown> {
    return prefs.evaluate(() =>
        (window as unknown as { __run_pending_saves: () => Promise<unknown> })
            .__run_pending_saves());
}

// Preferences has no Save button, so a typed value has to save itself. Neither
// half of that is obvious from the screen — this is the test that says the window
// is not quietly dropping edits.
test('a typed preference saves without Enter', async () => {
    const prefs = await open_preferences(app);
    try {
        // `fill` types without pressing Enter and leaves the field focused —
        // exactly the case that used to lose the value. 7 digits, matching the
        // stored default: a *shorter* number reads as a value still being typed
        // (see the test below), which is a different path.
        await prefs.fill('#csvMaxRows', '1000001');
        await expect.poll(() => stored_setting('csvMaxRows'), { timeout: 15_000 }).toBe(1000001);
    } finally {
        await prefs.fill('#csvMaxRows', '1000000');
        await prefs.locator('#csvMaxRows').blur();
        await expect.poll(() => stored_setting('csvMaxRows'), { timeout: 15_000 }).toBe(1_000_000);
        await close_preferences(app);
    }
});

// The other half of saving while typing: the settings apply to the app as they
// are written, so the values a user is only passing through must not be written
// at all. Every case here used to change the app under the user mid-keystroke —
// backspacing 13 to 1 shrank everything to the 8px minimum, and each prefix of a
// font name dropped the app to its default face.
//
// One case at a time, each with focus left in its own field: moving to another
// field is a blur, and a blur is a commit — which is the second half of every
// case here, and is asserted as such.
test('a value still being typed waits for the field or window to be left', async () => {
    const prefs = await open_preferences(app);
    try {
        await seize_debounce(prefs);
        // A known starting point, saved the ordinary way, so this test depends on
        // nothing the tests before it left behind.
        for (const [field, value] of [['#fontSize', '16'], ['#fontFamily', 'monospace']]) {
            await prefs.fill(field, value);
            await prefs.locator(field).blur();
        }
        await expect.poll(() => stored_setting('fontSize'), { timeout: 15_000 }).toBe(16);
        // A font the system does have applies as it is typed — what waits is an
        // unknown name, not every name. Polled, not read: `blur()` dispatches the
        // renderer's handler without awaiting the IPC it starts.
        await expect
            .poll(() => stored_setting('fontFamily'), { timeout: 15_000 })
            .toBe('monospace');

        // Cleared for retyping: no digit of the old value survives as a setting,
        // and leaving it blank keeps what was stored rather than saving nothing.
        await prefs.fill('#fontSize', '');
        await run_pending_saves(prefs);
        expect(stored_setting('fontSize')).toBe(16);
        await prefs.locator('#fontSize').blur();
        await run_pending_saves(prefs);
        expect(stored_setting('fontSize')).toBe(16);
        await expect(prefs.locator('#fontSize')).toHaveValue('16');

        // A digit taken off: 1000000 → 4321 is fewer characters than were there,
        // so it is someone partway through typing — until they leave the field.
        await prefs.fill('#csvMaxRows', '4321');
        await run_pending_saves(prefs);
        expect(stored_setting('csvMaxRows')).toBe(1_000_000);
        await prefs.locator('#csvMaxRows').blur();
        await expect.poll(() => stored_setting('csvMaxRows'), { timeout: 15_000 }).toBe(4321);

        // A font name the system does not have: not applied while it is typed, but
        // saved if the user closes the window still standing on it — they may know
        // something the availability check does not.
        await prefs.fill('#fontFamily', 'Nonexistent Zzz Face');
        await run_pending_saves(prefs);
        expect(stored_setting('fontFamily')).toBe('monospace');
        await close_preferences(app);
        await expect
            .poll(() => stored_setting('fontFamily'), { timeout: 15_000 })
            .toBe('Nonexistent Zzz Face');
    } finally {
        // Back to the defaults: the font is the app's, and the later tests measure
        // a grid drawn with it.
        await close_preferences(app);
        const restore = await open_preferences(app);
        for (const [field, value] of [
            ['#fontFamily', ''],
            ['#fontSize', '13'],
            ['#csvMaxRows', '1000000'],
        ]) {
            await restore.fill(field, value);
            await restore.locator(field).blur();
        }
        await expect.poll(() => stored_setting('fontFamily'), { timeout: 15_000 }).toBe('');
        await expect.poll(() => stored_setting('fontSize'), { timeout: 15_000 }).toBe(13);
        await expect.poll(() => stored_setting('csvMaxRows'), { timeout: 15_000 }).toBe(1_000_000);
        await close_preferences(app);
    }
});

// An edit can also be inside the debounce when the window goes away, with no blur
// of any kind to rescue it — the flush on close is the only thing that saves it.
test('an edit inside the debounce survives closing the window', async () => {
    const prefs = await open_preferences(app);
    try {
        // Seizing the debounce is what makes this deterministic: nothing here ever
        // runs what it captured, so the flush on close is the only thing left that
        // can produce the write.
        await seize_debounce(prefs);
        await prefs.fill('#csvMaxRows', '1234567');
        await close_preferences(app);
        await expect.poll(() => stored_setting('csvMaxRows'), { timeout: 15_000 }).toBe(1234567);
    } finally {
        await close_preferences(app);
        const restore = await open_preferences(app);
        await restore.fill('#csvMaxRows', '1000000');
        await restore.locator('#csvMaxRows').blur();
        await expect.poll(() => stored_setting('csvMaxRows'), { timeout: 15_000 }).toBe(1_000_000);
        await close_preferences(app);
    }
});

// The About window is custom rather than the native panel (GPLv3 wants the
// license and warranty notice reachable, and the native macOS panel cannot host
// links). Deliberately does not assert shell.openExternal/openPath actually
// launched anything — only that the controls exist and are wired.
test('the About window shows the app version and its notice links', async () => {
    // About lives on the app menu on macOS and under Help elsewhere, so scan
    // every top-level menu rather than naming one: the mac app menu's label is
    // `app.name`, which is `table-viewer` in an unpackaged dev run.
    const opened = await app.evaluate(({ BrowserWindow, Menu }) => {
        for (const menu of Menu.getApplicationMenu()?.items ?? []) {
            const item = menu.submenu?.items.find((entry) => entry.label === 'About Table Viewer');
            if (!item?.click) continue;
            item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {});
            return true;
        }
        return false;
    });
    expect(opened, 'an About Table Viewer menu item exists').toBe(true);

    const about_page = () => app.windows().find((page) => page.url().endsWith('about.html'));
    try {
        await expect.poll(about_page, { timeout: 15_000 }).toBeTruthy();
        const about = about_page()!;
        // Compared against the root package.json, not a loose version-shaped
        // regex: the bug this guards is the window showing *a* plausible version
        // that is not the app's (app.getVersion() reports Electron's own version
        // in an unpackaged dev run), which any /\d+\.\d+\.\d+/ happily accepts.
        await expect(about.locator('#version')).toHaveText(`Version ${app_version}`);
        for (const id of ['#license', '#notices', '#bundledNotices']) {
            await expect(about.locator(id)).toBeVisible();
        }
    } finally {
        await app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()
                .find((window) => window.getTitle().includes('About'))
                ?.close();
        });
    }
});

test('CSV keyboard navigation wraps and remains active after editing', async () => {
    const page = await focus_viewer('basic.csv');
    const edit_toggle = page.getByRole('button', { name: 'Edit' });
    await edit_toggle.click();
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'true');

    // Start at the first displayed data cell. Glide's accessibility columns
    // include the row marker at index 0, so the CSV columns are 1..3.
    await click_grid_cell(page, { column: 1, row: 0 }, { x: 120, y: 50 });
    await page.keyboard.press('Tab');
    await expect(page.locator('#glide-cell-2-0')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Tab');
    await expect(page.locator('#glide-cell-3-0')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Tab');
    await expect(page.locator('#glide-cell-1-1')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#glide-cell-3-0')).toHaveAttribute('aria-selected', 'true');

    // Open the last cell in the row and change its value before committing with
    // Tab. The value assertion proves this exercises the dirty-store update path;
    // the focus assertion then checks that update did not strand the keyboard.
    await page.keyboard.press('Enter');
    const cell_editor = page.locator('.cell-editor-input');
    await expect(cell_editor).toBeVisible();
    await expect(cell_editor).toBeFocused();
    await cell_editor.fill('New York!');
    await cell_editor.press('Tab');
    await expect(cell_editor).toBeHidden();
    await expect(page.locator('#glide-cell-3-0')).toHaveText('New York!');
    await expect(page.locator('#glide-cell-1-1')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#glide-cell-1-1')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#glide-cell-2-1')).toHaveAttribute('aria-selected', 'true');

    // Enter retains the displayed column and moves down after a commit.
    await page.keyboard.press('Enter');
    await expect(cell_editor).toBeVisible();
    await cell_editor.fill('26');
    await cell_editor.press('Enter');
    await expect(cell_editor).toBeHidden();
    await expect(page.locator('#glide-cell-2-1')).toHaveText('26');
    await expect(page.locator('#glide-cell-2-2')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#glide-cell-2-2')).toBeFocused();

    // The following Shift+Tab must be handled by the grid, proving the Enter
    // commit restored a functional keyboard target rather than only moving the
    // controlled selection while focus remained stranded in the closed editor.
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#glide-cell-1-2')).toHaveAttribute('aria-selected', 'true');

    // A Shift+Tab commit wraps backward to the preceding row. The following Tab
    // likewise proves that commit returned keyboard handling to the real grid.
    await page.keyboard.press('Enter');
    await expect(cell_editor).toBeVisible();
    await cell_editor.fill('Charlie!');
    await cell_editor.press('Shift+Tab');
    await expect(cell_editor).toBeHidden();
    await expect(page.locator('#glide-cell-1-2')).toHaveText('Charlie!');
    await expect(page.locator('#glide-cell-3-1')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#glide-cell-3-1')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#glide-cell-1-2')).toHaveAttribute('aria-selected', 'true');

    // Restore the fixture through the same edit path so this test leaves no
    // pending edits for the save smoke case that follows it.
    await page.keyboard.press('Enter');
    await cell_editor.fill('Charlie');
    await cell_editor.press('Enter');
    await expect(page.locator('#glide-cell-1-2')).toHaveText('Charlie');

    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#glide-cell-2-1')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await cell_editor.fill('25');
    await cell_editor.press('Enter');
    await expect(page.locator('#glide-cell-2-1')).toHaveText('25');

    for (let step = 0; step < 5; step++) await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#glide-cell-3-0')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await cell_editor.fill('New York');
    await cell_editor.press('Enter');
    await expect(page.locator('#glide-cell-3-0')).toHaveText('New York');
    await expect(edit_toggle).not.toHaveClass(/has-unsaved/);

    await edit_toggle.click();
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'false');
});

// Desktop editing uses the complete shared path: the renderer obtains an edit
// session, SQLite accepts the draft, and Cmd/Ctrl+S reaches the controller's
// conflict checks and the desktop filesystem port. The fixture is a temporary
// copy, so this proves the physical save without modifying the repository.
test('CSV edits are marked dirty and save to the opened file', async () => {
    const page = await focus_viewer('basic.csv');
    const window_state = () => app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()
            .find((candidate) => candidate.getTitle().includes('basic.csv'));
        return { title: window?.getTitle(), edited: window?.isDocumentEdited() };
    });
    expect(await window_state()).toEqual({ title: 'basic.csv', edited: false });

    // Enter edit mode — and wait for it, or the keystrokes below land in a grid
    // that is still read-only and are swallowed.
    const edit_toggle = page.getByRole('button', { name: 'Edit' });
    await edit_toggle.click();
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'true');

    // Open the first body cell's editor explicitly, replace its value, and commit.
    // Separating activation from entry makes the expected saved bytes unambiguous.
    await click_grid_cell(page, { column: 1, row: 0 }, { x: 120, y: 50 });
    await page.keyboard.press('Enter');
    const cell_editor = page.locator('.cell-editor-input');
    await expect(cell_editor).toBeVisible();
    await expect(cell_editor).toBeFocused();
    await expect(cell_editor).toHaveValue('Alice');
    await cell_editor.fill('Alicia');
    await cell_editor.press('Enter');
    await expect(cell_editor).toBeHidden();
    await expect(edit_toggle).toHaveClass(/has-unsaved/);

    await expect.poll(window_state, { timeout: 15_000 }).toEqual(
        process.platform === 'darwin'
            ? { title: 'basic.csv', edited: true }
            : { title: '• basic.csv', edited: false },
    );

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
    await expect.poll(
        () => fs.readFileSync(editable_csv, 'utf8'),
        { timeout: 15_000 },
    ).toBe([
        'Name,Age,City',
        'Alicia,30,New York',
        'Bob,25,London',
        'Charlie,35,Paris',
        '',
    ].join('\n'));
    await expect(edit_toggle).not.toHaveClass(/has-unsaved/);
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(window_state, { timeout: 15_000 }).toEqual({
        title: 'basic.csv',
        edited: false,
    });
});
