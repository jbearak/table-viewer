// Undo and redo of view changes, in the desktop app.
//
// A sort, a filter, hidden rows, and hidden columns are steps in the same
// history as edits. Each test here makes the change the way a person does,
// then undoes and redoes it, and reads what the window shows: the grid's
// accessibility table, the state strip, and what the Edit menu's Undo and
// Redo items read. Where it says so, it quits and relaunches to read the view
// the file remembers.
//
// No assertion needs the window focused, and no application-menu command is
// used: undo and redo arrive as the Edit menu sends them to the window. Every
// wait polls what the window shows; none waits a fixed time.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { build_fixture_xlsx, cell, row } from '../../src/test/helpers/xlsx-structure-fixture';
import { history_menu_item, type HistoryMenuState } from '../main/history-menu-model';
import { isolated_user_data, read_workbook } from './smoke-helpers';
import {
    cell_point,
    choose,
    exit_app,
    install_dialog_capture,
    install_history_menu_capture,
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
    test_root = isolated_user_data('tv-undo-redo-view-');
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
const NATURAL = ['Alice|30|New York', 'Bob|25|London', 'Charlie|35|Paris', 'Dora|28|Oslo'];
const AGE_DESCENDING = ['Charlie|35|Paris', 'Alice|30|New York', 'Dora|28|Oslo', 'Bob|25|London'];
const AGE_ASCENDING = ['Bob|25|London', 'Dora|28|Oslo', 'Alice|30|New York', 'Charlie|35|Paris'];

function sheet(name: string, rows: readonly (readonly (string | number)[])[]) {
    return {
        name,
        body: `<sheetData>${rows.map((cells, index) =>
            row(index + 1, cells.map((value, column) => cell(`${'ABC'[column]}${index + 1}`, value))))
            .join('')}</sheetData>`,
    };
}

const fixture = (kind: 'csv' | 'xlsx'): string | Buffer => kind === 'csv'
    ? CSV
    : Buffer.from(build_fixture_xlsx({ sheets: [sheet('Data', ROWS)] }));

/** Launch the app on a file in this test's directory. A second call relaunches on the same state. */
async function open_file(name: string, content?: string | Buffer): Promise<{ file: string; page: Page }> {
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir, { recursive: true });
    const file = path.join(test_root, name);
    if (content !== undefined) fs.writeFileSync(file, content);
    const launched = await launch_structural_viewer(user_data_dir, file);
    app = launched.app;
    await install_dialog_capture(app);
    await install_history_menu_capture(app);
    await wait_for_grid(launched.page);
    return { file, page: launched.page };
}

async function relaunch(name: string): Promise<Page> {
    await exit_app(app!);
    app = undefined;
    return (await open_file(name)).page;
}

interface Shown {
    /** Each body row's cells. */
    body: string[];
    /** The column headers. */
    headers: string[];
    /** The state strip's text: sort keys, filters, hidden rows. Empty when there is none. */
    strip: string;
    /** What the Edit menu's Undo and Redo items read. */
    undo: string;
    redo: string;
}

async function shown(page: Page): Promise<Shown> {
    const view = await page.evaluate(() => ({
        body: [...document.querySelectorAll('tbody tr')].map((line) =>
            [...line.querySelectorAll('td')].map((data) => data.textContent ?? '').join('|')),
        headers: [...document.querySelectorAll('thead th')].map((header) => header.textContent ?? '')
            .filter((text) => text !== ''),
        strip: ((document.querySelector('.state-strip') as HTMLElement | null)?.innerText ?? '')
            .replace(/\s+/g, ' ').trim(),
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

/**
 * Wait until the window shows `expected`, and nothing was said that is not in
 * `dialogs`. A message the test did not expect fails here, with its text,
 * instead of somewhere later.
 */
async function expect_shown(
    page: Page,
    expected: Partial<Shown>,
    dialogs: readonly string[] = [],
): Promise<void> {
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

async function sort(page: Page, column: number, direction: 'ascending' | 'descending'): Promise<void> {
    const menu = await open_column_menu(page, column);
    const entry = menu.getByRole('menuitemcheckbox', { name: `Sort ${direction}` });
    await expect(entry).not.toHaveAttribute('aria-disabled', 'true');
    await entry.click();
    await expect(menu).toHaveCount(0);
}

/** Select a body cell by clicking it. */
async function select_cell(page: Page, column: number, display_row: number): Promise<void> {
    const point = await cell_point(page, column, display_row);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator(`#glide-cell-${column + 1}-${display_row}`))
        .toHaveAttribute('aria-selected', 'true');
}

/** Fill in the open filter popover: "contains `text`", and apply. */
async function apply_contains(page: Page, text: string): Promise<void> {
    const popover = page.locator('.filter-popover');
    await expect(popover).toBeVisible();
    await popover.locator('#filter-condition').selectOption('contains');
    await popover.getByLabel('Filter value').fill(text);
    const apply = popover.getByRole('button', { name: 'Apply' });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(popover).toBeHidden();
}

/** Filter a column to the rows containing `text`, from the keyboard on a selected cell. */
async function filter_contains(page: Page, column: number, text: string): Promise<void> {
    await select_cell(page, column, 0);
    await page.keyboard.press('Shift+Alt+F');
    await apply_contains(page, text);
}

async function expect_clean_and_released(page: Page): Promise<void> {
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/);
    await expect.poll(() => page.locator('.grid-shell-root').getAttribute('data-edit-session')).toBe('none');
}

/** The saved file's body rows as `a|b|c`. */
async function saved_body(kind: 'csv' | 'xlsx', file: string): Promise<string[] | undefined> {
    if (kind === 'csv') {
        return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(1)
            .map((line) => line.split(',').join('|'));
    }
    return (await read_workbook(file))?.data.sheets[0].rows.slice(1)
        .map((cells) => cells.map((value) => value?.formatted ?? '').join('|'));
}

for (const kind of ['csv', 'xlsx'] as const) {
    test(`${kind}: a sort set, changed, and cleared is undone and redone step by step`, async () => {
        const { page } = await open_file(`sort.${kind}`, fixture(kind));
        await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo', redo: 'Redo' });

        await sort(page, 1, 'descending');
        await expect_shown(page, { body: AGE_DESCENDING, undo: 'Undo Sort', redo: 'Redo' });
        const descending = (await shown(page)).strip;
        expect(descending).toContain('Age');
        await sort(page, 1, 'ascending');
        await expect_shown(page, { body: AGE_ASCENDING, undo: 'Undo Sort' });
        const ascending = (await shown(page)).strip;
        expect(ascending).not.toBe(descending);
        await page.getByRole('button', { name: 'Clear all sorts' }).click();
        await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo Clear sort' });
        // A view step is not an edit: the file has nothing to save.
        await expect(save_button(page)).not.toHaveClass(/has-unsaved/);

        await history(page, 'undo');
        await expect_shown(page, { body: AGE_ASCENDING, strip: ascending, undo: 'Undo Sort', redo: 'Redo Clear sort' });
        await history(page, 'undo');
        await expect_shown(page, { body: AGE_DESCENDING, strip: descending, undo: 'Undo Sort', redo: 'Redo Sort' });
        await history(page, 'undo');
        await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo', redo: 'Redo Sort' });

        await history(page, 'redo');
        await expect_shown(page, { body: AGE_DESCENDING, strip: descending, undo: 'Undo Sort', redo: 'Redo Sort' });
        await history(page, 'redo');
        await expect_shown(page, { body: AGE_ASCENDING, strip: ascending, redo: 'Redo Clear sort' });
        await history(page, 'redo');
        await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo Clear sort', redo: 'Redo' });
        await expect(save_button(page)).not.toHaveClass(/has-unsaved/);
    });

    test(`${kind}: an edit, a sort, and an edit are undone to a clean file, redone, and saved`, async () => {
        const { file, page } = await open_file(`edits.${kind}`, fixture(kind));
        await expect_shown(page, { body: NATURAL });

        await type_into_cell(page, 1, 0, 'Ann');
        await sort(page, 1, 'descending');
        const sorted = ['Charlie|35|Paris', 'Ann|30|New York', 'Dora|28|Oslo', 'Bob|25|London'];
        await expect_shown(page, { body: sorted, undo: 'Undo Sort' });
        const strip = (await shown(page)).strip;
        // The display order stays as sorted while editing.
        await type_into_cell(page, 3, 0, 'Lyon');
        const edited = ['Charlie|35|Lyon', 'Ann|30|New York', 'Dora|28|Oslo', 'Bob|25|London'];
        await expect_shown(page, { body: edited, strip });

        await history(page, 'undo');
        await expect_shown(page, { body: sorted, strip, undo: 'Undo Sort' });
        await history(page, 'undo');
        await expect_shown(page, {
            body: ['Ann|30|New York', 'Bob|25|London', 'Charlie|35|Paris', 'Dora|28|Oslo'],
            strip: '',
            redo: 'Redo Sort',
        });
        await history(page, 'undo');
        await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo' });
        // Nothing is unsaved, the editing session is let go, and every step is still there.
        await expect_clean_and_released(page);

        await history(page, 'redo');
        await expect_shown(page, {
            body: ['Ann|30|New York', 'Bob|25|London', 'Charlie|35|Paris', 'Dora|28|Oslo'],
            strip: '',
            redo: 'Redo Sort',
        });
        await history(page, 'redo');
        await expect_shown(page, { body: sorted, strip });
        await history(page, 'redo');
        await expect_shown(page, { body: edited, strip, redo: 'Redo' });
        await save_changes(page);
        // The file keeps its own row order: a sort is a view.
        await expect.poll(() => saved_body(kind, file)).toEqual(
            ['Ann|30|New York', 'Bob|25|London', 'Charlie|35|Lyon', 'Dora|28|Oslo'],
        );
    });
}

test('a filter added, changed, and removed is undone and redone step by step', async () => {
    const { page } = await open_file('filter.csv', CSV);
    await expect_shown(page, { body: NATURAL, strip: '' });

    await filter_contains(page, 2, 'o');
    const with_o = ['Alice|30|New York', 'Bob|25|London', 'Dora|28|Oslo'];
    await expect_shown(page, { body: with_o, undo: 'Undo Filter' });
    const first = (await shown(page)).strip;
    expect(first).toContain('City');
    // Change it through its chip.
    await page.locator('.filter-chip-body').first().click();
    await apply_contains(page, 'on');
    const with_on = ['Bob|25|London'];
    await expect_shown(page, { body: with_on, undo: 'Undo Filter' });
    const second = (await shown(page)).strip;
    expect(second).not.toBe(first);
    await page.getByRole('button', { name: 'Clear all filters' }).click();
    await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo Clear filter' });

    await history(page, 'undo');
    await expect_shown(page, { body: with_on, strip: second, redo: 'Redo Clear filter' });
    await history(page, 'undo');
    await expect_shown(page, { body: with_o, strip: first, redo: 'Redo Filter' });
    await history(page, 'undo');
    await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo', redo: 'Redo Filter' });

    await history(page, 'redo');
    await expect_shown(page, { body: with_o, strip: first });
    await history(page, 'redo');
    await expect_shown(page, { body: with_on, strip: second });
    await history(page, 'redo');
    await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo Clear filter', redo: 'Redo' });
});

test('hidden rows and Unhide all are undone and redone step by step', async () => {
    const { page } = await open_file('rows.csv', CSV);
    await expect_shown(page, { body: NATURAL, strip: '' });

    await choose(await open_row_menu(page, 1), 'Hide row');
    const without_bob = ['Alice|30|New York', 'Charlie|35|Paris', 'Dora|28|Oslo'];
    await expect_shown(page, { body: without_bob, strip: '1 hidden row Unhide all', undo: 'Undo Hide row' });
    await choose(await open_row_menu(page, 2), 'Hide row');
    const without_two = ['Alice|30|New York', 'Charlie|35|Paris'];
    await expect_shown(page, { body: without_two, strip: '2 hidden rows Unhide all', undo: 'Undo Hide row' });
    await page.getByRole('button', { name: 'Unhide all' }).click();
    await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo Unhide rows' });

    await history(page, 'undo');
    await expect_shown(page, { body: without_two, strip: '2 hidden rows Unhide all', redo: 'Redo Unhide rows' });
    await history(page, 'undo');
    await expect_shown(page, { body: without_bob, strip: '1 hidden row Unhide all', redo: 'Redo Hide row' });
    await history(page, 'undo');
    await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo', redo: 'Redo Hide row' });

    await history(page, 'redo');
    await expect_shown(page, { body: without_bob, strip: '1 hidden row Unhide all' });
    await history(page, 'redo');
    await expect_shown(page, { body: without_two, strip: '2 hidden rows Unhide all' });
    await history(page, 'redo');
    await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo Unhide rows', redo: 'Redo' });
});

test('hidden and shown columns are undone and redone, and the file remembers the undone view', async () => {
    let { page } = await open_file('columns.csv', CSV);
    const all = ['Name', 'Age', 'City'];
    await expect_shown(page, { headers: all, body: NATURAL });

    await choose(await open_column_menu(page, 1), 'Hide column');
    const without_age = ['Alice|New York', 'Bob|London', 'Charlie|Paris', 'Dora|Oslo'];
    await expect_shown(page, { headers: ['Name', 'City'], body: without_age, undo: 'Undo Hide column' });
    await choose(await open_column_menu(page, 0), 'Hide column');
    const city_only = ['New York', 'London', 'Paris', 'Oslo'];
    await expect_shown(page, { headers: ['City'], body: city_only, undo: 'Undo Hide column' });
    // Show both again from the Columns control, then leave it: with focus in
    // its search field, Undo is that field's own text undo.
    await page.locator('.column-visibility-trigger').click();
    await page.locator('.column-visibility-action', { hasText: 'Show all' }).click();
    await expect_shown(page, { headers: all, body: NATURAL, undo: 'Undo Show 2 columns' });
    await page.keyboard.press('Escape');
    await expect(page.locator('.column-visibility-popover')).toBeHidden();
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/);

    await history(page, 'undo');
    await expect_shown(page, { headers: ['City'], body: city_only, undo: 'Undo Hide column', redo: 'Redo Show 2 columns' });
    await history(page, 'undo');
    await expect_shown(page, { headers: ['Name', 'City'], body: without_age, redo: 'Redo Hide column' });
    await history(page, 'undo');
    await expect_shown(page, { headers: all, body: NATURAL, undo: 'Undo', redo: 'Redo Hide column' });
    await history(page, 'redo');
    await expect_shown(page, { headers: ['Name', 'City'], body: without_age, undo: 'Undo Hide column' });
    await history(page, 'redo');
    await expect_shown(page, { headers: ['City'], body: city_only });
    await history(page, 'redo');
    await expect_shown(page, { headers: all, body: NATURAL, redo: 'Redo' });

    // Back two steps, then quit: the next launch shows the undone view.
    await history(page, 'undo');
    await expect_shown(page, { headers: ['City'], body: city_only });
    await history(page, 'undo');
    await expect_shown(page, { headers: ['Name', 'City'], body: without_age });
    page = await relaunch('columns.csv');
    await expect_shown(page, { headers: ['Name', 'City'], body: without_age });
});

test('a sort that was undone stays undone after a relaunch', async () => {
    let { page } = await open_file('persisted.csv', CSV);
    await sort(page, 1, 'descending');
    await expect_shown(page, { body: AGE_DESCENDING, undo: 'Undo Sort' });
    const descending = (await shown(page)).strip;
    await sort(page, 0, 'descending');
    const by_name = ['Dora|28|Oslo', 'Charlie|35|Paris', 'Bob|25|London', 'Alice|30|New York'];
    await expect_shown(page, { body: by_name });

    await history(page, 'undo');
    await expect_shown(page, { body: AGE_DESCENDING, strip: descending, redo: 'Redo Sort' });
    page = await relaunch('persisted.csv');
    await expect_shown(page, { body: AGE_DESCENDING, strip: descending });

    // And all the way back: nothing sorted, and nothing sorted after a relaunch.
    await sort(page, 0, 'descending');
    await expect_shown(page, { body: by_name, undo: 'Undo Sort' });
    await history(page, 'undo');
    await expect_shown(page, { body: AGE_DESCENDING, strip: descending });
    await page.getByRole('button', { name: 'Clear all sorts' }).click();
    await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo Clear sort' });
    await history(page, 'undo');
    await expect_shown(page, { body: AGE_DESCENDING, strip: descending });
    await history(page, 'redo');
    await expect_shown(page, { body: NATURAL, strip: '' });
    page = await relaunch('persisted.csv');
    await expect_shown(page, { body: NATURAL, strip: '' });
});

test('a sort made after an edit was undone is itself undone and redone', async () => {
    const { page } = await open_file('after-undo.csv', CSV);
    await type_into_cell(page, 1, 0, 'Ann');
    await history(page, 'undo');
    await expect_shown(page, { body: NATURAL, undo: 'Undo' });
    await expect_clean_and_released(page);

    // A new step clears what there was to redo.
    await sort(page, 1, 'descending');
    await expect_shown(page, { body: AGE_DESCENDING, undo: 'Undo Sort', redo: 'Redo' });
    const strip = (await shown(page)).strip;
    await history(page, 'undo');
    await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo', redo: 'Redo Sort' });
    await history(page, 'redo');
    await expect_shown(page, { body: AGE_DESCENDING, strip, undo: 'Undo Sort', redo: 'Redo' });
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/);
});

test('Undo pressed again the instant the last edit is undone takes back the sort under it, with no message', async () => {
    const { page } = await open_file('held.csv', CSV);
    await sort(page, 1, 'descending');
    await expect_shown(page, { body: AGE_DESCENDING, undo: 'Undo Sort' });
    await type_into_cell(page, 3, 0, 'Lyon');
    await expect_shown(page, { body: ['Charlie|35|Lyon', ...AGE_DESCENDING.slice(1)] });
    await expect.poll(() => page.locator('.grid-shell-root').getAttribute('data-edit-session'))
        .not.toBe('none');

    // The second Undo is sent from inside the page on the render that shows
    // the editing session let go, so the release has been posted and its
    // answer has not arrived. A person holding the Undo key lands here.
    //
    // This checks what the person sees. The desktop host usually finishes the
    // release before the second request reaches it, so the wait that covers
    // the slower case is pinned in app.test.ts ("while this window's editing
    // session is being let go"), not here.
    await page.evaluate(() => {
        const session = () => document.querySelector('.grid-shell-root')?.getAttribute('data-edit-session');
        const observer = new MutationObserver(() => {
            if (session() !== 'none') return;
            observer.disconnect();
            window.postMessage({ type: 'editCommand', command: 'undo' }, '*');
        });
        observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-edit-session'],
            childList: true,
            subtree: true,
        });
    });
    await history(page, 'undo');

    await expect_shown(page, { body: NATURAL, strip: '', undo: 'Undo', redo: 'Redo Sort' });
    await history(page, 'redo');
    await expect_shown(page, { body: AGE_DESCENDING, redo: 'Redo Edit cell' });
});

test('text typed into a cell is committed by the sort that follows it, and sits under the sort in history', async () => {
    const { page } = await open_file('typed.csv', CSV);
    await expect_shown(page, { body: NATURAL });

    // Type, and sort without closing the editor.
    const target = page.locator('#glide-cell-1-0');
    await target.focus();
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    const editor = page.locator('.cell-editor-input');
    await expect(editor).toBeVisible();
    await editor.fill('Ann');
    await sort(page, 1, 'descending');

    const sorted = ['Charlie|35|Paris', 'Ann|30|New York', 'Dora|28|Oslo', 'Bob|25|London'];
    await expect_shown(page, { body: sorted, undo: 'Undo Sort' });
    await history(page, 'undo');
    await expect_shown(page, {
        body: ['Ann|30|New York', 'Bob|25|London', 'Charlie|35|Paris', 'Dora|28|Oslo'],
        strip: '',
        redo: 'Redo Sort',
    });
    await history(page, 'undo');
    await expect_shown(page, { body: NATURAL, undo: 'Undo' });
});

test('a sort on another worksheet is undone from the first, which switches to it', async () => {
    const { page } = await open_file('two-sheets.xlsx', Buffer.from(build_fixture_xlsx({
        sheets: [
            sheet('First', ROWS),
            sheet('Second', [['Item', 'Qty'], ['apple', 3], ['pear', 1], ['fig', 2]]),
        ],
    })));
    await expect_shown(page, { body: NATURAL });
    await page.locator('.sheet-tab', { hasText: 'Second' }).click();
    const second = ['apple|3', 'pear|1', 'fig|2'];
    await expect_shown(page, { body: second });
    await sort(page, 1, 'ascending');
    const by_quantity = ['pear|1', 'fig|2', 'apple|3'];
    await expect_shown(page, { body: by_quantity, undo: 'Undo Sort' });
    const strip = (await shown(page)).strip;
    await page.locator('.sheet-tab', { hasText: 'First' }).click();
    await expect_shown(page, { body: NATURAL, strip: '' });

    await history(page, 'undo');
    await expect_shown(page, { body: second, strip: '', undo: 'Undo', redo: 'Redo Sort' });
    await expect(page.locator('.sheet-tab.active')).toHaveText('Second');
    await page.locator('.sheet-tab', { hasText: 'First' }).click();
    await expect_shown(page, { body: NATURAL });
    await history(page, 'redo');
    await expect_shown(page, { body: by_quantity, strip, undo: 'Undo Sort', redo: 'Redo' });
});

test('a sort made before the header row was turned off is undone in order, once the header has gone back, with no message', async () => {
    const { page } = await open_file('header.xlsx', fixture('xlsx'));
    await expect_shown(page, { headers: ['Name', 'Age', 'City'], body: NATURAL });
    await type_into_cell(page, 1, 0, 'Ann');
    await sort(page, 1, 'descending');
    const sorted = ['Charlie|35|Paris', 'Ann|30|New York', 'Dora|28|Oslo', 'Bob|25|London'];
    await expect_shown(page, { body: sorted, undo: 'Undo Sort' });
    const strip = (await shown(page)).strip;

    // Turn the header row off: its cells become the first row, and the
    // columns are no longer the ones the sort named. That is a step too.
    await page.getByRole('button', { name: 'Header Row', exact: true }).click();
    await expect.poll(async () => (await shown(page)).headers).toEqual(['A', 'B', 'C']);
    await expect.poll(async () => (await shown(page)).body).toContain('Ann|30|New York');
    await expect_shown(page, { undo: 'Undo Turn off header row' });

    // In order, the header goes back before the sort made under it is
    // reached, so the sort's columns are the ones it named and nothing is
    // skipped. (The skip, "the columns of this worksheet changed since
    // then", is for a header change this window's history does not hold;
    // app.test.ts covers it.)
    await history(page, 'undo');
    await expect_shown(page, {
        headers: ['Name', 'Age', 'City'],
        body: sorted,
        strip,
        undo: 'Undo Sort',
        redo: 'Redo Turn off header row',
    });
    await history(page, 'undo');
    await expect_shown(page, {
        body: ['Ann|30|New York', 'Bob|25|London', 'Charlie|35|Paris', 'Dora|28|Oslo'],
        strip: '',
        undo: 'Undo Edit cell',
        redo: 'Redo Sort',
    });
    await history(page, 'undo');
    await expect_shown(page, { body: NATURAL, undo: 'Undo', redo: 'Redo Edit cell' });
});
