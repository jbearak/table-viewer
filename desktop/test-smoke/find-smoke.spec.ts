// Find in the desktop app: Cmd/Ctrl+F opens the find bar, typing selects the
// first cell containing the text, Enter and Shift+Enter step through matches
// (wrapping), a match far below the fold loads and scrolls into view, and
// Escape closes the bar. Edit > Find… opens it too.
//
// Every check polls the grid's accessibility table (`aria-selected`) or the
// bar's DOM; nothing waits a fixed delay.
//
// CI runs only the relaunch spec from this directory; run this one locally:
//   npm run desktop:prepackage
//   npx playwright test --config=desktop/test-smoke/playwright.config.ts \
//     desktop/test-smoke/find-smoke.spec.ts
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { isolated_user_data, launch_app } from './smoke-helpers';

const VIEWER_URL_PREFIX = 'tv-app://viewer';
const GRID_CANVAS = '[data-testid="data-grid-canvas"]';
const ROWS = 5_000;
const FAR_ROW = 4_321;
const NEAR_ROW = 10;

let app: ElectronApplication | undefined;
let directory: string;

test.beforeAll(() => {
    directory = isolated_user_data('tv-find-smoke-');
});

test.afterAll(async () => {
    await app?.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
});

async function viewer_page(launched: ElectronApplication): Promise<Page> {
    const pages = () => launched.windows().filter((page) => page.url().startsWith(VIEWER_URL_PREFIX));
    await expect.poll(() => pages().length, { timeout: 30_000 }).toBe(1);
    const page = pages()[0];
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
    return page;
}

/** The accessibility cell of data column `column` (0-based) at `row`. */
function cell(page: Page, column: number, row: number) {
    // Column 0 of the grid is the row-number column.
    return page.locator(`#glide-cell-${column + 1}-${row}`);
}

test('Cmd/Ctrl+F finds text in cells, including rows far below the fold', async () => {
    const file = path.join(directory, 'people.csv');
    const lines = ['id,name,note'];
    for (let row = 0; row < ROWS; row++) {
        const note = row === FAR_ROW
            ? 'the NEEDLE is here'
            : row === NEAR_ROW ? 'a needle nearby' : `note ${row}`;
        lines.push(`${row},person ${row},${note}`);
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    const user_data = isolated_user_data('tv-find-smoke-user-');
    try {
        const launched = await launch_app(user_data, [file]);
        app = launched;
        const page = await viewer_page(launched);
        await expect(cell(page, 1, 0)).toHaveText('person 0');

        const find_input = page.locator('input[aria-label="Find"]');
        await expect(find_input).toHaveCount(0);
        // Page keyboard events reach the renderer directly, as in a VS Code
        // webview, so this drives the webview's own listener.
        // Select the first body cell (past the row-number gutter and header).
        // Glide overlays a scroller on the canvas, so click by coordinates.
        const box = (await page.locator(GRID_CANVAS).first().boundingBox())!;
        await page.mouse.click(box.x + 120, box.y + 50);
        await expect(page.locator('[id^="glide-cell-"][id$="-0"][aria-selected="true"]'))
            .toHaveCount(1);
        await page.keyboard.press('ControlOrMeta+F');
        await expect(find_input).toBeFocused();

        await find_input.fill('needle');
        await expect(cell(page, 2, NEAR_ROW)).toHaveAttribute('aria-selected', 'true');

        await find_input.press('Enter');
        await expect(cell(page, 2, FAR_ROW)).toHaveAttribute('aria-selected', 'true');
        await expect(cell(page, 2, FAR_ROW)).toHaveText('the NEEDLE is here');

        // Wraps past the end, and steps back with Shift+Enter.
        await find_input.press('Enter');
        await expect(cell(page, 2, NEAR_ROW)).toHaveAttribute('aria-selected', 'true');
        await find_input.press('Shift+Enter');
        await expect(cell(page, 2, FAR_ROW)).toHaveAttribute('aria-selected', 'true');

        await find_input.fill('no such text');
        await expect(page.locator('.find-bar-status')).toHaveText('No matches');

        await find_input.press('Escape');
        await expect(find_input).toHaveCount(0);
        // The last match stays selected for the user to act on.
        await expect(cell(page, 2, FAR_ROW)).toHaveAttribute('aria-selected', 'true');

        // Edit > Find… opens the bar with the query kept, as the native menu would.
        const clicked = await launched.evaluate(({ BrowserWindow, Menu }) => {
            const window = BrowserWindow.getAllWindows().find((candidate) =>
                candidate.webContents.getURL().startsWith('tv-app://viewer'));
            const target = Menu.getApplicationMenu()
                ?.items.find((menu) => menu.label === 'Edit')
                ?.submenu?.items.find((entry) => entry.label === 'Find…');
            if (!window || !target?.click) return false;
            target.click(target, window, {});
            return target.accelerator;
        });
        expect(clicked).toBe('CmdOrCtrl+F');
        await expect(find_input).toBeFocused();
        await expect(find_input).toHaveValue('no such text');
    } finally {
        await app?.close().catch(() => {});
        app = undefined;
        fs.rmSync(user_data, { recursive: true, force: true });
    }
});
