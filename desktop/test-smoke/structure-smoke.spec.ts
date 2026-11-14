// Inserting, deleting, restoring, and moving rows and columns in the desktop app
// (row and column structure design, "Integration and desktop smoke").
//
// Each test opens its own copy of a fixture in its own app, drives the shared
// webview by context menu, keyboard, and drag, checks the Edit menu's Undo label
// after each gesture, saves with the Save button, and reads the file back.
//
// No focus assertions and no application-menu commands: the Undo labels are
// read from the history state the renderer reports for the Edit menu (see
// `install_history_menu_capture`). Restored drafts after a relaunch are in
// structure-relaunch.spec.ts.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { parse_xlsx } from '../../src/parse-xlsx';
import { build_fixture_xlsx, cell, row } from '../../src/test/helpers/xlsx-structure-fixture';
import { isolated_user_data, repo_dir, state_database_path } from './smoke-helpers';
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
    install_dialog_capture,
    install_history_menu_capture,
    launch_structural_viewer,
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
    await expect(page.getByRole('button', { name: 'Diff' })).toBeVisible();
    await page.mouse.up();
    await expect_undo_label('Move row');
    await save_changes(page);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('name,qty\ncherry,3\napple,1\nbanana,2\n');

    await expect(save_button(page)).toBeDisabled();
    await select_column(page, 1);
    const header_from = await header_point(page, 1);
    const header_to = await header_point(page, 0);
    await page.mouse.move(header_from.x, header_from.y);
    await page.mouse.down();
    await page.mouse.move(header_from.x - 10, header_from.y, { steps: 5 });
    await page.mouse.move(header_to.x - 40, header_to.y, { steps: 5 });
    await expect(page.getByRole('button', { name: 'Diff' })).toBeVisible();
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
    const saved = async () => {
        const parsed = await parse_xlsx(new Uint8Array(fs.readFileSync(file)));
        return parsed.data.sheets[0].rows.map((row) => row.map((cell) => cell?.formatted ?? ''));
    };
    await expect.poll(async () => (await saved()).map((row) => row.slice(0, 3))).toEqual([
        ['New column', 'Name', 'Age'],
        ['', 'Alice', '30'],
        ['', 'Bob', '25'],
        ['', 'Cara', ''],
    ]);
    expect((await saved())[0]).toHaveLength(4);
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
    await save_changes(page);
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
 * row summing Qty and Total.
 */
function totals_workbook(): Buffer {
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
    return Buffer.from(build_fixture_xlsx({
        sheets: [{ name: 'Data', body: `<sheetData>${rows.join('')}</sheetData>` }],
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
    await broken.getByRole('button', { name: 'Show 4 formulas' }).click();
    // Labelled the way the grid shows the cell: by its column's name and row number.
    await expect(broken.locator('li').first()).toContainText('Total, row 2');
    await expect(broken.locator('li').first()).toContainText('=B2*#REF!');
    await expect(broken.locator('li').first()).toContainText('was =B2*C2');
    await save_screenshot(page, '12-xlsx-ref-notice');

    await save_button(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Save: 1 row inserted, 1 column deleted.');
    await save_screenshot(page, '13-save-tooltip');

    // Restoring the column takes the warning away, and the grid stays put.
    await choose(await open_column_menu(page, 2), 'Restore column');
    await expect(notices).toHaveCount(0, { timeout: 30_000 });
    expect(await canvas_top(page)).toBe(top);
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
    await save_changes(page);
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
    const saved = async () => {
        const parsed = await parse_xlsx(new Uint8Array(fs.readFileSync(file)));
        return parsed.data.sheets[0].rows.map((cells) => cells.map((value) => value?.formatted ?? ''));
    };
    await expect.poll(saved)
        .toEqual([['x', 'y'], ['3', '4'], ['5', '6'], ['7', '8'], ['9', 'typed-under-conflict']]);
});
