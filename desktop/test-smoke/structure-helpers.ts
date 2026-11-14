// Shared helpers for the structural-editing smoke specs (row and column
// structure design, "Integration and desktop smoke").
//
// The specs launch the app as shipped: structural editing is on by default
// (`STRUCTURAL_EDITING_ENABLED`), with no test switch.
//
// The grid is a canvas, so the helpers aim at row markers and column headers by
// coordinate, then confirm the target through something the grid reports in the
// DOM: the context menu's accessible name, a row's accessibility label, or a
// header's text. Every wait polls; none sleeps.
import * as fs from 'fs';
import * as path from 'path';
import { expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { CHANNEL_WEBVIEW_MESSAGE } from '../shared/ipc';
import { history_menu_item, type HistoryMenuState } from '../main/history-menu-model';
import { launch_app } from './smoke-helpers';

const VIEWER_URL_PREFIX = 'tv-app://viewer';
const GRID_CANVAS = '[data-testid="data-grid-canvas"]';

// Glide's default header height and the app's default row height and column
// width at the default font size. The row marker is 32 px wide below 100 rows.
const HEADER_HEIGHT_PX = 36;
const ROW_HEIGHT_PX = 24;
const ROW_MARKER_WIDTH_PX = 32;
const COLUMN_WIDTH_PX = 120;

/** Where proof screenshots go, when the caller asks for them. Unset in CI. */
const SCREENSHOT_DIR = process.env.TABLE_VIEWER_SMOKE_SCREENSHOTS;

export async function save_screenshot(page: Page, name: string): Promise<void> {
    if (!SCREENSHOT_DIR) return;
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
}

/** Launch the app on `file` and return it with its one viewer. */
export async function launch_structural_viewer(
    user_data_dir: string,
    file: string,
): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await launch_app(user_data_dir, [file]);
    try {
        const pages = () => app.windows().filter((page) => page.url().startsWith(VIEWER_URL_PREFIX));
        await expect.poll(() => pages().length, { timeout: 30_000 }).toBe(1);
        const page = pages()[0];
        await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
        return { app, page };
    } catch (error) {
        // The caller never receives `app`, so it can't clean up.
        await app.close().catch(() => {});
        throw error;
    }
}

export async function viewer_count(app: ElectronApplication): Promise<number> {
    return app.windows().filter((page) => page.url().startsWith(VIEWER_URL_PREFIX)).length;
}

/** Quit and wait for the process to be gone. */
export async function exit_app(app: ElectronApplication): Promise<void> {
    const process_handle = app.process();
    await app.evaluate(({ app: electron_app }) => electron_app.quit()).catch(() => {});
    await expect
        .poll(() => process_handle.exitCode !== null || process_handle.signalCode !== null,
            { timeout: 30_000 })
        .toBe(true);
    await app.close().catch(() => {});
}

export interface CapturedDialog {
    readonly message?: string;
    readonly buttons?: readonly string[];
}

/**
 * Answer every message box with its first button and record it. With
 * `record_file`, each dialog is also appended to that file as a JSON line, so
 * it can be read after the process exits: on Windows and Linux, closing the
 * last window quits the app, and an in-memory record would race that exit.
 */
export async function install_dialog_capture(
    app: ElectronApplication,
    record_file?: string,
): Promise<void> {
    await app.evaluate(({ dialog }, file) => {
        const main = globalThis as typeof globalThis & {
            __tableViewerSmokeDialogs?: Array<{ message?: string; buttons?: readonly string[] }>;
        };
        main.__tableViewerSmokeDialogs = [];
        const fs = process.getBuiltinModule('fs');
        const replacement = async (...args: unknown[]) => {
            const options = (args.length === 1 ? args[0] : args[1]) as {
                message?: string;
                buttons?: readonly string[];
            };
            const entry = { message: options.message, buttons: options.buttons };
            main.__tableViewerSmokeDialogs?.push(entry);
            if (file !== undefined) fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
            return { response: 0, checkboxChecked: false };
        };
        dialog.showMessageBox = replacement as typeof dialog.showMessageBox;
    }, record_file);
}

/** The dialogs `install_dialog_capture` appended to `record_file`. */
export function recorded_dialogs(record_file: string): CapturedDialog[] {
    if (!fs.existsSync(record_file)) return [];
    return fs.readFileSync(record_file, 'utf8').split('\n').filter((line) => line !== '')
        .map((line) => JSON.parse(line) as CapturedDialog);
}

export async function take_dialogs(app: ElectronApplication): Promise<CapturedDialog[]> {
    return app.evaluate(() => {
        const main = globalThis as typeof globalThis & {
            __tableViewerSmokeDialogs?: CapturedDialog[];
        };
        return main.__tableViewerSmokeDialogs?.splice(0) ?? [];
    });
}

/**
 * Record the history state each viewer reports for the Edit menu.
 *
 * The application menu is rebuilt only for the focused window, and a launch
 * from a terminal or a CI runner is not guaranteed focus. So instead of
 * reading the native menu, this listens on the same channel main.ts does and
 * keeps the latest `historyMenuStateChanged`; `undo_menu_label` then runs it
 * through the menu's own label rule. desktop-smoke.spec.ts covers the native
 * menu rebuild itself.
 */
export async function install_history_menu_capture(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ ipcMain }, channel) => {
        const main = globalThis as typeof globalThis & { __tableViewerSmokeHistory?: unknown };
        ipcMain.on(channel, (_event, envelope: { message?: { type?: string; state?: unknown } }) => {
            if (envelope?.message?.type === 'historyMenuStateChanged') {
                main.__tableViewerSmokeHistory = envelope.message.state;
            }
        });
    }, CHANNEL_WEBVIEW_MESSAGE);
}

/** What the Edit menu's Undo item reads for the viewer's latest history. */
export async function undo_menu_label(app: ElectronApplication): Promise<string> {
    const state = await app.evaluate(() => (globalThis as typeof globalThis & {
        __tableViewerSmokeHistory?: unknown;
    }).__tableViewerSmokeHistory) as HistoryMenuState | undefined;
    return history_menu_item('undo', state).label;
}

/**
 * The toolbar's Save button. It is there for any file that can be edited, and
 * carries `has-unsaved` exactly while there are changes to save.
 */
export function save_button(page: Page): Locator {
    return page.getByRole('button', { name: 'Save' });
}

/**
 * Wait until the grid can take a gesture. There is no edit mode to enter: the
 * first editing gesture acquires the session behind it.
 */
export async function wait_for_grid(page: Page): Promise<void> {
    await expect(save_button(page)).toBeVisible();
    await expect.poll(() => page.locator('tbody tr').count(), { timeout: 30_000 })
        .toBeGreaterThan(0);
}

/** Save through the toolbar and wait until nothing is left unsaved. */
export async function save_changes(page: Page): Promise<void> {
    await expect(save_button(page)).toHaveClass(/has-unsaved/);
    await save_button(page).click();
    await expect(save_button(page)).not.toHaveClass(/has-unsaved/, { timeout: 30_000 });
}

async function canvas_box(page: Page): Promise<{ x: number; y: number }> {
    const box = await page.locator(GRID_CANVAS).first().boundingBox();
    if (!box) throw new Error('the grid canvas has no box');
    return box;
}

/** The centre of a display row's marker, in page coordinates. */
export async function row_marker_point(page: Page, row: number): Promise<{ x: number; y: number }> {
    const box = await canvas_box(page);
    return {
        x: box.x + ROW_MARKER_WIDTH_PX / 2,
        y: box.y + HEADER_HEIGHT_PX + row * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2,
    };
}

/** The centre of a display column's header, assuming default widths. */
export async function header_point(page: Page, column: number): Promise<{ x: number; y: number }> {
    const box = await canvas_box(page);
    return {
        x: box.x + ROW_MARKER_WIDTH_PX + column * COLUMN_WIDTH_PX + COLUMN_WIDTH_PX / 2,
        y: box.y + HEADER_HEIGHT_PX / 2,
    };
}

function context_menu(page: Page): Locator {
    return page.locator('[role="menu"]').first();
}

/** Right-click a row marker and wait for the row menu. */
export async function open_row_menu(page: Page, row: number): Promise<Locator> {
    const point = await row_marker_point(page, row);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    const menu = context_menu(page);
    await expect(menu).toHaveAttribute('aria-label', /^Row actions/);
    return menu;
}

/** Right-click a column header and wait for its menu. */
export async function open_column_menu(page: Page, column: number): Promise<Locator> {
    const point = await header_point(page, column);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    const menu = context_menu(page);
    await expect(menu).toHaveAttribute('aria-label', /^Column actions/);
    return menu;
}

/** The centre of a body cell, assuming default column widths and row heights. */
export async function cell_point(page: Page, column: number, row: number): Promise<{ x: number; y: number }> {
    const box = await canvas_box(page);
    return {
        x: box.x + ROW_MARKER_WIDTH_PX + column * COLUMN_WIDTH_PX + COLUMN_WIDTH_PX / 2,
        y: box.y + HEADER_HEIGHT_PX + row * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2,
    };
}

/** Right-click a body cell and wait for the cell menu. */
export async function open_cell_menu(page: Page, column: number, row: number): Promise<Locator> {
    const point = await cell_point(page, column, row);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    const menu = context_menu(page);
    await expect(menu.getByRole('menuitem', { name: 'Copy cell', exact: true })).toBeVisible();
    return menu;
}

/** Open `submenu` in a menu and choose `item` from it. */
export async function choose_from_submenu(menu: Locator, submenu: string, item: string): Promise<void> {
    await menu.getByRole('menuitem', { name: submenu, exact: true }).click();
    const entry = menu.page().getByRole('menuitem', { name: item, exact: true });
    await expect(entry).not.toHaveAttribute('aria-disabled', 'true');
    await entry.click();
    await expect(menu).toHaveCount(0);
}

export async function choose(menu: Locator, item: string): Promise<void> {
    const entry = menu.getByRole('menuitem', { name: item, exact: true });
    await expect(entry).not.toHaveAttribute('aria-disabled', 'true');
    await entry.click();
    await expect(menu).toHaveCount(0);
}

/** A display row's accessible row, which reports whole-row selection. */
function accessible_row(page: Page, row: number): Locator {
    // aria-rowindex is 1-based and counts the header row.
    return page.locator(`tbody tr[aria-rowindex="${row + 2}"]`);
}

/** Click a row marker, selecting the whole row; with `extend`, Shift+click. */
export async function select_row(page: Page, row: number, extend = false): Promise<void> {
    const point = await row_marker_point(page, row);
    if (extend) await page.keyboard.down('Shift');
    await page.mouse.click(point.x, point.y);
    if (extend) await page.keyboard.up('Shift');
    await expect(accessible_row(page, row)).toHaveAttribute('aria-selected', 'true');
}

/** Click a column header, selecting the whole column. */
export async function select_column(page: Page, column: number): Promise<void> {
    const point = await header_point(page, column);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator(`th[aria-colindex="${column + 1}"]`))
        .toHaveAttribute('aria-selected', 'true');
}

/** Each accessible body row as `label|cell|cell…`, the label empty for a plain row. */
export async function grid_rows(page: Page): Promise<string[]> {
    return page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((row) => [
        row.getAttribute('aria-label') ?? '',
        ...[...row.querySelectorAll('td')].map((cell) => cell.textContent ?? ''),
    ].join('|')));
}

/** Each accessible column header as `label|text`. */
export async function grid_headers(page: Page): Promise<string[]> {
    return page.evaluate(() => [...document.querySelectorAll('thead th')].map((header) =>
        `${header.getAttribute('aria-label') ?? ''}|${header.textContent ?? ''}`));
}

/**
 * Type `value` into a grid cell through the cell editor. Focusing the
 * accessible cell selects it and Enter opens the editor, except after a
 * refresh, when focus no longer moves the grid's selection and Enter would
 * edit whichever cell is selected. Then the cell is double-clicked on the
 * canvas, at default widths, which opens its editor directly.
 */
export async function type_into_cell(page: Page, column: number, row: number, value: string): Promise<void> {
    const cell = page.locator(`#glide-cell-${column}-${row}`);
    await expect(cell).toHaveAttribute('aria-readonly', 'false');
    await cell.focus();
    const selected = await expect.poll(() => cell.getAttribute('aria-selected'), { timeout: 3_000 })
        .toBe('true').then(() => true, () => false);
    if (selected) {
        await page.keyboard.press('Enter');
    } else {
        const box = await canvas_box(page);
        await page.mouse.dblclick(
            box.x + ROW_MARKER_WIDTH_PX + (column - 1) * COLUMN_WIDTH_PX + COLUMN_WIDTH_PX / 2,
            box.y + HEADER_HEIGHT_PX + row * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2,
        );
        await expect(cell).toHaveAttribute('aria-selected', 'true');
    }
    const editor = page.locator('.cell-editor-input');
    await expect(editor).toBeVisible();
    await editor.fill(value);
    await editor.press('Enter');
    await expect(editor).toBeHidden();
    await expect(cell).toHaveText(value);
}
