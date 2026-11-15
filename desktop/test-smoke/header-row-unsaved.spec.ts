// Choosing, turning off, and turning on an .xlsx Header Row while the workbook
// holds unsaved changes, in the desktop app.
//
// Each test opens its own copy of a fixture in its own app, makes unsaved
// changes, changes the Header Row, saves with the Save button, and reads the
// file back to check every change landed in the cell it was made in.
//
// No assertions that need the window focused, and no application-menu
// commands. Every wait polls the accessibility table or the file.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { build_fixture_xlsx, cell, row } from '../../src/test/helpers/xlsx-structure-fixture';
import { isolated_user_data, read_workbook } from './smoke-helpers';
import {
    choose,
    exit_app,
    grid_headers,
    grid_rows,
    install_dialog_capture,
    launch_structural_viewer,
    open_row_menu,
    save_button,
    save_changes,
    take_dialogs,
    type_into_cell,
    wait_for_grid,
} from './structure-helpers';

let test_root: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
    test_root = isolated_user_data('tv-header-unsaved-');
});

test.afterEach(async () => {
    if (app) await exit_app(app);
    app = undefined;
    fs.rmSync(test_root, { recursive: true, force: true });
});

function workbook(rows: readonly (readonly (string | number)[])[]): Buffer {
    return Buffer.from(build_fixture_xlsx({
        sheets: [{
            name: 'Data',
            body: `<sheetData>${rows.map((cells, index) =>
                row(index + 1, cells.map((value, column) => cell(`${'ABC'[column]}${index + 1}`, value))))
                .join('')}</sheetData>`,
        }],
    }));
}

async function open_file(name: string, content: Buffer): Promise<{ file: string; page: Page }> {
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir);
    const file = path.join(test_root, name);
    fs.writeFileSync(file, content);
    const launched = await launch_structural_viewer(user_data_dir, file);
    app = launched.app;
    await install_dialog_capture(app);
    return { file, page: launched.page };
}

/** Each body row's cells, without the row label. */
async function body(page: Page): Promise<string[]> {
    return (await grid_rows(page)).map((line) => line.split('|').slice(1).join('|'));
}

/** Each column header's text. */
async function headers(page: Page): Promise<string[]> {
    return (await grid_headers(page)).map((header) => header.split('|')[1]);
}

async function saved_rows(file: string): Promise<string[][] | undefined> {
    return (await read_workbook(file))?.data.sheets[0].rows
        .map((cells) => cells.map((value) => value?.formatted ?? ''));
}

/** The cells of each row shown as a Pending Row Removal. */
async function removed_rows(page: Page): Promise<string[]> {
    return (await grid_rows(page))
        .filter((line) => line.startsWith('Row removed'))
        .map((line) => line.split('|').slice(1).join('|'));
}

function header_row_button(page: Page) {
    return page.getByRole('button', { name: 'Header Row', exact: true });
}

test('a row chosen as the header while a cell edit is unsaved keeps the edit in its cell', async () => {
    // Row 1 holds numbers, so no Header Row is detected; row 2 is the real one.
    const { file, page } = await open_file('late-header.xlsx', workbook([
        [1, 2], ['name', 'qty'], ['apple', 10], ['banana', 20],
    ]));
    await wait_for_grid(page);
    await expect.poll(() => body(page)).toEqual(['1|2', 'name|qty', 'apple|10', 'banana|20']);

    await type_into_cell(page, 1, 2, 'pear');
    await expect(save_button(page)).toHaveClass(/has-unsaved/);

    await choose(await open_row_menu(page, 1), 'Use row as header');
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);
    await expect.poll(() => body(page)).toEqual(['pear|10', 'banana|20']);
    await expect(save_button(page)).toHaveClass(/has-unsaved/);

    // Editing goes on under the new header, in the row it shows.
    await type_into_cell(page, 2, 0, '11');
    await expect.poll(() => body(page)).toEqual(['pear|11', 'banana|20']);

    await save_changes(page);
    await expect.poll(() => saved_rows(file)).toEqual([
        ['1', '2'], ['name', 'qty'], ['pear', '11'], ['banana', '20'],
    ]);
});

test('turning the Header Row off and on with an unsaved edit and a deleted row saves both where they were made', async () => {
    const { file, page } = await open_file('detected.xlsx', workbook([
        ['name', 'qty'], ['apple', 10], ['banana', 20], ['cherry', 30],
    ]));
    await wait_for_grid(page);
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);

    await type_into_cell(page, 1, 0, 'pear');
    await choose(await open_row_menu(page, 1), 'Delete row');
    await expect.poll(() => removed_rows(page)).toEqual(['banana|20']);

    await expect(header_row_button(page)).not.toHaveAttribute('aria-disabled', 'true');
    await header_row_button(page).click();
    await expect.poll(() => body(page)).toEqual(['name|qty', 'pear|10', 'banana|20', 'cherry|30']);
    await expect.poll(() => removed_rows(page)).toEqual(['banana|20']);
    await expect(save_button(page)).toHaveClass(/has-unsaved/);

    // An edit made with the header off, in a body row.
    await type_into_cell(page, 2, 1, '11');
    await expect.poll(() => body(page)).toEqual(['name|qty', 'pear|11', 'banana|20', 'cherry|30']);

    await expect(header_row_button(page)).not.toHaveAttribute('aria-disabled', 'true');
    await header_row_button(page).click();
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);
    await expect.poll(() => body(page)).toEqual(['pear|11', 'banana|20', 'cherry|30']);
    await expect.poll(() => removed_rows(page)).toEqual(['banana|20']);

    await save_changes(page);
    await expect.poll(() => saved_rows(file)).toEqual([
        ['name', 'qty'], ['pear', '11'], ['cherry', '30'],
    ]);
});

test('an unsaved change to the row that would become the header refuses the change and keeps the edit', async () => {
    const { file, page } = await open_file('detected.xlsx', workbook([
        ['name', 'qty'], ['apple', 10], ['banana', 20],
    ]));
    await wait_for_grid(page);
    await header_row_button(page).click();
    await expect.poll(() => body(page)).toEqual(['name|qty', 'apple|10', 'banana|20']);

    await type_into_cell(page, 2, 0, 'count');
    await expect(header_row_button(page)).not.toHaveAttribute('aria-disabled', 'true');
    await header_row_button(page).click();
    await expect.poll(async () => (await take_dialogs(app!)).map((dialog) => dialog.message ?? '').join('\n'))
        .toContain('the row that would become the header row has unsaved changes');
    await expect.poll(() => body(page)).toEqual(['name|count', 'apple|10', 'banana|20']);
    // The header change is over: editing works again.
    await type_into_cell(page, 1, 1, 'pear');

    await save_changes(page);
    await expect.poll(() => saved_rows(file)).toEqual([
        ['name', 'count'], ['pear', '10'], ['banana', '20'],
    ]);
});

test('an appended row and text left open in the cell editor survive choosing a header row', async () => {
    const { file, page } = await open_file('appended.xlsx', workbook([
        [1, 2], ['name', 'qty'], ['apple', 10],
    ]));
    await wait_for_grid(page);
    await expect.poll(() => body(page)).toEqual(['1|2', 'name|qty', 'apple|10']);

    // Enter on the last row appends a Pending Appended Row below it.
    await type_into_cell(page, 1, 2, 'pear');
    await expect.poll(async () => (await body(page)).length).toBe(4);
    // Text typed into the appended row, its editor still open.
    const cell = page.locator('#glide-cell-1-3');
    await expect(cell).toHaveAttribute('aria-readonly', 'false');
    await cell.focus();
    await expect.poll(() => cell.getAttribute('aria-selected')).toBe('true');
    await page.keyboard.press('Enter');
    const editor = page.locator('.cell-editor-input');
    await expect(editor).toBeVisible();
    await editor.fill('kiwi');

    // The right-click that opens the row menu commits the open editor.
    await choose(await open_row_menu(page, 1), 'Use row as header');
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);
    await expect.poll(() => body(page)).toEqual(['pear|10', 'kiwi|']);

    await save_changes(page);
    await expect.poll(async () => (await saved_rows(file))?.map((cells) => {
        const kept = [...cells];
        while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
        return kept.join('|');
    })).toEqual(['1|2', 'name|qty', 'pear|10', 'kiwi']);
});
