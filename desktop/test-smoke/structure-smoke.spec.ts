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
    choose,
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
