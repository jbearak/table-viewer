import * as fs from 'fs';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { parse_xlsx } from '../../src/parse-xlsx';
import {
    isolated_user_data,
    launch_app,
    repo_dir,
} from './smoke-helpers';

const VIEWER_URL_PREFIX = 'tv-app://viewer';
const GRID_CANVAS = '[data-testid="data-grid-canvas"]';
const fixture = path.join(repo_dir, 'docs', 'examples', 'garden-cafe-sample.xlsx');
const SHEET_INDEX = 1;

interface CapturedDialog {
    readonly message?: string;
    readonly buttons?: readonly string[];
}

let app: ElectronApplication;
let test_root: string;
let user_data_dir: string;
let workbook_path: string;
let original_row_count: number;
let page: Page;
let initial_accessible_row_count: number;

function run_git(args: readonly string[]): void {
    execFileSync('git', [...args], {
        cwd: test_root,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Table Viewer Smoke',
            GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
            GIT_COMMITTER_NAME: 'Table Viewer Smoke',
            GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
        },
        stdio: 'pipe',
    });
}

async function workbook_row_count(): Promise<number> {
    const parsed = await parse_xlsx(new Uint8Array(fs.readFileSync(workbook_path)));
    return parsed.data.sheets[SHEET_INDEX]?.rowCount ?? -1;
}

async function workbook_cell(row: number, column: number): Promise<string | undefined> {
    const parsed = await parse_xlsx(new Uint8Array(fs.readFileSync(workbook_path)));
    return parsed.data.sheets[SHEET_INDEX]?.rows[row]?.[column]?.formatted;
}

async function install_dialog_capture(): Promise<void> {
    await app.evaluate(({ dialog }) => {
        const main = globalThis as typeof globalThis & {
            __tableViewerSmokeDialogs?: Array<{
                message?: string;
                buttons?: readonly string[];
            }>;
        };
        main.__tableViewerSmokeDialogs = [];
        const replacement = async (...args: unknown[]) => {
            const options = (args.length === 1 ? args[0] : args[1]) as {
                message?: string;
                buttons?: readonly string[];
            };
            main.__tableViewerSmokeDialogs?.push({
                message: options.message,
                buttons: options.buttons,
            });
            return { response: 0, checkboxChecked: false };
        };
        dialog.showMessageBox = replacement as typeof dialog.showMessageBox;
    });
}

async function take_dialogs(): Promise<CapturedDialog[]> {
    return app.evaluate(() => {
        const main = globalThis as typeof globalThis & {
            __tableViewerSmokeDialogs?: CapturedDialog[];
        };
        return main.__tableViewerSmokeDialogs?.splice(0) ?? [];
    });
}

async function compose_rows(count: number, first_value = ''): Promise<void> {
    const rows = page.locator('tbody tr');
    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Compose row…' }).click();
    const composer = page.getByRole('dialog', {
        name: 'Compose a row from the visible columns',
    });
    await expect(composer).toBeVisible();
    for (let row = 1; row < count; row += 1) {
        await composer.getByRole('button', { name: 'Add another row' }).click();
    }
    if (first_value !== '') {
        await composer.locator('#append-composer-0-0').fill(first_value);
    }
    await composer.getByRole('button', { name: `Stage ${count} rows` }).click();
    await expect(composer).toHaveCount(0);
    await expect(rows).toHaveCount(initial_accessible_row_count + count);
}

test.beforeAll(async () => {
    test_root = isolated_user_data('tv-append-row-lifecycle-');
    user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir);
    workbook_path = path.join(test_root, 'garden-cafe-sample.xlsx');
    fs.copyFileSync(fixture, workbook_path);
    original_row_count = await workbook_row_count();
    run_git(['init', '--quiet']);
    run_git(['add', '--', path.basename(workbook_path)]);
    run_git(['commit', '--quiet', '-m', 'baseline']);

    app = await launch_app(user_data_dir, [workbook_path]);
    await expect.poll(
        () => app.windows().filter((candidate) =>
            candidate.url().startsWith(VIEWER_URL_PREFIX)).length,
        { timeout: 30_000 },
    ).toBe(1);
    page = app.windows().find((candidate) =>
        candidate.url().startsWith(VIEWER_URL_PREFIX))!;
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
    const first_sheet = page.getByRole('button', { name: 'Fruit Stand', exact: true });
    await first_sheet.click();
    await expect(first_sheet).toHaveClass(/active/);
    await install_dialog_capture();
});

test.afterAll(async () => {
    const process_handle = app?.process();
    await app?.evaluate(({ app: electron_app }) => electron_app.exit(0)).catch(() => {});
    if (process_handle) {
        await expect.poll(
            () => process_handle.exitCode !== null || process_handle.signalCode !== null,
            { timeout: 30_000 },
        ).toBe(true);
    }
    await app?.close().catch(() => {});
    fs.rmSync(test_root, { recursive: true, force: true });
});

test('saved appended rows settle cleanly and an external Git reset reloads them', async () => {
    const edit_toggle = page.getByRole('button', { name: 'Edit' });
    await edit_toggle.click();
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('tbody tr')).toHaveCount(original_row_count - 1);
    initial_accessible_row_count = await page.locator('tbody tr').count();

    await compose_rows(7, 'Composer Saved');
    await expect(edit_toggle).toHaveClass(/has-unsaved/);
    const saved_row = page.locator(`#glide-cell-1-${original_row_count - 1}`);
    await expect(saved_row).toHaveAttribute('aria-selected', 'true');
    const scroller = page.locator('.dvn-scroller');
    const scroll_top_before_save = await scroller.evaluate((element) => element.scrollTop);

    await edit_toggle.click();
    await expect.poll(workbook_row_count).toBe(original_row_count + 7);
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('tbody tr')).toHaveCount(
        initial_accessible_row_count + 7,
    );
    await expect(edit_toggle).not.toHaveClass(/has-unsaved/);
    await expect(saved_row).toHaveText('Composer Saved');
    await expect(saved_row).toHaveAttribute('aria-selected', 'true');
    await expect.poll(
        () => scroller.evaluate((element) => element.scrollTop),
    ).toBe(scroll_top_before_save);
    expect(await take_dialogs()).toEqual([{
        message: 'Leave edit mode?',
        buttons: ['Save Edits', 'Discard Edits', 'Stay in Edit Mode'],
    }]);

    const other_sheet_name = await page.locator('.sheet-tab:not(.active)').first().textContent();
    if (!other_sheet_name) throw new Error('missing inactive worksheet tab');
    const other_sheet = page.getByRole('button', { name: other_sheet_name, exact: true });
    await other_sheet.click();
    await expect(other_sheet).toHaveClass(/active/);
    const fruit_sheet = page.getByRole('button', { name: 'Fruit Stand', exact: true });
    await fruit_sheet.click();
    await expect(fruit_sheet).toHaveClass(/active/);

    await edit_toggle.click();
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'true');
    await edit_toggle.click();
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await take_dialogs()).toEqual([]);
    await other_sheet.click();
    await expect(other_sheet).toHaveClass(/active/);
    await fruit_sheet.click();
    await expect(fruit_sheet).toHaveClass(/active/);

    await edit_toggle.click();
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'true');
    const first_saved_blank = page.locator(`#glide-cell-1-${original_row_count}`);
    await expect(first_saved_blank).toBeAttached();
    await expect(first_saved_blank).toHaveAttribute('aria-readonly', 'false');
    await first_saved_blank.focus();
    await expect(first_saved_blank).toBeFocused();
    await page.keyboard.press('Enter');
    const editor = page.locator('.cell-editor-input');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue('');
    await editor.fill('a');
    await editor.press('Enter');
    await expect(editor).toBeHidden();

    await edit_toggle.click();
    await expect.poll(() => workbook_cell(original_row_count + 1, 0)).toBe('a');
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(first_saved_blank).toHaveText('a');
    expect(await take_dialogs()).toEqual([{
        message: 'Leave edit mode?',
        buttons: ['Save Edits', 'Discard Edits', 'Stay in Edit Mode'],
    }]);

    run_git(['reset', '--hard', '--quiet', 'HEAD']);
    await expect.poll(workbook_row_count).toBe(original_row_count);
    await expect(first_saved_blank).toHaveCount(0);
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await take_dialogs()).toEqual([]);
});
