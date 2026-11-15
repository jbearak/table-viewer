// Undo and redo across an .xlsx Header Row change, in the desktop app.
//
// A Header Row change keeps the undo and redo history. Each test makes
// changes, changes the Header Row (choosing a row, or turning it off and on),
// undoes and redoes across that change, saves with the Save button, and reads
// the file back to check every change landed in the cell or row it was made in.
//
// No assertion needs the window focused, and no application-menu command is
// used: undo and redo arrive as the Edit menu sends them to the window. Every
// wait polls the accessibility table, the session attribute, or the file.
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
    open_column_menu,
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
    test_root = isolated_user_data('tv-undo-redo-header-');
});

test.afterEach(async () => {
    if (app) await exit_app(app);
    app = undefined;
    fs.rmSync(test_root, { recursive: true, force: true });
});

async function open_workbook(
    name: string,
    rows: readonly (readonly (string | number)[])[],
): Promise<{ file: string; page: Page }> {
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir);
    const file = path.join(test_root, name);
    fs.writeFileSync(file, Buffer.from(build_fixture_xlsx({
        sheets: [{
            name: 'Data',
            body: `<sheetData>${rows.map((cells, index) =>
                row(index + 1, cells.map((value, column) => cell(`${'ABC'[column]}${index + 1}`, value))))
                .join('')}</sheetData>`,
        }],
    })));
    const launched = await launch_structural_viewer(user_data_dir, file);
    app = launched.app;
    await install_dialog_capture(app);
    await wait_for_grid(launched.page);
    return { file, page: launched.page };
}

/** Each body row as its cells, a row shown as removed marked `-`. */
async function body(page: Page): Promise<string[]> {
    return (await grid_rows(page)).map((line) => {
        const [label, ...cells] = line.split('|');
        return `${label.startsWith('Row removed') ? '-' : ''}${cells.join('|')}`;
    });
}

/** Each column header's text. */
async function headers(page: Page): Promise<string[]> {
    return (await grid_headers(page)).map((header) => header.split('|')[1]);
}

async function dialogs(): Promise<string[]> {
    return (await take_dialogs(app!)).map((dialog) => dialog.message ?? '');
}

/** Undo or redo, as the Edit menu sends it to the window. */
async function send(page: Page, command: 'undo' | 'redo'): Promise<void> {
    await page.evaluate((sent) => window.postMessage({ type: 'editCommand', command: sent }, '*'), command);
}

/** Undo or redo, and wait for the grid to show `rows`. */
async function step(page: Page, command: 'undo' | 'redo', rows: readonly string[]): Promise<void> {
    await send(page, command);
    await expect.poll(async () => {
        const shown = await body(page);
        // A refusal is a dialog; report it instead of waiting out the poll.
        const refused = await dialogs();
        return refused.length > 0 ? refused : shown;
    }).toEqual(rows);
}

/** Undo or redo a change that waits on the Header Row: the message, and nothing moved. */
async function refused(page: Page, command: 'undo' | 'redo', rows: readonly string[]): Promise<string> {
    await send(page, command);
    let message = '';
    await expect.poll(async () => {
        message = (await dialogs()).join('\n') || message;
        return message;
    }).not.toBe('');
    expect(await body(page)).toEqual(rows);
    return message;
}

async function expect_clean_and_released(page: Page): Promise<void> {
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/);
    await expect.poll(() => page.locator('.grid-shell-root').getAttribute('data-edit-session')).toBe('none');
}

function header_row_button(page: Page) {
    return page.getByRole('button', { name: 'Header Row', exact: true });
}

async function toggle_header(page: Page): Promise<void> {
    await expect(header_row_button(page)).not.toHaveAttribute('aria-disabled', 'true');
    await header_row_button(page).click();
}

/** The saved worksheet's rows as `a|b`, trailing blank cells dropped. */
async function saved(file: string): Promise<string[] | undefined> {
    return (await read_workbook(file))?.data.sheets[0].rows.map((cells) => {
        const kept = cells.map((value) => value?.formatted ?? '');
        while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
        return kept.join('|');
    });
}

test('edits, a deleted row and an added row are undone and redone after a row is chosen as the header', async () => {
    // Row 1 holds numbers, so no Header Row is detected; row 2 is the real one.
    const { file, page } = await open_workbook('chosen.xlsx', [
        [1, 2], ['name', 'qty'], ['apple', 10], ['banana', 20], ['cherry', 30],
    ]);
    await expect.poll(() => body(page)).toEqual(['1|2', 'name|qty', 'apple|10', 'banana|20', 'cherry|30']);

    await type_into_cell(page, 1, 2, 'pear');
    await choose(await open_row_menu(page, 3), 'Delete row');
    await expect.poll(() => body(page)).toEqual(['1|2', 'name|qty', 'pear|10', '-banana|20', 'cherry|30']);
    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Add row', exact: true }).click();
    await expect.poll(() => body(page))
        .toEqual(['1|2', 'name|qty', 'pear|10', '-banana|20', 'cherry|30', '|']);

    await choose(await open_row_menu(page, 1), 'Use row as header');
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);
    const changed = ['pear|10', '-banana|20', 'cherry|30', '|'];
    await expect.poll(() => body(page)).toEqual(changed);

    // Back past the header change, one change at a time, to a clean workbook.
    await step(page, 'undo', ['pear|10', '-banana|20', 'cherry|30']);
    await step(page, 'undo', ['pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'undo', ['apple|10', 'banana|20', 'cherry|30']);
    await expect_clean_and_released(page);
    // The header change is not an edit: it stays.
    expect(await headers(page)).toEqual(['name', 'qty']);

    await step(page, 'redo', ['pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'redo', ['pear|10', '-banana|20', 'cherry|30']);
    await step(page, 'redo', changed);
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['1|2', 'name|qty', 'pear|10', 'cherry|30', '']);
});

test('changes made with the header on are undone with it off and redone with it on again', async () => {
    const { file, page } = await open_workbook('toggled.xlsx', [
        ['name', 'qty'], ['apple', 10], ['banana', 20], ['cherry', 30],
    ]);
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);

    await type_into_cell(page, 1, 0, 'pear');
    await choose(await open_row_menu(page, 1), 'Insert row above');
    await expect.poll(() => body(page)).toEqual(['pear|10', '|', 'banana|20', 'cherry|30']);
    await choose(await open_row_menu(page, 3), 'Delete row');
    await expect.poll(() => body(page)).toEqual(['pear|10', '|', 'banana|20', '-cherry|30']);

    await toggle_header(page);
    await expect.poll(() => body(page)).toEqual(['name|qty', 'pear|10', '|', 'banana|20', '-cherry|30']);
    // An edit made with the header off, on a row that is a body row either way.
    await type_into_cell(page, 2, 3, '21');
    await expect.poll(() => body(page)).toEqual(['name|qty', 'pear|10', '|', 'banana|21', '-cherry|30']);

    // Everything is undone with the header off: the rows the changes named
    // are one further down the body than when they were made.
    await step(page, 'undo', ['name|qty', 'pear|10', '|', 'banana|20', '-cherry|30']);
    await step(page, 'undo', ['name|qty', 'pear|10', '|', 'banana|20', 'cherry|30']);
    await step(page, 'undo', ['name|qty', 'pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'undo', ['name|qty', 'apple|10', 'banana|20', 'cherry|30']);
    await expect_clean_and_released(page);

    await toggle_header(page);
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);
    await expect.poll(() => body(page)).toEqual(['apple|10', 'banana|20', 'cherry|30']);

    await step(page, 'redo', ['pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'redo', ['pear|10', '|', 'banana|20', 'cherry|30']);
    await step(page, 'redo', ['pear|10', '|', 'banana|20', '-cherry|30']);
    // Made with the header off, redone with it on.
    await step(page, 'redo', ['pear|10', '|', 'banana|21', '-cherry|30']);
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['name|qty', 'pear|10', '', 'banana|21']);
});

test('two cell edits undone to a clean workbook are redone after the header is turned off', async () => {
    const { file, page } = await open_workbook('cells.xlsx', [
        ['name', 'qty'], ['apple', 10], ['banana', 20], ['cherry', 30],
    ]);
    await expect.poll(() => body(page)).toEqual(['apple|10', 'banana|20', 'cherry|30']);
    await type_into_cell(page, 1, 0, 'pear');
    await type_into_cell(page, 2, 1, '21');
    await step(page, 'undo', ['pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'undo', ['apple|10', 'banana|20', 'cherry|30']);
    await expect_clean_and_released(page);

    await toggle_header(page);
    await expect.poll(() => body(page)).toEqual(['name|qty', 'apple|10', 'banana|20', 'cherry|30']);
    await step(page, 'redo', ['name|qty', 'pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'redo', ['name|qty', 'pear|10', 'banana|21', 'cherry|30']);
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['name|qty', 'pear|10', 'banana|21', 'cherry|30']);
});

test('a new column, its name and a cell in it are redone after the header was turned off and on', async () => {
    const { file, page } = await open_workbook('column.xlsx', [
        ['name', 'qty'], ['apple', 10], ['banana', 20],
    ]);
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);

    await choose(await open_column_menu(page, 0), 'Insert column right');
    await expect.poll(() => headers(page)).toEqual(['name', 'New column', 'qty']);
    await choose(await open_column_menu(page, 1), 'Rename column…');
    const dialog = page.getByRole('dialog', { name: 'Rename column' });
    await dialog.getByLabel('Column name').fill('notes');
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => headers(page)).toEqual(['name', 'notes', 'qty']);
    await type_into_cell(page, 2, 0, 'ripe');
    await expect.poll(() => body(page)).toEqual(['apple|ripe|10', 'banana||20']);

    await step(page, 'undo', ['apple||10', 'banana||20']);
    await send(page, 'undo');
    await expect.poll(() => headers(page)).toEqual(['name', 'New column', 'qty']);
    await step(page, 'undo', ['apple|10', 'banana|20']);
    await expect_clean_and_released(page);

    await toggle_header(page);
    await expect.poll(() => body(page)).toEqual(['name|qty', 'apple|10', 'banana|20']);
    await toggle_header(page);
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);

    await step(page, 'redo', ['apple||10', 'banana||20']);
    await send(page, 'redo');
    await expect.poll(() => headers(page)).toEqual(['name', 'notes', 'qty']);
    await step(page, 'redo', ['apple|ripe|10', 'banana||20']);
    expect(await dialogs()).toEqual([]);
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['name|notes|qty', 'apple|ripe|10', 'banana||20']);
});

test('a deleted row that is now above the header waits, says which header row brings it back, and is redone under it', async () => {
    const { file, page } = await open_workbook('waits.xlsx', [
        ['name', 'qty'], ['apple', 10], ['banana', 20], ['cherry', 30],
    ]);
    await expect.poll(() => body(page)).toEqual(['apple|10', 'banana|20', 'cherry|30']);
    await choose(await open_row_menu(page, 0), 'Delete row');
    await expect.poll(() => body(page)).toEqual(['-apple|10', 'banana|20', 'cherry|30']);
    await step(page, 'undo', ['apple|10', 'banana|20', 'cherry|30']);
    await expect_clean_and_released(page);

    // Row 3 becomes the header: the deleted row is above it now.
    await choose(await open_row_menu(page, 1), 'Use row as header');
    await expect.poll(() => headers(page)).toEqual(['banana', '20']);
    await expect.poll(() => body(page)).toEqual(['cherry|30']);
    expect(await refused(page, 'redo', ['cherry|30'])).toBe(
        "Can't redo this row change while row 3 is the header row: "
        + 'it changes rows that are now in or above the header. '
        + 'Use row 1 as the header row to redo it.',
    );
    await expect_clean_and_released(page);

    // Row 1 as the header again, as the message says. The rows above the
    // chosen header are hidden; unhiding them turns that header off.
    await page.getByRole('button', { name: 'Unhide all' }).click();
    await expect.poll(() => body(page)).toEqual(['name|qty', 'apple|10', 'banana|20', 'cherry|30']);
    await choose(await open_row_menu(page, 0), 'Use row as header');
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);
    await step(page, 'redo', ['-apple|10', 'banana|20', 'cherry|30']);
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['name|qty', 'banana|20', 'cherry|30']);
});

test('a saved cell edit on the row that became the header waits, and is undone once the header is off', async () => {
    const { file, page } = await open_workbook('header-cell.xlsx', [
        [1, 2], ['name', 'qty'], ['apple', 10],
    ]);
    await expect.poll(() => body(page)).toEqual(['1|2', 'name|qty', 'apple|10']);
    await type_into_cell(page, 1, 1, 'title');
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['1|2', 'title|qty', 'apple|10']);

    await choose(await open_row_menu(page, 1), 'Use row as header');
    await expect.poll(() => headers(page)).toEqual(['title', 'qty']);
    await expect.poll(() => body(page)).toEqual(['apple|10']);
    // Undoing it here would rename a column, which is not what was typed.
    expect(await refused(page, 'undo', ['apple|10'])).toBe(
        "Can't undo this cell change while row 2 is the header row: "
        + 'it was made when row 2 was an ordinary row. '
        + 'Use another row as the header row, or turn the header row off, to undo it.',
    );
    expect(await headers(page)).toEqual(['title', 'qty']);

    // Turning the header off leaves the rows above it hidden.
    await toggle_header(page);
    await expect.poll(() => body(page)).toEqual(['title|qty', 'apple|10']);
    await step(page, 'undo', ['name|qty', 'apple|10']);
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['1|2', 'name|qty', 'apple|10']);
});
