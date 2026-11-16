// Undo and redo of edits and row changes around an .xlsx Header Row change,
// in the desktop app.
//
// A Header Row change is a step in the same history as the edits. Each test
// makes changes, changes the Header Row (choosing a row, or turning it off
// and on), walks back and forward through all of it in order, saves with the
// Save button, and reads the file back to check every change landed in the
// cell or row it was made in. Walking in order, each change is undone and
// redone under the header it was made with, so none of them waits.
// `undo-redo-header-step.spec.ts` covers the header step itself. The wait for
// a header row this window's history does not hold (another window changed
// it) cannot be reached from one window's own steps; `app.test.ts` and
// `history-command-model.test.ts` cover it.
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

test('edits, a deleted row and an added row are undone and redone through the header chosen after them', async () => {
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
    const before_header = ['1|2', 'name|qty', 'pear|10', '-banana|20', 'cherry|30', '|'];
    await expect.poll(() => body(page)).toEqual(before_header);

    await choose(await open_row_menu(page, 1), 'Use row as header');
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);
    const changed = ['pear|10', '-banana|20', 'cherry|30', '|'];
    await expect.poll(() => body(page)).toEqual(changed);

    // Back one step at a time: the header first, then each change under the
    // header it was made with, to a clean workbook.
    await step(page, 'undo', before_header);
    expect(await headers(page)).toEqual(['A', 'B']);
    await step(page, 'undo', before_header.slice(0, -1));
    await step(page, 'undo', ['1|2', 'name|qty', 'pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'undo', ['1|2', 'name|qty', 'apple|10', 'banana|20', 'cherry|30']);
    await expect_clean_and_released(page);

    await step(page, 'redo', ['1|2', 'name|qty', 'pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'redo', before_header.slice(0, -1));
    await step(page, 'redo', before_header);
    await step(page, 'redo', changed);
    expect(await headers(page)).toEqual(['name', 'qty']);
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['1|2', 'name|qty', 'pear|10', 'cherry|30', '']);
});

test('changes made with the header on, and one made with it off, are each undone and redone under the header they were made with', async () => {
    const { file, page } = await open_workbook('toggled.xlsx', [
        ['name', 'qty'], ['apple', 10], ['banana', 20], ['cherry', 30],
    ]);
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);

    await type_into_cell(page, 1, 0, 'pear');
    await choose(await open_row_menu(page, 1), 'Insert row above');
    await expect.poll(() => body(page)).toEqual(['pear|10', '|', 'banana|20', 'cherry|30']);
    await choose(await open_row_menu(page, 3), 'Delete row');
    const with_header = ['pear|10', '|', 'banana|20', '-cherry|30'];
    await expect.poll(() => body(page)).toEqual(with_header);

    await toggle_header(page);
    await expect.poll(() => body(page)).toEqual(['name|qty', ...with_header]);
    // An edit made with the header off, on a row that is a body row either way.
    await type_into_cell(page, 2, 3, '21');
    const all_changes = ['name|qty', 'pear|10', '|', 'banana|21', '-cherry|30'];
    await expect.poll(() => body(page)).toEqual(all_changes);

    // The edit made with the header off, then the header back on, then the
    // three changes made under it.
    await step(page, 'undo', ['name|qty', ...with_header]);
    await step(page, 'undo', with_header);
    expect(await headers(page)).toEqual(['name', 'qty']);
    await step(page, 'undo', ['pear|10', '|', 'banana|20', 'cherry|30']);
    await step(page, 'undo', ['pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'undo', ['apple|10', 'banana|20', 'cherry|30']);
    await expect_clean_and_released(page);

    await step(page, 'redo', ['pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'redo', ['pear|10', '|', 'banana|20', 'cherry|30']);
    await step(page, 'redo', with_header);
    await step(page, 'redo', ['name|qty', ...with_header]);
    expect(await headers(page)).toEqual(['A', 'B']);
    await step(page, 'redo', all_changes);
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['name|qty', 'pear|10', '', 'banana|21']);
});

test('two cell edits and the header turned off after them are undone to a clean workbook and redone', async () => {
    const { file, page } = await open_workbook('cells.xlsx', [
        ['name', 'qty'], ['apple', 10], ['banana', 20], ['cherry', 30],
    ]);
    await expect.poll(() => body(page)).toEqual(['apple|10', 'banana|20', 'cherry|30']);
    await type_into_cell(page, 1, 0, 'pear');
    await type_into_cell(page, 2, 1, '21');
    await toggle_header(page);
    await expect.poll(() => body(page)).toEqual(['name|qty', 'pear|10', 'banana|21', 'cherry|30']);

    await step(page, 'undo', ['pear|10', 'banana|21', 'cherry|30']);
    await step(page, 'undo', ['pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'undo', ['apple|10', 'banana|20', 'cherry|30']);
    await expect_clean_and_released(page);
    expect(await headers(page)).toEqual(['name', 'qty']);

    await step(page, 'redo', ['pear|10', 'banana|20', 'cherry|30']);
    await step(page, 'redo', ['pear|10', 'banana|21', 'cherry|30']);
    await step(page, 'redo', ['name|qty', 'pear|10', 'banana|21', 'cherry|30']);
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['name|qty', 'pear|10', 'banana|21', 'cherry|30']);
});

test('a new column, its name and a cell in it are undone and redone above a header turned off and on', async () => {
    const { file, page } = await open_workbook('column.xlsx', [
        ['name', 'qty'], ['apple', 10], ['banana', 20],
    ]);
    await expect.poll(() => headers(page)).toEqual(['name', 'qty']);
    await toggle_header(page);
    await expect.poll(() => body(page)).toEqual(['name|qty', 'apple|10', 'banana|20']);
    await toggle_header(page);
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
    // The two header steps under the column: the column that was taken back
    // does not stand in their way.
    await step(page, 'undo', ['name|qty', 'apple|10', 'banana|20']);
    await step(page, 'undo', ['apple|10', 'banana|20']);
    expect(await headers(page)).toEqual(['name', 'qty']);

    await step(page, 'redo', ['name|qty', 'apple|10', 'banana|20']);
    await step(page, 'redo', ['apple|10', 'banana|20']);
    await step(page, 'redo', ['apple||10', 'banana||20']);
    await send(page, 'redo');
    await expect.poll(() => headers(page)).toEqual(['name', 'notes', 'qty']);
    await step(page, 'redo', ['apple|ripe|10', 'banana||20']);
    expect(await dialogs()).toEqual([]);
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['name|notes|qty', 'apple|ripe|10', 'banana||20']);
});
