// The Header Row as an undo step, in the desktop app.
//
// Choosing, changing, and clearing an .xlsx Header Row is a step in the same
// history as edits and other view changes. Each test here changes the header
// the way a person does (the Header Row toggle and its all-sheets menu, "Use
// row as header", Unhide all), then undoes and redoes it, and reads what the
// window shows: the column headers and body in the grid's accessibility
// table, the state strip, what the Edit menu's Undo and Redo items read, and
// every message the app showed. Where it says so, it also reads what the file
// state database remembers, relaunches, or reads the saved file back.
//
// No assertion needs the window focused, and no application-menu command is
// used: undo and redo arrive as the Edit menu sends them to the window. Every
// wait polls what the window shows; none waits a fixed time.
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { build_fixture_xlsx, cell, row } from '../../src/test/helpers/xlsx-structure-fixture';
import { history_menu_item, type HistoryMenuState } from '../main/history-menu-model';
import { CHANNEL_WEBVIEW_MESSAGE } from '../shared/ipc';
import {
    hot_journal_present,
    isolated_user_data,
    read_workbook,
    state_database_path,
} from './smoke-helpers';
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
    test_root = isolated_user_data('tv-undo-redo-header-step-');
});

test.afterEach(async () => {
    if (app) await exit_app(app);
    app = undefined;
    fs.rmSync(test_root, { recursive: true, force: true });
});

type Rows = readonly (readonly (string | number)[])[];

// Row 1 holds text over numbers, so the first row is detected as the header.
const DETECTED: Rows = [['name', 'qty'], ['apple', 10], ['banana', 20], ['cherry', 30]];
// Row 1 holds numbers, so no header is detected; row 2 is the real one.
const TITLED: Rows = [[1, 2], ['name', 'qty'], ['apple', 10], ['banana', 20], ['cherry', 30]];
const TITLED_BODY = ['1|2', 'name|qty', 'apple|10', 'banana|20', 'cherry|30'];
const FRUIT = ['apple|10', 'banana|20', 'cherry|30'];
const NO_HEADER = ['A', 'B'];

function sheet(name: string, rows: Rows) {
    return {
        name,
        body: `<sheetData>${rows.map((cells, index) =>
            row(index + 1, cells.map((value, column) => cell(`${'ABC'[column]}${index + 1}`, value))))
            .join('')}</sheetData>`,
    };
}

const workbook = (...sheets: ReturnType<typeof sheet>[]): Buffer =>
    Buffer.from(build_fixture_xlsx({ sheets }));

const user_data_dir = (): string => path.join(test_root, 'user-data');

/** Launch the app on a file in this test's directory. A second call relaunches on the same state. */
async function open_file(name: string, content?: Buffer): Promise<{ file: string; page: Page }> {
    fs.mkdirSync(user_data_dir(), { recursive: true });
    const file = path.join(test_root, name);
    if (content !== undefined) fs.writeFileSync(file, content);
    const launched = await launch_structural_viewer(user_data_dir(), file);
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
async function history(page: Page, command: 'undo' | 'redo', times = 1): Promise<void> {
    await page.evaluate(({ sent, count }) => {
        for (let press = 0; press < count; press += 1) {
            window.postMessage({ type: 'editCommand', command: sent }, '*');
        }
    }, { sent: command, count: times });
}

/**
 * Undo or redo a cell edit soon after a Save, and wait for `expected`.
 *
 * This allows for a race that has nothing to do with the header row. The file
 * watcher's refresh for the save can land while the edit is being replayed,
 * and the host then refuses the replay and says "… did not run because the
 * file was refreshing. Try again." The helper does what the message says.
 * A message in `also_said` is waited for and set aside. Any other message
 * fails, with its text.
 */
async function history_after_save(
    page: Page,
    command: 'undo' | 'redo',
    expected: Partial<Shown>,
    // Messages the app says here that are not this test's subject. Each is
    // waited for, so none can arrive later and be read as something else.
    also_said: readonly string[] = [],
): Promise<void> {
    const try_again = `${command === 'undo' ? 'Undo' : 'Redo'} did not run because the file was refreshing. Try again.`;
    await history(page, command);
    const said: string[] = [];
    const awaited = new Set(also_said);
    await expect.poll(async () => {
        for (const dialog of await take_dialogs(app!)) {
            const message = dialog.message ?? '';
            if (message === try_again) await history(page, command);
            else if (also_said.includes(message)) awaited.delete(message);
            else said.push(message);
        }
        const now = await shown(page);
        const picked: Record<string, unknown> = {};
        for (const key of Object.keys(expected) as (keyof Shown)[]) picked[key] = now[key];
        return { ...picked, dialogs: [...said], awaited: [...awaited] };
    }).toEqual({ ...expected, dialogs: [], awaited: [] });
}

interface Remembered {
    /** The worksheet's stored header choice; `auto` when none is stored. */
    header: 'auto' | 'on' | 'off';
    /** The worksheet's stored hidden source rows. */
    hidden: number[];
}

/**
 * What the state database remembers for the file's first worksheet, or
 * undefined while it cannot be read. Read from a copy, never in place, and
 * never from a copy taken while the app is inside a write (see
 * `undo-redo-size.spec.ts`).
 */
function remembered(file: string, sheet_name = 'Data'): Remembered | undefined {
    try {
        const copy = path.join(test_root, 'file-state-copy.sqlite3');
        if (hot_journal_present(user_data_dir())) return undefined;
        fs.copyFileSync(state_database_path(user_data_dir()), copy);
        if (hot_journal_present(user_data_dir())) return undefined;
        const database = new DatabaseSync(copy, { readOnly: true });
        try {
            const entries = database.prepare('SELECT path, state_json FROM entries').all() as
                { path: string; state_json: string }[];
            const entry = entries.find((candidate) => candidate.path.endsWith(path.basename(file)));
            if (entry === undefined) return { header: 'auto', hidden: [] };
            const state = JSON.parse(entry.state_json) as {
                excelFirstRowHeaders?: Record<string, 'on' | 'off'>;
                transforms?: ({ hiddenRows?: number[] } | null)[];
            };
            return {
                header: state.excelFirstRowHeaders?.[sheet_name] ?? 'auto',
                hidden: state.transforms?.[0]?.hiddenRows ?? [],
            };
        } finally {
            database.close();
        }
    } catch {
        // Not there yet, or copied mid-write: read again.
        return undefined;
    }
}

async function expect_remembered(file: string, expected: Remembered): Promise<void> {
    await expect.poll(() => remembered(file)).toEqual(expected);
}

function header_row_button(page: Page) {
    return page.getByRole('button', { name: 'Header Row', exact: true });
}

async function toggle_header(page: Page): Promise<void> {
    await expect(header_row_button(page)).not.toHaveAttribute('aria-disabled', 'true');
    await header_row_button(page).click();
}

async function use_row_as_header(page: Page, display_row: number): Promise<void> {
    await choose(await open_row_menu(page, display_row), 'Use row as header');
}

async function unhide_all(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Unhide all' }).click();
}

async function sort_descending(page: Page, column: number): Promise<void> {
    const menu = await open_column_menu(page, column);
    const entry = menu.getByRole('menuitemcheckbox', { name: 'Sort descending' });
    await expect(entry).not.toHaveAttribute('aria-disabled', 'true');
    await entry.click();
    await expect(menu).toHaveCount(0);
}

async function expect_clean_and_released(page: Page): Promise<void> {
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/);
    await expect.poll(() => page.locator('.grid-shell-root').getAttribute('data-edit-session')).toBe('none');
}

/** The saved worksheet's rows as `a|b`, trailing blank cells dropped. */
async function saved(file: string): Promise<string[] | undefined> {
    return (await read_workbook(file))?.data.sheets[0].rows.map((cells) => {
        const kept = cells.map((value) => value?.formatted ?? '');
        while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
        return kept.join('|');
    });
}

test('the Header Row toggle is undone and redone, and undoing the first toggle puts "automatic" back', async () => {
    let { file, page } = await open_file('toggle.xlsx', workbook(sheet('Data', DETECTED)));
    const off_body = ['name|qty', ...FRUIT];
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT, undo: 'Undo', redo: 'Redo' });
    await expect_remembered(file, { header: 'auto', hidden: [] });

    await toggle_header(page);
    await expect_shown(page, { headers: NO_HEADER, body: off_body, undo: 'Undo Turn off header row', redo: 'Redo' });
    await expect_remembered(file, { header: 'off', hidden: [] });
    await toggle_header(page);
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT, undo: 'Undo Use row 1 as header' });
    await expect_remembered(file, { header: 'on', hidden: [] });
    // A header step is not an edit: the file has nothing to save.
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/);

    await history(page, 'undo');
    await expect_shown(page, {
        headers: NO_HEADER,
        body: off_body,
        undo: 'Undo Turn off header row',
        redo: 'Redo Use row 1 as header',
    });
    await expect_remembered(file, { header: 'off', hidden: [] });
    await history(page, 'undo');
    await expect_shown(page, {
        headers: ['name', 'qty'],
        body: FRUIT,
        undo: 'Undo',
        redo: 'Redo Turn off header row',
    });
    // Not "on": the choice is the detector's again, as before the first click.
    await expect_remembered(file, { header: 'auto', hidden: [] });

    await history(page, 'redo');
    await expect_shown(page, { headers: NO_HEADER, body: off_body, redo: 'Redo Use row 1 as header' });
    await expect_remembered(file, { header: 'off', hidden: [] });
    await history(page, 'redo');
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT, undo: 'Undo Use row 1 as header', redo: 'Redo' });
    await expect_remembered(file, { header: 'on', hidden: [] });

    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: off_body });
    await history(page, 'undo');
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT, undo: 'Undo' });
    page = await relaunch('toggle.xlsx');
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    await expect_remembered(file, { header: 'auto', hidden: [] });
});

test('"Use row as header" is undone and redone with the rows it hid, also from a header turned on by hand', async () => {
    const { file, page } = await open_file('chosen.xlsx', workbook(sheet('Data', TITLED)));
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, strip: '' });

    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT, undo: 'Undo Use row 2 as header' });
    const hidden_strip = (await shown(page)).strip;
    expect(hidden_strip).toContain('1 hidden row');
    await expect_remembered(file, { header: 'on', hidden: [0] });

    await history(page, 'undo');
    await expect_shown(page, {
        headers: NO_HEADER,
        body: TITLED_BODY,
        strip: '',
        undo: 'Undo',
        redo: 'Redo Use row 2 as header',
    });
    await expect_remembered(file, { header: 'auto', hidden: [] });
    await history(page, 'redo');
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT, strip: hidden_strip, redo: 'Redo' });
    await expect_remembered(file, { header: 'on', hidden: [0] });
    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, strip: '' });

    // Turn the header on by hand: row 1. Then choose row 3 from there.
    await toggle_header(page);
    await expect_shown(page, {
        headers: ['1', '2'],
        body: TITLED_BODY.slice(1),
        strip: '',
        undo: 'Undo Use row 1 as header',
    });
    await use_row_as_header(page, 1);
    await expect_shown(page, {
        headers: ['apple', '10'],
        body: ['banana|20', 'cherry|30'],
        undo: 'Undo Use row 3 as header',
    });
    await expect_remembered(file, { header: 'on', hidden: [0, 1] });
    // Back to row 1 as the header, with the two rows above the chosen one shown again.
    await history(page, 'undo');
    await expect_shown(page, {
        headers: ['1', '2'],
        body: TITLED_BODY.slice(1),
        strip: '',
        undo: 'Undo Use row 1 as header',
        redo: 'Redo Use row 3 as header',
    });
    await expect_remembered(file, { header: 'on', hidden: [] });
    await history(page, 'redo');
    await expect_shown(page, { headers: ['apple', '10'], body: ['banana|20', 'cherry|30'] });
    await expect_remembered(file, { header: 'on', hidden: [0, 1] });
});

test('Unhide all on a chosen header is one step: Undo brings the header and every hidden row back together', async () => {
    const { file, page } = await open_file('unhide.xlsx', workbook(sheet('Data', TITLED)));
    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    // A row hidden by hand, below the header.
    await choose(await open_row_menu(page, 1), 'Hide row');
    await expect_shown(page, { headers: ['name', 'qty'], body: ['apple|10', 'cherry|30'], undo: 'Undo Hide row' });
    const promoted_strip = (await shown(page)).strip;
    await expect_remembered(file, { header: 'on', hidden: [0, 3] });

    await unhide_all(page);
    await expect_shown(page, {
        headers: NO_HEADER,
        body: TITLED_BODY,
        strip: '',
        undo: 'Undo Unhide rows',
        redo: 'Redo',
    });
    await expect_remembered(file, { header: 'off', hidden: [] });

    await history(page, 'undo');
    await expect_shown(page, {
        headers: ['name', 'qty'],
        body: ['apple|10', 'cherry|30'],
        strip: promoted_strip,
        undo: 'Undo Hide row',
        redo: 'Redo Unhide rows',
    });
    await expect_remembered(file, { header: 'on', hidden: [0, 3] });
    await history(page, 'redo');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, strip: '', undo: 'Undo Unhide rows' });
    await expect_remembered(file, { header: 'off', hidden: [] });
});

test('an edit on the row that then became the header is undone after the header goes back, and both are redone, with no message', async () => {
    const { file, page } = await open_file('header-cell.xlsx', workbook(sheet('Data', TITLED)));
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY });
    await type_into_cell(page, 1, 1, 'title');
    const edited = ['1|2', 'title|qty', ...FRUIT];
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(edited);

    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['title', 'qty'], body: FRUIT, undo: 'Undo Use row 2 as header' });

    // The header goes back first, so the edit is undone on the ordinary row
    // it was typed on. (Before the header was a step, this Undo was refused:
    // "Can't undo this cell change while row 2 is the header row…")
    await history(page, 'undo');
    await expect_shown(page, {
        headers: NO_HEADER,
        body: edited,
        undo: 'Undo Edit cell',
        redo: 'Redo Use row 2 as header',
    });
    await history_after_save(page, 'undo', {
        headers: NO_HEADER,
        body: TITLED_BODY,
        undo: 'Undo',
        redo: 'Redo Edit cell',
    });
    await expect(save_button(page)).toHaveClass(/has-unsaved/);

    // And forward: the edit, then the header over it.
    await history_after_save(page, 'redo', { headers: NO_HEADER, body: edited, redo: 'Redo Use row 2 as header' });
    await history(page, 'redo');
    await expect_shown(page, { headers: ['title', 'qty'], body: FRUIT, undo: 'Undo Use row 2 as header', redo: 'Redo' });
    await expect_clean_and_released(page);
    expect(await saved(file)).toEqual(edited);
});

test('a row hidden before a header was chosen below it is shown again in order, with no "rows above the header row" message', async () => {
    const { file, page } = await open_file('hidden-then-header.xlsx', workbook(sheet('Data', TITLED)));
    await choose(await open_row_menu(page, 0), 'Hide row');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY.slice(1), undo: 'Undo Hide row' });
    const one_hidden = (await shown(page)).strip;
    // Row 3 of the file: the rows above it are row 1 (hidden already) and row 2.
    await use_row_as_header(page, 1);
    await expect_shown(page, {
        headers: ['apple', '10'],
        body: ['banana|20', 'cherry|30'],
        undo: 'Undo Use row 3 as header',
    });
    await expect_remembered(file, { header: 'on', hidden: [0, 1] });

    await history(page, 'undo');
    await expect_shown(page, {
        headers: NO_HEADER,
        body: TITLED_BODY.slice(1),
        strip: one_hidden,
        undo: 'Undo Hide row',
        redo: 'Redo Use row 3 as header',
    });
    await expect_remembered(file, { header: 'auto', hidden: [0] });
    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, strip: '', undo: 'Undo', redo: 'Redo Hide row' });
    await expect_remembered(file, { header: 'auto', hidden: [] });

    await history(page, 'redo');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY.slice(1), strip: one_hidden });
    await history(page, 'redo');
    await expect_shown(page, { headers: ['apple', '10'], body: ['banana|20', 'cherry|30'], redo: 'Redo' });
    await expect_remembered(file, { header: 'on', hidden: [0, 1] });
});

test('edits, an added row, a chosen header, a sort and an auto-fit are undone to a clean workbook and redone into the saved file', async () => {
    const { file, page } = await open_file('interleaved.xlsx', workbook(sheet('Data', TITLED)));
    await type_into_cell(page, 1, 2, 'pear');
    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Add row', exact: true }).click();
    const added = ['1|2', 'name|qty', 'pear|10', 'banana|20', 'cherry|30', '|'];
    await expect_shown(page, { headers: NO_HEADER, body: added });

    await use_row_as_header(page, 1);
    const under_header = ['pear|10', 'banana|20', 'cherry|30', '|'];
    await expect_shown(page, { headers: ['name', 'qty'], body: under_header, undo: 'Undo Use row 2 as header' });
    await type_into_cell(page, 2, 1, '21');
    const edited = ['pear|10', 'banana|21', 'cherry|30', '|'];
    await expect_shown(page, { headers: ['name', 'qty'], body: edited, undo: 'Undo Edit cell' });
    await sort_descending(page, 1);
    const sorted = ['cherry|30', 'banana|21', 'pear|10', '|'];
    await expect_shown(page, { headers: ['name', 'qty'], body: sorted, undo: 'Undo Sort' });
    await page.getByRole('button', { name: 'Auto-fit Columns', exact: true }).click();
    await expect_shown(page, { body: sorted, undo: 'Undo Auto-fit columns' });

    await history(page, 'undo');
    await expect_shown(page, { body: sorted, undo: 'Undo Sort', redo: 'Redo Auto-fit columns' });
    await history(page, 'undo');
    await expect_shown(page, { headers: ['name', 'qty'], body: edited, undo: 'Undo Edit cell', redo: 'Redo Sort' });
    await history(page, 'undo');
    await expect_shown(page, { body: under_header, undo: 'Undo Use row 2 as header', redo: 'Redo Edit cell' });
    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: added, redo: 'Redo Use row 2 as header' });
    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: added.slice(0, -1) });
    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, undo: 'Undo' });
    await expect_clean_and_released(page);

    await history(page, 'redo');
    await expect_shown(page, { body: added.slice(0, -1) });
    await history(page, 'redo');
    await expect_shown(page, { headers: NO_HEADER, body: added, redo: 'Redo Use row 2 as header' });
    await history(page, 'redo');
    await expect_shown(page, { headers: ['name', 'qty'], body: under_header, redo: 'Redo Edit cell' });
    await history(page, 'redo');
    await expect_shown(page, { body: edited, redo: 'Redo Sort' });
    await history(page, 'redo');
    await expect_shown(page, { body: sorted, redo: 'Redo Auto-fit columns' });
    await history(page, 'redo');
    await expect_shown(page, { body: sorted, undo: 'Undo Auto-fit columns', redo: 'Redo' });

    await save_changes(page);
    // Every edit in the cell it was typed in, whichever row was the header then.
    await expect.poll(() => saved(file)).toEqual(['1|2', 'name|qty', 'pear|10', 'banana|21', 'cherry|30', '']);
});

test('the header the file remembers follows undo and redo across a relaunch', async () => {
    let { file, page } = await open_file('persisted.xlsx', workbook(sheet('Data', TITLED)));
    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, strip: '' });
    page = await relaunch('persisted.xlsx');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, strip: '' });
    await expect_remembered(file, { header: 'auto', hidden: [] });

    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY });
    await history(page, 'redo');
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    page = await relaunch('persisted.xlsx');
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    await expect_remembered(file, { header: 'on', hidden: [0] });
});

test('the all-sheets item is one step: one Undo puts every worksheet back', async () => {
    const second_rows: Rows = [['item', 'count'], ['fig', 3], ['kiwi', 5]];
    const { page } = await open_file('all-sheets.xlsx', workbook(sheet('Data', DETECTED), sheet('More', second_rows)));
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    const second = async () => {
        await page.locator('.sheet-tab', { hasText: 'More' }).click();
        await expect(page.locator('.sheet-tab.active')).toHaveText('More');
    };
    const first = async () => {
        await page.locator('.sheet-tab', { hasText: 'Data' }).click();
        await expect(page.locator('.sheet-tab.active')).toHaveText('Data');
    };

    await page.getByRole('button', { name: 'Header row scope' }).click();
    await page.getByRole('menuitem', { name: /Show first row as data on all/ }).click();
    await expect_shown(page, {
        headers: NO_HEADER,
        body: ['name|qty', ...FRUIT],
        undo: 'Undo Show first row as data on all sheets',
    });
    await second();
    await expect_shown(page, { headers: NO_HEADER, body: ['item|count', 'fig|3', 'kiwi|5'] });

    // From the second worksheet: one Undo, both back.
    await history(page, 'undo');
    await expect_shown(page, {
        headers: ['item', 'count'],
        body: ['fig|3', 'kiwi|5'],
        undo: 'Undo',
        redo: 'Redo Show first row as data on all sheets',
    });
    await first();
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });

    await history(page, 'redo');
    await expect_shown(page, { headers: NO_HEADER, body: ['name|qty', ...FRUIT], redo: 'Redo' });
    await second();
    await expect_shown(page, { headers: NO_HEADER, body: ['item|count', 'fig|3', 'kiwi|5'] });
});

test('Undo pressed again while a header step is being undone is carried out after it, with no message', async () => {
    const { page } = await open_file('pressed-again.xlsx', workbook(sheet('Data', TITLED)));
    await type_into_cell(page, 1, 2, 'pear');
    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['name', 'qty'], body: ['pear|10', 'banana|20', 'cherry|30'] });
    await type_into_cell(page, 2, 1, '21');
    const all_done = ['pear|10', 'banana|21', 'cherry|30'];
    await expect_shown(page, { headers: ['name', 'qty'], body: all_done, undo: 'Undo Edit cell' });

    await history(page, 'undo');
    await expect_shown(page, { body: ['pear|10', 'banana|20', 'cherry|30'], undo: 'Undo Use row 2 as header' });
    // Three presses back to back. The first starts the header step's undo;
    // the others arrive while it runs, and leave one press to carry out.
    await history(page, 'undo', 3);
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, undo: 'Undo', redo: 'Redo Edit cell' });
    await expect_clean_and_released(page);

    await history(page, 'redo');
    await expect_shown(page, {
        headers: NO_HEADER,
        body: ['1|2', 'name|qty', 'pear|10', 'banana|20', 'cherry|30'],
        redo: 'Redo Use row 2 as header',
    });
    await history(page, 'redo', 3);
    await expect_shown(page, { headers: ['name', 'qty'], body: all_done, undo: 'Undo Edit cell', redo: 'Redo' });
});

test('a held Undo walks through an edit, a header step, an edit and a sort in order, skipping none, with no message', async () => {
    const { page } = await open_file('held.xlsx', workbook(sheet('Data', TITLED)));
    await type_into_cell(page, 1, 2, 'pear');
    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['name', 'qty'], body: ['pear|10', 'banana|20', 'cherry|30'] });
    await type_into_cell(page, 2, 1, '21');
    await sort_descending(page, 1);
    const all_done = { headers: ['name', 'qty'], body: ['cherry|30', 'banana|21', 'pear|10'] };
    await expect_shown(page, { ...all_done, undo: 'Undo Sort', redo: 'Redo' });

    // Every history state the window reports, in order, kept in the main
    // process: none can be missed between two reads from here. (The grid's
    // accessibility table is debounced and does not keep up with a held key,
    // so the view is read once the key is released.)
    await app!.evaluate(({ ipcMain }, channel) => {
        const main = globalThis as typeof globalThis & { __tableViewerSmokeHistoryLog?: unknown[] };
        main.__tableViewerSmokeHistoryLog = [];
        ipcMain.on(channel, (_event, envelope: { message?: { type?: string; state?: unknown } }) => {
            if (envelope?.message?.type === 'historyMenuStateChanged') {
                main.__tableViewerSmokeHistoryLog?.push(envelope.message.state);
            }
        });
    }, CHANNEL_WEBVIEW_MESSAGE);
    /** The Undo and Redo labels the window passed through since the last call, repeats collapsed. */
    const walked = async (): Promise<string[]> => {
        const states = await app!.evaluate(() => (globalThis as typeof globalThis & {
            __tableViewerSmokeHistoryLog?: unknown[];
        }).__tableViewerSmokeHistoryLog?.splice(0) ?? []) as HistoryMenuState[];
        return states
            .map((state) => `${history_menu_item('undo', state).label} / ${history_menu_item('redo', state).label}`)
            .filter((labels, index, all) => index === 0 || all[index - 1] !== labels);
    };
    /** Repeat the key the way a held key does, until `release`. */
    const hold = (command: 'undo' | 'redo') => page.evaluate((sent) => {
        const held = window as typeof window & { __heldStop?: () => void };
        held.__heldStop?.();
        const repeat = window.setInterval(
            () => window.postMessage({ type: 'editCommand', command: sent }, '*'),
            30,
        );
        held.__heldStop = () => window.clearInterval(repeat);
    }, command);
    const release = () => page.evaluate(() => {
        (window as typeof window & { __heldStop?: () => void }).__heldStop?.();
    });
    const menu_label = async (which: 'undo' | 'redo') => (await shown(page))[which];

    await hold('undo');
    await expect.poll(() => menu_label('undo')).toBe('Undo');
    await release();
    expect(await walked()).toEqual([
        'Undo Edit cell / Redo Sort',
        'Undo Use row 2 as header / Redo Edit cell',
        'Undo Edit cell / Redo Use row 2 as header',
        'Undo / Redo Edit cell',
    ]);
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, undo: 'Undo', redo: 'Redo Edit cell' });
    await expect_clean_and_released(page);

    await hold('redo');
    await expect.poll(() => menu_label('redo')).toBe('Redo');
    await release();
    expect(await walked()).toEqual([
        'Undo Edit cell / Redo Use row 2 as header',
        'Undo Use row 2 as header / Redo Edit cell',
        'Undo Edit cell / Redo Sort',
        'Undo Sort / Redo',
    ]);
    await expect_shown(page, { ...all_done, undo: 'Undo Sort', redo: 'Redo' });
});

test('the grid keeps keyboard focus across an undone header step', async () => {
    const { page } = await open_file('focus.xlsx', workbook(sheet('Data', TITLED)));
    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    const point = await cell_point(page, 0, 1);
    await page.mouse.click(point.x, point.y);
    const in_grid = () => page.evaluate(() =>
        document.activeElement?.closest('.grid-shell-root') !== null && document.activeElement !== document.body);
    await expect.poll(in_grid).toBe(true);

    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY });
    await expect.poll(in_grid).toBe(true);
});

test('a new column undone after a header was chosen does not stop the header step under it', async () => {
    const { page } = await open_file('column.xlsx', workbook(sheet('Data', TITLED)));
    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    await choose(await open_column_menu(page, 0), 'Insert column right');
    await expect_shown(page, { headers: ['name', 'New column', 'qty'] });

    await history(page, 'undo');
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT, undo: 'Undo Use row 2 as header' });
    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, undo: 'Undo' });
    await expect_clean_and_released(page);
});

test('a header step under a saved edit that was undone says to save first, and goes through after Save', async () => {
    const { file, page } = await open_file('save-first.xlsx', workbook(sheet('Data', DETECTED)));
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    await toggle_header(page);
    const off_body = ['name|qty', ...FRUIT];
    await expect_shown(page, { headers: NO_HEADER, body: off_body, undo: 'Undo Turn off header row' });
    // The old header row is an ordinary row now. Edit it, and save.
    await type_into_cell(page, 1, 0, 'label');
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['label|qty', ...FRUIT]);

    // Undoing a saved edit leaves the cell unsaved against the file.
    await history_after_save(page, 'undo', { headers: NO_HEADER, body: off_body, undo: 'Undo Turn off header row' });
    await expect(save_button(page)).toHaveClass(/has-unsaved/);
    // A header cell is saved as a column name and a body cell is not, so an
    // unsaved cell cannot be carried onto the row that becomes the header.
    // The step stays where it is, with the reason.
    await history(page, 'undo');
    await expect_shown(
        page,
        { headers: NO_HEADER, body: off_body, undo: 'Undo Turn off header row', redo: 'Redo Edit cell' },
        ["Can't undo “Turn off header row”: Save first: the row that would become the header row "
            + 'has unsaved changes.'],
    );

    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(off_body);
    await history(page, 'undo');
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT, undo: 'Undo', redo: 'Redo Turn off header row' });
});

// The three walks on which a header step waits for a Save. Undoing or redoing
// an edit that was already saved leaves its cell unsaved against the file, and
// the host does not carry an unsaved cell onto the header row, off it, or
// under it. Each step stays where it is, says "Save first", and goes through
// once the file is saved.

test('header, rename, Save, Undo, Undo: the header step waits while the header row has an unsaved name', async () => {
    const { file, page } = await open_file('walk-rename.xlsx', workbook(sheet('Data', TITLED)));
    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT, undo: 'Undo Use row 2 as header' });
    await choose(await open_column_menu(page, 0), 'Rename column…');
    const rename = page.getByRole('dialog', { name: 'Rename column' });
    await rename.getByLabel('Column name').fill('title');
    await rename.getByRole('button', { name: 'Rename' }).click();
    await expect(rename).toHaveCount(0);
    await expect_shown(page, { headers: ['title', 'qty'], undo: 'Undo Rename column' });
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(['1|2', 'title|qty', ...FRUIT]);

    // The saved name is undone: the header cell is unsaved against the file.
    // The app also says the undone cell is hidden by the view, every time; the
    // message is waited for here so that it is not read as the next step's.
    await history_after_save(
        page,
        'undo',
        { headers: ['name', 'qty'], undo: 'Undo Use row 2 as header', redo: 'Redo Rename column' },
        ['The change was undone, but the affected cells are hidden by the current view.'],
    );
    await expect(save_button(page)).toHaveClass(/has-unsaved/);

    await history(page, 'undo');
    await expect_shown(
        page,
        { headers: ['name', 'qty'], body: FRUIT, undo: 'Undo Use row 2 as header', redo: 'Redo Rename column' },
        ["Can't undo “Use row 2 as header”: Save first: the header row has unsaved changes, "
            + 'and it would stop being the header row.'],
    );

    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(TITLED_BODY);
    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, undo: 'Undo', redo: 'Redo Use row 2 as header' });
});

test('edit, Save, header, Undo, Undo, Save, Redo, Redo: the header step waits while the row it would use has an unsaved cell', async () => {
    const { file, page } = await open_file('walk-redo.xlsx', workbook(sheet('Data', TITLED)));
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY });
    await type_into_cell(page, 1, 1, 'title');
    const edited = ['1|2', 'title|qty', ...FRUIT];
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(edited);
    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['title', 'qty'], body: FRUIT, undo: 'Undo Use row 2 as header' });

    await history(page, 'undo');
    await expect_shown(page, { headers: NO_HEADER, body: edited, undo: 'Undo Edit cell' });
    await history_after_save(page, 'undo', { headers: NO_HEADER, body: TITLED_BODY, undo: 'Undo', redo: 'Redo Edit cell' });
    // The file goes back to what it was, so the edit, redone, is unsaved.
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(TITLED_BODY);
    await history_after_save(page, 'redo', { headers: NO_HEADER, body: edited, undo: 'Undo Edit cell', redo: 'Redo Use row 2 as header' });
    await expect(save_button(page)).toHaveClass(/has-unsaved/);

    await history(page, 'redo');
    await expect_shown(
        page,
        { headers: NO_HEADER, body: edited, undo: 'Undo Edit cell', redo: 'Redo Use row 2 as header' },
        ["Can't redo “Use row 2 as header”: Save first: the row that would become the header row "
            + 'has unsaved changes.'],
    );

    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(edited);
    await history(page, 'redo');
    await expect_shown(page, { headers: ['title', 'qty'], body: FRUIT, undo: 'Undo Use row 2 as header', redo: 'Redo' });
});

test('Unhide all, edit a shown row, Save, Undo, Undo: the step waits while a row it would hide has an unsaved cell', async () => {
    const { file, page } = await open_file('walk-unhide.xlsx', workbook(sheet('Data', TITLED)));
    await use_row_as_header(page, 1);
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT });
    await unhide_all(page);
    await expect_shown(page, { headers: NO_HEADER, body: TITLED_BODY, undo: 'Undo Unhide rows' });
    // Row 1 was hidden above the header until now.
    await type_into_cell(page, 1, 0, '9');
    const edited = ['9|2', ...TITLED_BODY.slice(1)];
    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(edited);

    await history_after_save(page, 'undo', { headers: NO_HEADER, body: TITLED_BODY, undo: 'Undo Unhide rows', redo: 'Redo Edit cell' });
    await expect(save_button(page)).toHaveClass(/has-unsaved/);

    await history(page, 'undo');
    await expect_shown(
        page,
        { headers: NO_HEADER, body: TITLED_BODY, undo: 'Undo Unhide rows', redo: 'Redo Edit cell' },
        ["Can't undo “Unhide rows”: Save first: rows that would be hidden above the header row "
            + 'have unsaved changes.'],
    );

    await save_changes(page);
    await expect.poll(() => saved(file)).toEqual(TITLED_BODY);
    await history(page, 'undo');
    await expect_shown(page, { headers: ['name', 'qty'], body: FRUIT, undo: 'Undo Use row 2 as header', redo: 'Redo Unhide rows' });
});
