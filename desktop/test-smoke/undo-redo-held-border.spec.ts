// New rows and columns that were resized, and borders held while Undo moves
// rows or columns, in the desktop app.
//
// The height of a new (unsaved) row and the width of a new column are kept
// on the row or column and are no step of their own. Undoing the insert
// takes the row or column away whatever size it was dragged to.
//
// A border names its row or column by where it is on screen. If Undo moves
// the rows or columns while the border is held, the drag is for a row or
// column that is not there any more, and its release resizes nothing.
//
// Each test reads the grid's accessibility table, what the Edit menu's Undo
// and Redo items read, and every message the app showed; a message the test
// does not name fails it. No assertion needs the window focused: undo and
// redo arrive as the Edit menu sends them to the window. Every wait polls
// what the window shows; none waits a fixed time.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { build_fixture_xlsx, cell, row } from '../../src/test/helpers/xlsx-structure-fixture';
import { history_menu_item, type HistoryMenuState } from '../main/history-menu-model';
import { isolated_user_data } from './smoke-helpers';
import {
    canvas_box,
    choose,
    exit_app,
    header_point,
    install_dialog_capture,
    install_history_menu_capture,
    launch_structural_viewer,
    open_column_menu,
    open_row_menu,
    select_column,
    take_dialogs,
    wait_for_grid,
} from './structure-helpers';

let test_root: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
    test_root = isolated_user_data('tv-undo-redo-held-border-');
});

test.afterEach(async () => {
    if (app) await exit_app(app);
    app = undefined;
    fs.rmSync(test_root, { recursive: true, force: true });
});

type Rows = readonly (readonly (string | number)[])[];

const ROWS: Rows = [
    ['Name', 'Age', 'City'],
    ['Alice', 30, 'New York'],
    ['Bob', 25, 'London'],
    ['Charlie', 35, 'Paris'],
    ['Dora', 28, 'Oslo'],
];
const CSV = `${ROWS.map((cells) => cells.join(',')).join('\n')}\n`;
const NATURAL = ['Alice|30|New York', 'Bob|25|London', 'Charlie|35|Paris', 'Dora|28|Oslo'];
const WITH_ROW = ['Alice|30|New York', '||', 'Bob|25|London', 'Charlie|35|Paris', 'Dora|28|Oslo'];

const fixture = (kind: 'csv' | 'xlsx'): string | Buffer => kind === 'csv'
    ? CSV
    : Buffer.from(build_fixture_xlsx({
        sheets: [{
            name: 'Data',
            body: `<sheetData>${ROWS.map((cells, index) =>
                row(index + 1, cells.map((value, column) => cell(`${'ABC'[column]}${index + 1}`, value))))
                .join('')}</sheetData>`,
        }],
    }));

async function open_file(name: string, content: string | Buffer): Promise<Page> {
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir, { recursive: true });
    const file = path.join(test_root, name);
    fs.writeFileSync(file, content);
    const launched = await launch_structural_viewer(user_data_dir, file);
    app = launched.app;
    await install_dialog_capture(app);
    await install_history_menu_capture(app);
    await wait_for_grid(launched.page);
    return launched.page;
}

// Glide's default header height, the row marker's width below 100 rows, and
// the app's default row height and column width at the default font size.
const HEADER_HEIGHT_PX = 36;
const ROW_MARKER_WIDTH_PX = 32;
const ROW_HEIGHT_PX = 24;
const COLUMN_WIDTH_PX = 120;

interface Shown {
    body: string[];
    headers: string[];
    undo: string;
    redo: string;
}

async function shown(page: Page): Promise<Shown> {
    const view = await page.evaluate(() => ({
        body: [...document.querySelectorAll('tbody tr')].map((line) =>
            [...line.querySelectorAll('td')].map((data) => data.textContent ?? '').join('|')),
        headers: [...document.querySelectorAll('thead th')].map((header) => header.textContent ?? '')
            .filter((text) => text !== ''),
    }));
    const menu = await app!.evaluate(() => (globalThis as typeof globalThis & {
        __tableViewerSmokeHistory?: unknown;
    }).__tableViewerSmokeHistory) as HistoryMenuState | undefined;
    return {
        ...view,
        undo: history_menu_item('undo', menu).label,
        redo: history_menu_item('redo', menu).label,
    };
}

/** Wait until the window shows `expected`, with nothing said that is not in `dialogs`. */
async function expect_shown(page: Page, expected: Partial<Shown>, dialogs: readonly string[] = []): Promise<void> {
    const said: string[] = [];
    await expect.poll(async () => {
        const now = await shown(page);
        said.push(...(await take_dialogs(app!)).map((dialog) => dialog.message ?? ''));
        const picked: Record<string, unknown> = {};
        for (const key of Object.keys(expected) as (keyof Shown)[]) picked[key] = now[key];
        return { ...picked, dialogs: [...said] };
    }).toEqual({ ...expected, dialogs: [...dialogs] });
}

/** Undo or redo, as the Edit menu sends it to the window. */
async function history(page: Page, command: 'undo' | 'redo'): Promise<void> {
    await page.evaluate((sent) => window.postMessage({ type: 'editCommand', command: sent }, '*'), command);
}

/**
 * Click a point of the grid, from its corner, and expect it to select the
 * cell `column`,`line`: how a test reads where a border is drawn without
 * asking the app. Aimed at a cell nothing before it selected: a second click
 * on the selected cell opens its editor.
 */
async function expect_cell_at(page: Page, x: number, y: number, column: number, line: number): Promise<void> {
    const box = await canvas_box(page);
    await page.mouse.click(box.x + x, box.y + y);
    await expect.poll(() => page.evaluate(() =>
        [...document.querySelectorAll('tbody td[aria-selected="true"]')].map((data) => data.id)))
        .toEqual([`glide-cell-${column + 1}-${line}`]);
    await expect(page.locator('.cell-editor-input')).toHaveCount(0);
}

/** Drag the bottom border of display row `line`, at the default height, by `dy`. */
async function drag_row_border(page: Page, line: number, dy: number): Promise<void> {
    const box = await canvas_box(page);
    const x = box.x + ROW_MARKER_WIDTH_PX + 40;
    const y = box.y + HEADER_HEIGHT_PX + (line + 1) * ROW_HEIGHT_PX - 2;
    await page.mouse.move(x, y + 12);
    await page.mouse.move(x, y);
    await expect(page.locator('.row-resize-strip')).toBeVisible();
    await page.mouse.down();
    await page.mouse.move(x, y + dy, { steps: 6 });
    await page.mouse.up();
}

/** Drag the right border of display column `column`, at the default widths, by `dx`. */
async function drag_column_border(page: Page, column: number, dx: number): Promise<void> {
    const box = await canvas_box(page);
    const x = box.x + ROW_MARKER_WIDTH_PX + (column + 1) * COLUMN_WIDTH_PX - 2;
    const y = box.y + HEADER_HEIGHT_PX / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 6 });
    await page.mouse.up();
}

async function sort_descending(page: Page, column: number): Promise<void> {
    const menu = await open_column_menu(page, column);
    const entry = menu.getByRole('menuitemcheckbox', { name: 'Sort descending' });
    await expect(entry).not.toHaveAttribute('aria-disabled', 'true');
    await entry.click();
    await expect(menu).toHaveCount(0);
}

/**
 * Show that the release recorded no step: a sort made after it, undone,
 * leaves nothing else to undo.
 */
async function expect_no_step_recorded(page: Page, shown_after: Partial<Shown>): Promise<void> {
    await sort_descending(page, 2);
    await expect_shown(page, { undo: 'Undo Sort' });
    await history(page, 'undo');
    await expect_shown(page, { ...shown_after, undo: 'Undo', redo: 'Redo Sort' });
}

for (const kind of ['csv', 'xlsx'] as const) {
    test(`${kind}: a new row made taller is taken away by Undo and brought back by Redo`, async () => {
        const page = await open_file(`taller.${kind}`, fixture(kind));
        await expect_shown(page, { body: NATURAL, undo: 'Undo', redo: 'Redo' });
        await choose(await open_row_menu(page, 1), 'Insert row above');
        await expect_shown(page, { body: WITH_ROW, undo: 'Undo Insert row' });

        await drag_row_border(page, 1, 30);
        // The new row now reaches past where its border was. In the second
        // column: the drag's own press selected the first.
        await expect_cell_at(page, ROW_MARKER_WIDTH_PX + COLUMN_WIDTH_PX + 10, HEADER_HEIGHT_PX + 2 * ROW_HEIGHT_PX + 10, 1, 1);
        // Its height is no step of its own.
        await expect_shown(page, { body: WITH_ROW, undo: 'Undo Insert row', redo: 'Redo' });

        await history(page, 'undo');
        await expect_shown(page, { body: NATURAL, undo: 'Undo', redo: 'Redo Insert row' });
        await history(page, 'redo');
        await expect_shown(page, { body: WITH_ROW, undo: 'Undo Insert row', redo: 'Redo' });
    });

    test(`${kind}: a new column made wider is taken away by Undo and brought back by Redo`, async () => {
        const page = await open_file(`wider.${kind}`, fixture(kind));
        await expect_shown(page, { headers: ['Name', 'Age', 'City'], undo: 'Undo', redo: 'Redo' });
        await choose(await open_column_menu(page, 0), 'Insert column right');
        const with_column = ['Name', 'New column', 'Age', 'City'];
        await expect_shown(page, { headers: with_column, undo: 'Undo Insert column' });

        await drag_column_border(page, 1, 60);
        // The new column now reaches past where its border was.
        await expect_cell_at(page, ROW_MARKER_WIDTH_PX + 2 * COLUMN_WIDTH_PX + 10, HEADER_HEIGHT_PX + ROW_HEIGHT_PX + 10, 1, 1);
        await expect_shown(page, { headers: with_column, undo: 'Undo Insert column', redo: 'Redo' });

        await history(page, 'undo');
        await expect_shown(page, { headers: ['Name', 'Age', 'City'], body: NATURAL, undo: 'Undo', redo: 'Redo Insert column' });
        await history(page, 'redo');
        await expect_shown(page, { headers: with_column, undo: 'Undo Insert column', redo: 'Redo' });
    });
}

for (const moved of [true, false]) {
    test(`a column border held while a column move is undone resizes nothing (${moved ? 'after' : 'before'} the pointer moves)`, async () => {
        const page = await open_file('column-border.csv', CSV);
        await expect_shown(page, { headers: ['Name', 'Age', 'City'] });
        // Move Age in front of Name.
        await select_column(page, 1);
        const from = await header_point(page, 1);
        const to = await header_point(page, 0);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x - 10, from.y, { steps: 5 });
        await page.mouse.move(to.x - 40, to.y, { steps: 5 });
        await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'held');
        await page.mouse.up();
        await expect_shown(page, { headers: ['Age', 'Name', 'City'], undo: 'Undo Move column' });

        // Hold the border between the first two columns, and undo the move with it held.
        const box = await canvas_box(page);
        const x = box.x + ROW_MARKER_WIDTH_PX + COLUMN_WIDTH_PX - 2;
        const y = box.y + HEADER_HEIGHT_PX / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        if (moved) await page.mouse.move(x + 20, y, { steps: 4 });
        await history(page, 'undo');
        await expect_shown(page, { headers: ['Name', 'Age', 'City'], undo: 'Undo', redo: 'Redo Move column' });
        await page.mouse.move(x + 50, y, { steps: 4 });
        await page.mouse.up();

        await expect_no_step_recorded(page, { headers: ['Name', 'Age', 'City'], body: NATURAL });
        // Name kept its width: a click just past where its border is by default is in Age.
        await expect_cell_at(page, ROW_MARKER_WIDTH_PX + COLUMN_WIDTH_PX + 10, HEADER_HEIGHT_PX + 2 * ROW_HEIGHT_PX + 10, 1, 2);
    });
}

test('a row border held while a row insert is undone resizes nothing', async () => {
    const page = await open_file('row-border.csv', CSV);
    await choose(await open_row_menu(page, 1), 'Insert row above');
    await expect_shown(page, { body: WITH_ROW, undo: 'Undo Insert row' });

    // Hold Bob's bottom border, and undo the insert with it held.
    const box = await canvas_box(page);
    const x = box.x + ROW_MARKER_WIDTH_PX + 40;
    const y = box.y + HEADER_HEIGHT_PX + 3 * ROW_HEIGHT_PX - 2;
    await page.mouse.move(x, y + 12);
    await page.mouse.move(x, y);
    await expect(page.locator('.row-resize-strip')).toBeVisible();
    await page.mouse.down();
    await page.mouse.move(x, y + 10, { steps: 4 });
    await history(page, 'undo');
    await expect_shown(page, { body: NATURAL, undo: 'Undo', redo: 'Redo Insert row' });
    await page.mouse.move(x, y + 30, { steps: 4 });
    await page.mouse.up();

    await expect_no_step_recorded(page, { body: NATURAL });
});
