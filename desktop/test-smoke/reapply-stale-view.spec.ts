// Rows stay where they are while the person edits a sorted or filtered table, and
// the notice that says so offers Reapply, which sorts and filters again by the
// values on screen, unsaved ones included.
//
// Nothing here uses the application menu, so nothing depends on OS focus.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { build_fixture_xlsx, cell, row } from '../../src/test/helpers/xlsx-structure-fixture';
import { isolated_user_data } from './smoke-helpers';
import {
    exit_app,
    install_history_menu_capture,
    launch_structural_viewer,
    open_column_menu,
    save_changes,
    type_into_cell,
    undo_menu_label,
    wait_for_grid,
} from './structure-helpers';

let test_root: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
    test_root = isolated_user_data('tv-reapply-stale-view-');
});

test.afterEach(async () => {
    if (app) await exit_app(app);
    app = undefined;
    fs.rmSync(test_root, { recursive: true, force: true });
});

const ROWS: readonly (readonly (string | number)[])[] = [
    ['Name', 'Age', 'City'],
    ['Alice', 30, 'New York'],
    ['Bob', 25, 'London'],
    ['Charlie', 35, 'Paris'],
    ['Dora', 28, 'Oslo'],
];
const CSV = `${ROWS.map((cells) => cells.join(',')).join('\n')}\n`;
const AGE_DESCENDING = ['Charlie|35|Paris', 'Alice|30|New York', 'Dora|28|Oslo', 'Bob|25|London'];
const NOTICE = 'Rows stay in place as you edit, so sorting and filters may be out of date.';

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
    await install_history_menu_capture(app);
    await wait_for_grid(launched.page);
    return { file, page: launched.page };
}

/** Each body row's cells, without the empty add-row line an editable table ends with. */
async function body(page: Page): Promise<string[]> {
    const lines = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((line) =>
        [...line.querySelectorAll('td')].map((data) => data.textContent ?? '').join('|')));
    return lines.filter((line) => line.replace(/\|/g, '') !== '');
}

const notice = (page: Page) => page.locator('.stale-view-banner');

for (const kind of ['csv', 'xlsx'] as const) {
    test(`${kind}: an edit leaves its row in place until Reapply sorts by it`, async () => {
        const { file, page } = await open_file(`reapply.${kind}`, fixture(kind));
        const menu = await open_column_menu(page, 1);
        await menu.getByRole('menuitemcheckbox', { name: 'Sort descending' }).click();
        await expect.poll(() => body(page)).toEqual(AGE_DESCENDING);

        // Bob, last at 25, becomes the oldest. His row stays where it was.
        await type_into_cell(page, 2, 3, '99');
        const edited = ['Charlie|35|Paris', 'Alice|30|New York', 'Dora|28|Oslo', 'Bob|99|London'];
        await expect.poll(() => body(page)).toEqual(edited);
        await expect(notice(page)).toContainText(NOTICE);
        // Enter on the last row commits the edit and appends a row, which is now
        // the last thing Undo takes back.
        await expect.poll(() => undo_menu_label(app!)).toBe('Undo Append row');

        await notice(page).getByRole('button', { name: 'Reapply' }).click();
        await expect.poll(() => body(page))
            .toEqual(['Bob|99|London', 'Charlie|35|Paris', 'Alice|30|New York', 'Dora|28|Oslo']);
        await expect(notice(page)).toHaveCount(0);
        // Reapply is not a step: Undo still takes back the edit.
        expect(await undo_menu_label(app!)).toBe('Undo Append row');

        // The order does not follow the next edit either, until asked again.
        await type_into_cell(page, 2, 0, '1');
        await expect.poll(() => body(page))
            .toEqual(['Bob|1|London', 'Charlie|35|Paris', 'Alice|30|New York', 'Dora|28|Oslo']);
        await expect(notice(page)).toContainText(NOTICE);
        await notice(page).getByRole('button', { name: 'Reapply' }).click();
        await expect.poll(() => body(page))
            .toEqual(['Charlie|35|Paris', 'Alice|30|New York', 'Dora|28|Oslo', 'Bob|1|London']);

        // Saved, the file holds the edit and the view needs no notice.
        await save_changes(page);
        await expect(notice(page)).toHaveCount(0);
        if (kind === 'csv') {
            expect(fs.readFileSync(file, 'utf8')).toContain('Bob,1,London');
        }
    });
}
