// After a Save the table is read back from the file, which takes seconds on a
// large workbook. Until those rows arrive, the grid keeps showing what was
// saved, not the value the cell had before the edit.
//
// No menu is used and nothing depends on the window holding OS focus.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { isolated_user_data, launch_app, repo_dir } from './smoke-helpers';
import { build_fixture_xlsx } from '../../src/test/helpers/xlsx-structure-fixture';

const GRID_CANVAS = '[data-testid="data-grid-canvas"]';
const VIEWER_URL_PREFIX = 'tv-app://viewer';
// Enough rows that reading the file back takes many frames.
const ROWS = 100_000;

let app: ElectronApplication | undefined;
let page: Page;
let root: string;

test.beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tv-save-shows-saved-')));
});

test.afterEach(async () => {
    await app?.close().catch(() => {});
    app = undefined;
    fs.rmSync(root, { recursive: true, force: true });
});

const cell = (column: number, row: number) => page.locator(`#glide-cell-${column}-${row}`);

test('a saved cell keeps its saved value while the workbook is read back', async () => {
    test.setTimeout(180_000);
    const file = path.join(root, 'large.xlsx');
    const rows: string[] = [];
    for (let r = 1; r <= ROWS; r++) {
        rows.push(`<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>n${r}</t></is></c>`
            + `<c r="B${r}"><v>${r}</v></c><c r="C${r}" t="inlineStr"><is><t>c${r}</t></is></c></row>`);
    }
    fs.writeFileSync(file, build_fixture_xlsx({
        sheets: [{ name: 'Sheet1', body: `<sheetData>${rows.join('')}</sheetData>` }],
    }));
    await save_and_watch(file, 'n1');
});

// A real 7 MB workbook: its own timing exposed an ordering the generated one
// does not (the grid committing once more with the session just released).
test('a saved cell keeps its saved value while a real workbook is read back', async () => {
    test.setTimeout(180_000);
    const file = path.join(root, 'survey.xlsx');
    fs.copyFileSync(
        path.join(repo_dir, 'src', 'test', 'fixtures', 'undesa_pd_2024_wcu_country_data_survey-based.xlsx'),
        file,
    );
    await save_and_watch(file, '');
});

/** Open `file`, edit A1 (which reads `before`), Save, and check every frame until the read-back. */
async function save_and_watch(file: string, before: string): Promise<void> {
    app = await launch_app(isolated_user_data('tv-save-shows-saved-data-'), [file]);
    await expect.poll(
        () => app!.windows().filter((candidate) => candidate.url().startsWith(VIEWER_URL_PREFIX)).length,
        { timeout: 60_000 },
    ).toBe(1);
    page = app.windows().find((candidate) => candidate.url().startsWith(VIEWER_URL_PREFIX))!;
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible', timeout: 120_000 });
    await expect(cell(1, 0)).toHaveText(before, { timeout: 60_000 });
    await expect(cell(1, 0)).toHaveAttribute('aria-readonly', 'false', { timeout: 60_000 });

    // Edit A1.
    const box = (await page.locator(GRID_CANVAS).first().boundingBox())!;
    await page.mouse.click(box.x + 30 + 60, box.y + 36 + 12);
    await expect(cell(1, 0)).toHaveAttribute('aria-selected', 'true');
    const saved = 'saved value';
    await page.keyboard.type(saved, { delay: 3 });
    await expect(page.locator('.cell-editor-input')).toHaveValue(saved);
    await page.keyboard.press('Enter');
    await expect(cell(1, 0)).toHaveText(saved);

    // Record, every frame, what A1 reads as, and when the Save's result and
    // the next rows arrive.
    await page.evaluate(() => {
        const w = window as unknown as {
            __saved_frames: { t: number; text: string }[];
            __saved_events: { t: number; type: string; generation?: number }[];
        };
        w.__saved_frames = [];
        w.__saved_events = [];
        window.addEventListener('message', (event) => {
            const data = event.data as {
                type?: string;
                generation?: number;
                snapshot?: { generation?: number };
            } | null;
            const type = data?.type;
            if (type === 'saveResult' || type === 'rowData' || type === 'workbookSnapshot') {
                w.__saved_events.push({
                    t: performance.now(),
                    type,
                    generation: type === 'workbookSnapshot' ? data?.snapshot?.generation : data?.generation,
                });
            }
        });
        const tick = () => {
            w.__saved_frames.push({
                t: performance.now(),
                text: document.querySelector('#glide-cell-1-0')?.textContent ?? '',
            });
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    const written = fs.statSync(file).mtimeMs;
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => fs.statSync(file).mtimeMs > written, { timeout: 60_000 }).toBe(true);

    // Wait for the rows read back from the file: the snapshot that adopts it
    // (a new generation), then its rows.
    type SavedEvent = { t: number; type: string; generation?: number };
    const events = () => page.evaluate(() =>
        (window as unknown as { __saved_events: SavedEvent[] }).__saved_events);
    const read_back = (seen: SavedEvent[]) => {
        const success = seen.find((event) => event.type === 'saveResult');
        if (success === undefined) return undefined;
        // The generation the grid showed when the Save succeeded.
        const before = seen.filter((event) => event.type === 'workbookSnapshot' && event.t < success.t).at(-1);
        if (before?.generation === undefined) return undefined;
        const adopted = seen.find((event) => event.type === 'workbookSnapshot'
            && event.t > success.t
            && event.generation !== undefined
            && event.generation !== before.generation);
        const rows = adopted && seen.find((event) => event.type === 'rowData'
            && event.t > adopted.t
            && event.generation === adopted.generation);
        return rows ? { success, adopted: adopted!, rows } : undefined;
    };
    await expect.poll(async () => read_back(await events()) !== undefined, { timeout: 120_000 }).toBe(true);
    await expect(cell(1, 0)).toHaveText(saved);

    const { success, adopted } = read_back(await events())!;
    const frames = await page.evaluate(() =>
        (window as unknown as { __saved_frames: { t: number; text: string }[] }).__saved_frames);
    const gap = frames.filter((frame) => frame.t > success.t && frame.t < adopted.t);
    // The read-back took frames, and every one of them showed the saved value.
    expect(gap.length).toBeGreaterThan(0);
    expect([...new Set(gap.map((frame) => frame.text))]).toEqual([saved]);
}
