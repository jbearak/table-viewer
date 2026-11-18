// Redo after undoing everything, in the desktop app.
//
// Undoing every unsaved change leaves the workbook clean, so the editing
// session behind the edits is released. Redo then acquires a session again
// and has to bring back exactly what was undone: cells, rows added at the end
// one after another, and rows added on a worksheet other than the one the
// new session is acquired on.
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
    exit_app,
    grid_rows,
    install_dialog_capture,
    launch_structural_viewer,
    open_row_menu,
    choose_from_submenu,
    save_button,
    save_changes,
    take_dialogs,
    type_into_cell,
    wait_for_grid,
} from './structure-helpers';

let test_root: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
    test_root = isolated_user_data('tv-undo-redo-release-');
});

test.afterEach(async () => {
    if (app) await exit_app(app);
    app = undefined;
    fs.rmSync(test_root, { recursive: true, force: true });
});

const CSV = 'Name,Age,City\nAlice,30,New York\nBob,25,London\nCharlie,35,Paris\n';
const ROWS: readonly (readonly (string | number)[])[] = [
    ['Name', 'Age', 'City'], ['Alice', 30, 'New York'], ['Bob', 25, 'London'], ['Charlie', 35, 'Paris'],
];

function sheet(name: string, rows: readonly (readonly (string | number)[])[]) {
    return {
        name,
        body: `<sheetData>${rows.map((cells, index) =>
            row(index + 1, cells.map((value, column) => cell(`${'ABC'[column]}${index + 1}`, value))))
            .join('')}</sheetData>`,
    };
}

async function open_file(name: string, content: string | Buffer): Promise<{ file: string; page: Page }> {
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir);
    const file = path.join(test_root, name);
    fs.writeFileSync(file, content);
    const launched = await launch_structural_viewer(user_data_dir, file);
    app = launched.app;
    await install_dialog_capture(app);
    await wait_for_grid(launched.page);
    return { file, page: launched.page };
}

/** Each body row's cells, without the row label. */
async function body(page: Page): Promise<string[]> {
    return (await grid_rows(page)).map((line) => line.split('|').slice(1).join('|'));
}

/** Undo or redo, as the Edit menu sends it to the window. */
async function history(page: Page, command: 'undo' | 'redo'): Promise<void> {
    await page.evaluate((sent) => window.postMessage({ type: 'editCommand', command: sent }, '*'), command);
}

/** Undo or redo, and wait for the grid to show `rows`. */
async function step(page: Page, command: 'undo' | 'redo', rows: readonly string[]): Promise<void> {
    await history(page, command);
    await expect.poll(async () => {
        const shown = await body(page);
        // A refusal is a dialog; report it instead of waiting out the poll.
        const dialogs = (await take_dialogs(app!)).map((dialog) => dialog.message ?? '');
        return dialogs.length > 0 ? dialogs : shown;
    }).toEqual(rows);
}

async function expect_clean_and_released(page: Page): Promise<void> {
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/);
    await expect.poll(() => page.locator('.grid-shell-root').getAttribute('data-edit-session')).toBe('none');
}

/** A saved worksheet's rows as `a|b|c`, trailing blank cells dropped. */
async function saved_sheet(file: string, index: number): Promise<string[] | undefined> {
    return (await read_workbook(file))?.data.sheets[index].rows.map((cells) => {
        const kept = cells.map((value) => value?.formatted ?? '');
        while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
        return kept.join('|');
    });
}

for (const kind of ['csv', 'xlsx'] as const) {
    const fixture = () => kind === 'csv'
        ? CSV
        : Buffer.from(build_fixture_xlsx({ sheets: [sheet('Data', ROWS)] }));
    const saved = async (file: string): Promise<string[] | undefined> => kind === 'csv'
        ? fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(1).map((line) => {
            const cells = line.split(',');
            while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
            return cells.join('|');
        })
        : (await saved_sheet(file, 0))?.slice(1);

    test(`${kind}: two cell edits undone to a clean workbook are both redone and saved`, async () => {
        const { file, page } = await open_file(`cells.${kind}`, fixture());
        const original = ['Alice|30|New York', 'Bob|25|London', 'Charlie|35|Paris'];
        await expect.poll(() => body(page)).toEqual(original);

        await type_into_cell(page, 1, 0, 'Ann');
        await type_into_cell(page, 3, 1, 'Leeds');
        const edited = ['Ann|30|New York', 'Bob|25|Leeds', 'Charlie|35|Paris'];
        await expect.poll(() => body(page)).toEqual(edited);

        await step(page, 'undo', ['Ann|30|New York', 'Bob|25|London', 'Charlie|35|Paris']);
        await step(page, 'undo', original);
        await expect_clean_and_released(page);

        await step(page, 'redo', ['Ann|30|New York', 'Bob|25|London', 'Charlie|35|Paris']);
        await step(page, 'redo', edited);
        await save_changes(page);
        await expect.poll(() => saved(file)).toEqual(edited);
    });

    test(`${kind}: two rows added one after the other at the end are undone and redone with the edits around them`, async () => {
        const { file, page } = await open_file(`appended.${kind}`, fixture());
        const original = ['Alice|30|New York', 'Bob|25|London', 'Charlie|35|Paris'];
        await expect.poll(() => body(page)).toEqual(original);

        // Enter on the last row adds a row and moves to it; Enter in that row
        // adds the next.
        await type_into_cell(page, 1, 2, 'Cy');
        const one_added = ['Alice|30|New York', 'Bob|25|London', 'Cy|35|Paris', '||'];
        await expect.poll(() => body(page)).toEqual(one_added);
        await type_into_cell(page, 1, 3, 'Dee');
        const two_added = ['Alice|30|New York', 'Bob|25|London', 'Cy|35|Paris', 'Dee||', '||'];
        await expect.poll(() => body(page)).toEqual(two_added);

        await step(page, 'undo', ['Alice|30|New York', 'Bob|25|London', 'Cy|35|Paris', 'Dee||']);
        await step(page, 'undo', one_added);
        await step(page, 'undo', ['Alice|30|New York', 'Bob|25|London', 'Cy|35|Paris']);
        await step(page, 'undo', original);
        await expect_clean_and_released(page);

        await step(page, 'redo', ['Alice|30|New York', 'Bob|25|London', 'Cy|35|Paris']);
        await step(page, 'redo', one_added);
        await step(page, 'redo', ['Alice|30|New York', 'Bob|25|London', 'Cy|35|Paris', 'Dee||']);
        await step(page, 'redo', two_added);
        await save_changes(page);
        await expect.poll(() => saved(file)).toEqual(['Alice|30|New York', 'Bob|25|London', 'Cy|35|Paris', 'Dee', '']);
    });
}

for (const added of ['appended', 'inserted'] as const) {
    test(`a row ${added} on another worksheet is redone after everything was undone`, async () => {
        const { file, page } = await open_file('two-sheets.xlsx', Buffer.from(build_fixture_xlsx({
            sheets: [
                sheet('First', [['Name', 'Age'], ['Alice', 30], ['Bob', 25]]),
                sheet('Second', [['Item', 'Qty'], ['apple', 1], ['pear', 2]]),
            ],
        })));
        await expect.poll(() => body(page)).toEqual(['Alice|30', 'Bob|25']);
        await type_into_cell(page, 1, 0, 'Ann');

        await page.locator('.sheet-tab', { hasText: 'Second' }).click();
        await expect.poll(() => body(page)).toEqual(['apple|1', 'pear|2']);
        const with_row = added === 'appended' ? ['apple|1', 'pear|2', '|'] : ['apple|1', '|', 'pear|2'];
        if (added === 'appended') {
            await page.getByRole('button', { name: 'Add rows' }).click();
            await page.getByRole('button', { name: 'Add row', exact: true }).click();
        } else {
            await choose_from_submenu(await open_row_menu(page, 1), 'Insert', 'Insert row above');
        }
        await expect.poll(() => body(page)).toEqual(with_row);

        // Undo follows each change to its worksheet.
        await step(page, 'undo', ['apple|1', 'pear|2']);
        await step(page, 'undo', ['Alice|30', 'Bob|25']);
        await expect_clean_and_released(page);

        await step(page, 'redo', ['Ann|30', 'Bob|25']);
        await step(page, 'redo', with_row);
        await save_changes(page);
        await expect.poll(() => saved_sheet(file, 0)).toEqual(['Name|Age', 'Ann|30', 'Bob|25']);
        await expect.poll(() => saved_sheet(file, 1)).toEqual(
            added === 'appended'
                ? ['Item|Qty', 'apple|1', 'pear|2', '']
                : ['Item|Qty', 'apple|1', '', 'pear|2'],
        );
    });
}
