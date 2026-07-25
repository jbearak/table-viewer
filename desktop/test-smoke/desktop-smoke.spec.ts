// Smoke test for the standalone desktop app: launches the built Electron
// bundle (dist/desktop/main.js) with a csv and an xlsx fixture, asserts each
// file opened in its own window and rendered the data grid, and exercises a
// couple of interactions (sort, and the Edit menu's grid-routed Copy /
// Select All).
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

const csv_fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.csv');
const xlsx_fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx');

/** The app's real version — the same file desktop/build.mjs injects from. */
const app_version = (
    JSON.parse(fs.readFileSync(path.join(repo_dir, 'package.json'), 'utf8')) as { version: string }
).version;

const VIEWER_URL_PREFIX = 'tv-app://viewer';
const GRID_CANVAS = '[data-testid="data-grid-canvas"]';

let app: ElectronApplication;
let user_data_dir: string;

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
    if (user_data_dir) fs.rmSync(user_data_dir, { recursive: true, force: true });
});

test('opens each file in its own window and renders both grids', async () => {
    // No launcher window alongside the two viewer windows.
    expect(app.windows()).toHaveLength(2);
    // Each window is titled by its file, so the OS window list names them.
    expect((await window_titles()).map(file_of).sort()).toEqual(['basic.csv', 'basic.xlsx']);
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
        const file = path.join(user_data_dir, 'settings.v1.json');
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
    }, csv_fixture);
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

// The appearance preference overrides the OS setting, so this exercises the
// whole path: the Preferences select → settings file → nativeTheme.themeSource →
// the palette every open window is holding.
test('the appearance preference pins light/dark, and System restores OS following', async () => {
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
        await expect(color_theme.locator('option')).toHaveCount(3);
        await expect(color_theme).toHaveValue('light');

        // Flipping the OS while Preferences is open must retarget the dropdown
        // live — under Appearance=System its meaning *is* the current mode.
        // No reload: the list is rebuilt from the theme payload it already gets.
        await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
        await expect(color_theme.locator('option')).toHaveCount(6);
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

// Switching to Match last window has to adopt whatever is on screen: while Fixed
// size was selected the app deliberately ignored every resize, so without this
// the stored size is the number last typed, and the first window opened after
// the switch would still use it.
test('switching to Match last window adopts the current window size', async () => {
    const settings = () => {
        const file = path.join(user_data_dir, 'settings.v1.json');
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

// Unsaved CSV edits are durable, so the window only has to *show* that it holds a
// draft: macOS puts a dot in an edited document's close button, other platforms
// mark the title. Kept last — it deliberately leaves a draft behind.
test('a window holding unsaved edits is marked as edited', async () => {
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

    // Type into the first body cell and commit it. The first keystroke opens the
    // overwrite editor and is consumed, so the cell ends up holding "licia".
    await click_grid_cell(page, { column: 1, row: 0 }, { x: 120, y: 50 });
    await page.keyboard.type('Alicia');
    await page.keyboard.press('Enter');
    // The toolbar marks its own unsaved state; wait for the page to agree a draft
    // exists before asking the window about it.
    await expect(edit_toggle).toHaveClass(/has-unsaved/);

    await expect.poll(window_state, { timeout: 15_000 }).toEqual(
        process.platform === 'darwin'
            ? { title: 'basic.csv', edited: true }
            : { title: '• basic.csv', edited: false },
    );
});
