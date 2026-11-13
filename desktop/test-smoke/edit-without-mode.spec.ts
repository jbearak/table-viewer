// Editing with no edit mode: an editable file takes an editing gesture as it
// is, the toolbar's Save button writes the result, and the editing session
// behind the gesture is acquired and released without the person seeing it.
//
// Each test launches its own app on its own copy of the fixture, and none of
// them uses the application menu, so nothing here depends on the window
// holding OS focus.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { isolated_user_data, launch_app, repo_dir } from './smoke-helpers';

const GRID_CANVAS = '[data-testid="data-grid-canvas"]';
const VIEWER_URL_PREFIX = 'tv-app://viewer';
const fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.csv');
const fixture_text = 'Name,Age,City\nAlice,30,New York\nBob,25,London\nCharlie,35,Paris\n';

let app: ElectronApplication | undefined;
let page: Page;
let csv: string;
let root: string;

test.beforeEach(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tv-edit-without-mode-')));
    csv = path.join(root, 'basic.csv');
    fs.copyFileSync(fixture, csv);
    expect(fs.readFileSync(csv, 'utf8')).toBe(fixture_text);
    app = await launch_app(isolated_user_data('tv-edit-without-mode-data-'), [csv]);
    await expect.poll(
        () => app!.windows().filter((candidate) => candidate.url().startsWith(VIEWER_URL_PREFIX)).length,
        { timeout: 30_000 },
    ).toBe(1);
    page = app.windows().find((candidate) => candidate.url().startsWith(VIEWER_URL_PREFIX))!;
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
    await page.locator('#glide-cell-1-0').waitFor({ state: 'attached' });
});

test.afterEach(async () => {
    await app?.close().catch(() => {});
    app = undefined;
    fs.rmSync(root, { recursive: true, force: true });
});

const save = () => page.getByRole('button', { name: 'Save' });
const discard = () => page.getByRole('button', { name: 'Discard' });
const diff = () => page.getByRole('button', { name: 'Diff' });
const editor = () => page.locator('.cell-editor-input');
const cell = (column: number, row: number) => page.locator(`#glide-cell-${column}-${row}`);

/** Click the cell at `column`, `row` on the canvas and wait until it is selected. */
async function select_cell(column: number, row: number): Promise<void> {
    const box = (await page.locator(GRID_CANVAS).first().boundingBox())!;
    // Default layout of the three-column fixture: a row-number gutter, then
    // 120 px columns under a 36 px header, with 24 px rows.
    await page.mouse.click(box.x + 30 + (column - 1) * 120 + 60, box.y + 36 + row * 24 + 12);
    await expect(cell(column, row)).toHaveAttribute('aria-selected', 'true');
}

/** Undo, as the Edit menu sends it to the window. */
async function undo(): Promise<void> {
    await page.evaluate(() => window.postMessage({ type: 'editCommand', command: 'undo' }, '*'));
}

async function expect_nothing_unsaved(): Promise<void> {
    await expect(save()).toHaveAttribute('aria-disabled', 'true');
    await expect(save()).not.toHaveClass(/has-unsaved/);
    await expect(discard()).toHaveCount(0);
    await expect(diff()).toHaveCount(0);
}

test('an editable file opens ready to edit, with Save waiting and no Edit button', async () => {
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect_nothing_unsaved();
    // Cells say they can be changed before anything has been.
    await expect(cell(1, 0)).toHaveAttribute('aria-readonly', 'false');
});

test('typing starts an edit and keeps every key; Save writes it', async () => {
    await select_cell(1, 0);
    // No pause between keys: the ones typed while the session is being
    // acquired belong to the edit the first one started.
    await page.keyboard.type('Hello', { delay: 0 });
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue('Hello');
    await page.keyboard.press('Enter');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 0)).toHaveText('Hello');

    await expect(save()).toHaveClass(/has-unsaved/);
    await expect(save()).not.toHaveAttribute('aria-disabled', 'true');
    await expect(discard()).toBeVisible();
    await expect(diff()).toBeVisible();
    // Nothing reaches the file until Save.
    expect(fs.readFileSync(csv, 'utf8')).toBe(fixture_text);

    await save().click();
    await expect.poll(() => fs.readFileSync(csv, 'utf8'))
        .toBe('Name,Age,City\nHello,30,New York\nBob,25,London\nCharlie,35,Paris\n');
    await expect_nothing_unsaved();
});

test('an editor opened and cancelled leaves nothing behind, and the next edit just works', async () => {
    await select_cell(2, 0);
    await page.keyboard.press('Enter');
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue('30');
    await page.keyboard.press('Escape');
    await expect(editor()).toBeHidden();
    await expect_nothing_unsaved();

    // The session that editor used is gone again. Delete acquires another.
    await select_cell(2, 1);
    await page.keyboard.press('Delete');
    await expect(cell(2, 1)).toHaveText('');
    await expect(save()).toHaveClass(/has-unsaved/);
});

test('Discard drops every unsaved change at once, and undo brings them back the first time', async () => {
    await select_cell(2, 1);
    await page.keyboard.press('Delete');
    await expect(cell(2, 1)).toHaveText('');
    await expect(discard()).toBeVisible();

    await discard().click();
    await expect(cell(2, 1)).toHaveText('25');
    await expect_nothing_unsaved();

    await undo();
    await expect(cell(2, 1)).toHaveText('');
    await expect(save()).toHaveClass(/has-unsaved/);
    expect(fs.readFileSync(csv, 'utf8')).toBe(fixture_text);
});

test('undo reaches an edit made before a cancelled editor released the session', async () => {
    await select_cell(1, 0);
    await page.keyboard.type('Zed');
    await expect(editor()).toHaveValue('Zed');
    await page.keyboard.press('Enter');
    await expect(cell(1, 0)).toHaveText('Zed');
    await undo();
    await expect(cell(1, 0)).toHaveText('Alice');
    await expect_nothing_unsaved();

    // Acquire and release a session with nothing in it, then redo at once.
    await select_cell(3, 2);
    await page.keyboard.press('Enter');
    await expect(editor()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor()).toBeHidden();
    await page.evaluate(() => window.postMessage({ type: 'editCommand', command: 'redo' }, '*'));
    await expect(cell(1, 0)).toHaveText('Zed');
    await expect(save()).toHaveClass(/has-unsaved/);
});

test('a paste is the first edit, and Cmd/Ctrl+S saves it', async () => {
    await app!.evaluate(({ clipboard }) => clipboard.writeText('P1\tP2\nP3\tP4'));
    await select_cell(1, 0);
    await page.keyboard.press('ControlOrMeta+V');
    await expect(cell(1, 0)).toHaveText('P1');
    await expect(cell(2, 1)).toHaveText('P4');
    await expect(save()).toHaveClass(/has-unsaved/);

    await page.keyboard.press('ControlOrMeta+S');
    await expect.poll(() => fs.readFileSync(csv, 'utf8'))
        .toBe('Name,Age,City\nP1,P2,New York\nP3,P4,London\nCharlie,35,Paris\n');
    await expect_nothing_unsaved();
});

test('the add-row launcher is there from the start and its first use adds a row', async () => {
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Add row', exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect(save()).toHaveClass(/has-unsaved/);

    await save().click();
    await expect.poll(() => fs.readFileSync(csv, 'utf8').split('\n').length).toBe(6);
    await expect_nothing_unsaved();
});
