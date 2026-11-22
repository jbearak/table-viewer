// Auto-fit Rows in the desktop app: the Auto-fit Columns menu's checked
// "Auto-fit Rows" item fits every row of the sheet, the rows never scrolled
// to included, as one step; chosen again, it puts back what the fit
// replaced, as another. Undo and redo leave the toggle as the
// gesture left it.
//
// What was fitted is read from the state database, keyed by source row (an
// unsorted CSV with a header line stores display row r under key r). No step
// needs the window focused: keys and clicks go to the page, and undo and
// redo arrive as the Edit menu sends them to the window. Every wait polls
// what the window shows or what the database holds.
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { history_menu_item, type HistoryMenuState } from '../main/history-menu-model';
import { hot_journal_present, isolated_user_data, state_database_path } from './smoke-helpers';
import {
    canvas_box,
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
    test_root = isolated_user_data('tv-auto-fit-rows-');
});

test.afterEach(async () => {
    if (app) await exit_app(app);
    app = undefined;
    fs.rmSync(test_root, { recursive: true, force: true });
});

const HEADER_HEIGHT_PX = 36;
const ROW_HEIGHT_PX = 24;
/** Far more rows than the grid loads without scrolling. */
const ROW_COUNT = 1_000;
/** Every fifth row is short and fits the default height, so it keeps none. */
const is_short = (row: number) => row % 5 === 0;
/** Wraps onto several lines in a 120 px column. */
const note = (row: number) => is_short(row)
    ? `ok ${row}`
    : `Row ${row} carries a note long enough to wrap onto several lines`;
const CSV = `Name,Note\n${Array.from({ length: ROW_COUNT }, (_, row) => `R${row},${note(row)}`).join('\n')}\n`;
const FITTED_ROWS = Array.from({ length: ROW_COUNT }, (_, row) => row)
    .filter((row) => !is_short(row))
    .map(String)
    .sort();

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
            return (JSON.parse(entry.state_json) as StoredState).rowHeights?.[0] ?? {};
        } catch {
            return undefined;
        } finally {
            database.close();
        }
    } catch {
        return undefined;
    }
}

async function history_label(which: 'undo' | 'redo'): Promise<string> {
    const state = await app!.evaluate(() => (globalThis as typeof globalThis & {
        __tableViewerSmokeHistory?: unknown;
    }).__tableViewerSmokeHistory) as HistoryMenuState | undefined;
    return history_menu_item(which, state).label;
}

/** Undo or redo, as the Edit menu sends it to the window. */
async function history(page: Page, command: 'undo' | 'redo'): Promise<void> {
    await page.evaluate((sent) => window.postMessage({ type: 'editCommand', command: sent }, '*'), command);
}

/** Select a cell near the top, which leaves keys with the grid. */
async function focus_grid(page: Page): Promise<void> {
    const box = await canvas_box(page);
    await page.mouse.click(box.x + 80, box.y + HEADER_HEIGHT_PX + 2 * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2);
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.closest('.grid-shell-root') !== null,
    ), { message: 'the grid has the keyboard' }).toBe(true);
}

/** The Auto-fit Columns menu's Auto-fit Rows item, with the menu open. */
async function rows_item(page: Page) {
    await page.locator('.toolbar-split-caret[aria-label="Auto-fit options"]').click();
    const item = page.getByRole('menuitemcheckbox', { name: /Auto-fit Rows/ });
    await expect(item).toBeVisible();
    return item;
}

async function expect_checked(page: Page, checked: boolean): Promise<void> {
    const item = await rows_item(page);
    await expect(item).toHaveAttribute('aria-checked', String(checked));
    await page.keyboard.press('Escape');
    await expect(item).toHaveCount(0);
    // Escape hands focus back to the chevron a moment later: wait for it, or
    // it would take focus from whatever is clicked next.
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.getAttribute('aria-label'),
    ), { message: 'Escape returns focus to the chevron' }).toBe('Auto-fit options');
}

/** Every row that wraps has a custom height taller than the default, the last row included. */
async function expect_fitted(file: string): Promise<Record<string, number>> {
    let heights: Record<string, number> = {};
    await expect.poll(async () => {
        heights = stored_heights(file) ?? {};
        return Object.keys(heights).sort();
    }, { message: 'every wrapping row has a custom height', timeout: 30_000 }).toEqual(FITTED_ROWS);
    for (const height of Object.values(heights)) expect(height).toBeGreaterThan(ROW_HEIGHT_PX);
    return heights;
}

async function expect_none(file: string): Promise<void> {
    await expect.poll(() => stored_heights(file), { message: 'no custom heights are stored' }).toEqual({});
}

test('Auto-fit Rows fits every row, puts back what it replaced, and walks history as pressed', async () => {
    const { file, page } = await open_file('auto-fit-rows.csv');
    await expect_none(file);
    await expect_checked(page, false);
    await focus_grid(page);

    await (await rows_item(page)).click();
    const fitted = await expect_fitted(file);
    await expect.poll(() => history_label('undo')).toBe('Undo Auto-fit rows');
    await expect(page.locator('.row-fit-progress')).toHaveCount(0);
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.closest('.grid-shell-root') !== null,
    ), { message: 'the grid has the keyboard back' }).toBe(true);
    await expect_checked(page, true);

    // Chosen again from its menu item: what the fit replaced comes back.
    await (await rows_item(page)).click();
    await expect_none(file);
    await expect.poll(() => history_label('undo')).toBe('Undo Restore row heights');
    await expect_checked(page, false);

    // Undo and redo leave the toggle as each gesture left it.
    await history(page, 'undo');
    await expect.poll(() => stored_heights(file)).toEqual(fitted);
    await expect.poll(() => history_label('undo')).toBe('Undo Auto-fit rows');
    await expect_checked(page, true);
    await history(page, 'undo');
    await expect_none(file);
    await expect.poll(() => history_label('redo')).toBe('Redo Auto-fit rows');
    await expect_checked(page, false);
    await history(page, 'redo');
    await expect.poll(() => stored_heights(file)).toEqual(fitted);
    await expect.poll(() => history_label('undo')).toBe('Undo Auto-fit rows');
    await expect_checked(page, true);

    expect(await take_dialogs(app!)).toEqual([]);
});
