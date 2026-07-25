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
import { click_menu_item as click_menu, main_js, repo_dir } from './smoke-helpers';

const csv_fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.csv');
const xlsx_fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx');

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
    const focused = await app.evaluate(async ({ BrowserWindow }, name) => {
        let found = false;
        for (const window of BrowserWindow.getAllWindows()) {
            const title = window.getTitle();
            await window.webContents.executeJavaScript(
                `window.__tvWindowTitle = ${JSON.stringify(title)};`,
            );
            if (title.replace(/^• /, '') !== name) continue;
            window.show();
            window.focus();
            found = true;
        }
        return found;
    }, file_name);
    expect(focused, `window for ${file_name} exists`).toBe(true);

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
    const canvas = page.locator(GRID_CANVAS).first();
    await app.evaluate(({ clipboard }) => clipboard.writeText('untouched'));

    // Select the first body cell, then copy it through the menu.
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + 120, box.y + 50);
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
    const canvas = page.locator(GRID_CANVAS).first();

    // Focus a data cell (past the row-marker gutter and the header row), then
    // sort the focused column ascending via the keyboard shortcut. Glide
    // overlays a scroller element on the canvas, so click via raw coordinates.
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(
        box!.x + Math.min(140, box!.width - 10),
        box!.y + Math.min(60, box!.height - 10),
    );
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

    // Preferences… lives on the app menu on macOS and under File elsewhere.
    const opened = await app.evaluate(({ BrowserWindow, Menu }) => {
        for (const menu of Menu.getApplicationMenu()?.items ?? []) {
            const item = menu.submenu?.items.find((entry) => entry.label === 'Preferences…');
            if (!item?.click) continue;
            item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {});
            return true;
        }
        return false;
    });
    expect(opened, 'a Preferences… menu item exists').toBe(true);

    const prefs_page = () => app.windows().find((page) => page.url().endsWith('prefs.html'));
    await expect.poll(prefs_page, { timeout: 15_000 }).toBeTruthy();
    const prefs = prefs_page()!;
    const appearance = prefs.locator('#theme');
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
        await app.evaluate(({ BrowserWindow, nativeTheme }) => {
            nativeTheme.themeSource = 'system';
            BrowserWindow.getAllWindows()
                .find((window) => window.getTitle().includes('Preferences'))
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
    const canvas = page.locator(GRID_CANVAS).first();
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + 120, box.y + 50);
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
