// A paste that runs past the last row adds the rows it needs, in the desktop
// app, and is one step in the history: Undo takes back the pasted values and
// the rows together, Redo brings both back.
//
// The paste arrives as the paste event delivers it (its own data, so the OS
// clipboard is not shared), and runs through Glide's own paste and the grid's
// own row admission. Every wait polls what the window shows.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { build_fixture_xlsx, cell, row } from '../../src/test/helpers/xlsx-structure-fixture';
import { isolated_user_data, read_workbook } from './smoke-helpers';
import {
    cell_point,
    exit_app,
    install_dialog_capture,
    launch_structural_viewer,
    save_button,
    take_dialogs,
    type_into_cell,
    wait_for_grid,
} from './structure-helpers';

let test_root: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
    test_root = isolated_user_data('tv-paste-append-rows-');
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
];
const CSV = `${ROWS.map((cells) => cells.join(',')).join('\n')}\n`;
const NATURAL = ['Alice|30|New York', 'Bob|25|London'];

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

async function open_file(name: string, content: string | Buffer): Promise<{ file: string; page: Page }> {
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir, { recursive: true });
    const file = path.join(test_root, name);
    fs.writeFileSync(file, content);
    const launched = await launch_structural_viewer(user_data_dir, file);
    app = launched.app;
    await install_dialog_capture(app);
    await wait_for_grid(launched.page);
    return { file, page: launched.page };
}

/** The grid's body rows as `a|b|c`, from its accessibility table. */
async function body(page: Page): Promise<string[]> {
    return page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((line) =>
        [...line.querySelectorAll('td')].map((data) => data.textContent ?? '').join('|')));
}

/** Wait until the grid shows `expected`, with nothing said in the meantime. */
async function expect_body(page: Page, expected: readonly string[]): Promise<void> {
    const said: string[] = [];
    await expect.poll(async () => {
        said.push(...(await take_dialogs(app!)).map((dialog) => dialog.message ?? ''));
        return { body: await body(page), dialogs: [...said] };
    }).toEqual({ body: [...expected], dialogs: [] });
}

/** Select a cell (`column` as the grid's cell ids count it, from 1) with a click, at default widths. */
async function select_cell(page: Page, column: number, row_index: number): Promise<void> {
    const point = await cell_point(page, column - 1, row_index);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator(`#glide-cell-${column}-${row_index}`)).toHaveAttribute('aria-selected', 'true');
}

async function paste(page: Page, text: string): Promise<void> {
    await page.evaluate((pasted) => {
        const data = new DataTransfer();
        data.setData('text/plain', pasted);
        window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    }, text);
}

async function history(page: Page, command: 'undo' | 'redo'): Promise<void> {
    await page.evaluate((sent) => {
        window.postMessage({ type: 'editCommand', command: sent }, '*');
    }, command);
}

/** The saved file's body rows as `a|b|c`, trailing blank cells dropped. */
async function saved_body(kind: 'csv' | 'xlsx', file: string): Promise<string[] | undefined> {
    const trimmed = (cells: string[]): string => {
        while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
        return cells.join('|');
    };
    if (kind === 'csv') {
        return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(1)
            .map((line) => trimmed(line.split(',')));
    }
    return (await read_workbook(file))?.data.sheets[0].rows.slice(1)
        .map((cells) => trimmed(cells.map((value) => value?.formatted ?? '')));
}

for (const kind of ['csv', 'xlsx'] as const) {
    for (const session of ['no session yet', 'a session held'] as const) {
        test(`${kind}, ${session}: two rows pasted onto the last row add the row they need, and undo and redo as one step`, async () => {
            const { file, page } = await open_file(`paste.${kind}`, fixture(kind));
            await expect_body(page, NATURAL);
            if (session === 'a session held') {
                // In another column: Enter leaves the selection below the
                // edit, and a click on a selected cell opens its editor.
                await type_into_cell(page, 2, 0, '31');
                await expect_body(page, ['Alice|31|New York', NATURAL[1]]);
                await expect(page.locator('.grid-shell-root')).not.toHaveAttribute('data-edit-session', 'none');
            } else {
                await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
            }
            const before = await body(page);
            await select_cell(page, 1, 1);
            await paste(page, 'P1\tP2\nP3\tP4');
            const pasted = [before[0], 'P1|P2|London', 'P3|P4|'];
            await expect_body(page, pasted);
            // One step: the values and the added row go back together.
            await history(page, 'undo');
            await expect_body(page, before);
            await history(page, 'redo');
            await expect_body(page, pasted);
            await save_button(page).click();
            await expect(save_button(page)).not.toHaveClass(/has-unsaved/);
            await expect.poll(() => saved_body(kind, file)).toEqual(pasted.map((line) => line.replace(/\|+$/, '')));
        });
    }
}
