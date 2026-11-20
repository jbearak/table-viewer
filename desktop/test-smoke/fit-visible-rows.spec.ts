// Fit Visible Rows in the desktop app: Shift+Alt+H, the toolbar button and
// the row menu's item fit the rows on screen, and only those, as one
// Auto-fit step that undo and redo move like any other.
//
// Which rows are on screen is worked out here from the scroller alone (its
// scroll offset and height, the 36 px header and the 24 px default row), not
// from anything the grid reports: the grid's accessibility table follows the
// same range Glide reports, which is what the command must not trust. What
// was fitted is read from the state database, keyed by source row.
//
// No step needs the window focused: keys and clicks go to the page, and
// undo and redo arrive as the Edit menu sends them to the window. Every wait
// polls what the window shows or what the database holds.
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { history_menu_item, type HistoryMenuState } from '../main/history-menu-model';
import { hot_journal_present, isolated_user_data, state_database_path } from './smoke-helpers';
import {
    canvas_box,
    choose,
    exit_app,
    install_dialog_capture,
    install_history_menu_capture,
    launch_structural_viewer,
    take_dialogs,
    wait_for_grid,
} from './structure-helpers';

let test_root: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
    test_root = isolated_user_data('tv-fit-visible-rows-');
});

test.afterEach(async () => {
    if (app) await exit_app(app);
    app = undefined;
    fs.rmSync(test_root, { recursive: true, force: true });
});

const HEADER_HEIGHT_PX = 36;
const ROW_HEIGHT_PX = 24;
const ROW_COUNT = 300;
/** Wraps onto several lines in a 120 px column, so every fitted row grows. */
const note = (row: number) => `Row ${row} carries a note long enough to wrap onto several lines`;
const CSV = `Name,Note\n${Array.from({ length: ROW_COUNT }, (_, row) => `R${row},${note(row)}`).join('\n')}\n`;
/**
 * The stored key of display row 0 in an unsorted CSV with a header line.
 * Settled once by fitting display row 0 alone from its row menu, not from
 * this command.
 */
const SOURCE_ROW_OF_FIRST_DISPLAY_ROW = 0;

const user_data_dir = () => path.join(test_root, 'user-data');

async function open_file(name: string): Promise<{ file: string; page: Page }> {
    fs.mkdirSync(user_data_dir(), { recursive: true });
    const file = path.join(test_root, name);
    fs.writeFileSync(file, CSV);
    const launched = await launch_structural_viewer(user_data_dir(), file);
    app = launched.app;
    await install_dialog_capture(app);
    await install_history_menu_capture(app);
    await wait_for_grid(launched.page);
    return { file, page: launched.page };
}

interface StoredState {
    rowHeights?: (Record<string, number> | null)[];
}

/** The custom heights the state database holds for the file, by source row; undefined while unreadable. */
function stored_heights(file: string): Record<string, number> | undefined {
    const state = stored_state(file);
    return state === undefined ? undefined : state.rowHeights?.[0] ?? {};
}

/** The file's entry in the state database: `{}` before it has one, undefined while unreadable. */
function stored_state(file: string): StoredState | undefined {
    try {
        // A copy, never read in place, and never one taken mid-write: see
        // `stored` in undo-redo-size.spec.ts.
        const copy = path.join(test_root, 'file-state-copy.sqlite3');
        if (hot_journal_present(user_data_dir())) return undefined;
        fs.copyFileSync(state_database_path(user_data_dir()), copy);
        if (hot_journal_present(user_data_dir())) return undefined;
        const database = new DatabaseSync(copy, { readOnly: true });
        try {
            const entries = database.prepare('SELECT path, state_json FROM entries').all() as
                { path: string; state_json: string }[];
            const entry = entries.find((candidate) => candidate.path.endsWith(path.basename(file)));
            if (entry === undefined) return {};
            return JSON.parse(entry.state_json) as StoredState;
        } catch {
            return undefined;
        } finally {
            database.close();
        }
    } catch {
        return undefined;
    }
}

async function undo_label(): Promise<string> {
    const state = await app!.evaluate(() => (globalThis as typeof globalThis & {
        __tableViewerSmokeHistory?: unknown;
    }).__tableViewerSmokeHistory) as HistoryMenuState | undefined;
    return history_menu_item('undo', state).label;
}

async function redo_label(): Promise<string> {
    const state = await app!.evaluate(() => (globalThis as typeof globalThis & {
        __tableViewerSmokeHistory?: unknown;
    }).__tableViewerSmokeHistory) as HistoryMenuState | undefined;
    return history_menu_item('redo', state).label;
}

/** Undo or redo, as the Edit menu sends it to the window. */
async function history(page: Page, command: 'undo' | 'redo'): Promise<void> {
    await page.evaluate((sent) => window.postMessage({ type: 'editCommand', command: sent }, '*'), command);
}

interface OnScreen {
    readonly scroll_top: number;
    readonly first: number;
    readonly last: number;
}

/**
 * Scroll the grid to `scroll_top` and work out the rows on screen while
 * every row has the default height: row r is painted from
 * `36 + 24r - scroll_top` to 24 px below that, and it is on screen when more
 * than a pixel of that shows in the body, from the header's bottom to the
 * scroller's client height (a pixel is the header's border).
 */
async function scroll_to(page: Page, scroll_top: number): Promise<OnScreen> {
    await page.evaluate((top) => {
        document.querySelector<HTMLElement>('.dvn-scroller')!.scrollTop = top;
    }, scroll_top);
    let client_height = 0;
    await expect.poll(async () => {
        const read = await page.evaluate(() => {
            const scroller = document.querySelector<HTMLElement>('.dvn-scroller')!;
            return { top: scroller.scrollTop, height: scroller.clientHeight };
        });
        client_height = read.height;
        return read.top;
    }, { message: `the grid scrolls to ${scroll_top}` }).toBe(scroll_top);
    const first = Math.floor((scroll_top + 1) / ROW_HEIGHT_PX);
    const last = Math.ceil((client_height - HEADER_HEIGHT_PX - 1 + scroll_top) / ROW_HEIGHT_PX) - 1;
    expect(last).toBeGreaterThan(first + 3);
    expect(last).toBeLessThan(ROW_COUNT - 1);
    // Loaded: the grid's accessibility table has their notes. The bottom row
    // can be left out of Glide's range, so the one above it stands for it;
    // they share a page of the row loader. A row the fit found unloaded
    // would show as a warning, which the checks below would see.
    for (const row of [first, last - 1]) {
        await expect.poll(() => page.evaluate(
            (id) => document.getElementById(id)?.textContent ?? '',
            `glide-cell-2-${row}`,
        ), { message: `row ${row} is loaded` }).toContain(note(row));
    }
    return { scroll_top, first, last };
}

/**
 * Scroll to the last rows, where the fit put no height, and wait for them to
 * load. Above them some rows are taller now, so this goes by the rows shown,
 * not by `scroll_to`'s arithmetic.
 */
async function scroll_to_end(page: Page): Promise<void> {
    const row = ROW_COUNT - 2;
    // Scrolled again on each try: the fitted heights can reach the grid
    // after the database, and with them a taller scroll height.
    await expect(async () => {
        const text = await page.evaluate((id) => {
            const scroller = document.querySelector<HTMLElement>('.dvn-scroller')!;
            scroller.scrollTop = scroller.scrollHeight;
            return document.getElementById(id)?.textContent ?? '';
        }, `glide-cell-2-${row}`);
        expect(text, `row ${row} is loaded`).toContain(note(row));
    }).toPass({ timeout: 15_000 });
}

/** Select a cell of a row near the top of the screen, which leaves keys with the grid. */
async function focus_grid(page: Page, on_screen: OnScreen): Promise<void> {
    const box = await canvas_box(page);
    const row = on_screen.first + 2;
    const top = HEADER_HEIGHT_PX + row * ROW_HEIGHT_PX - on_screen.scroll_top;
    await page.mouse.click(box.x + 80, box.y + top + ROW_HEIGHT_PX / 2);
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.closest('.grid-shell-root') !== null,
    ), { message: 'the grid has the keyboard' }).toBe(true);
}

/** Right-click a row marker on screen and wait for the row menu. */
async function open_row_menu_at(page: Page, on_screen: OnScreen, row: number) {
    const box = await canvas_box(page);
    const top = HEADER_HEIGHT_PX + row * ROW_HEIGHT_PX - on_screen.scroll_top;
    await page.mouse.click(box.x + 8, box.y + top + ROW_HEIGHT_PX / 2, { button: 'right' });
    const menu = page.locator('[role="menu"]').first();
    await expect(menu).toHaveAttribute('aria-label', /^Row actions/);
    return menu;
}

/**
 * Wait until the file holds a custom height for exactly the source rows of
 * `on_screen`'s rows, each taller than the default, and the Edit menu offers
 * to undo it as one Auto-fit step; nothing said on the way.
 */
async function expect_fitted(file: string, on_screen: OnScreen): Promise<Record<string, number>> {
    const keys = Array.from(
        { length: on_screen.last - on_screen.first + 1 },
        (_, index) => String(on_screen.first + index + SOURCE_ROW_OF_FIRST_DISPLAY_ROW),
    ).sort();
    let heights: Record<string, number> = {};
    await expect.poll(async () => {
        heights = stored_heights(file) ?? {};
        return Object.keys(heights).sort();
    }, { message: 'the rows on screen, and only they, have custom heights' }).toEqual(keys);
    for (const height of Object.values(heights)) expect(height).toBeGreaterThan(ROW_HEIGHT_PX);
    await expect.poll(undo_label).toBe(`Undo Auto-fit ${keys.length} row heights`);
    expect(await take_dialogs(app!)).toEqual([]);
    return heights;
}

/**
 * Undo the fit, and wait until the file holds no custom height and the
 * Edit menu offers to redo it: the undo has landed, so the next gesture is
 * not asked to wait for it.
 */
async function undo_fit(page: Page, file: string, rows: number): Promise<void> {
    await history(page, 'undo');
    await expect_none(file);
    await expect.poll(redo_label).toBe(`Redo Auto-fit ${rows} row heights`);
    await expect.poll(undo_label).toBe('Undo');
}

async function expect_none(file: string): Promise<void> {
    await expect.poll(() => stored_heights(file), { message: 'no custom heights are stored' }).toEqual({});
}

test('Shift+Alt+H, the toolbar and the row menu fit the rows on screen as one step, at a scroll between rows', async () => {
    const { file, page } = await open_file('fit-visible.csv');
    await expect_none(file);
    // Half a row past row 40: rows partly on screen at the top and the bottom.
    const on_screen = await scroll_to(page, 40 * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2);
    await focus_grid(page, on_screen);

    await page.keyboard.press('Shift+Alt+KeyH');
    const fitted = await expect_fitted(file, on_screen);

    const rows = Object.keys(fitted).length;
    await undo_fit(page, file, rows);
    await history(page, 'redo');
    await expect.poll(() => stored_heights(file)).toEqual(fitted);
    await expect.poll(undo_label).toBe(`Undo Auto-fit ${rows} row heights`);

    // Nothing is fitted without the gesture: rows scrolled to keep their
    // height. The undo after this is the proof: size writes are stored one
    // at a time in order, so a fit of the rows at the end would be either a
    // step this undo takes back instead (leaving the visible fit stored) or
    // a height it leaves behind; either way the file would not end empty.
    await scroll_to_end(page);
    await expect.poll(() => stored_heights(file)).toEqual(fitted);
    expect(await undo_label()).toBe(`Undo Auto-fit ${rows} row heights`);
    expect(await take_dialogs(app!)).toEqual([]);

    // The toolbar's button, on the same rows.
    await undo_fit(page, file, rows);
    await scroll_to(page, on_screen.scroll_top);
    await page.getByRole('button', { name: 'Fit Visible Rows' }).click();
    expect(await expect_fitted(file, on_screen)).toEqual(fitted);

    // The row menu's item, from a row on screen.
    await undo_fit(page, file, rows);
    await scroll_to(page, on_screen.scroll_top);
    await choose(await open_row_menu_at(page, on_screen, on_screen.first + 3), 'Fit visible rows');
    expect(await expect_fitted(file, on_screen)).toEqual(fitted);
});

test('Shift+Alt+H at a scroll on a row boundary leaves out the row that ends at the header', async () => {
    const { file, page } = await open_file('fit-visible-aligned.csv');
    await expect_none(file);
    const on_screen = await scroll_to(page, 80 * ROW_HEIGHT_PX);
    expect(on_screen.first).toBe(80);
    await focus_grid(page, on_screen);

    await page.keyboard.press('Shift+Alt+KeyH');
    const fitted = await expect_fitted(file, on_screen);
    await undo_fit(page, file, Object.keys(fitted).length);
});
