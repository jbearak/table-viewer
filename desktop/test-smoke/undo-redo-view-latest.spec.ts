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
import { click_menu_item, isolated_user_data } from './smoke-helpers';
import {
    exit_app,
    install_dialog_capture,
    install_history_menu_capture,
    launch_structural_viewer,
    open_column_menu,
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
 * Click an Edit menu item once the native menu has it. The capture above sees
 * the window's post before main.ts rebuilds the menu from it, so the label
 * there can be ahead of the menu's. main.ts rebuilds it only for the focused
 * window, and routes the click to it, so the viewer is focused first, as
 * desktop-smoke.spec.ts's `focus_viewer` does.
 */
async function click_edit_item(label: string): Promise<void> {
    const viewer = await app!.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()
            .find((candidate) => candidate.webContents.getURL().startsWith('tv-app://viewer'));
        window?.show();
        window?.focus();
        return window?.id ?? null;
    });
    expect(viewer, 'a viewer window').not.toBeNull();
    await expect.poll(
        () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null),
        { message: 'the viewer is focused; is another app in front?', timeout: 15_000 },
    ).toBe(viewer);
    await expect.poll(() => app!.evaluate(({ Menu }, wanted) => Menu.getApplicationMenu()
        ?.items.find((item) => item.label === 'Edit')
        ?.submenu?.items.some((item) => item.label === wanted) ?? false, label)).toBe(true);
    await click_menu_item(app!, 'Edit', label);
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
