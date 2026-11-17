// Inserting, deleting, restoring, and moving rows and columns in the desktop app
// (row and column structure design, "Integration and desktop smoke").
//
// Each test opens its own copy of a fixture in its own app, drives the shared
// webview by context menu, keyboard, and drag, checks the Edit menu's Undo label
// after each gesture, saves with the Save button, and reads the file back.
//
// No assertions that need the window focused, and no application-menu
// commands. Checking which element has focus inside the page is fine. The Undo labels are
// read from the history state the renderer reports for the Edit menu (see
// `install_history_menu_capture`). Restored drafts after a relaunch are in
// structure-relaunch.spec.ts.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { parse_xlsx } from '../../src/parse-xlsx';
import { CHANNEL_HOST_MESSAGE, CHANNEL_WEBVIEW_MESSAGE } from '../shared/ipc';
import { build_fixture_xlsx, cell, row } from '../../src/test/helpers/xlsx-structure-fixture';
import { isolated_user_data, read_workbook, repo_dir, state_database_path } from './smoke-helpers';
import {
    cell_point,
    choose,
    choose_from_submenu,
    open_cell_menu,
    save_button,
    wait_for_grid,
    exit_app,
    grid_headers,
    grid_rows,
    header_point,
    install_applied_snapshot_capture,
    install_dialog_capture,
    install_history_menu_capture,
    launch_structural_viewer,
    save_and_reread,
    save_changes,
    open_column_menu,
    open_row_menu,
    row_marker_point,
    save_screenshot,
    select_column,
    select_row,
    type_into_cell,
    undo_menu_label,
} from './structure-helpers';

let test_root: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
    test_root = isolated_user_data('tv-structure-smoke-');
});

test.afterEach(async () => {
    // A test that failed holding the host's messages would hold up the quit.
    if (app) {
        await app.evaluate(() => {
            const main = globalThis as typeof globalThis & {
                __held_host_messages?: { replay: () => void }[];
            };
            const held = main.__held_host_messages ?? [];
            main.__held_host_messages = undefined;
            for (const message of held) message.replay();
        }).catch(() => {});
    }
    if (app) await exit_app(app);
    app = undefined;
    fs.rmSync(test_root, { recursive: true, force: true });
});

/** Open `name` holding `content` in a fresh app, with dialogs and history captured. */
async function open_file(name: string, content: string | Buffer): Promise<{ file: string; page: Page }> {
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir);
    const file = path.join(test_root, name);
    fs.writeFileSync(file, content);
    const launched = await launch_structural_viewer(user_data_dir, file);
    app = launched.app;
    await install_dialog_capture(app);
    await install_history_menu_capture(app);
    await install_applied_snapshot_capture(app);
    return { file, page: launched.page };
}

async function expect_undo_label(label: string): Promise<void> {
    await expect.poll(() => undo_menu_label(app!), { timeout: 15_000 }).toBe(`Undo ${label}`);
}

/**
 * Close a cell menu by clicking its cell: a press outside the menu closes it,
 * with no focus needed. The menu opens with its corner at the cell's center,
 * so the click lands left of center, clear of the menu's edge. The menu only
 * listens for outside presses after a zero-delay timer, which a background
 * window throttles, so an early click can miss; click again until it closes.
 */
async function close_cell_menu(page: Page, column: number, row: number): Promise<void> {
    const point = await cell_point(page, column, row);
    await expect(async () => {
        await page.mouse.click(point.x - 40, point.y);
        await expect(page.locator('[role="menu"]')).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
}

test('CSV rows: insert, delete, restore, move by keyboard and drag, then save', async () => {
    const { file, page } = await open_file(
        'fruit.csv',
        'name,qty\napple,1\nbanana,2\ncherry,3\ndate,4\nelderberry,5\n',
    );
    await wait_for_grid(page);

    // Insert above banana; focus moves into the new row.
    await choose(await open_row_menu(page, 1), 'Insert row above');
    await expect.poll(() => grid_rows(page)).toEqual([
        '|apple|1',
        'Row 2, inserted||',
        '|banana|2',
        '|cherry|3',
        '|date|4',
        '|elderberry|5',
    ]);
    await expect_undo_label('Insert row');
    // The green row is the record: no banner pushes the grid down.
    await expect(page.locator('.pending-change-notices')).toHaveCount(0);
    await type_into_cell(page, 1, 1, 'kiwi');

    // Delete cherry, restore it, and delete it again. A Pending Row Removal
    // stays in place, read-only, without a row number.
    await choose(await open_row_menu(page, 3), 'Delete row');
    await expect.poll(() => grid_rows(page)).toContain('Row removed, was row 3|cherry|3');
    await expect(page.locator('#glide-cell-1-3')).toHaveAttribute('aria-readonly', 'true');
    await expect_undo_label('Delete row');
    await choose(await open_row_menu(page, 3), 'Restore row');
    await expect.poll(() => grid_rows(page)).toContain('|cherry|3');
    await expect_undo_label('Restore row');
    await choose(await open_row_menu(page, 3), 'Delete row');
    await expect.poll(() => grid_rows(page)).toContain('Row removed, was row 3|cherry|3');

    // Drag date and elderberry, selected as a block, above banana.
    await select_row(page, 4);
    await select_row(page, 5, true);
    const from = await row_marker_point(page, 4);
    const to = await row_marker_point(page, 2);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y - 30, { steps: 5 });
    await page.mouse.move(to.x, to.y - 8, { steps: 5 });
    await page.mouse.up();
    // Moved detection tints the fewest rows that explain the new order:
    // banana, not the two rows that were dragged.
    await expect.poll(() => grid_rows(page)).toEqual([
        '|apple|1',
        'Row 2, inserted|kiwi|',
        '|date|4',
        '|elderberry|5',
        'Row 5, moved from row 2|banana|2',
        'Row removed, was row 3|cherry|3',
    ]);
    await expect_undo_label('Move 2 rows');

    // Alt+Shift+Down moves apple below kiwi.
    await select_row(page, 0);
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await expect.poll(async () => (await grid_rows(page)).slice(0, 2)).toEqual([
        'Row 1, inserted|kiwi|',
        '|apple|1',
    ]);
    await expect_undo_label('Move row');
    // Save says what it will do, without naming the sheet a CSV file doesn't have.
    await save_button(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText(/^Save: 1 row inserted, 1 row deleted, \d+ rows? moved\.$/);
    await expect(page.locator('.pending-change-notices')).toHaveCount(0);
    await save_screenshot(page, '01-csv-rows-before-save');

    await save_changes(page);
    await expect.poll(() => fs.readFileSync(file, 'utf8'))
        .toBe('name,qty\nkiwi,\napple,1\ndate,4\nelderberry,5\nbanana,2\n');
    await expect.poll(() => grid_rows(page)).toEqual([
        '|kiwi|',
        '|apple|1',
        '|date|4',
        '|elderberry|5',
        '|banana|2',
    ]);
    // A structural save is a history barrier.
    await expect.poll(() => undo_menu_label(app!)).toBe('Undo');
});

test('the cell menu inserts, deletes, and restores rows and columns', async () => {
    const { file, page } = await open_file(
        'fruit.csv',
        'name,qty,price\napple,1,0.5\nbanana,2,0.25\ncherry,3,3\n',
    );
    await wait_for_grid(page);

    // Nothing is unsaved and no whole row is selected: a right-click on a
    // cell is enough to insert beside it.
    await choose_from_submenu(await open_cell_menu(page, 0, 1), 'Insert', 'Insert row above');
    await expect.poll(() => grid_rows(page)).toEqual([
        '|apple|1|0.5',
        'Row 2, inserted|||',
        '|banana|2|0.25',
        '|cherry|3|3',
    ]);
    await expect_undo_label('Insert row');

    await choose_from_submenu(await open_cell_menu(page, 2, 0), 'Insert', 'Insert column left');
    await expect.poll(() => grid_headers(page)).toEqual([
        '|name',
        '|qty',
        'Column C, inserted|New column',
        '|price',
    ]);
    await expect_undo_label('Insert column');

    // Delete qty from one of its cells, bring it back, and delete it again.
    await choose_from_submenu(await open_cell_menu(page, 1, 2), 'Delete', 'Delete column');
    await expect.poll(() => grid_headers(page)).toContain('Column removed, was qty|qty');
    await expect_undo_label('Delete column');
    await choose_from_submenu(await open_cell_menu(page, 1, 2), 'Delete', 'Restore column');
    await expect.poll(() => grid_headers(page)).toContain('|qty');
    await choose_from_submenu(await open_cell_menu(page, 1, 2), 'Delete', 'Delete column');
    await expect.poll(() => grid_headers(page)).toContain('Column removed, was qty|qty');

    // Delete cherry from its name cell.
    await choose_from_submenu(await open_cell_menu(page, 0, 3), 'Delete', 'Delete row');
    await expect.poll(() => grid_rows(page)).toContain('Row removed, was row 3|cherry|3||3');
    await expect_undo_label('Delete row');
    await save_screenshot(page, '10-cell-menu-before-save');

    await save_changes(page);
    await expect.poll(() => fs.readFileSync(file, 'utf8'))
        .toBe('name,New column,price\napple,,0.5\n,,\nbanana,,0.25\n');
});

test('a cell in a Pending Column, a Pending Row, or a Pending Appended Row has a menu', async () => {
    const { page } = await open_file('fruit.csv', 'name,qty\napple,1\nbanana,2\n');
    await wait_for_grid(page);

    await choose(await open_column_menu(page, 0), 'Insert column right');
    await expect.poll(() => grid_headers(page)).toEqual([
        '|name',
        'Column B, inserted|New column',
        '|qty',
    ]);
    await save_screenshot(page, 'pending-cell-menu-0-column-inserted');

    // With the Pending Column selected, its cell's Copy selection copies it.
    await select_column(page, 1);
    const point = await cell_point(page, 1, 0);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await choose(page.locator('[role="menu"]').first(), 'Copy selection');
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()))
        .toMatch(/^New column\r?\n/);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('th[aria-colindex="2"]')).not.toHaveAttribute('aria-selected', 'true');

    // A cell in the Pending Column has the cell menu. The column can't be
    // hidden until it is saved, and the cell inserts a row beside itself.
    const pending_column_menu = await open_cell_menu(page, 1, 0);
    await pending_column_menu.getByRole('menuitem', { name: 'Hide', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Hide column', exact: true }))
        .toHaveAttribute('aria-disabled', 'true');
    await save_screenshot(page, 'pending-cell-menu-1-pending-column');
    await choose_from_submenu(pending_column_menu, 'Insert', 'Insert row below');
    await expect.poll(() => grid_rows(page)).toEqual([
        '|apple||1',
        'Row 2, inserted|||',
        '|banana||2',
    ]);
    await expect_undo_label('Insert row');

    // A cell in the Pending Row, in a source column and in the Pending Column.
    await open_cell_menu(page, 0, 1);
    await save_screenshot(page, 'pending-cell-menu-2-pending-row');
    await close_cell_menu(page, 0, 1);
    await open_cell_menu(page, 1, 1);
    await save_screenshot(page, 'pending-cell-menu-3-pending-row-and-column');
    await close_cell_menu(page, 1, 1);

    // A cell in a Pending Appended Row, in the Pending Column, deletes the column.
    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Add row', exact: true }).click();
    await expect.poll(() => grid_rows(page)).toHaveLength(4);
    const appended_menu = await open_cell_menu(page, 1, 3);
    await save_screenshot(page, 'pending-cell-menu-4-appended-row-and-column');
    await choose_from_submenu(appended_menu, 'Delete', 'Delete column');
    await expect.poll(() => grid_headers(page)).toEqual(['|name', '|qty']);
    await expect_undo_label('Delete column');
});

test('a row drag and a column drag are the first edits to a file', async () => {
    const { file, page } = await open_file('fruit.csv', 'name,qty\napple,1\nbanana,2\ncherry,3\n');
    await wait_for_grid(page);

    // Nothing is unsaved, so the press itself has to bring the session the drop needs.
    await select_row(page, 2);
    const from = await row_marker_point(page, 2);
    const to = await row_marker_point(page, 0);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y - 10, { steps: 5 });
    await page.mouse.move(to.x, to.y - 8, { steps: 5 });
    // A drop is judged against the session, which a scripted drag can outrun.
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'held');
    await page.mouse.up();
    await expect_undo_label('Move row');
    // Past the read-back, which replaces the rows the column drag below starts on.
    await save_and_reread(app!, page);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('name,qty\ncherry,3\napple,1\nbanana,2\n');

    await expect(save_button(page)).toBeDisabled();
    await select_column(page, 1);
    const header_from = await header_point(page, 1);
    const header_to = await header_point(page, 0);
    await page.mouse.move(header_from.x, header_from.y);
    await page.mouse.down();
    await page.mouse.move(header_from.x - 10, header_from.y, { steps: 5 });
    await page.mouse.move(header_to.x - 40, header_to.y, { steps: 5 });
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'held');
    await page.mouse.up();
    await expect_undo_label('Move column');
    await save_changes(page);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('qty,name\n3,cherry\n1,apple\n2,banana\n');
});

test('TSV columns: insert, rename, delete, restore, move, then save', async () => {
    const { file, page } = await open_file(
        'fruit.tsv',
        'name\tqty\tprice\napple\t1\t0.5\nbanana\t2\t0.25\n',
    );
    await wait_for_grid(page);

    await choose(await open_column_menu(page, 1), 'Insert column right');
    await expect.poll(() => grid_headers(page)).toEqual([
        '|name',
        '|qty',
        'Column C, inserted|New column',
        '|price',
    ]);
    await expect_undo_label('Insert column');

    // Renaming refuses the name of a column deleted in this session.
    await choose(await open_column_menu(page, 3), 'Delete column');
    await expect.poll(() => grid_headers(page)).toContain('Column removed, was price|price');
    await expect_undo_label('Delete column');
    await choose(await open_column_menu(page, 2), 'Rename column…');
    const dialog = page.getByRole('dialog', { name: 'Rename column' });
    const name = dialog.getByLabel('Column name');
    await name.fill('price');
    await expect(dialog).toContainText(
        'A deleted column on this sheet is named price. Restore it or choose another name.',
    );
    await expect(dialog.getByRole('button', { name: 'Rename' })).toBeDisabled();
    await name.fill('notes');
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => grid_headers(page)).toContain('Column C, inserted|notes');
    await expect_undo_label('Rename column');
    await type_into_cell(page, 3, 0, 'ripe');

    await choose(await open_column_menu(page, 3), 'Restore column');
    await expect.poll(() => grid_headers(page)).toContain('|price');
    await expect_undo_label('Restore column');
    await choose(await open_column_menu(page, 3), 'Delete column');
    await expect.poll(() => grid_headers(page)).toContain('Column removed, was price|price');

    // Alt+Shift+Right moves name past qty.
    await select_column(page, 0);
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(async () => (await grid_headers(page)).slice(0, 2)).toEqual([
        '|qty',
        'Column B, moved from column A|name',
    ]);
    await expect_undo_label('Move column');
    await save_screenshot(page, '02-tsv-columns-before-save');

    await save_changes(page);
    await expect.poll(() => fs.readFileSync(file, 'utf8'))
        .toBe('qty\tname\tnotes\n1\tapple\tripe\n2\tbanana\t\n');
    await expect.poll(() => grid_headers(page)).toEqual(['|qty', '|name', '|notes']);
});

test('XLSX rows and columns: insert, delete, move, then save', async () => {
    const fixture = fs.readFileSync(path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx'));
    const { file, page } = await open_file('basic.xlsx', fixture);
    await wait_for_grid(page);
    await expect.poll(() => grid_headers(page)).toEqual(['|Name', '|Age', '|Active', '|Joined']);

    await choose(await open_row_menu(page, 0), 'Insert row below');
    await expect.poll(async () => (await grid_rows(page))[1]).toMatch(/^Row 3, inserted\|/);
    await expect_undo_label('Insert row');
    await type_into_cell(page, 1, 1, 'Cara');

    await choose(await open_column_menu(page, 2), 'Delete column');
    await expect.poll(() => grid_headers(page)).toContain('Column removed, was Active|Active');
    await expect_undo_label('Delete column');

    await choose(await open_column_menu(page, 0), 'Insert column left');
    await expect.poll(async () => (await grid_headers(page))[0]).toBe('Column A, inserted|New column');
    await expect_undo_label('Insert column');

    // Move Bob above Cara.
    await choose(await open_row_menu(page, 2), 'Move rows up');
    await expect.poll(async () => (await grid_rows(page)).map((row) => row.split('|')[2]))
        .toEqual(['Alice', 'Bob', 'Cara']);
    await expect_undo_label('Move row');
    await save_screenshot(page, '03-xlsx-before-save');

    await save_changes(page);
    const saved = async () => (await read_workbook(file))?.data.sheets[0].rows
        .map((row) => row.map((cell) => cell?.formatted ?? ''));
    await expect.poll(async () => (await saved())?.map((row) => row.slice(0, 3))).toEqual([
        ['New column', 'Name', 'Age'],
        ['', 'Alice', '30'],
        ['', 'Bob', '25'],
        ['', 'Cara', ''],
    ]);
    expect((await saved())?.[0]).toHaveLength(4);
});

test('an .xlsx formula recalculated before Save shows General digits, as it does after Save', async () => {
    // B1 = (A1+A2)/9 with no number format, cached at 17/9.
    const book = Buffer.from(build_fixture_xlsx({
        sheets: [{
            name: 'Data',
            body: `<sheetData>${[
                row(1, [cell('A1', 15), cell('B1', { f: 'SUM(A1:A2)/9', v: 17 / 9 })]),
                row(2, [cell('A2', 2)]),
            ].join('')}</sheetData>`,
        }],
    }));
    const { file, page } = await open_file('ninths.xlsx', book);
    await wait_for_grid(page);
    // A before and after doesn't fit the cell, so hovering shows the painted text.
    const hovered_formula = async () => {
        const formula_cell = await cell_point(page, 1, 0);
        await page.mouse.move(0, 0);
        await page.mouse.move(formula_cell.x, formula_cell.y);
        return page.getByRole('tooltip');
    };

    // A value edit: B1 becomes 19/9.
    await type_into_cell(page, 1, 0, '17');
    await expect(await hovered_formula()).toContainText('1.888888889 → ');
    await save_screenshot(page, '11-xlsx-recalculated-before-save');
    await expect(await hovered_formula()).toHaveText('1.888888889 → 2.111111111');

    // Save writes the result, and the file's cached value displays the same way.
    // Waited past the read-back: it replaces the rows, which would close the
    // cell menu opened below under its click.
    await save_and_reread(app!, page);
    await save_screenshot(page, '12-xlsx-recalculated-after-save');
    const parsed = await parse_xlsx(new Uint8Array(fs.readFileSync(file)));
    expect(parsed.data.sheets[0].rows[0][1]?.formatted).toBe('2.111111111');

    // A row inserted inside the SUM and typed into: B1 becomes 21/9.
    await choose_from_submenu(await open_cell_menu(page, 0, 1), 'Insert', 'Insert row above');
    await expect.poll(async () => (await grid_rows(page))[1]).toMatch(/^Row 2, inserted\|/);
    await type_into_cell(page, 1, 1, '2');
    await expect(await hovered_formula()).toContainText(' → ');
    await save_screenshot(page, '13-xlsx-row-change-recalculated');
    await expect(await hovered_formula()).toHaveText('2.111111111 → 2.333333333');
});

/**
 * Data: Item / Qty / Price / Total, with Total `=B*C` on rows 2-5, and an All
 * row summing Qty and Total. With `summary`, a Summary worksheet holding those
 * formulas in A1, A2, and so on.
 */
function totals_workbook(summary: readonly string[] = []): Buffer {
    const fruit: readonly (readonly [string, number, number])[] = [
        ['Apple', 3, 0.5], ['Banana', 5, 0.25], ['Cherry', 7, 2], ['Date', 9, 1.5],
    ];
    const rows = [
        row(1, ['Item', 'Qty', 'Price', 'Total'].map((value, column) => cell(`${'ABCD'[column]}1`, value))),
        ...fruit.map(([item, qty, price], index) => {
            const n = index + 2;
            return row(n, [
                cell(`A${n}`, item),
                cell(`B${n}`, qty),
                cell(`C${n}`, price),
                cell(`D${n}`, { f: `B${n}*C${n}`, v: qty * price }),
            ]);
        }),
        row(6, [
            cell('A6', 'All'),
            cell('B6', { f: 'SUM(B2:B5)', v: 24 }),
            cell('D6', { f: 'SUM(D2:D5)', v: 30.25 }),
        ]),
    ];
    const summary_rows = summary.map((formula, index) => row(index + 1, [cell(`A${index + 1}`, { f: formula, v: 0 })]));
    return Buffer.from(build_fixture_xlsx({
        sheets: [
            { name: 'Data', body: `<sheetData>${rows.join('')}</sheetData>` },
            ...(summary.length === 0 ? [] : [{ name: 'Summary', body: `<sheetData>${summary_rows.join('')}</sheetData>` }]),
        ],
    }));
}

async function canvas_top(page: Page): Promise<number> {
    const box = await page.locator('[data-testid="data-grid-canvas"]').first().boundingBox();
    if (!box) throw new Error('the grid canvas has no box');
    return box.y;
}

test('an .xlsx warns before Save only about formulas a change breaks, under the grid', async () => {
    const { page } = await open_file('totals.xlsx', totals_workbook());
    await wait_for_grid(page);
    await expect.poll(() => grid_headers(page)).toEqual(['|Item', '|Qty', '|Price', '|Total']);
    const notices = page.locator('.pending-change-notices');

    // A plain insert breaks nothing: the green row says it all.
    await choose(await open_row_menu(page, 1), 'Insert row below');
    await expect.poll(async () => (await grid_rows(page))[2]).toMatch(/^Row 4, inserted\|/);
    await expect(notices).toHaveCount(0);
    await save_screenshot(page, '11-xlsx-insert-no-notice');
    const top = await canvas_top(page);

    // Deleting Price breaks every Total formula. The warning comes without a
    // click, docked under the grid, so the grid doesn't move.
    await choose(await open_column_menu(page, 2), 'Delete column');
    const broken = page.getByRole('status', { name: 'Formulas that will show #REF!' });
    await expect(broken).toContainText(
        '4 formulas use column Price, which you deleted. After you save, they will show #REF!.',
        { timeout: 30_000 },
    );
    await expect(broken).toContainText('Restore the column, or undo, to keep them working.');
    expect(await canvas_top(page)).toBe(top);
    await broken.getByRole('button', { name: /^Show \d+ formulas$/ }).click();
    // Labelled the way the grid shows the cell: by its column's name and row number.
    await expect(broken.locator('li').first()).toContainText('Total, row 2');
    await expect(broken.locator('li').first()).toContainText('=B2*#REF!');
    await expect(broken.locator('li').first()).toContainText('was =B2*C2');
    await save_screenshot(page, '12-xlsx-ref-notice');
    // The All row sums those Totals, so it breaks too: counted, and listed last.
    await expect(broken).toContainText('1 more formula uses their results and will show #REF! too.');
    await expect(broken.locator('li')).toHaveCount(5);
    await expect(broken.locator('li').last()).toContainText('Total, row 7');
    await expect(broken.locator('li').last()).toContainText('Uses a #REF! result');

    await save_button(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Save: 1 row inserted, 1 column deleted.');
    await save_screenshot(page, '13-save-tooltip');

    // Restoring the column takes the warning away, and the grid stays put.
    await choose(await open_column_menu(page, 2), 'Restore column');
    await expect(notices).toHaveCount(0, { timeout: 30_000 });
    expect(await canvas_top(page)).toBe(top);
});

test('an .xlsx counts the formulas that use a broken one, on other worksheets too', async () => {
    const { page } = await open_file('totals.xlsx', totals_workbook(['Data!D6*2', 'ROUND(Data!D6,2)', 'IFERROR(Data!D6,0)']));
    await wait_for_grid(page);
    await choose(await open_column_menu(page, 2), 'Delete column');
    const broken = page.getByRole('status', { name: 'Formulas that will show #REF!' });
    await expect(broken).toContainText(
        '4 formulas use column Price, which you deleted. After you save, they will show #REF!.',
        { timeout: 30_000 },
    );
    await broken.getByRole('button', { name: /^Show \d+ formulas$/ }).click();
    await save_screenshot(page, '15-xlsx-ref-dependents');
    // The All row and Summary!A1 evaluate to #REF!. ROUND is outside what Table
    // Viewer calculates, so A2 might show an error; IFERROR catches it.
    await expect(broken).toContainText('2 more formulas use their results and will show #REF! too.');
    await expect(broken).toContainText(
        "Table Viewer can't calculate 1 more formula that uses their results, so it might show an error too.");
    const items = broken.locator('li');
    await expect(items).toHaveCount(7);
    await expect(items.nth(4)).toContainText('Total, row 6 on Data');
    await expect(items.nth(4)).toContainText('Uses a #REF! result');
    await expect(items.nth(5)).toContainText('Summary!A1');
    await expect(items.nth(5)).toContainText('=Data!C6*2');
    await expect(items.nth(6)).toContainText('Summary!A2');
    await expect(items.nth(6)).toContainText('Might show an error');
    await expect(broken).not.toContainText('IFERROR');

    // Go to cell on Summary switches to its tab and lands on the cell once
    // Summary's rows load. Summary shows the pending results; the notice
    // stays, now naming Data.
    await broken.getByRole('button', { name: 'Go to Summary!A2' }).click();
    const summary = page.getByRole('button', { name: 'Summary', exact: true });
    await expect(summary).toHaveClass(/active/);
    // The accessible cells count the row markers as column 0.
    const a2 = page.locator('#glide-cell-1-1');
    await expect(a2).toHaveAttribute('aria-selected', 'true');
    await expect(a2).toBeFocused();
    await expect(page.locator('.pending-change-notices-status')).toHaveCount(0);
    await expect.poll(async () => (await grid_rows(page)).length).toBe(3);
    await expect(broken).toContainText('4 formulas use column Price on Data, which you deleted.');
    await save_screenshot(page, '16-summary-pending-results');

    // And back, from the list still open: Total, row 3 on Data, past the
    // deleted Price column the grid keeps in place until Save.
    await broken.getByRole('button', { name: 'Go to Total, row 3 on Data' }).click();
    await expect(page.getByRole('button', { name: 'Data', exact: true })).toHaveClass(/active/);
    const total = page.locator('#glide-cell-4-1');
    await expect(total).toHaveAttribute('aria-selected', 'true');
    await expect(total).toBeFocused();
    await expect(page.locator('.pending-change-notices-status')).toHaveCount(0);
    await save_screenshot(page, '17-back-to-data');
});

test('an .xlsx formula that catches the #REF! a delete leaves is listed, not counted as showing it', async () => {
    const { page } = await open_file('totals.xlsx', totals_workbook(['IFERROR(Data!C2*2,0)']));
    await wait_for_grid(page);
    await choose(await open_column_menu(page, 2), 'Delete column');
    const broken = page.getByRole('status', { name: 'Formulas that will show #REF!' });
    await expect(broken).toContainText(
        '4 formulas use column Price, which you deleted. After you save, they will show #REF!.',
        { timeout: 30_000 },
    );
    await broken.getByRole('button', { name: /^Show \d+ formulas$/ }).click();
    await save_screenshot(page, '18-xlsx-iferror-deleted-reference');
    // Save writes #REF! into Summary!A1, but Excel shows its fallback, 0.
    await expect(broken).toContainText(
        '1 more formula uses the deleted column but catches the error, so it will show its fallback value instead.');
    const items = broken.locator('li');
    await expect(items).toHaveCount(6);
    await expect(items.last()).toContainText('Summary!A1');
    await expect(items.last()).toContainText('=IFERROR(Data!#REF!*2,0)');
    await expect(items.last()).toContainText('Shows its fallback value');

    await broken.getByRole('button', { name: 'Go to Summary!A1' }).click();
    await expect(page.getByRole('button', { name: 'Summary', exact: true })).toHaveClass(/active/);
    const a1 = page.locator('#glide-cell-1-0');
    await expect(a1).toHaveAttribute('aria-selected', 'true');
    await expect(a1).toBeFocused();
});

test('a move that changes a summed range says so before Save', async () => {
    const { page } = await open_file('totals.xlsx', totals_workbook());
    await wait_for_grid(page);

    // Apple, the first row of SUM(B2:B5), moves below Banana: Banana leaves
    // the range, where Excel would keep it.
    await select_row(page, 0);
    await choose(await open_row_menu(page, 0), 'Move rows down');
    await expect.poll(async () => (await grid_rows(page)).map((line) => line.split('|')[1]).slice(0, 2))
        .toEqual(['Banana', 'Apple']);
    const ranges = page.getByRole('status', { name: 'Formulas whose ranges changed' });
    await expect(ranges).toContainText('Moving rows changed the range in 2 formulas.', { timeout: 30_000 });
    await expect(ranges).toContainText('Excel might adjust them differently, so check them before you save.');
    await expect(ranges).toContainText('Qty, row 6');
    await expect(ranges).toContainText('=SUM(B3:B5)');
    await expect(ranges).toContainText('was =SUM(B2:B5)');
    await save_screenshot(page, '14-xlsx-range-notice');
});

test('moving the last row of a summed range up, then another row beside it, warns with the shrunken range', async () => {
    // Rows 2-5 summed in B7, a note in row 8. Row 5 (d) moves above row 4,
    // then the note moves above row 4 too: rows 2, 3, 5, 8, 4, 6, 7, and the
    // range ends on d, so it now sums a, b, and d.
    const amounts: readonly (readonly [string, number])[] = [['a', 3], ['b', 5], ['c', 9], ['d', 7]];
    const rows = [
        row(1, [cell('A1', 'Name'), cell('B1', 'Amount')]),
        ...amounts.map(([name, amount], index) => row(index + 2, [cell(`A${index + 2}`, name), cell(`B${index + 2}`, amount)])),
        row(7, [cell('A7', 'Total'), cell('B7', { f: 'SUM(B2:B5)', v: 24 })]),
        row(8, [cell('A8', 'Note')]),
    ];
    const book = Buffer.from(build_fixture_xlsx({ sheets: [{ name: 'Data', body: `<sheetData>${rows.join('')}</sheetData>` }] }));
    const { page } = await open_file('budget.xlsx', book);
    await wait_for_grid(page);
    await select_row(page, 3);
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await expect.poll(async () => (await grid_rows(page)).map((line) => line.split('|')[1]).slice(0, 4))
        .toEqual(['a', 'b', 'd', 'c']);
    await select_row(page, 6);
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Alt+Shift+ArrowUp');
    await expect.poll(async () => (await grid_rows(page)).map((line) => line.split('|')[1]))
        .toEqual(['a', 'b', 'd', 'Note', 'c', '', 'Total']);
    const ranges = page.getByRole('status', { name: 'Formulas whose ranges changed' });
    await expect(ranges).toContainText('=SUM(B2:B4)', { timeout: 30_000 });
    await expect(ranges).toContainText('was =SUM(B2:B5)');
    await save_screenshot(page, '16-xlsx-last-row-moved-range-notice');
});

test('a number in a Pending Column shows the format and digits it has after Save', async () => {
    // A holds numbers with no number format; B is formatted 0% (style 2).
    const book = Buffer.from(build_fixture_xlsx({
        sheets: [{
            name: 'Data',
            body: `<sheetData>${[
                row(1, [cell('A1', 19), cell('B1', 0.5, 2)]),
                row(2, [cell('A2', 1), cell('B2', 0.25, 2)]),
            ].join('')}</sheetData>`,
        }],
    }));
    const { file, page } = await open_file('ninths-pending.xlsx', book);
    await wait_for_grid(page);
    // A column right of B takes B's 0%; then one right of A takes A's General.
    await choose(await open_column_menu(page, 1), 'Insert column right');
    await expect.poll(async () => (await grid_headers(page)).length).toBe(3);
    await choose(await open_column_menu(page, 0), 'Insert column right');
    await expect.poll(async () => (await grid_headers(page)).length).toBe(4);
    await type_into_cell(page, 2, 0, '=A1/9');
    await type_into_cell(page, 4, 0, '=A1/9');
    await type_into_cell(page, 4, 1, '0.125');

    // Find matches what each cell paints: 19/9 as General and as 0%, 0.125 as 0%.
    const find_input = page.locator('input[aria-label="Find"]');
    const painted = async (text: string, column: number, row: number) => {
        if (await find_input.count() === 0) await page.keyboard.press('ControlOrMeta+F');
        await find_input.fill(text);
        await expect(page.locator(`#glide-cell-${column}-${row}`)).toHaveAttribute('aria-selected', 'true');
    };
    const not_painted = async (text: string) => {
        await find_input.fill(text);
        await expect(page.locator('.find-bar-status')).toHaveText('No matches');
    };
    const expect_painted = async () => {
        await painted('2.111111111', 2, 0);
        await not_painted('2.1111111111');
        await painted('211%', 4, 0);
        await painted('13%', 4, 1);
        await not_painted('0.125');
    };
    await save_screenshot(page, '14-xlsx-pending-column-before-save');
    await expect_painted();

    await save_changes(page);
    await expect_painted();
    await save_screenshot(page, '15-xlsx-pending-column-after-save');
    // The file gives D1 and D2 B's 0% and B1 no format. Save writes a new
    // formula with no cached value, so the reader has no digits to show for it.
    const [first, second] = (await parse_xlsx(new Uint8Array(fs.readFileSync(file)))).data.sheets[0].rows;
    expect([first[1]?.formula, first[1]?.numberFormat?.code]).toEqual(['=A1/9', undefined]);
    expect([first[3]?.formula, first[3]?.numberFormat?.code]).toEqual(['=A1/9', '0%']);
    expect(second[3]?.formatted).toBe('13%');
});

test('a 16-digit integer shows as General shows it, and auto-fit measures what cells show', async () => {
    // A holds plain numbers and B text, neither with a number format.
    const book = Buffer.from(build_fixture_xlsx({
        sheets: [{
            name: 'Data',
            body: `<sheetData>${[
                row(1, [cell('A1', 1), cell('B1', 'x')]),
                row(2, [cell('A2', 12), cell('B2', 'y')]),
            ].join('')}</sheetData>`,
        }],
    }));
    const { file, page } = await open_file('large-integers.xlsx', book);
    await wait_for_grid(page);
    await choose(await open_column_menu(page, 0), 'Insert column right');
    await expect.poll(async () => (await grid_headers(page)).length).toBe(3);
    // 1E+15 and 12 * 102880657510288 = 1234567890123456, 1.23457E+15 to 15 digits.
    await type_into_cell(page, 2, 0, '=A1*1000000000000000');
    await type_into_cell(page, 2, 1, '=A2*102880657510288');
    // 2e15 is a number; 1234567890123456 would lose its last digit, so it stays text.
    await type_into_cell(page, 3, 0, '2e15');
    await type_into_cell(page, 3, 1, '1234567890123456');

    const find_input = page.locator('input[aria-label="Find"]');
    // Find searches once per query, and a result arrives some time after the
    // edit that asks for it, so search again until it matches.
    const painted = async (text: string, column: number, row: number) => {
        if (await find_input.count() === 0) await page.keyboard.press('ControlOrMeta+F');
        await expect(async () => {
            await find_input.fill('');
            await find_input.fill(text);
            await expect(page.locator(`#glide-cell-${column}-${row}`))
                .toHaveAttribute('aria-selected', 'true', { timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
    };
    const not_painted = async (text: string) => {
        await find_input.fill(text);
        await expect(page.locator('.find-bar-status')).toHaveText('No matches');
    };
    // The painted checks come first, so the absent ones run on settled results.
    const expect_painted = async () => {
        await painted('1E+15', 2, 0);
        await painted('1.23457E+15', 2, 1);
        await painted('2E+15', 3, 0);
        await painted('1234567890123456', 3, 1);
        await not_painted('1000000000000000');
        await not_painted('1234567890123460');
    };
    await expect_painted();
    // Fitted to 1.23457E+15 and 1234567890123456, as painted; see the screenshots.
    await page.getByRole('button', { name: 'Auto-fit Columns' }).click();
    await expect_painted();
    await save_screenshot(page, '17-xlsx-large-integers-fitted-before-save');

    await save_changes(page);
    await expect_painted();
    await save_screenshot(page, '18-xlsx-large-integers-after-save');
    const [first, second] = (await parse_xlsx(new Uint8Array(fs.readFileSync(file)))).data.sheets[0].rows;
    expect([first[2]?.raw, first[2]?.formatted]).toEqual([2e15, '2E+15']);
    expect(second[2]?.raw).toBe('1234567890123456');
});

test('auto-fit makes room for a long value in an inserted row and an appended row, before and after Save', async () => {
    const { file, page } = await open_file(
        'fruit.csv',
        'name,qty,note,x,y,z\napple,1,a,1,1,1\nbanana,2,b,2,2,2\n',
    );
    await wait_for_grid(page);
    const auto_fit = page.getByRole('button', { name: 'Auto-fit Columns' });
    /** Fit again: the button restores the widths while a fit is on. */
    const fit = async () => {
        if (await auto_fit.getAttribute('aria-pressed') === 'true') {
            await auto_fit.click();
            await expect(auto_fit).toHaveAttribute('aria-pressed', 'false');
        }
        await auto_fit.click();
        await expect(auto_fit).toHaveAttribute('aria-pressed', 'true');
    };
    /**
     * Whether column A (name) is at least `width` px wide: a click that far
     * into apple's row lands in its name cell. A click on banana's name first
     * moves the selection off it, so a click past the grid's last column
     * can't leave it there. While Save remounts the grid there is no canvas
     * to click, which reads as "not yet" so the caller's poll tries again.
     */
    const name_reaches = async (width: number, banana_row: number): Promise<boolean> => {
        const apple = await cell_point(page, 0, 0).catch(() => undefined);
        const banana = await cell_point(page, 0, banana_row).catch(() => undefined);
        if (apple === undefined || banana === undefined) return false;
        await page.mouse.click(banana.x - 50, banana.y);
        const moved_off = await expect(page.locator(`#glide-cell-1-${banana_row}`))
            .toHaveAttribute('aria-selected', 'true', { timeout: 2_000 }).then(() => true, () => false);
        if (!moved_off) return false;
        await page.mouse.click(apple.x - 60 + width, apple.y);
        return expect.poll(() => page.locator('#glide-cell-1-0').getAttribute('aria-selected'), { timeout: 2_000 })
            .toBe('true').then(() => true, () => false);
    };

    // The probe's click leaves a tooltip under the pointer; move it aside first.
    const screenshot = async (name: string) => {
        await page.mouse.move(1, 1);
        await save_screenshot(page, name);
    };

    // About 300 px of text in an inserted row, under banana's 6 characters.
    await choose(await open_row_menu(page, 1), 'Insert row above');
    await expect.poll(async () => (await grid_rows(page))[1]).toBe('Row 2, inserted||||||');
    const inserted = 'a long value typed into an inserted row, not cut off';
    await type_into_cell(page, 1, 1, inserted);
    await fit();
    await expect.poll(() => name_reaches(220, 2), { timeout: 15_000 }).toBe(true);
    await screenshot('19-inserted-row-fitted');

    // About 550 px in an appended row, wider than the inserted row's value.
    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Add row', exact: true }).click();
    await expect.poll(() => grid_rows(page)).toHaveLength(4);
    const appended = 'a much longer value typed into an appended row, which auto-fit has to make room for too';
    await type_into_cell(page, 1, 3, appended);
    await fit();
    await expect.poll(() => name_reaches(420, 2), { timeout: 15_000 }).toBe(true);
    await screenshot('20-appended-row-fitted');

    // Saved, the rows are source rows: the fit made before Save still holds,
    // and fitting again makes room for both.
    await save_changes(page);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain(appended);
    await expect.poll(() => name_reaches(420, 2), { timeout: 15_000 }).toBe(true);
    await screenshot('21-inserted-and-appended-after-save');
    await fit();
    await expect.poll(() => name_reaches(420, 2), { timeout: 15_000 }).toBe(true);
    await screenshot('22-inserted-and-appended-fitted-after-save');
});

test('an external change conflicts, and both salvage actions resolve it', async () => {
    const { file, page } = await open_file(
        'fruit.csv',
        'name,qty\napple,1\nbanana,2\ncherry,3\ndate,4\n',
    );
    await wait_for_grid(page);

    // Insert a row and a column, type into both, and delete a row.
    await choose(await open_row_menu(page, 1), 'Insert row above');
    await expect.poll(async () => (await grid_rows(page))[1]).toBe('Row 2, inserted||');
    await type_into_cell(page, 1, 1, 'kiwi');
    await choose(await open_column_menu(page, 1), 'Insert column right');
    await expect.poll(() => grid_headers(page)).toContain('Column C, inserted|New column');
    await type_into_cell(page, 3, 0, 'crisp');
    await choose(await open_row_menu(page, 3), 'Delete row');
    await expect.poll(() => grid_rows(page)).toContain('Row removed, was row 3|cherry|3|');

    // Another program rewrites a value in place: not an append, so the layout
    // can't be placed in the new file.
    fs.writeFileSync(file, 'name,qty\napple,10\nbanana,2\ncherry,3\ndate,4\n');
    const review = page.getByRole('alert', { name: 'Row and column changes that need review' });
    await expect(review).toContainText(
        'Sheet1 changed on disk after you inserted, deleted, or moved rows or columns.',
        { timeout: 30_000 },
    );
    await expect(review).toContainText("Table Viewer can't tell where those changes belong in the new version.");
    await expect(review).toContainText('Values typed in 1 new column will be discarded.');
    await save_screenshot(page, '04-conflict-review');

    // Keep new rows at the end: kiwi becomes an appended row after the new
    // file's rows; the removal and the new column are dropped.
    await review.getByRole('button', { name: 'Keep new rows at the end' }).click();
    await expect(review).toHaveCount(0);
    await expect.poll(async () => (await grid_rows(page)).map((row) => row.split('|').slice(1).join('|')))
        .toEqual(['apple|10', 'banana|2', 'cherry|3', 'date|4', 'kiwi|']);
    await expect.poll(() => grid_headers(page)).toEqual(['|name', '|qty']);
    await save_screenshot(page, '05-kept-new-rows-at-end');
    // Past the read-back, which would close the row menu opened below.
    await save_and_reread(app!, page);
    await expect.poll(() => fs.readFileSync(file, 'utf8'))
        .toBe('name,qty\napple,10\nbanana,2\ncherry,3\ndate,4\nkiwi,\n');

    // Discard row and column changes: the source layout comes back.
    await wait_for_grid(page);
    await choose(await open_row_menu(page, 0), 'Delete row');
    await expect.poll(async () => (await grid_rows(page))[0]).toBe('Row removed, was row 1|apple|10');
    fs.writeFileSync(file, 'name,qty\napple,11\nbanana,2\ncherry,3\ndate,4\nkiwi,\n');
    await expect(review).toBeVisible({ timeout: 30_000 });
    await review.getByRole('button', { name: 'Discard row and column changes on Sheet1' }).click();
    await expect(review).toHaveCount(0);
    await expect.poll(async () => (await grid_rows(page))[0]).toBe('|apple|11');
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/);
    await save_screenshot(page, '06-discarded-layout');
    expect(fs.readFileSync(file, 'utf8'))
        .toBe('name,qty\napple,11\nbanana,2\ncherry,3\ndate,4\nkiwi,\n');
});

test('the row menu of an .xlsx with nothing unsaved still makes a row the header', async () => {
    const book = Buffer.from(build_fixture_xlsx({
        sheets: [{
            name: 'Data',
            body: `<sheetData>${[[1, 2], ['name', 'qty'], [5, 6], [7, 8]].map((cells, index) =>
                row(index + 1, cells.map((value, column) => cell(`${'AB'[column]}${index + 1}`, value))))
                .join('')}</sheetData>`,
        }],
    }));
    const { page } = await open_file('late-header.xlsx', book);
    await wait_for_grid(page);

    // The menu holds an editing session for its insert and delete items; with
    // nothing unsaved that must not take the header item away.
    await choose(await open_row_menu(page, 1), 'Use row as header');
    await expect.poll(async () => (await grid_headers(page)).map((header) => header.split('|')[1]))
        .toEqual(['name', 'qty']);
    await expect(save_button(page)).toBeDisabled();
});

test('an external edit that turns on an .xlsx Header Row conflicts, and Keep new rows at the end saves', async () => {
    // No detected header while row 1 holds numbers; text in row 1 turns one on,
    // which moves the body start under the layout.
    const book = (first: readonly [string | number, string | number]) => Buffer.from(build_fixture_xlsx({
        sheets: [{
            name: 'Data',
            body: `<sheetData>${[first, [3, 4], [5, 6], [7, 8]].map((cells, index) =>
                row(index + 1, cells.map((value, column) => cell(`${'AB'[column]}${index + 1}`, value))))
                .join('')}</sheetData>`,
        }],
    }));
    const { file, page } = await open_file('numbers.xlsx', book([1, 2]));
    await wait_for_grid(page);
    await expect.poll(async () => (await grid_rows(page)).map((line) => line.split('|')[1]))
        .toEqual(['1', '3', '5', '7']);

    await choose(await open_row_menu(page, 0), 'Insert row below');
    await expect.poll(async () => (await grid_rows(page))[1]).toBe('Row 2, inserted||');
    await type_into_cell(page, 1, 1, '9');
    await choose(await open_row_menu(page, 2), 'Delete row');
    await expect.poll(() => grid_rows(page)).toContain('Row removed, was row 2|3|4');

    fs.writeFileSync(file, book(['x', 'y']));
    const review = page.getByRole('alert', { name: 'Row and column changes that need review' });
    await expect(review).toContainText('Data changed on disk after you inserted, deleted, or moved rows or columns.',
        { timeout: 30_000 });
    // Editing still works while the notice is up, and the edit is durable:
    // the flush republishes the layout against the body start it was
    // authored at, so the host accepts it.
    await type_into_cell(page, 2, 1, 'typed-under-conflict');
    await expect.poll(() => fs.readFileSync(state_database_path(path.join(test_root, 'user-data')))
        .includes('typed-under-conflict'), { timeout: 30_000 }).toBe(true);
    await save_screenshot(page, '09-xlsx-header-conflict');

    await review.getByRole('button', { name: 'Keep new rows at the end' }).click();
    await expect(review).toHaveCount(0);
    await expect.poll(async () => (await grid_rows(page)).map((line) => line.split('|').slice(1).join('|')))
        .toEqual(['3|4', '5|6', '7|8', '9|typed-under-conflict']);
    await save_changes(page);
    const saved = async () => (await read_workbook(file))?.data.sheets[0].rows
        .map((cells) => cells.map((value) => value?.formatted ?? ''));
    await expect.poll(saved)
        .toEqual([['x', 'y'], ['3', '4'], ['5', '6'], ['7', '8'], ['9', 'typed-under-conflict']]);
});

test('a conflict notice counts a formula that catches the #REF! a salvage action leaves apart from those that show it', async () => {
    const book = (first: number) => Buffer.from(build_fixture_xlsx({
        sheets: [{
            name: 'Data',
            body: `<sheetData>${[[first, 'x'], [3, 'y'], [5, 'z']].map((cells, index) =>
                row(index + 1, cells.map((value, column) => cell(`${'AB'[column]}${index + 1}`, value))))
                .join('')}</sheetData>`,
        }],
    }));
    const { file, page } = await open_file('salvage.xlsx', book(1));
    await wait_for_grid(page);

    // A new column B, and two formulas in C that use it: one catches errors.
    await choose(await open_column_menu(page, 0), 'Insert column right');
    await expect.poll(async () => (await grid_headers(page)).length).toBe(3);
    await type_into_cell(page, 2, 0, '10');
    await type_into_cell(page, 3, 0, '=IFERROR(B1*2,0)');
    await type_into_cell(page, 3, 1, '=B1*2');

    // Another program changes a value in place, so the layout conflicts. Both
    // salvage actions drop the new column, and Save writes #REF! into both
    // formulas, but the IFERROR shows its fallback value, 0.
    fs.writeFileSync(file, book(2));
    const review = page.getByRole('alert', { name: 'Row and column changes that need review' });
    await expect(review).toContainText('Data changed on disk after you inserted, deleted, or moved rows or columns.',
        { timeout: 30_000 });
    await expect(review).toContainText('Discard row and column changes on Data: ', { timeout: 30_000 });
    await save_screenshot(page, '19-xlsx-conflict-iferror');
    const counts = 'will show #REF! and 1 will show its fallback value because it catches the error.';
    await expect(review).toContainText(`Discard row and column changes on Data: 1 formula ${counts}`);
    await expect(review).toContainText(`Keep new rows at the end: 1 formula ${counts}`);
    await expect(review).not.toContainText('2 formulas will show #REF!');
});

test('a context menu opened and dismissed is no edit', async () => {
    const { file, page } = await open_file('fruit.csv', 'name,qty\napple,1\nbanana,2\n');
    await wait_for_grid(page);
    const root = page.locator('.grid-shell-root');
    const menus = page.locator('[role="menu"]');
    for (const open of [
        () => open_cell_menu(page, 0, 0),
        () => open_column_menu(page, 1),
        () => open_row_menu(page, 1),
    ]) {
        await open();
        // The menu holds the session so its Insert and Delete act on the first
        // click, and the session alone is no edit: nothing offers to save it,
        // drop it, or show a before and after.
        await expect(root).toHaveAttribute('data-edit-session', 'held');
        await expect(save_button(page)).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Diff' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Discard' })).toHaveCount(0);
        const label = await menus.getAttribute('aria-label');
        await page.keyboard.press('Escape');
        await expect(menus, `Escape closes ${label}`).toHaveCount(0);
        await expect(root).toHaveAttribute('data-edit-session', 'none');
        // Escape gives focus back to the grid on a timer, which a background
        // window can hold back past the next right-click; wait it out, or it
        // takes focus from the next menu.
        await expect.poll(() => page.evaluate(
            () => document.activeElement?.closest('.grid-shell-root') != null,
        )).toBe(true);
    }
    await expect(save_button(page)).toBeDisabled();
    expect(fs.readFileSync(file, 'utf8')).toBe('name,qty\napple,1\nbanana,2\n');
});

test('Escape closes a workbook row menu that gains "Use row as header" as it opens', async () => {
    const { page } = await open_file(
        'basic.xlsx',
        fs.readFileSync(path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx')),
    );
    await wait_for_grid(page);
    const menu = await open_row_menu(page, 0);
    // Offered once the session arrives, above the item the menu focused on opening.
    await expect(menu.getByRole('menuitem', { name: 'Use row as header', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.closest('[role="menu"]') != null,
    )).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
    await expect(page.getByRole('button', { name: 'Diff' })).toHaveCount(0);
});

/**
 * Record, from the page, whether the grid holds the editing session at any
 * moment from now on. A release that never comes cannot be told apart from a
 * grant still on its way by polling for 'none' alone; seen held first, it can.
 */
async function watch_session_held(page: Page): Promise<void> {
    await page.evaluate(() => {
        const state = window as typeof window & { __session_held_seen?: boolean };
        state.__session_held_seen = false;
        const held = () => document.querySelector('.grid-shell-root[data-edit-session="held"]') !== null;
        new MutationObserver((records) => {
            if (held() || records.some((record) => record.oldValue === 'held')) state.__session_held_seen = true;
        }).observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['data-edit-session'],
            attributeOldValue: true,
        });
        if (held()) state.__session_held_seen = true;
    });
}

/** The session the gesture acquired was held, and has been let go. */
async function expect_session_let_go(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(
        () => (window as typeof window & { __session_held_seen?: boolean }).__session_held_seen,
    ), { timeout: 15_000 }).toBe(true);
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
}

test('a click on a selected row number or column header, released before the session arrives, is no edit', async () => {
    const { file, page } = await open_file('fruit.csv', 'name,qty\napple,1\nbanana,2\n');
    await wait_for_grid(page);
    const root = page.locator('.grid-shell-root');
    for (const [select, point] of [
        [() => select_row(page, 1), () => row_marker_point(page, 1)],
        [() => select_column(page, 1), () => header_point(page, 1)],
    ] as const) {
        await select();
        await expect(root).toHaveAttribute('data-edit-session', 'none');
        await watch_session_held(page);
        // Pressed and released at once: the press may be a drag, so it asks
        // for the session, and the button is up before the host answers.
        const { x, y } = await point();
        await page.mouse.click(x, y);
        await expect_session_let_go(page);
    }
    await expect(save_button(page)).toBeDisabled();
    expect(fs.readFileSync(file, 'utf8')).toBe('name,qty\napple,1\nbanana,2\n');
});

test('Escape the moment a context menu opens is no edit', async () => {
    const { file, page } = await open_file('fruit.csv', 'name,qty\napple,1\nbanana,2\n');
    await wait_for_grid(page);
    const root = page.locator('.grid-shell-root');
    for (const open of [
        () => open_cell_menu(page, 0, 0),
        () => open_column_menu(page, 1),
        () => open_row_menu(page, 1),
    ]) {
        await expect(root).toHaveAttribute('data-edit-session', 'none');
        await watch_session_held(page);
        await open();
        // No wait for the session the menu asked for: Escape closes the menu first.
        await page.keyboard.press('Escape');
        await expect(page.locator('[role="menu"]')).toHaveCount(0);
        await expect_session_let_go(page);
        // Escape gives focus back to the grid on a timer; wait it out, or it
        // takes focus from the next menu.
        await expect.poll(() => page.evaluate(
            () => document.activeElement?.closest('.grid-shell-root') != null,
        )).toBe(true);
    }
    await expect(save_button(page)).toBeDisabled();
    expect(fs.readFileSync(file, 'utf8')).toBe('name,qty\napple,1\nbanana,2\n');
});

test('Enter on an unchanged column name closes the Rename column dialog', async () => {
    const { page } = await open_file(
        'basic.xlsx',
        fs.readFileSync(path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx')),
    );
    await wait_for_grid(page);
    await choose(await open_column_menu(page, 1), 'Rename column…');
    const dialog = page.getByRole('dialog', { name: 'Rename column' });
    await expect(dialog.getByLabel('Column name')).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Rename' })).toBeDisabled();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
    await expect(save_button(page)).toBeDisabled();
});

test('a workbook row copied with Copy and pasted onto itself is no edit', async () => {
    const fixture = fs.readFileSync(path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx'));
    const { file, page } = await open_file('basic.xlsx', fixture);
    await wait_for_grid(page);
    // What the webview tells the host, as the main process receives it.
    await app!.evaluate(({ ipcMain }) => {
        const sent: string[] = [];
        (globalThis as { webview_messages?: string[] }).webview_messages = sent;
        ipcMain.on('tableViewer:webviewMessage', (_event, envelope: { message: { type: string } }) => {
            sent.push(envelope.message.type);
        });
    });
    const sent_types = () => app!.evaluate(() => (globalThis as { webview_messages?: string[] }).webview_messages!);

    const marker = await row_marker_point(page, 1);
    await page.mouse.click(marker.x, marker.y);
    // The Edit menu's Copy, as it reaches the window. Other runs share the OS
    // clipboard, so start it at a value of this test's own and wait for Copy
    // to replace it.
    const sentinel = `structure-smoke-${process.pid}-${Date.now()}`;
    await app!.evaluate(({ clipboard }, text) => clipboard.writeText(text), sentinel);
    await page.evaluate(() => window.postMessage({ type: 'editCommand', command: 'copy' }, '*'));
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).not.toBe(sentinel);
    // The Joined cell is a date, and Copy writes what it shows.
    const copied = await app!.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toBe('Bob\t25\tFALSE\t6/1/23');

    // Paste that text back, as Cmd/Ctrl+V delivers it, carried on the event
    // so another run's copy cannot replace it first.
    const before = (await sent_types()).length;
    await page.evaluate((text) => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    }, copied);
    // The paste has run once it lets go of the session it asked for, or once
    // it left an edit, which keeps the session.
    const paste_settled = async () => {
        const types = (await sent_types()).slice(before);
        const requested = types.indexOf('requestEditSession');
        return (requested >= 0 && types.indexOf('releaseEditSession', requested) > requested)
            || /has-unsaved/.test(await save_button(page).getAttribute('class') ?? '');
    };
    await expect.poll(paste_settled).toBe(true);
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/);
    await expect(save_button(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Diff' })).toHaveCount(0);
    expect(fs.readFileSync(file).equals(fixture)).toBe(true);
});

/**
 * Record, from the page, every list of items a context menu shows from now
 * on, and where each item sat the first time it was shown. Installed before
 * the right-click, so the first list the menu renders is caught too.
 */
async function watch_menu_items(page: Page): Promise<void> {
    await page.evaluate(() => {
        type Watch = { lists: string[][]; first_rects: Record<string, number> };
        const state = window as typeof window & { __menu_watch?: Watch; __menu_observer?: MutationObserver };
        state.__menu_observer?.disconnect();
        const watch: Watch = { lists: [], first_rects: {} };
        state.__menu_watch = watch;
        const record = () => {
            const menu = document.querySelector('[role="menu"]');
            if (menu === null) return;
            const items = [...menu.querySelectorAll('.context-menu-item')];
            const labels = items.map((item) => item.querySelector('.context-menu-label')?.textContent ?? '');
            const last = watch.lists.at(-1);
            if (last !== undefined && last.join('\n') === labels.join('\n')) return;
            watch.lists.push(labels);
            items.forEach((item, index) => {
                const label = labels[index]!;
                if (!(label in watch.first_rects)) watch.first_rects[label] = item.getBoundingClientRect().top;
            });
        };
        state.__menu_observer = new MutationObserver(record);
        state.__menu_observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        // A menu already open is its first list.
        record();
    });
}

/**
 * Hold everything the host sends the page from now on, until
 * `release_host_messages` delivers it in order.
 */
async function hold_host_messages(): Promise<void> {
    await app!.evaluate(({ webContents }, channel) => {
        const main = globalThis as typeof globalThis & {
            __held_host_messages?: { type?: string; replay: () => void }[];
            __host_send_wrapped?: WeakSet<object>;
        };
        main.__held_host_messages = [];
        main.__host_send_wrapped ??= new WeakSet();
        for (const contents of webContents.getAllWebContents()) {
            if (main.__host_send_wrapped.has(contents)) continue;
            main.__host_send_wrapped.add(contents);
            const send = contents.send.bind(contents);
            contents.send = (sent_channel: string, ...args: unknown[]) => {
                const held = main.__held_host_messages;
                if (sent_channel !== channel || held === undefined) return send(sent_channel, ...args);
                held.push({
                    type: (args[0] as { message?: { type?: string } }).message?.type,
                    replay: () => send(sent_channel, ...args),
                });
            };
        }
    }, CHANNEL_HOST_MESSAGE);
}

/** Wait until a held host message of `type` is among those held. */
async function expect_host_message_held(type: string): Promise<void> {
    await expect.poll(() => app!.evaluate((_electron, wanted) => (globalThis as typeof globalThis & {
        __held_host_messages?: { type?: string }[];
    }).__held_host_messages!.some((message) => message.type === wanted), type)).toBe(true);
}

async function release_host_messages(): Promise<void> {
    await app!.evaluate(() => {
        const main = globalThis as typeof globalThis & {
            __held_host_messages?: { replay: () => void }[];
        };
        const held = main.__held_host_messages!;
        main.__held_host_messages = undefined;
        for (const message of held) message.replay();
    });
}

async function menu_watch(page: Page): Promise<{ lists: string[][]; first_rects: Record<string, number> }> {
    return page.evaluate(() => (window as typeof window & {
        __menu_watch?: { lists: string[][]; first_rects: Record<string, number> };
    }).__menu_watch!);
}

/**
 * Open each menu with the session not yet held, wait for the session the menu
 * acquires, and check the menu showed one list of items throughout: none
 * appears, vanishes, or moves as the session arrives.
 */
async function expect_menus_steady(
    page: Page,
    menus: readonly { name: string; open: () => Promise<Locator>; expect_item: string }[],
): Promise<void> {
    const root = page.locator('.grid-shell-root');
    for (const { name, open, expect_item } of menus) {
        await expect(root).toHaveAttribute('data-edit-session', 'none');
        await watch_menu_items(page);
        const menu = await open();
        await expect(root).toHaveAttribute('data-edit-session', 'held');
        // Enabled once the session is held: the menu has settled.
        const settled_item = menu.locator('.context-menu-item').filter({
            has: page.locator('.context-menu-label').getByText(expect_item, { exact: true }),
        });
        await expect(settled_item).toBeVisible();
        await expect(settled_item).not.toHaveAttribute('aria-disabled', 'true');
        const { lists, first_rects } = await menu_watch(page);
        expect(lists, `${name} showed one list of items`).toHaveLength(1);
        // Where each item was first drawn is where a click aimed at it lands.
        const items = menu.locator('.context-menu-item');
        for (let index = 0; index < await items.count(); index += 1) {
            const item = items.nth(index);
            const label = await item.locator('.context-menu-label').textContent() ?? '';
            const top = await item.evaluate((element) => element.getBoundingClientRect().top);
            expect(top, `${name}: "${label}" stayed where it was first drawn`).toBe(first_rects[label]);
        }
        await page.keyboard.press('Escape');
        await expect(page.locator('[role="menu"]')).toHaveCount(0);
        await expect(root).toHaveAttribute('data-edit-session', 'none');
        await expect.poll(() => page.evaluate(
            () => document.activeElement?.closest('.grid-shell-root') != null,
        )).toBe(true);
    }
}

test('a CSV menu shows its items from the moment it opens, not as the session arrives', async () => {
    const { page } = await open_file('fruit.csv', 'name,qty\napple,1\nbanana,2\n');
    await wait_for_grid(page);
    await expect_menus_steady(page, [
        { name: 'the column menu', open: () => open_column_menu(page, 1), expect_item: 'Sort ascending' },
        { name: 'the row menu', open: () => open_row_menu(page, 1), expect_item: 'Hide row' },
        { name: 'the cell menu', open: () => open_cell_menu(page, 0, 0), expect_item: 'Copy cell' },
    ]);
});

test('a workbook menu shows its items from the moment it opens, not as the session arrives', async () => {
    const { page } = await open_file(
        'basic.xlsx',
        fs.readFileSync(path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx')),
    );
    await wait_for_grid(page);
    await expect_menus_steady(page, [
        { name: 'the row menu', open: () => open_row_menu(page, 0), expect_item: 'Use row as header' },
        { name: 'the column menu', open: () => open_column_menu(page, 1), expect_item: 'Filter…' },
        { name: 'the cell menu', open: () => open_cell_menu(page, 0, 0), expect_item: 'Copy cell' },
    ]);
});

test('a click on a workbook row menu item as first drawn, before the session arrives, lands on that item', async () => {
    const { page } = await open_file(
        'basic.xlsx',
        fs.readFileSync(path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx')),
    );
    await wait_for_grid(page);
    await watch_menu_items(page);
    // Hold everything the host says from here on, the answer to the menu's
    // session request among it, so the click is sure to come while the
    // session is on its way.
    await hold_host_messages();
    const menu = await open_row_menu(page, 0);
    await expect_host_message_held('editSessionResult');
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
    // Aimed at "Move rows down" where the menu first drew it.
    const { first_rects } = await menu_watch(page);
    const target = first_rects['Move rows down']!;
    const box = (await menu.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, target + 4);
    // Moving waits for the session, so the click does nothing: no other item
    // ran in its place, and the menu is still open.
    await expect(menu).toBeVisible();
    await expect(save_button(page)).toBeDisabled();
    await release_host_messages();
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'held');
    await expect(menu.locator('.context-menu-item').filter({
        has: page.locator('.context-menu-label').getByText('Move rows down', { exact: true }),
    })).not.toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
    await expect(save_button(page)).toBeDisabled();
});

test('a date typed into an .xlsx date cell the way the cell shows dates saves as a date', async () => {
    const fixture = fs.readFileSync(path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx'));
    const { file, page } = await open_file('basic.xlsx', fixture);
    await wait_for_grid(page);
    const joined = async () => (await read_workbook(file))?.data.sheets[0].rows[2][3];
    // Bob's Joined cell holds 2023-06-01 under `m/d/yy`, so it shows 6/1/23.
    expect(await joined()).toMatchObject({ formatted: '6/1/23', rawType: 'date' });

    await type_into_cell(page, 4, 1, '6/2/23');
    await save_changes(page);

    await expect.poll(async () => (await joined())?.formatted).toBe('6/2/23');
    expect(await joined()).toMatchObject({ raw: '2023-06-02T00:00:00.000Z', rawType: 'date' });
});

test('a month typed into an .xlsx mmm-yy date cell keeps the day the cell held', async () => {
    // A1 holds 2023-06-15 under `mmm-yy`, so it shows Jun-23.
    const book = Buffer.from(build_fixture_xlsx({
        numberFormats: ['mmm-yy'],
        sheets: [{ name: 'Data', body: `<sheetData>${row(1, [cell('A1', 45092, 4)])}</sheetData>` }],
    }));
    const { file, page } = await open_file('months.xlsx', book);
    await wait_for_grid(page);
    const month = async () => (await read_workbook(file))?.data.sheets[0].rows[0][0];
    expect(await month()).toMatchObject({ formatted: 'Jun-23', rawType: 'date' });

    await type_into_cell(page, 1, 0, 'Jul-23');
    await save_changes(page);

    await expect.poll(async () => (await month())?.formatted).toBe('Jul-23');
    expect(await month()).toMatchObject({ raw: '2023-07-15T00:00:00.000Z', rawType: 'date' });
});

/** Click a body cell, focusing the grid on it for a keyboard shortcut. */
async function focus_cell(page: Page, column: number, row: number): Promise<void> {
    const point = await cell_point(page, column, row);
    await page.mouse.click(point.x, point.y);
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.closest('.grid-shell-root') != null,
    )).toBe(true);
}

function menu_item(menu: Locator, label: string): Locator {
    return menu.locator('.context-menu-item').filter({
        has: menu.page().locator('.context-menu-label').getByText(label, { exact: true }),
    });
}

async function menu_labels(menu: Locator): Promise<string[]> {
    return menu.locator('.context-menu-item .context-menu-label').allTextContents();
}

async function close_menu(page: Page): Promise<void> {
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.closest('.grid-shell-root') != null,
    )).toBe(true);
}

/** The cell menu with its Hide submenu open, where "Hide row" is. */
async function open_cell_hide_menu(page: Page): Promise<Locator> {
    const menu = await open_cell_menu(page, 0, 1);
    await menu.getByRole('menuitem', { name: 'Hide', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Hide column', exact: true })).toBeVisible();
    return menu;
}

/**
 * Wait for the window's sort or filter change to have ended: the host has
 * answered and settled everything it asked for. The chips alone do not say
 * so, since they show the rules asked for from the moment they are asked for.
 */
async function view_change_ended(page: Page): Promise<void> {
    await expect(page.locator('.toolbar-progress')).toHaveCount(0);
}

/** Sort ascending by the column of the cell clicked, and wait for the sort to land. */
async function sort_by_column(page: Page, column = 1): Promise<void> {
    await focus_cell(page, column, 1);
    await page.keyboard.press('Shift+Alt+A');
    await expect(page.locator('.sort-strip .sort-chip')).toHaveCount(1);
    await view_change_ended(page);
}

/**
 * Start a sort or filter change with the host's answer held, so it stays in
 * flight, and open a menu. The menu offers the items it will offer once the
 * change lands: `item` disabled, `absent` absent. Landing remounts the grid,
 * closing the menu; the same menu opened afterwards lists the same items,
 * `item` now enabled.
 *
 * A sort or filter item is enabled throughout (`live_in_flight`): a new choice
 * replaces the person's own request in flight (docs/plans/window-queue.md, V1).
 */
async function expect_menu_offers_settled_items(page: Page, options: {
    name: string;
    start: () => Promise<void>;
    settled: () => Promise<void>;
    open: () => Promise<Locator>;
    item: string;
    absent?: readonly string[];
    live_in_flight?: boolean;
}): Promise<void> {
    const { name, start, settled, open, item, absent = [], live_in_flight = false } = options;
    await hold_host_messages();
    await start();
    await expect_host_message_held('transformInstalled');
    const pending_menu = await open();
    if (live_in_flight) {
        await expect(menu_item(pending_menu, item)).not.toHaveAttribute('aria-disabled', 'true');
    } else {
        await expect(menu_item(pending_menu, item)).toHaveAttribute('aria-disabled', 'true');
    }
    for (const label of absent) await expect(menu_item(pending_menu, label)).toHaveCount(0);
    const pending_labels = await menu_labels(pending_menu);
    await release_host_messages();
    await settled();
    await view_change_ended(page);
    if (await page.locator('[role="menu"]').count() > 0) await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
    // The remounted grid takes focus back; a menu opened before then loses it.
    await expect.poll(() => page.evaluate(
        () => document.activeElement?.closest('.grid-shell-root') != null,
    )).toBe(true);
    const menu = await open();
    await expect(menu_item(menu, item)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'held');
    expect(await menu_labels(menu), `${name} offered while the change was in flight what it offers once landed`)
        .toEqual(pending_labels);
    await close_menu(page);
}

/**
 * Keep the page's next sort or filter request from reaching the host until
 * its Cancel is sent, as if the host were still computing it. The request then
 * reaches the host just ahead of the Cancel, which takes the sheet from it
 * before it computes; the Cancel asks for the rules the host already holds, so
 * the host acknowledges it without remounting the grid, and settles both: the
 * window waits for every request it sent to be settled (plan I3).
 */
async function withhold_next_transform_request(): Promise<void> {
    await app!.evaluate(({ ipcMain }, channel) => {
        const main = globalThis as typeof globalThis & {
            __withhold_transform?: boolean;
            __transform_withholder?: boolean;
        };
        main.__withhold_transform = true;
        if (main.__transform_withholder) return;
        main.__transform_withholder = true;
        const listeners = ipcMain.listeners(channel) as ((...args: unknown[]) => void)[];
        ipcMain.removeAllListeners(channel);
        let withheld: unknown[] | undefined;
        ipcMain.on(channel, (...args: unknown[]) => {
            const message = (args[1] as { message?: { type?: string; intent?: string } })?.message;
            if (main.__withhold_transform && message?.type === 'setTransform' && message.intent !== 'cancel') {
                main.__withhold_transform = false;
                withheld = args;
                return;
            }
            if (withheld !== undefined && message?.type === 'setTransform' && message.intent === 'cancel') {
                const earlier = withheld;
                withheld = undefined;
                for (const listener of listeners) listener(...earlier);
            }
            for (const listener of listeners) listener(...args);
        });
    }, CHANNEL_WEBVIEW_MESSAGE);
}

/**
 * Open a menu while a cancelled sort or filter change is in flight, then let
 * the cancel's answer through. The menu stays open and shows one list of
 * items throughout: `item` disabled while the cancel is in flight and enabled
 * once it lands (a sort or filter item, `live_in_flight`, is enabled
 * throughout), and nothing appears, vanishes, or moves as it lands.
 */
async function expect_menu_steady_through_cancel(page: Page, options: {
    name: string;
    change: () => Promise<void>;
    open: () => Promise<Locator>;
    item: string;
    absent?: readonly string[];
    live_in_flight?: boolean;
}): Promise<void> {
    const { name, change, open, item, absent = [], live_in_flight = false } = options;
    const root = page.locator('.grid-shell-root');
    await withhold_next_transform_request();
    await change();
    const cancel = page.locator('.toolbar-cancel', { hasText: 'Cancel' });
    await expect(cancel).toBeEnabled();
    await hold_host_messages();
    await cancel.click();
    await expect_host_message_held('transformInstalled');
    const menu = await open();
    await watch_menu_items(page);
    if (!live_in_flight) await expect(menu_item(menu, item)).toHaveAttribute('aria-disabled', 'true');
    await release_host_messages();
    await view_change_ended(page);
    await expect(menu_item(menu, item)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(root).toHaveAttribute('data-edit-session', 'held');
    for (const label of absent) await expect(menu_item(menu, label)).toHaveCount(0);
    const { lists, first_rects } = await menu_watch(page);
    expect(lists, `${name} showed one list of items`).toHaveLength(1);
    const items = menu.locator('.context-menu-item');
    for (let index = 0; index < await items.count(); index += 1) {
        const entry = items.nth(index);
        const label = await entry.locator('.context-menu-label').textContent() ?? '';
        const top = await entry.evaluate((element) => element.getBoundingClientRect().top);
        expect(top, `${name}: "${label}" stayed where it was first drawn`).toBe(first_rects[label]);
    }
    await close_menu(page);
}

function open_basic_xlsx(): Promise<{ file: string; page: Page }> {
    return open_file(
        'basic.xlsx',
        fs.readFileSync(path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.xlsx')),
    );
}

const sort_chips = (page: Page) => page.locator('.sort-strip .sort-chip');

test('a workbook menu opened while a sort is added offers the items it offers once the sort lands', async () => {
    const { page } = await open_basic_xlsx();
    await wait_for_grid(page);
    // Row 2: a click where the cell menu was just opened would be a double-click.
    // Column 0 after the first sort: a sorted grid may size its columns anew.
    const add_sort = async (key: string, column = 1) => {
        await focus_cell(page, column, 2);
        await page.keyboard.press(key);
    };
    // A sorted view offers no "Use row as header": not while the sort is in
    // flight either.
    await expect_menu_offers_settled_items(page, {
        name: 'the row menu',
        start: () => add_sort('Shift+Alt+A'),
        settled: () => expect(sort_chips(page)).toHaveCount(1),
        open: () => open_row_menu(page, 0),
        item: 'Hide row',
        absent: ['Use row as header'],
    });
    await expect_menu_offers_settled_items(page, {
        name: 'the cell menu',
        start: () => add_sort('Shift+Alt+D', 0),
        settled: () => expect(page.getByRole('button', { name: /^Sort key 1: Name, descending/ })).toHaveCount(1),
        open: () => open_cell_hide_menu(page),
        item: 'Hide row',
    });
    // The column's own sort items follow the sort that is landing, and stay
    // enabled: a new choice replaces it.
    await expect_menu_offers_settled_items(page, {
        name: 'the column menu',
        start: () => add_sort('Shift+Alt+A', 0),
        settled: () => expect(page.getByRole('button', { name: /^Sort key 1: Name, ascending/ })).toHaveCount(1),
        open: () => open_column_menu(page, 0),
        item: 'Clear sort on this column',
        live_in_flight: true,
    });
});

test('a workbook menu opened while its only sort is cleared offers the items it offers once the change lands', async () => {
    const { page } = await open_basic_xlsx();
    await wait_for_grid(page);
    const clear_sorts = async () => {
        await focus_cell(page, 1, 1);
        await page.keyboard.press('Shift+Alt+0');
    };
    const cleared = () => expect(sort_chips(page)).toHaveCount(0);
    // With the sort cleared the view offers "Use row as header": shown,
    // disabled, while the change is in flight.
    for (const { name, open, item, absent, live_in_flight } of [
        { name: 'the row menu', open: () => open_row_menu(page, 0), item: 'Use row as header' },
        { name: 'the row menu', open: () => open_row_menu(page, 1), item: 'Hide row' },
        { name: 'the cell menu', open: () => open_cell_hide_menu(page), item: 'Hide row' },
        {
            name: 'the column menu',
            open: () => open_column_menu(page, 1),
            item: 'Sort ascending',
            absent: ['Clear sort on this column', 'Clear all sorts'],
            live_in_flight: true,
        },
    ]) {
        await sort_by_column(page);
        await expect_menu_offers_settled_items(page, {
            name, start: clear_sorts, settled: cleared, open, item,
            ...(absent ? { absent } : {}),
            ...(live_in_flight ? { live_in_flight } : {}),
        });
    }
});

test('a workbook menu opened while a sort is cancelled keeps its items as the cancel lands', async () => {
    const { page } = await open_basic_xlsx();
    await wait_for_grid(page);
    // Sorted and cleared again, so the host holds an empty view to go back to.
    await sort_by_column(page);
    await focus_cell(page, 1, 1);
    await page.keyboard.press('Shift+Alt+0');
    await expect(sort_chips(page)).toHaveCount(0);
    await view_change_ended(page);
    const add_sort = async () => {
        await focus_cell(page, 1, 1);
        await page.keyboard.press('Shift+Alt+A');
    };
    await expect_menu_steady_through_cancel(page, {
        name: 'the row menu',
        change: add_sort,
        open: () => open_row_menu(page, 0),
        item: 'Use row as header',
    });
    await expect_menu_steady_through_cancel(page, {
        name: 'the row menu',
        change: add_sort,
        open: () => open_row_menu(page, 1),
        item: 'Hide row',
    });
    await expect_menu_steady_through_cancel(page, {
        name: 'the cell menu',
        change: add_sort,
        open: () => open_cell_hide_menu(page),
        item: 'Hide row',
    });
    await expect_menu_steady_through_cancel(page, {
        name: 'the column menu',
        change: add_sort,
        open: () => open_column_menu(page, 1),
        item: 'Sort ascending',
        absent: ['Clear sort on this column', 'Clear all sorts'],
        live_in_flight: true,
    });
    await expect(sort_chips(page)).toHaveCount(0);
});
