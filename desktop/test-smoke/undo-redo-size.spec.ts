// Undo and redo of column widths and row heights, in the desktop app.
//
// A resize is a step in the same history as edits, sorts, and hidden rows.
// Each test here resizes the way a person does (a drag on a border, a
// double-click, the toolbar's Auto-fit, the row menu), then undoes and redoes
// it, and reads three things: the size the window shows, the size the file
// remembers, and what the Edit menu's Undo and Redo items read.
//
// The size shown is read without asking the app for it. A click selects the
// cell under it, and the grid's accessibility table says which cell that is,
// so a click just inside where a border should be, and one just past it, say
// where the border is. The size remembered is read from the state database.
//
// No assertion needs the window focused, and no application-menu command is
// used: undo and redo arrive as the Edit menu sends them to the window. Every
// wait polls what the window shows or what the database holds; none waits a
// fixed time.
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { build_fixture_xlsx, cell, row } from '../../src/test/helpers/xlsx-structure-fixture';
import { history_menu_item, type HistoryMenuState } from '../main/history-menu-model';
import { hot_journal_present, isolated_user_data, state_database_path } from './smoke-helpers';
import {
    canvas_box,
    choose,
    exit_app,
    install_dialog_capture,
    install_history_menu_capture,
    launch_structural_viewer,
    open_column_menu,
    open_row_menu,
    save_button,
    take_dialogs,
    type_into_cell,
    wait_for_grid,
} from './structure-helpers';

let test_root: string;
let app: ElectronApplication | undefined;
/** The cell the last probe click selected. A second click on it would open its editor. */
let last_probe: string | undefined;
/**
 * The borders a test reads on screen: the right border of each of these
 * columns and the bottom border of each of these rows. A test names the ones
 * its steps move. The grid's accessibility table follows a click after a
 * fifth of a second, so reading every border after every step would take
 * most of a test's time.
 */
let watched: { columns: readonly number[]; rows: readonly number[] };

function watch(columns: readonly number[], rows: readonly number[]): void {
    watched = { columns, rows };
}

test.beforeEach(() => {
    test_root = isolated_user_data('tv-undo-redo-size-');
    last_probe = undefined;
    watch([0, 1], [0, 1, 2]);
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

const user_data_dir = () => path.join(test_root, 'user-data');

/** Launch the app on a file in this test's directory. A second call relaunches on the same state. */
async function open_file(name: string, content?: string | Buffer): Promise<{ file: string; page: Page }> {
    fs.mkdirSync(user_data_dir(), { recursive: true });
    const file = path.join(test_root, name);
    if (content !== undefined) fs.writeFileSync(file, content);
    const launched = await launch_structural_viewer(user_data_dir(), file);
    app = launched.app;
    await install_dialog_capture(app);
    await install_history_menu_capture(app);
    await wait_for_grid(launched.page);
    last_probe = undefined;
    return { file, page: launched.page };
}

async function relaunch(name: string): Promise<Page> {
    await exit_app(app!);
    app = undefined;
    return (await open_file(name)).page;
}

// Glide's default header height, the row marker's width below 100 rows, and
// the app's default row height and column width at the default font size.
const HEADER_HEIGHT_PX = 36;
const ROW_MARKER_WIDTH_PX = 32;
const ROW_HEIGHT_PX = 24;
const COLUMN_WIDTH_PX = 120;
/** How far inside and past a border a probe clicks. Past the row border's own 5 px grab zone. */
const PROBE_PX = 6;

/** The sizes the window is expected to show: three columns, four rows. */
interface Layout {
    readonly widths: readonly number[];
    readonly heights: readonly number[];
}

const layout = (widths: readonly number[] = [], heights: readonly number[] = []): Layout => ({
    widths: [0, 1, 2].map((column) => widths[column] ?? COLUMN_WIDTH_PX),
    heights: [0, 1, 2, 3].map((line) => heights[line] ?? ROW_HEIGHT_PX),
});

const left_of = (shown: Layout, column: number) =>
    ROW_MARKER_WIDTH_PX + shown.widths.slice(0, column).reduce((sum, width) => sum + width, 0);
const top_of = (shown: Layout, line: number) =>
    HEADER_HEIGHT_PX + shown.heights.slice(0, line).reduce((sum, height) => sum + height, 0);

/** The cells the accessibility table reports selected, as `column,row`. */
function selected_cells(page: Page): Promise<string[]> {
    return page.evaluate(() => [...document.querySelectorAll('tbody td[aria-selected="true"]')]
        .map((data) => {
            const [, column, line] = /^glide-cell-(\d+)-(\d+)$/.exec(data.id) ?? [];
            return `${Number(column) - 1},${line}`;
        }));
}

/**
 * Click a point of the grid and expect it to select one cell.
 *
 * One click, then a poll of what is selected: a second click on a selected
 * cell opens its editor, so a probe is never repeated, and never aimed at the
 * cell the probe before it selected.
 */
async function expect_cell_at(
    page: Page,
    offset: { x: number; y: number },
    expected: { column: number; row: number },
): Promise<void> {
    const key = `${expected.column},${expected.row}`;
    if (key === last_probe) throw new Error(`two probes in a row aim at cell ${key}`);
    last_probe = key;
    const box = await canvas_box(page);
    await page.mouse.click(box.x + offset.x, box.y + offset.y);
    // Polled in the page, once a frame: a test makes a few hundred probes.
    const selected = page.waitForFunction((wanted) => {
        const cells = [...document.querySelectorAll('tbody td[aria-selected="true"]')];
        return cells.length === 1 && cells[0].id === wanted;
    }, `glide-cell-${expected.column + 1}-${expected.row}`, { timeout: 15_000 });
    await selected.catch(async () => {
        throw new Error(`a click at ${offset.x},${offset.y} from the grid's corner should select cell ${key}; `
            + `selected: ${JSON.stringify(await selected_cells(page))}`);
    });
    await expect(page.locator('.cell-editor-input')).toHaveCount(0);
}

/**
 * Expect the window to show `shown`: for each watched border, a click just
 * inside it lands in the column or row before it and a click just past it
 * lands in the next one. Columns are probed in different rows and rows in different
 * columns, so no two clicks in a row aim at the same cell, and none aims at
 * the last cell of the grid, where the check starts.
 */
async function expect_layout(page: Page, shown: Layout): Promise<void> {
    // Start from a cell no probe aims at. Whatever was selected before (the
    // cell an edit or its undo left the cursor on) is then not selected, and
    // the first probe cannot be a second click on it.
    last_probe = undefined;
    await expect_cell_at(
        page,
        { x: left_of(shown, 2) + 10, y: top_of(shown, 3) + 10 },
        { column: 2, row: 3 },
    );
    for (const column of watched.columns) {
        const border = left_of(shown, column) + shown.widths[column];
        const y = top_of(shown, column) + 10;
        await expect_cell_at(page, { x: border - PROBE_PX, y }, { column, row: column });
        await expect_cell_at(page, { x: border + PROBE_PX, y }, { column: column + 1, row: column });
    }
    for (const line of watched.rows) {
        const column = line % 2;
        const border = top_of(shown, line) + shown.heights[line];
        const x = left_of(shown, column) + 10;
        await expect_cell_at(page, { x, y: border - PROBE_PX }, { column, row: line });
        await expect_cell_at(page, { x, y: border + PROBE_PX }, { column, row: line + 1 });
    }
}

interface Stored {
    /** Stored widths by source column. */
    widths: Record<string, number>;
    /** The stored custom heights, ascending. Which source rows hold them is the file format's business. */
    heights: number[];
}

/**
 * What the state database holds for the file, or undefined while it cannot be
 * read.
 *
 * Read from a copy, never in place: a reader's lock at the moment the app
 * commits makes its write wait until the reader is done, and no test here
 * should be what the app waits for ("a column resize waits for an outside
 * reader" holds one on purpose). A copy taken while the app is inside a write
 * is not read: under `journal_mode = DELETE` the journal file exists for
 * exactly that long.
 */
function stored(file: string): Stored | undefined {
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
            if (entry === undefined) return { widths: {}, heights: [] };
            const state = JSON.parse(entry.state_json) as {
                columnWidths?: (Record<string, number> | null)[];
                rowHeights?: (Record<string, number> | null)[];
            };
            return {
                widths: state.columnWidths?.[0] ?? {},
                heights: Object.values(state.rowHeights?.[0] ?? {}).sort((left, right) => left - right),
            };
        } finally {
            database.close();
        }
    } catch {
        // Not there yet, or copied mid-write: read again.
        return undefined;
    }
}

interface Expected {
    /** The sizes the file remembers. */
    stored: Stored;
    /** The sizes the window shows. */
    shown: Layout;
    /** What the Edit menu's Undo and Redo items read. */
    undo: string;
    redo: string;
}

async function menu_labels(): Promise<{ undo: string; redo: string }> {
    const menu = await app!.evaluate(() => (globalThis as typeof globalThis & {
        __tableViewerSmokeHistory?: unknown;
    }).__tableViewerSmokeHistory) as HistoryMenuState | undefined;
    return {
        undo: history_menu_item('undo', menu).label,
        redo: history_menu_item('redo', menu).label,
    };
}

/**
 * Wait until the file remembers, and the Edit menu reads, what is expected,
 * with nothing said that is not in `dialogs`; then read the sizes on screen.
 */
async function expect_sizes(
    page: Page,
    file: string,
    expected: Expected,
    dialogs: readonly string[] = [],
): Promise<void> {
    const said: string[] = [];
    await expect.poll(async () => {
        said.push(...(await take_dialogs(app!)).map((dialog) => dialog.message ?? ''));
        return { stored: stored(file), ...(await menu_labels()), dialogs: [...said] };
    }, { intervals: [25, 50, 100, 250] }).toEqual({ stored: expected.stored, undo: expected.undo, redo: expected.redo, dialogs: [...dialogs] });
    await expect_layout(page, expected.shown);
}

/** Undo or redo, as the Edit menu sends it to the window. */
async function history(page: Page, command: 'undo' | 'redo'): Promise<void> {
    await page.evaluate((sent) => window.postMessage({ type: 'editCommand', command: sent }, '*'), command);
}

/** Drag the right border of a column by `dx`, in the header. */
async function drag_column_border(page: Page, shown: Layout, column: number, dx: number): Promise<void> {
    const box = await canvas_box(page);
    const x = box.x + left_of(shown, column) + shown.widths[column] - 2;
    const y = box.y + HEADER_HEIGHT_PX / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    if (dx !== 0) await page.mouse.move(x + dx, y, { steps: 6 });
    await page.mouse.up();
}

/** Drag the bottom border of a row by `dy`, over a cell of the first column. */
async function drag_row_border(page: Page, shown: Layout, line: number, dy: number): Promise<void> {
    const box = await canvas_box(page);
    const x = box.x + left_of(shown, 0) + 40;
    const y = box.y + top_of(shown, line) + shown.heights[line] - 2;
    // Onto the border from the row below it. "a row border reached from
    // inside its own cell" comes at it the other way.
    await page.mouse.move(x, y + 12);
    await page.mouse.move(x, y);
    await expect(page.locator('.row-resize-strip')).toBeVisible();
    await page.mouse.down();
    await page.mouse.move(x, y + dy, { steps: 6 });
    await page.mouse.up();
}

/** Click a column's header; with `extend`, Shift+click, selecting the columns between. */
async function click_header(page: Page, shown: Layout, column: number, extend = false): Promise<void> {
    const box = await canvas_box(page);
    if (extend) await page.keyboard.down('Shift');
    await page.mouse.click(
        box.x + left_of(shown, column) + shown.widths[column] / 2,
        box.y + HEADER_HEIGHT_PX / 2,
    );
    if (extend) await page.keyboard.up('Shift');
    await expect(page.locator(`thead th[aria-colindex="${column + 1}"]`))
        .toHaveAttribute('aria-selected', 'true');
    last_probe = undefined;
}

/** Click a row's marker; with `extend`, Shift+click, selecting the rows between. */
async function click_row_marker(page: Page, shown: Layout, line: number, extend = false): Promise<void> {
    const box = await canvas_box(page);
    if (extend) await page.keyboard.down('Shift');
    await page.mouse.click(
        box.x + ROW_MARKER_WIDTH_PX / 2,
        box.y + top_of(shown, line) + shown.heights[line] / 2,
    );
    if (extend) await page.keyboard.up('Shift');
    await expect(page.locator(`tbody tr[aria-rowindex="${line + 2}"]`))
        .toHaveAttribute('aria-selected', 'true');
    last_probe = undefined;
}

/**
 * Wait for the file to remember a width for `column` within a few pixels of
 * `about`, and return it. A drag ends a pixel or two from where it is aimed,
 * and a second drag of the same column starts from a width already stored,
 * so the wait is for the width, not for any width.
 */
async function stored_width(file: string, column: number, about: number): Promise<number> {
    let width: number | undefined;
    await expect.poll(() => {
        width = stored(file)?.widths[column];
        return width === undefined ? `nothing stored for column ${column}` : Math.abs(width - about) <= 4;
    }, { message: `column ${column} is stored about ${about} wide` }).toBe(true);
    return width!;
}

const auto_fit_button = (page: Page) => page.getByRole('button', { name: 'Auto-fit Columns' });

const NOTHING: Stored = { widths: {}, heights: [] };

async function body(page: Page): Promise<string[]> {
    return page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((line) =>
        [...line.querySelectorAll('td')].map((data) => data.textContent ?? '').join('|')));
}

for (const kind of ['csv', 'xlsx'] as const) {
    test(`${kind}: a dragged column border is one step, undone and redone`, async () => {
        watch([0], []);
        const { file, page } = await open_file(`column.${kind}`, fixture(kind));
        await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo' });

        await drag_column_border(page, layout(), 0, 60);
        const width = await stored_width(file, 0, 180);
        const resized = { stored: { widths: { 0: width }, heights: [] }, shown: layout([width]) };
        await expect_sizes(page, file, { ...resized, undo: 'Undo Resize column', redo: 'Redo' });
        // A resize is not an edit: the file has nothing to save.
        await expect(save_button(page)).not.toHaveClass(/has-unsaved/);

        await history(page, 'undo');
        await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Resize column' });
        await history(page, 'redo');
        await expect_sizes(page, file, { ...resized, undo: 'Undo Resize column', redo: 'Redo' });
        await expect(save_button(page)).not.toHaveClass(/has-unsaved/);

        // Dragging again is a second step.
        await drag_column_border(page, resized.shown, 0, -30);
        const narrower = await stored_width(file, 0, width - 30);
        expect(narrower).not.toBe(width);
        await expect_sizes(page, file, {
            stored: { widths: { 0: narrower }, heights: [] },
            shown: layout([narrower]),
            undo: 'Undo Resize column',
            redo: 'Redo',
        });
        await history(page, 'undo');
        await expect_sizes(page, file, { ...resized, undo: 'Undo Resize column', redo: 'Redo Resize column' });
        await history(page, 'undo');
        await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Resize column' });
    });

    test(`${kind}: a dragged row border is one step, undone and redone`, async () => {
        watch([], [1]);
        const { file, page } = await open_file(`row.${kind}`, fixture(kind));
        await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo' });

        await drag_row_border(page, layout(), 1, 30);
        const taller = { stored: { widths: {}, heights: [54] }, shown: layout([], [24, 54]) };
        await expect_sizes(page, file, { ...taller, undo: 'Undo Resize row', redo: 'Redo' });
        await expect(save_button(page)).not.toHaveClass(/has-unsaved/);

        // Undo removes the custom height; redo puts it back.
        await history(page, 'undo');
        await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Resize row' });
        await history(page, 'redo');
        await expect_sizes(page, file, { ...taller, undo: 'Undo Resize row', redo: 'Redo' });
    });
}

test('Auto-fit on and off are steps, and undo and redo leave the toolbar as each left it', async () => {
    watch([0, 1], []);
    const { file, page } = await open_file('fit.csv', CSV);
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo' });

    await auto_fit_button(page).click();
    // The fit makes at least the first column narrower than the default.
    let fitted: Stored = NOTHING;
    await expect.poll(() => {
        fitted = stored(file) ?? NOTHING;
        return fitted.widths[0] ?? COLUMN_WIDTH_PX;
    }).toBeLessThan(COLUMN_WIDTH_PX);
    const fitted_shown = layout([0, 1, 2].map((column) => fitted.widths[column] ?? COLUMN_WIDTH_PX));
    await expect_sizes(page, file, { stored: fitted, shown: fitted_shown, undo: 'Undo Auto-fit columns', redo: 'Redo' });
    await expect(auto_fit_button(page)).toHaveClass(/active/);

    await auto_fit_button(page).click();
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo Restore column widths', redo: 'Redo' });
    await expect(auto_fit_button(page)).not.toHaveClass(/active/);

    await history(page, 'undo');
    await expect_sizes(page, file, {
        stored: fitted,
        shown: fitted_shown,
        undo: 'Undo Auto-fit columns',
        redo: 'Redo Restore column widths',
    });
    await expect(auto_fit_button(page)).toHaveClass(/active/);
    await history(page, 'undo');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Auto-fit columns' });
    await expect(auto_fit_button(page)).not.toHaveClass(/active/);

    await history(page, 'redo');
    await expect_sizes(page, file, {
        stored: fitted,
        shown: fitted_shown,
        undo: 'Undo Auto-fit columns',
        redo: 'Redo Restore column widths',
    });
    await expect(auto_fit_button(page)).toHaveClass(/active/);
    await history(page, 'redo');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo Restore column widths', redo: 'Redo' });
    await expect(auto_fit_button(page)).not.toHaveClass(/active/);
});

test('a row border dragged with every row selected is one step for all of them', async () => {
    watch([], [0, 1, 2]);
    const { file, page } = await open_file('rows.csv', CSV);
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo' });

    await click_row_marker(page, layout(), 0);
    await click_row_marker(page, layout(), 3, true);
    await drag_row_border(page, layout(), 1, 20);
    const all = { stored: { widths: {}, heights: [44, 44, 44, 44] }, shown: layout([], [44, 44, 44, 44]) };
    await expect_sizes(page, file, { ...all, undo: 'Undo Resize 4 rows', redo: 'Redo' });

    await history(page, 'undo');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Resize 4 rows' });
    await history(page, 'redo');
    await expect_sizes(page, file, { ...all, undo: 'Undo Resize 4 rows', redo: 'Redo' });
});

test('a column border dragged with three columns selected is one step for all of them', async () => {
    watch([0, 1], []);
    const { file, page } = await open_file('columns.csv', CSV);
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo' });

    await click_header(page, layout(), 0);
    await click_header(page, layout(), 2, true);
    await drag_column_border(page, layout(), 0, 40);
    const width = await stored_width(file, 0, 160);
    const all = {
        stored: { widths: { 0: width, 1: width, 2: width }, heights: [] },
        shown: layout([width, width, width]),
    };
    await expect_sizes(page, file, { ...all, undo: 'Undo Resize 3 columns', redo: 'Redo' });

    await history(page, 'undo');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Resize 3 columns' });
    await history(page, 'redo');
    await expect_sizes(page, file, { ...all, undo: 'Undo Resize 3 columns', redo: 'Redo' });
});

test('Reset row height is a step, undone and redone', async () => {
    watch([], [1]);
    const { file, page } = await open_file('reset.csv', CSV);
    await drag_row_border(page, layout(), 1, 30);
    const taller = { stored: { widths: {}, heights: [54] }, shown: layout([], [24, 54]) };
    await expect_sizes(page, file, { ...taller, undo: 'Undo Resize row', redo: 'Redo' });

    await choose(await open_row_menu(page, 1), 'Reset row height');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo Reset row height', redo: 'Redo' });

    await history(page, 'undo');
    await expect_sizes(page, file, { ...taller, undo: 'Undo Resize row', redo: 'Redo Reset row height' });
    await history(page, 'redo');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo Reset row height', redo: 'Redo' });

    // The row is at the default height again, and is offered nothing to reset.
    const plain = await open_row_menu(page, 1);
    await expect(plain.getByRole('menuitem', { name: 'Hide row', exact: true })).toBeVisible();
    await expect(plain.getByRole('menuitem', { name: 'Reset row height', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(plain).toHaveCount(0);
});

test('an edit, a column resize, a sort, and a row resize are undone and redone in order', async () => {
    watch([1], [0]);
    const { file, page } = await open_file('mixed.csv', CSV);
    await expect.poll(() => body(page)).toEqual(NATURAL);

    await type_into_cell(page, 1, 0, 'Ann');
    const edited = ['Ann|30|New York', 'Bob|25|London', 'Charlie|35|Paris', 'Dora|28|Oslo'];
    await drag_column_border(page, layout(), 1, 40);
    const width = await stored_width(file, 1, 160);
    const wide = layout([120, width]);
    await expect_sizes(page, file, {
        stored: { widths: { 1: width }, heights: [] },
        shown: wide,
        undo: 'Undo Resize column',
        redo: 'Redo',
    });
    const menu = await open_column_menu(page, 1);
    await menu.getByRole('menuitemcheckbox', { name: 'Sort descending' }).click();
    await expect(menu).toHaveCount(0);
    last_probe = undefined;
    const sorted = ['Charlie|35|Paris', 'Ann|30|New York', 'Dora|28|Oslo', 'Bob|25|London'];
    await expect.poll(() => body(page)).toEqual(sorted);
    await expect.poll(async () => (await menu_labels()).undo).toBe('Undo Sort');
    await drag_row_border(page, wide, 0, 30);
    const everything = {
        stored: { widths: { 1: width }, heights: [54] },
        shown: layout([120, width], [54]),
    };
    await expect_sizes(page, file, { ...everything, undo: 'Undo Resize row', redo: 'Redo' });

    await history(page, 'undo');
    await expect_sizes(page, file, {
        stored: { widths: { 1: width }, heights: [] },
        shown: wide,
        undo: 'Undo Sort',
        redo: 'Redo Resize row',
    });
    expect(await body(page)).toEqual(sorted);
    await history(page, 'undo');
    await expect.poll(() => body(page)).toEqual(edited);
    await expect_sizes(page, file, {
        stored: { widths: { 1: width }, heights: [] },
        shown: wide,
        undo: 'Undo Resize column',
        redo: 'Redo Sort',
    });
    await history(page, 'undo');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo Edit cell', redo: 'Redo Resize column' });
    expect(await body(page)).toEqual(edited);
    await history(page, 'undo');
    await expect.poll(() => body(page)).toEqual(NATURAL);
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Edit cell' });
    // Nothing is unsaved, and every step is still there to redo.
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/);

    await history(page, 'redo');
    await expect.poll(() => body(page)).toEqual(edited);
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo Edit cell', redo: 'Redo Resize column' });
    await history(page, 'redo');
    await expect_sizes(page, file, {
        stored: { widths: { 1: width }, heights: [] },
        shown: wide,
        undo: 'Undo Resize column',
        redo: 'Redo Sort',
    });
    await history(page, 'redo');
    await expect.poll(() => body(page)).toEqual(sorted);
    await expect.poll(async () => (await menu_labels()).redo).toBe('Redo Resize row');
    await history(page, 'redo');
    await expect_sizes(page, file, { ...everything, undo: 'Undo Resize row', redo: 'Redo' });
    expect(await body(page)).toEqual(sorted);
});

test('what the file remembers follows undo and redo across a relaunch', async () => {
    watch([0], [1]);
    const first = await open_file('remembered.csv', CSV);
    const { file } = first;
    let page = first.page;
    await drag_column_border(page, layout(), 0, 60);
    const width = await stored_width(file, 0, 180);
    await drag_row_border(page, layout([width]), 1, 30);
    const both = {
        stored: { widths: { 0: width }, heights: [54] },
        shown: layout([width], [24, 54]),
    };
    await expect_sizes(page, file, { ...both, undo: 'Undo Resize row', redo: 'Redo' });

    // Undo both and quit: the file opens at the sizes it had before either.
    await history(page, 'undo');
    await expect_sizes(page, file, {
        stored: { widths: { 0: width }, heights: [] },
        shown: layout([width]),
        undo: 'Undo Resize column',
        redo: 'Redo Resize row',
    });
    await history(page, 'undo');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Resize column' });
    page = await relaunch('remembered.csv');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo' });

    // Resize both, undo both, redo both, and quit: the file opens resized.
    await drag_column_border(page, layout(), 0, 60);
    const again = await stored_width(file, 0, 180);
    await drag_row_border(page, layout([again]), 1, 30);
    const redone = {
        stored: { widths: { 0: again }, heights: [54] },
        shown: layout([again], [24, 54]),
    };
    await expect_sizes(page, file, { ...redone, undo: 'Undo Resize row', redo: 'Redo' });
    await history(page, 'undo');
    await expect.poll(async () => (await menu_labels()).redo).toBe('Redo Resize row');
    await history(page, 'undo');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Resize column' });
    await history(page, 'redo');
    await expect.poll(async () => (await menu_labels()).undo).toBe('Undo Resize column');
    await history(page, 'redo');
    await expect_sizes(page, file, { ...redone, undo: 'Undo Resize row', redo: 'Redo' });
    page = await relaunch('remembered.csv');
    await expect_sizes(page, file, { ...redone, undo: 'Undo', redo: 'Redo' });
});

test('a double-click on a column border fits the column in one step', async () => {
    watch([0], []);
    const { file, page } = await open_file('double.csv', CSV);
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo' });

    const box = await canvas_box(page);
    await page.mouse.dblclick(
        box.x + left_of(layout(), 0) + COLUMN_WIDTH_PX - 2,
        box.y + HEADER_HEIGHT_PX / 2,
    );
    // The fit makes the column narrower than the default: its longest text is short.
    let width = COLUMN_WIDTH_PX;
    await expect.poll(() => {
        width = stored(file)?.widths[0] ?? COLUMN_WIDTH_PX;
        return width;
    }).toBeLessThan(COLUMN_WIDTH_PX);
    const fitted = { stored: { widths: { 0: width }, heights: [] }, shown: layout([width]) };
    await expect_sizes(page, file, { ...fitted, undo: 'Undo Resize column', redo: 'Redo' });

    await history(page, 'undo');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Resize column' });
    await history(page, 'redo');
    await expect_sizes(page, file, { ...fitted, undo: 'Undo Resize column', redo: 'Redo' });
    // One step: there is nothing under it.
    await history(page, 'undo');
    await history(page, 'undo');
    await expect_sizes(page, file, { stored: NOTHING, shown: layout(), undo: 'Undo', redo: 'Redo Resize column' });
});

test('a click on a border inside a column selection changes no width and is no step', async () => {
    watch([0, 1], []);
    const { file, page } = await open_file('click.csv', CSV);
    await drag_column_border(page, layout(), 0, 40);
    const first = await stored_width(file, 0, 160);
    await drag_column_border(page, layout([first]), 1, 20);
    const second = await stored_width(file, 1, 140);
    const two = {
        stored: { widths: { 0: first, 1: second }, heights: [] },
        shown: layout([first, second]),
    };
    await expect_sizes(page, file, { ...two, undo: 'Undo Resize column', redo: 'Redo' });

    // Three columns of three different widths, all selected; then a press and
    // release on the first one's border that does not move it.
    await click_header(page, two.shown, 0);
    await click_header(page, two.shown, 2, true);
    await drag_column_border(page, two.shown, 0, 0);
    // The selection is still there, so the press was taken by the grid.
    await expect(page.locator('thead th[aria-colindex="3"]')).toHaveAttribute('aria-selected', 'true');

    // The widths, and what Undo and Redo read, are as before the click.
    await expect_sizes(page, file, { ...two, undo: 'Undo Resize column', redo: 'Redo' });
    // One Undo takes back the second drag, so the click recorded nothing.
    await history(page, 'undo');
    await expect_sizes(page, file, {
        stored: { widths: { 0: first }, heights: [] },
        shown: layout([first]),
        undo: 'Undo Resize column',
        redo: 'Redo Resize column',
    });
});
