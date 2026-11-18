// Undo and Redo pressed back to back, in the desktop app.
//
// A person holding Cmd+Z, or pressing it again the instant the last step
// lands, meets the short windows in which this window is still finishing
// something it started itself: letting go of the editing session, asking for
// one, a refresh on its way, a replay still out. A press made in one of those
// windows is carried out when the window clears. It is never refused with
// "Try again", and it never does nothing.
//
// Each test makes several changes of different kinds the way a person does,
// then undoes all of them and redoes all of them with no wait between the
// presses, and reads what the window showed on the way: every step in order,
// each once, the grid at both ends, and no message.
//
// Two ways of pressing, both with no retry:
//   - chained: the next press is sent from the main process at the instant
//     the window reports that the last step moved (what the Edit menu
//     rebuilds from), so each press arrives while the step before it is
//     still settling.
//   - held: a press every few milliseconds, far more often than a step
//     takes, until there is nothing left.
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
import { CHANNEL_WEBVIEW_MESSAGE } from '../shared/ipc';
import { isolated_user_data, read_workbook } from './smoke-helpers';
import {
    canvas_box,
    cell_point,
    choose,
    exit_app,
    install_dialog_capture,
    launch_structural_viewer,
    open_column_menu,
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
    test_root = isolated_user_data('tv-undo-redo-back-to-back-');
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
    ['Charlie', 35, 'Paris'],
    ['Dora', 28, 'Oslo'],
];
const CSV = `${ROWS.map((cells) => cells.join(',')).join('\n')}\n`;
const NATURAL = ['Alice|30|New York', 'Bob|25|London', 'Charlie|35|Paris', 'Dora|28|Oslo'];

function sheet(name: string, rows: Rows) {
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

interface MainGlobals {
    /** Every history state the window reported, in order. */
    __tableViewerSmokeHistoryLog?: HistoryMenuState[];
    /** Presses still to send, one for each report that the stack moved. */
    __tableViewerSmokeChain?: { command: 'undo' | 'redo'; sent: number } | undefined;
}

/**
 * Record every history state the viewer reports for the Edit menu, and, while
 * a chain is armed, answer each report that the stack moved with the next
 * press, from the main process, as a click on the Edit menu's item does.
 */
async function install_history_recorder(electron_app: ElectronApplication): Promise<void> {
    await electron_app.evaluate(({ ipcMain }, channel) => {
        const main = globalThis as typeof globalThis & MainGlobals;
        main.__tableViewerSmokeHistoryLog = [];
        ipcMain.on(channel, (event, envelope: { message?: { type?: string; state?: HistoryMenuState } }) => {
            const message = envelope?.message;
            if (message?.type !== 'historyMenuStateChanged' || message.state === undefined) return;
            const log = main.__tableViewerSmokeHistoryLog!;
            const last = log[log.length - 1];
            const state = message.state;
            log.push(state);
            const chain = main.__tableViewerSmokeChain;
            if (chain === undefined) return;
            // Only a report that the stack moved: a focus change reports too.
            if (
                last !== undefined
                && last.undoLabel === state.undoLabel
                && last.redoLabel === state.redoLabel
                && last.undoAvailable === state.undoAvailable
                && last.redoAvailable === state.redoAvailable
            ) return;
            const more = chain.command === 'undo' ? state.undoAvailable : state.redoAvailable;
            if (!more) {
                main.__tableViewerSmokeChain = undefined;
                return;
            }
            chain.sent += 1;
            void event.sender.executeJavaScript(
                `window.postMessage({ type: 'editCommand', command: ${JSON.stringify(chain.command)} }, '*')`,
            );
        });
    }, CHANNEL_WEBVIEW_MESSAGE);
}

async function open_file(name: string, content: string | Buffer): Promise<{ file: string; page: Page }> {
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir, { recursive: true });
    const file = path.join(test_root, name);
    fs.writeFileSync(file, content);
    const launched = await launch_structural_viewer(user_data_dir, file);
    app = launched.app;
    await install_dialog_capture(app);
    await install_history_recorder(app);
    await wait_for_grid(launched.page);
    return { file, page: launched.page };
}

interface Shown {
    body: string[];
    headers: string[];
    /** The state strip's text: sort keys, filters, hidden rows. */
    strip: string;
    undo: string;
    redo: string;
}

async function history_log(): Promise<HistoryMenuState[]> {
    return app!.evaluate(() =>
        [...((globalThis as typeof globalThis & MainGlobals).__tableViewerSmokeHistoryLog ?? [])]);
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
    const log = await history_log();
    const menu = log[log.length - 1];
    return {
        ...view,
        undo: history_menu_item('undo', menu).label,
        redo: history_menu_item('redo', menu).label,
    };
}

/** Wait until the window shows `expected`, with nothing said that is not in `dialogs`. */
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

/** The labels the Edit menu's item for `command` read since `from`, without repeats. */
async function labels_since(from: number, command: 'undo' | 'redo'): Promise<string[]> {
    const labels: string[] = [];
    for (const state of (await history_log()).slice(from)) {
        const label = history_menu_item(command, state).label;
        if (labels[labels.length - 1] !== label) labels.push(label);
    }
    return labels;
}

type Pressing = 'chained' | 'held';

/**
 * Press `command` until there is nothing left for it, back to back, and
 * check the walk: the Edit menu's item read `walk` in order, each once and
 * none skipped, and the window said nothing.
 */
async function press_through(
    page: Page,
    pressing: Pressing,
    command: 'undo' | 'redo',
    walk: readonly string[],
): Promise<void> {
    const from = (await history_log()).length - 1;
    const plain = command === 'undo' ? 'Undo' : 'Redo';
    if (pressing === 'chained') {
        await app!.evaluate((_electron, sent) => {
            (globalThis as typeof globalThis & MainGlobals).__tableViewerSmokeChain = { command: sent, sent: 0 };
        }, command);
        await history(page, command);
    } else {
        // Far more often than a step takes. The interval is the key repeat,
        // not a wait: nothing is read after a fixed time.
        await page.evaluate((sent) => {
            const held = window as typeof window & { __smokeHeldKey?: number };
            held.__smokeHeldKey = window.setInterval(() => {
                window.postMessage({ type: 'editCommand', command: sent }, '*');
            }, 4);
        }, command);
    }
    const said: string[] = [];
    try {
        await expect.poll(async () => {
            said.push(...(await take_dialogs(app!)).map((dialog) => dialog.message ?? ''));
            return { labels: await labels_since(from, command), dialogs: [...said] };
        }, { timeout: 30_000 }).toEqual({ labels: [...walk, plain], dialogs: [] });
    } finally {
        await page.evaluate(() => {
            const held = window as typeof window & { __smokeHeldKey?: number };
            if (held.__smokeHeldKey !== undefined) window.clearInterval(held.__smokeHeldKey);
            held.__smokeHeldKey = undefined;
        });
        await app!.evaluate(() => {
            (globalThis as typeof globalThis & MainGlobals).__tableViewerSmokeChain = undefined;
        });
    }
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
    for (const pressing of ['chained', 'held'] as const) {
        test(`${kind}, ${pressing}: edits, a sort, a hidden column and a hidden row are all undone and all redone with no wait between presses`, async () => {
            const { file, page } = await open_file(`mixed-${pressing}.${kind}`, fixture(kind));
            await expect_shown(page, { headers: ['Name', 'Age', 'City'], body: NATURAL, undo: 'Undo', redo: 'Redo' });

            // A view step first, so the last Undo is one made just after the
            // editing session was let go.
            await choose(await open_column_menu(page, 1), 'Hide column');
            await expect_shown(page, { headers: ['Name', 'City'], undo: 'Undo Hide column' });
            await type_into_cell(page, 1, 0, 'Ann');
            await sort_descending(page, 0);
            await expect_shown(page, {
                body: ['Dora|Oslo', 'Charlie|Paris', 'Bob|London', 'Ann|New York'],
                undo: 'Undo Sort',
            });
            await choose(await open_row_menu(page, 1), 'Hide row');
            await expect_shown(page, { body: ['Dora|Oslo', 'Bob|London', 'Ann|New York'], undo: 'Undo Hide row' });
            await type_into_cell(page, 2, 0, 'Bergen');
            await expect_shown(page, { body: ['Dora|Bergen', 'Bob|London', 'Ann|New York'], undo: 'Undo Edit cell' });
            const done = await shown(page);
            const steps = ['Hide column', 'Edit cell', 'Sort', 'Hide row', 'Edit cell'];

            await press_through(page, pressing, 'undo', [...steps].reverse().map((step) => `Undo ${step}`));
            await expect_shown(page, {
                headers: ['Name', 'Age', 'City'],
                body: NATURAL,
                strip: '',
                undo: 'Undo',
                redo: 'Redo Hide column',
            });
            await expect_clean_and_released(page);

            await press_through(page, pressing, 'redo', steps.map((step) => `Redo ${step}`));
            await expect_shown(page, { ...done, redo: 'Redo' });
            await save_changes(page);
            await expect.poll(() => saved_body(kind, file)).toEqual(
                ['Ann|30|New York', 'Bob|25|London', 'Charlie|35|Paris', 'Dora|28|Bergen'],
            );
        });
    }
}


const HEADER_HEIGHT_PX = 36;
const ROW_HEIGHT_PX = 24;
const ROW_MARKER_WIDTH_PX = 32;
const COLUMN_WIDTH_PX = 120;

/** Drag the border on the right of display column 0 by `dx`, at default widths. */
async function widen_first_column(page: Page, dx: number): Promise<void> {
    const box = await canvas_box(page);
    const x = box.x + ROW_MARKER_WIDTH_PX + COLUMN_WIDTH_PX - 2;
    const y = box.y + HEADER_HEIGHT_PX / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 6 });
    await page.mouse.up();
}

function header_row_button(page: Page) {
    return page.getByRole('button', { name: 'Header Row', exact: true });
}

async function toggle_header(page: Page): Promise<void> {
    await expect(header_row_button(page)).not.toHaveAttribute('aria-disabled', 'true');
    await header_row_button(page).click();
}

async function rename_column(page: Page, column: number, name: string): Promise<void> {
    await choose(await open_column_menu(page, column), 'Rename column…');
    const rename = page.getByRole('dialog', { name: 'Rename column' });
    await rename.getByLabel('Column name').fill(name);
    await rename.getByRole('button', { name: 'Rename' }).click();
    await expect(rename).toHaveCount(0);
}

/** One gesture of a walk, and the step the Edit menu names for it. */
interface Step {
    readonly label: string;
    readonly make: (page: Page) => Promise<void>;
    /** What the window shows once the gesture has landed. */
    readonly shows: Partial<Shown>;
}

/**
 * Make every step, then undo all of them and redo all of them back to back,
 * and check the walk both ways, the grid at both ends, and the saved file.
 */
async function walk_back_and_forth(
    kind: 'csv' | 'xlsx',
    pressing: Pressing,
    name: string,
    steps: readonly Step[],
    saved: readonly string[],
): Promise<void> {
    const { file, page } = await open_file(`${name}-${pressing}.${kind}`, fixture(kind));
    const start: Partial<Shown> = { headers: ['Name', 'Age', 'City'], body: NATURAL, strip: '', undo: 'Undo', redo: 'Redo' };
    await expect_shown(page, start);
    for (const step of steps) {
        await step.make(page);
        await expect_shown(page, { ...step.shows, undo: `Undo ${step.label}` });
    }
    const done = await shown(page);
    const labels = steps.map((step) => step.label);

    await press_through(page, pressing, 'undo', [...labels].reverse().map((label) => `Undo ${label}`));
    await expect_shown(page, { ...start, redo: `Redo ${labels[0]}` });
    await expect_clean_and_released(page);

    await press_through(page, pressing, 'redo', labels.map((label) => `Redo ${label}`));
    await expect_shown(page, { ...done, redo: 'Redo' });
    await save_changes(page);
    await expect.poll(() => saved_body(kind, file)).toEqual([...saved]);
}

// A sort or a hidden row cannot be made while inserted rows are unsaved, nor
// a row inserted while the rows are sorted, so these walks leave the row view
// to the walk above and cover the structural and size steps instead.
for (const pressing of ['chained', 'held'] as const) {
    test(`csv, ${pressing}: an edit first and a view step last, across an inserted row, a column resize and an edit in the new row`, async () => {
        await walk_back_and_forth('csv', pressing, 'edit-first', [
            { label: 'Edit cell', make: (page) => type_into_cell(page, 1, 0, 'Ann'), shows: { body: ['Ann|30|New York', ...NATURAL.slice(1)] } },
            {
                label: 'Insert row',
                make: async (page) => choose_from_submenu(await open_row_menu(page, 1), 'Insert', 'Insert row above'),
                shows: { body: ['Ann|30|New York', '||', ...NATURAL.slice(1)] },
            },
            { label: 'Resize column', make: (page) => widen_first_column(page, 40), shows: {} },
            {
                label: 'Edit cell',
                make: (page) => type_into_cell(page, 3, 1, 'Rome'),
                shows: { body: ['Ann|30|New York', '||Rome', ...NATURAL.slice(1)] },
            },
            {
                label: 'Hide column',
                make: async (page) => choose(await open_column_menu(page, 1), 'Hide column'),
                shows: { headers: ['Name', 'City'], body: ['Ann|New York', '|Rome', 'Bob|London', 'Charlie|Paris', 'Dora|Oslo'] },
            },
        ], ['Ann|30|New York', '||Rome', ...NATURAL.slice(1)]);
    });

    test(`xlsx, ${pressing}: an edit first and a view step last, across header toggles, a rename, an inserted row and a column resize`, async () => {
        await walk_back_and_forth('xlsx', pressing, 'edit-first', [
            { label: 'Edit cell', make: (page) => type_into_cell(page, 1, 0, 'Ann'), shows: { body: ['Ann|30|New York', ...NATURAL.slice(1)] } },
            {
                label: 'Turn off header row',
                make: toggle_header,
                shows: { body: ['Name|Age|City', 'Ann|30|New York', ...NATURAL.slice(1)] },
            },
            {
                label: 'Use row 1 as header',
                make: toggle_header,
                shows: { headers: ['Name', 'Age', 'City'], body: ['Ann|30|New York', ...NATURAL.slice(1)] },
            },
            { label: 'Rename column', make: (page) => rename_column(page, 2, 'Town'), shows: { headers: ['Name', 'Age', 'Town'] } },
            {
                label: 'Insert row',
                make: async (page) => choose_from_submenu(await open_row_menu(page, 1), 'Insert', 'Insert row above'),
                shows: { body: ['Ann|30|New York', '||', ...NATURAL.slice(1)] },
            },
            { label: 'Resize column', make: (page) => widen_first_column(page, 40), shows: {} },
            {
                label: 'Hide column',
                make: async (page) => choose(await open_column_menu(page, 1), 'Hide column'),
                shows: { headers: ['Name', 'Town'] },
            },
        ], ['Ann|30|New York', '', ...NATURAL.slice(1)]);
    });
}

test('csv: Undo pressed as a row menu opens is carried out', async () => {
    // Opening the menu claims the editing session; the press waits for the
    // claim instead of saying "another change is still being applied".
    const { page } = await open_file('menu.csv', CSV);
    await sort_descending(page, 0);
    await expect_shown(page, { body: [...NATURAL].reverse(), undo: 'Undo Sort' });
    const box = await canvas_box(page);
    await Promise.all([
        page.mouse.click(box.x + ROW_MARKER_WIDTH_PX / 2, box.y + HEADER_HEIGHT_PX + ROW_HEIGHT_PX * 1.5, { button: 'right' }),
        history(page, 'undo'),
    ]);
    await expect_shown(page, { body: NATURAL, undo: 'Undo', redo: 'Redo Sort' });
});

for (const kind of ['csv', 'xlsx'] as const) {
    test(`${kind}: Undo pressed the instant a Save is clean, then Redo, each go through`, async () => {
        const { file, page } = await open_file(`after-save.${kind}`, fixture(kind));
        await type_into_cell(page, 1, 0, 'Ann');
        await expect_shown(page, { undo: 'Undo Edit cell' });
        // Save, and press Undo from the page the instant the button is clean,
        // which is when the watcher's refresh for the save is on its way.
        await save_button(page).evaluate((button) => new Promise<void>((resolve) => {
            (button as HTMLElement).click();
            const check = () => {
                if (!button.classList.contains('has-unsaved')) {
                    window.postMessage({ type: 'editCommand', command: 'undo' }, '*');
                    resolve();
                    return;
                }
                requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
        }));
        await expect_shown(page, { body: NATURAL, undo: 'Undo', redo: 'Redo Edit cell' });
        await expect.poll(() => saved_body(kind, file)).toEqual(['Ann|30|New York', ...NATURAL.slice(1)]);
        await history(page, 'redo');
        await expect_shown(page, { body: ['Ann|30|New York', ...NATURAL.slice(1)], undo: 'Undo Edit cell', redo: 'Redo' });
        await expect(save_button(page)).not.toHaveClass(/has-unsaved/);
    });

    test(`${kind}: Undo pressed while a Save is in flight is carried out after it`, async () => {
        const { file, page } = await open_file(`during-save.${kind}`, fixture(kind));
        await type_into_cell(page, 1, 0, 'Ann');
        await expect_shown(page, { undo: 'Undo Edit cell' });
        // The click and the press in one task: the Save is in flight when
        // the press arrives.
        await save_button(page).evaluate((button) => {
            (button as HTMLElement).click();
            window.postMessage({ type: 'editCommand', command: 'undo' }, '*');
        });
        await expect_shown(page, { body: NATURAL, undo: 'Undo', redo: 'Redo Edit cell' });
        // The Save went through first, so the file holds the edit and the
        // window holds its undo, unsaved.
        await expect.poll(() => saved_body(kind, file)).toEqual(['Ann|30|New York', ...NATURAL.slice(1)]);
        await expect(save_button(page)).toHaveClass(/has-unsaved/);
    });
}

/** Paste `text` at the selected cell, as the paste event delivers it, and press Undo in the same instant. */
async function paste_and_undo(page: Page, text: string): Promise<void> {
    await page.evaluate((pasted) => {
        const data = new DataTransfer();
        data.setData('text/plain', pasted);
        window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
        window.postMessage({ type: 'editCommand', command: 'undo' }, '*');
    }, text);
}

/** Select a cell (`column` as the grid's cell ids count it, from 1) with a click, at default widths. */
async function select_cell(page: Page, column: number, row: number): Promise<void> {
    const point = await cell_point(page, column - 1, row);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator(`#glide-cell-${column}-${row}`)).toHaveAttribute('aria-selected', 'true');
}

test('csv: two rows pasted onto the last row with no session yet, and Undo in the same instant: the paste and the row it added land whole, then are undone', async () => {
    const { page } = await open_file('paste.csv', CSV);
    await expect_shown(page, { body: NATURAL });
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
    await select_cell(page, 1, 3);
    // The paste crosses the session grant and the admission of the row it
    // needs while the press is held, and is recorded before the press undoes it.
    await paste_and_undo(page, 'P1\tP2\nP3\tP4');
    await expect_shown(page, { body: NATURAL, undo: 'Undo', redo: 'Redo Paste' });
    // Whole: redone, every destination has its value, in the row it added.
    await history(page, 'redo');
    await expect_shown(page, {
        body: [...NATURAL.slice(0, 3), 'P1|P2|Oslo', 'P3|P4|'],
        undo: 'Undo Paste',
        redo: 'Redo',
    });
});

test('xlsx: two rows pasted onto the last row across a new column and a saved one, with Undo in the same instant, write every destination before they are undone', async () => {
    const { page } = await open_file('paste.xlsx', fixture('xlsx'));
    await choose(await open_column_menu(page, 0), 'Insert column right');
    const inserted = ['Alice||30|New York', 'Bob||25|London', 'Charlie||35|Paris', 'Dora||28|Oslo'];
    await expect_shown(page, { body: inserted, undo: 'Undo Insert column' });
    await select_cell(page, 2, 3);
    await paste_and_undo(page, 'P1\tP2\nP3\tP4');
    await expect_shown(page, { body: inserted, undo: 'Undo Insert column', redo: 'Redo Paste' });
    await history(page, 'redo');
    await expect_shown(page, {
        body: [...inserted.slice(0, 3), 'Dora|P1|P2|Oslo', '|P3|P4|'],
        undo: 'Undo Paste',
        redo: 'Redo',
    });
});

interface QueueGlobals {
    __tableViewerSmokeHostQueue?: { held: boolean; queued: unknown[][]; release?: () => void };
}

/**
 * From now on, hold back everything the main process sends the viewer
 * window, in order, until `release_host_messages`.
 */
async function hold_host_messages(electron_app: ElectronApplication): Promise<void> {
    await electron_app.evaluate(({ BrowserWindow }) => {
        const main = globalThis as typeof globalThis & QueueGlobals;
        const queue: NonNullable<QueueGlobals['__tableViewerSmokeHostQueue']> = { held: true, queued: [] };
        main.__tableViewerSmokeHostQueue = queue;
        for (const window of BrowserWindow.getAllWindows()) {
            const contents = window.webContents;
            const send = contents.send.bind(contents);
            contents.send = (...args: Parameters<typeof send>) => {
                if (queue.held) {
                    queue.queued.push(args);
                    return;
                }
                send(...args);
            };
            queue.release = () => {
                queue.held = false;
                for (const args of queue.queued.splice(0)) send(...(args as Parameters<typeof send>));
                contents.send = send;
            };
        }
    });
}

async function release_host_messages(electron_app: ElectronApplication): Promise<void> {
    await electron_app.evaluate(() => {
        (globalThis as typeof globalThis & QueueGlobals).__tableViewerSmokeHostQueue?.release?.();
    });
}

test('csv: no editor opens while a press is held, from a typed key or a double click', async () => {
    const { page } = await open_file('no-editor.csv', CSV);
    await type_into_cell(page, 1, 0, 'Ann');
    await type_into_cell(page, 1, 1, 'Ben');
    await expect_shown(page, { body: ['Ann|30|New York', 'Ben|25|London', ...NATURAL.slice(2)], undo: 'Undo Edit cell' });
    await select_cell(page, 2, 2);

    // The window's own replay stays out: its answer is held back.
    await hold_host_messages(app!);
    try {
        await history(page, 'undo');
        await history(page, 'undo');
        // A letter at a cell: Glide would open its editor inside the key's
        // own dispatch, so the check is made when the key returns.
        await page.keyboard.press('x');
        expect(await page.locator('.cell-editor-input').count()).toBe(0);
        const point = await cell_point(page, 2, 3);
        await page.mouse.dblclick(point.x, point.y);
        expect(await page.locator('.cell-editor-input').count()).toBe(0);
    } finally {
        await release_host_messages(app!);
    }

    const said: string[] = [];
    await expect.poll(async () => {
        said.push(...(await take_dialogs(app!)).map((dialog) => dialog.message ?? ''));
        const now = await shown(page);
        return { body: now.body, undo: now.undo, redo: now.redo };
    }).toEqual({ body: NATURAL, undo: 'Undo', redo: 'Redo Edit cell' });
    said.push(...(await take_dialogs(app!)).map((dialog) => dialog.message ?? ''));
    expect(said.length).toBeGreaterThan(0);
    expect(new Set(said)).toEqual(new Set(['Wait for the table view to finish updating.']));
    // The letter is in no cell and no step.
    expect((await shown(page)).body.join('|')).not.toContain('x');
    await expect_shown(page, { redo: 'Redo Edit cell' });

    // With nothing held, a letter opens the editor and nothing is said.
    await select_cell(page, 2, 2);
    await page.keyboard.press('y');
    await expect(page.locator('.cell-editor-input')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await take_dialogs(app!)).toEqual([]);
});
