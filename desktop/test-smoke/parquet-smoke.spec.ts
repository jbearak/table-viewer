// Parquet in the desktop app: a .parquet file opened from argv renders its
// cells, with Formatting on (value labels, dates, and zoned timestamps as
// text) and off (the stored values), and a column header's tooltip shows the
// column's label, type, value label set, and footer statistics.
//
// Glide's accessibility table holds each cell's raw value whatever the
// Formatting toggle says (TextCell's accessibility string is its `data`), so
// the table shows that the rows loaded and what they store, and the displayed
// text is read the way a user gets it out of the grid: Edit > Select All, then
// Edit > Copy, which copies formatted text when Formatting is on. Every check
// is a poll on that text or on the clipboard; nothing waits a fixed delay. The
// header is hovered through the page's input events, which reach the window
// whether or not it has focus, and the tooltip's text is polled.
//
// CI runs only the relaunch spec from this directory; run this one locally:
//   npm run desktop:prepackage
//   npx playwright test --config=desktop/test-smoke/playwright.config.ts \
//     desktop/test-smoke/parquet-smoke.spec.ts
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MISSING, type Missing } from '@jbearak/dta-parser';
import { writeParquetFile } from '@jbearak/dta-parser/node';
import { isolated_user_data, launch_app } from './smoke-helpers';

const VIEWER_URL_PREFIX = 'tv-app://viewer';
const GRID_CANVAS = '[data-testid="data-grid-canvas"]';

let app: ElectronApplication | undefined;
let directory: string;

test.beforeAll(() => {
    directory = isolated_user_data('tv-parquet-smoke-');
});

test.afterAll(async () => {
    await app?.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
});

/** The viewer page of an app launched with exactly one file. */
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

/**
 * Invoke Edit > `item` for the viewer window, as the native menu would. The
 * window is passed to the item's handler directly, as Electron passes the
 * focused window, so the check does not depend on which app has focus.
 */
async function edit_menu(launched: ElectronApplication, item: string): Promise<void> {
    const clicked = await launched.evaluate(({ BrowserWindow, Menu }, label) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith('tv-app://viewer'));
        const target = Menu.getApplicationMenu()
            ?.items.find((menu) => menu.label === 'Edit')
            ?.submenu?.items.find((entry) => entry.label === label);
        if (!window || !target?.click) return false;
        target.click(target, window, {});
        return true;
    }, item);
    expect(clicked, `Edit > ${item} exists`).toBe(true);
}

/** The grid's text as Edit > Select All and Edit > Copy put it on the clipboard. */
async function copied_grid(launched: ElectronApplication): Promise<string> {
    await launched.evaluate(({ clipboard }) => clipboard.writeText('untouched'));
    await edit_menu(launched, 'Select All');
    await edit_menu(launched, 'Copy');
    await expect
        .poll(() => launched.evaluate(({ clipboard }) => clipboard.readText()))
        .not.toBe('untouched');
    const text = await launched.evaluate(({ clipboard }) => clipboard.readText());
    return text.replace(/\r\n/gu, '\n').replace(/\n$/u, '');
}

test('opens a Parquet file and shows labels, .a, dates, and zoned timestamps', async () => {
    const file = path.join(directory, 'survey.parquet');
    writeParquetFile(file, {
        valueLabels: {
            yesno: new Map<number | Missing, string>([[0, 'No'], [1, 'Yes'], [MISSING['.a'], 'Refused']]),
        },
        variables: [
            {
                name: 'answer', type: 'byte', label: 'Did you answer?', valueLabels: 'yesno',
                values: [1, MISSING['.a'], 0],
            },
            { name: 'code', type: 'byte', values: [MISSING['.a'], 2, null] },
            { name: 'day', type: 'date', values: [19_783, 0, null] },
            {
                name: 'seen', type: 'timestamp', unit: 'us', timeZone: 'America/New_York',
                values: [1_709_301_600_123_456, 0, null],
            },
        ],
    });
    const user_data = isolated_user_data('tv-parquet-smoke-user-');
    try {
        const launched = await launch_app(user_data, [file]);
        app = launched;
        const page = await viewer_page(launched);

        // The stored values, which the accessibility table holds in either mode.
        const stored = [
            [0, 0, '1'], [0, 1, '.a'], [0, 2, '0'],
            [1, 0, '.a'], [1, 1, '2'], [1, 2, '.'],
            [2, 0, '19783'], [2, 1, '0'],
            [3, 0, '1709301600123456'],
        ] as const;
        for (const [column, row, text] of stored) {
            await expect(cell(page, column, row)).toHaveText(text);
        }

        // The first data column's header: the same x as a click on its first
        // cell, half a header high.
        const canvas = (await page.locator(GRID_CANVAS).first().boundingBox())!;
        await page.mouse.move(canvas.x + 120, canvas.y + 18);
        await expect.poll(() => page.locator('.cell-overflow-tooltip').textContent()).toBe([
            'Did you answer?',
            'byte; Parquet DOUBLE; snappy',
            'Value labels: yesno',
            'No nulls; between No and Yes',
        ].join('\n'));

        await expect(copied_grid(launched)).resolves.toBe([
            'Yes\t.a\t2024-03-01\t2024-03-01T09:00:00.123456-05:00[America/New_York]',
            'Refused\t2\t1970-01-01\t1969-12-31T19:00:00.000000-05:00[America/New_York]',
            'No\t.\t.\t.',
        ].join('\n'));

        const formatting = page.getByRole('button', { name: 'Formatting', exact: true });
        await formatting.click();
        await expect(copied_grid(launched)).resolves.toBe([
            '1\t.a\t19783\t1709301600123456',
            '.a\t2\t0\t0',
            '0\t.\t.\t.',
        ].join('\n'));
        for (const [column, row, text] of stored) {
            await expect(cell(page, column, row)).toHaveText(text);
        }
    } finally {
        await app?.close().catch(() => {});
        app = undefined;
        fs.rmSync(user_data, { recursive: true, force: true });
    }
});
