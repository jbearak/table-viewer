// A sort or filter the person chooses while another of theirs computes replaces
// it and keeps what it asked for, as one step, and Undo of one still in flight
// cancels it (docs/plans/window-queue.md, V1). Through the real menus, on a
// table large enough that the sort is still computing when the next choice
// and the Undo arrive: each step checks that it is, so the spec cannot pass by
// arriving late.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { history_menu_item, type HistoryMenuState } from '../main/history-menu-model';
import { CHANNEL_WEBVIEW_MESSAGE } from '../shared/ipc';
import { isolated_user_data } from './smoke-helpers';
import {
    choose,
    exit_app,
    install_dialog_capture,
    install_history_menu_capture,
    launch_structural_viewer,
    open_column_menu,
    open_row_menu,
    take_dialogs,
    wait_for_grid,
} from './structure-helpers';

let test_root: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
    test_root = isolated_user_data('tv-undo-redo-view-latest-');
});

test.afterEach(async () => {
    if (app) await exit_app(app);
    app = undefined;
    fs.rmSync(test_root, { recursive: true, force: true });
});

const ROWS = 1_000_000;
/** Three columns of distinct numbers, so every sort has one first row. */
const cells = (i: number): [number, number, number] => [i, (i * 7919) % 1_000_003, (i * 104_729) % 999_983];

function write_table(file: string): void {
    const fd = fs.openSync(file, 'w');
    try {
        fs.writeSync(fd, 'Id,First,Second\n');
        let chunk = '';
        for (let i = 1; i <= ROWS; i += 1) {
            chunk += `${cells(i).join(',')}\n`;
            if (i % 50_000 === 0) {
                fs.writeSync(fd, chunk);
                chunk = '';
            }
        }
        if (chunk !== '') fs.writeSync(fd, chunk);
    } finally {
        fs.closeSync(fd);
    }
}

/** The first row a sort of `column` puts first. */
function first_row(column: 1 | 2, direction: 'ascending' | 'descending'): string {
    let best = cells(1);
    for (let i = 2; i <= ROWS; i += 1) {
        const candidate = cells(i);
        const better = direction === 'ascending'
            ? candidate[column] < best[column]
            : candidate[column] > best[column];
        if (better) best = candidate;
    }
    return best.join('|');
}

async function shown_first_row(page: Page): Promise<string> {
    return page.evaluate(() => [...(document.querySelector('tbody tr')?.querySelectorAll('td') ?? [])]
        .map((cell) => cell.textContent ?? '').join('|'));
}

async function menu_label(direction: 'undo' | 'redo'): Promise<string> {
    const menu = await app!.evaluate(() => (globalThis as typeof globalThis & {
        __tableViewerSmokeHistory?: unknown;
    }).__tableViewerSmokeHistory) as HistoryMenuState | undefined;
    return history_menu_item(direction, menu).label;
}
const undo_label = () => menu_label('undo');
const redo_label = () => menu_label('redo');

/**
 * Keep the page's next sort or filter request from reaching the host until the
 * page asks which source rows a hide hides. The two then reach the host back to
 * back, the sort first, so the host answers the hide while the sort computes,
 * however long the hide took to choose.
 */
async function withhold_transform_until_hide(): Promise<void> {
    await app!.evaluate(({ ipcMain }, channel) => {
        const listeners = ipcMain.listeners(channel) as ((...args: unknown[]) => void)[];
        ipcMain.removeAllListeners(channel);
        let armed = true;
        let withheld: unknown[] | undefined;
        ipcMain.on(channel, (...args: unknown[]) => {
            const message = (args[1] as { message?: { type?: string; intent?: string } })?.message;
            if (armed && message?.type === 'setTransform' && message.intent === 'user') {
                armed = false;
                withheld = args;
                return;
            }
            if (withheld !== undefined && message?.type === 'resolveHiddenRows') {
                const earlier = withheld;
                withheld = undefined;
                (globalThis as typeof globalThis & { __sort_sent_with_hide?: boolean })
                    .__sort_sent_with_hide = true;
                for (const listener of listeners) listener(...earlier);
            }
            for (const listener of listeners) listener(...args);
        });
    }, CHANNEL_WEBVIEW_MESSAGE);
}

/**
 * Click the Edit menu's Undo or Redo item, as the native menu would, once the
 * item reads `label` by the menu's own label rule.
 *
 * Read through the capture above, not off the native menu: main.ts rebuilds
 * the menu only for the focused window, and a smoke run cannot count on its
 * window being in front (desktop-smoke.spec.ts covers the rebuild). The item
 * is the real one, found by its id, and its click routes on the window it is
 * given (`route_edit_command`), so it is given the viewer.
 */
async function click_edit_item(label: string): Promise<void> {
    const direction = label.startsWith('Undo') ? 'undo' : 'redo';
    await expect.poll(() => menu_label(direction)).toBe(label);
    const clicked = await app!.evaluate(({ BrowserWindow, Menu }, id) => {
        const viewer = BrowserWindow.getAllWindows()
            .find((candidate) => candidate.webContents.getURL().startsWith('tv-app://viewer'));
        const item = Menu.getApplicationMenu()?.getMenuItemById(id);
        if (viewer === undefined || !item?.click) return false;
        item.click(item, viewer, {});
        return true;
    }, `edit.${direction}`);
    expect(clicked, `Edit > ${label} and a viewer exist`).toBe(true);
}

async function choose_sort(page: Page, column: number, direction: 'ascending' | 'descending'): Promise<void> {
    const menu = await open_column_menu(page, column);
    const entry = menu.getByRole('menuitemcheckbox', { name: `Sort ${direction}` });
    // Enabled even while this window's own sort is in flight.
    await expect(entry).not.toHaveAttribute('aria-disabled', 'true');
    await entry.click();
    await expect(menu).toHaveCount(0);
}

const in_flight = (page: Page) => page.locator('.toolbar-progress');

test('a second sort during the first replaces it as one step, and Undo during a sort cancels it', async () => {
    test.setTimeout(240_000);
    const file = path.join(test_root, 'large.csv');
    write_table(file);
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir, { recursive: true });
    const launched = await launch_structural_viewer(user_data_dir, file);
    app = launched.app;
    const page = launched.page;
    await install_dialog_capture(app);
    await install_history_menu_capture(app);
    await wait_for_grid(page);
    const natural = '1|7919|104729';
    await expect.poll(() => shown_first_row(page), { timeout: 60_000 }).toBe(natural);

    // A sort, and while it computes, another: the second replaces the first.
    await choose_sort(page, 1, 'ascending');
    await expect(in_flight(page)).toBeVisible();
    await expect.poll(undo_label).toBe('Undo Sort');
    await choose_sort(page, 2, 'descending');
    await expect.poll(() => shown_first_row(page), { timeout: 60_000 })
        .toBe(first_row(2, 'descending'));
    await expect(in_flight(page)).toHaveCount(0);
    await expect.poll(undo_label).toBe('Undo Sort');

    // One step: one Undo, from the Edit menu, is back at the natural order.
    await click_edit_item('Undo Sort');
    await expect.poll(() => shown_first_row(page), { timeout: 60_000 }).toBe(natural);
    await expect(in_flight(page)).toHaveCount(0);
    await expect.poll(undo_label).toBe('Undo');
    await expect.poll(redo_label).toBe('Redo Sort');
    await click_edit_item('Redo Sort');
    await expect.poll(() => shown_first_row(page), { timeout: 60_000 })
        .toBe(first_row(2, 'descending'));
    await click_edit_item('Undo Sort');
    await expect.poll(() => shown_first_row(page), { timeout: 60_000 }).toBe(natural);
    await expect(in_flight(page)).toHaveCount(0);

    // A sort, and Undo from the Edit menu while it computes: it is cancelled, and
    // no step is made. Redo is left as it was, so it redoes the earlier sort of
    // the second column; had the sort installed and been undone, it would redo
    // the sort of the first column.
    await choose_sort(page, 1, 'ascending');
    await expect(in_flight(page)).toBeVisible();
    await expect.poll(undo_label).toBe('Undo Sort');
    await click_edit_item('Undo Sort');
    await expect(in_flight(page)).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(() => shown_first_row(page), { timeout: 60_000 }).toBe(natural);
    await expect.poll(undo_label).toBe('Undo');
    await expect.poll(redo_label).toBe('Redo Sort');
    await click_edit_item('Redo Sort');
    await expect.poll(() => shown_first_row(page), { timeout: 60_000 })
        .toBe(first_row(2, 'descending'));
    expect((await take_dialogs(app)).map((dialog) => dialog.message)).toEqual([]);
});

test('Hide rows during a sort keeps both as one step, and one Undo takes both back', async () => {
    test.setTimeout(240_000);
    const file = path.join(test_root, 'large.csv');
    write_table(file);
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir, { recursive: true });
    const launched = await launch_structural_viewer(user_data_dir, file);
    app = launched.app;
    const page = launched.page;
    await install_dialog_capture(app);
    await install_history_menu_capture(app);
    await wait_for_grid(page);
    const natural = '1|7919|104729';
    await expect.poll(() => shown_first_row(page), { timeout: 60_000 }).toBe(natural);
    const hidden_count = page.getByText(/^\d+ hidden rows?$/);

    // A sort, and while it is in flight, Hide row on the first row as it is
    // shown. The sort reaches the host just ahead of the hide's question, so
    // the host answers the hide while the sort computes (about 2 s) and the
    // hide composes onto it, however slow the menu is under load.
    await withhold_transform_until_hide();
    await choose_sort(page, 1, 'ascending');
    await expect(in_flight(page)).toBeVisible();
    const row_menu = await open_row_menu(page, 0);
    await expect(in_flight(page)).toBeVisible();
    expect(await shown_first_row(page)).toBe(natural);
    // Enabled during the person's own sort, as the sort items are.
    await choose(row_menu, 'Hide row');
    await expect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & {
        __sort_sent_with_hide?: boolean;
    }).__sort_sent_with_hide === true)).toBe(true);

    // One step for both: the sort, without the hidden row. Row 1 is not the
    // sort's first row (`first_row` starts from it and finds a smaller one), so
    // the first row shown is the same with it hidden; "1 hidden row" is the hide.
    await expect.poll(undo_label).toBe('Undo Change view');
    await expect.poll(() => shown_first_row(page), { timeout: 60_000 }).toBe(first_row(1, 'ascending'));
    await expect(in_flight(page)).toHaveCount(0, { timeout: 60_000 });
    await expect(hidden_count).toHaveText('1 hidden row');
    await expect.poll(undo_label).toBe('Undo Change view');

    // One Undo takes both back.
    await click_edit_item('Undo Change view');
    await expect.poll(() => shown_first_row(page), { timeout: 60_000 }).toBe(natural);
    await expect(in_flight(page)).toHaveCount(0, { timeout: 60_000 });
    await expect(hidden_count).toHaveCount(0);
    await expect.poll(undo_label).toBe('Undo');
    await expect.poll(redo_label).toBe('Redo Change view');
    expect((await take_dialogs(app)).map((dialog) => dialog.message)).toEqual([]);
});
