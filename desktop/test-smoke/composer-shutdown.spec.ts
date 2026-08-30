import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
    isolated_user_data,
    launch_app,
    reader_tokens,
} from './smoke-helpers';

const VIEWER_URL_PREFIX = 'tv-app://viewer';
const GRID_CANVAS = '[data-testid="data-grid-canvas"]';

interface LifecycleApp {
    readonly app: ElectronApplication;
    readonly root: string;
    readonly userData: string;
    readonly csvPath: string;
    readonly page: Page;
}

interface ShutdownState {
    readonly viewerCount: number;
    readonly dialogs: readonly {
        readonly message?: string;
        readonly detail?: string;
        readonly buttons?: readonly string[];
    }[];
}

type CloseTerminal =
    | { readonly type: 'closed'; readonly state: ShutdownState }
    | { readonly type: 'exited' }
    | { readonly type: 'refused'; readonly state: ShutdownState };

interface PendingChangeScenario {
    readonly id: string;
    readonly name: string;
    readonly appendedRows: number;
    readonly savedMarkers: readonly string[];
    readonly stage: (page: Page) => Promise<void>;
}

async function launch_lifecycle_app(prefix: string): Promise<LifecycleApp> {
    const root = isolated_user_data(prefix);
    const user_data = path.join(root, 'user-data');
    fs.mkdirSync(user_data);
    const csv_path = path.join(root, 'inventory.csv');
    fs.writeFileSync(csv_path, 'Item,Quantity\nApples,4\n');
    let app: ElectronApplication | undefined;
    try {
        app = await launch_app(user_data, [csv_path]);
        await app.evaluate(({ dialog }) => {
            const main = globalThis as typeof globalThis & {
                __tableViewerShutdownDialogs?: Array<{
                    message?: string;
                    detail?: string;
                    buttons?: readonly string[];
                }>;
            };
            main.__tableViewerShutdownDialogs = [];
            dialog.showMessageBox = (async (...args: unknown[]) => {
                const options = (args.length === 1 ? args[0] : args[1]) as {
                    message?: string;
                    detail?: string;
                    buttons?: readonly string[];
                };
                main.__tableViewerShutdownDialogs?.push({
                    message: options.message,
                    detail: options.detail,
                    buttons: options.buttons,
                });
                return { response: 0, checkboxChecked: false };
            }) as typeof dialog.showMessageBox;
        });
        await expect.poll(
            () => app!.windows().filter((candidate) =>
                candidate.url().startsWith(VIEWER_URL_PREFIX)).length,
            { timeout: 30_000 },
        ).toBe(1);
        const page = app.windows().find((candidate) =>
            candidate.url().startsWith(VIEWER_URL_PREFIX));
        if (!page) throw new Error('missing viewer window');
        await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
        return { app, root, userData: user_data, csvPath: csv_path, page };
    } catch (error) {
        await force_exit(app).catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
        throw error;
    }
}

function shutdown_state(app: ElectronApplication): Promise<ShutdownState> {
    return app.evaluate(({ BrowserWindow }) => {
        const main = globalThis as typeof globalThis & {
            __tableViewerShutdownDialogs?: ShutdownState['dialogs'];
        };
        return {
            viewerCount: BrowserWindow.getAllWindows().filter((window) =>
                window.webContents.getURL().startsWith('tv-app://viewer')).length,
            dialogs: main.__tableViewerShutdownDialogs ?? [],
        };
    });
}

async function edit_grid_cell(
    page: Page,
    column: number,
    row: number,
    value: string,
    commit_key: 'Tab' | 'Shift+Tab' = 'Tab',
): Promise<void> {
    const cell = page.locator(`#glide-cell-${column}-${row}`);
    await expect(cell).toBeAttached();
    await cell.focus();
    await expect(cell).toBeFocused();
    await page.keyboard.press('Enter');
    const editor = page.locator('.cell-editor-input');
    await expect(editor).toBeVisible();
    await editor.fill(value);
    // Enter and forward Tab from the final displayed cell intentionally grow
    // the worksheet. Callers use Shift+Tab there to commit within the row.
    await editor.press(commit_key);
    await expect(editor).toBeHidden();
}

async function quick_add_row(page: Page, values: readonly string[]): Promise<void> {
    const rows = page.locator('tbody tr');
    const initial_row_count = await rows.count();
    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Add row', exact: true }).click();
    await expect(rows).toHaveCount(initial_row_count + 1);
    for (const [column, value] of values.entries()) {
        if (value === '') continue;
        await edit_grid_cell(
            page,
            column + 1,
            initial_row_count,
            value,
            column === 0 ? 'Tab' : 'Shift+Tab',
        );
    }
}

async function compose_rows(page: Page, values: readonly (readonly string[])[]): Promise<void> {
    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Compose row…' }).click();
    const composer = page.getByRole('dialog', {
        name: 'Compose a row from the visible columns',
    });
    await expect(composer).toBeVisible();
    for (let row = 1; row < values.length; row += 1) {
        await composer.getByRole('button', { name: 'Add another row' }).click();
    }
    for (const [row, row_values] of values.entries()) {
        for (const [column, value] of row_values.entries()) {
            if (value === '') continue;
            await composer.locator(`#append-composer-${row}-${column}`).fill(value);
        }
    }
    const stage_label = values.length === 1 ? 'Stage row' : `Stage ${values.length} rows`;
    await composer.getByRole('button', { name: stage_label }).click();
    await expect(composer).toHaveCount(0);
}

const pending_change_scenarios: readonly PendingChangeScenario[] = [
    {
        id: 'cell',
        name: 'a changed cell',
        appendedRows: 0,
        savedMarkers: ['Edited Apples'],
        stage: (page) => edit_grid_cell(page, 1, 0, 'Edited Apples'),
    },
    {
        id: 'quick-empty',
        name: 'one empty quick-add row',
        appendedRows: 1,
        savedMarkers: [],
        stage: (page) => quick_add_row(page, []),
    },
    {
        id: 'quick-filled',
        name: 'one filled quick-add row',
        appendedRows: 1,
        savedMarkers: ['Quick Pears', '9'],
        stage: (page) => quick_add_row(page, ['Quick Pears', '9']),
    },
    {
        id: 'composer-empty',
        name: 'one empty composer row',
        appendedRows: 1,
        savedMarkers: [],
        stage: (page) => compose_rows(page, [['', '']]),
    },
    {
        id: 'composer-filled',
        name: 'one filled composer row',
        appendedRows: 1,
        savedMarkers: ['Composer Pears', '8'],
        stage: (page) => compose_rows(page, [['Composer Pears', '8']]),
    },
    {
        id: 'composer-many-empty',
        name: 'multiple empty composer rows',
        appendedRows: 2,
        savedMarkers: [],
        stage: (page) => compose_rows(page, [['', ''], ['', '']]),
    },
    {
        id: 'composer-many-filled',
        name: 'multiple filled composer rows',
        appendedRows: 2,
        savedMarkers: ['Composer A', '1', 'Composer B', '2'],
        stage: (page) => compose_rows(page, [
            ['Composer A', '1'],
            ['Composer B', '2'],
        ]),
    },
    {
        id: 'composer-many-mixed',
        name: 'mixed empty and filled composer rows',
        appendedRows: 2,
        savedMarkers: ['Composer Mixed', '3'],
        stage: (page) => compose_rows(page, [
            ['', ''],
            ['Composer Mixed', '3'],
        ]),
    },
];

async function stage_pending_change(
    page: Page,
    scenario: PendingChangeScenario,
): Promise<void> {
    const rows = page.locator('tbody tr');
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    const initial_row_count = await rows.count();
    const edit_toggle = page.getByRole('button', { name: 'Edit' });
    await edit_toggle.click();
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'true');
    await scenario.stage(page);
    await expect(rows).toHaveCount(initial_row_count + scenario.appendedRows);
    await expect(edit_toggle).toHaveClass(/has-unsaved/);
}

function csv_data_row_count(csv_path: string): number {
    return fs.readFileSync(csv_path, 'utf8').trimEnd().split(/\r?\n/u).length - 1;
}

async function force_exit(app: ElectronApplication | undefined): Promise<void> {
    if (!app) return;
    let process_handle: ReturnType<ElectronApplication['process']>;
    try {
        process_handle = app.process();
    } catch {
        return;
    }
    await app.evaluate(({ app: electron_app }) => electron_app.exit(0)).catch(() => {});
    if (process_handle && process_handle.exitCode === null && process_handle.signalCode === null) {
        await expect.poll(
            () => process_handle.exitCode !== null || process_handle.signalCode !== null,
            { timeout: 30_000 },
        ).toBe(true);
    }
    await app.close().catch(() => {});
}

async function with_lifecycle_app(
    prefix: string,
    run: (launched: LifecycleApp) => Promise<void>,
): Promise<void> {
    let launched: LifecycleApp | undefined;
    try {
        launched = await launch_lifecycle_app(prefix);
        await run(launched);
    } finally {
        await force_exit(launched?.app);
        if (launched) fs.rmSync(launched.root, { recursive: true, force: true });
    }
}

async function close_viewer(launched: LifecycleApp): Promise<void> {
    const process_handle = launched.app.process();
    await launched.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL().startsWith('tv-app://viewer'))
            ?.close();
    });
    let terminal: CloseTerminal | undefined;
    await expect.poll(
        async () => {
            if (process_handle.exitCode !== null || process_handle.signalCode !== null) {
                terminal = { type: 'exited' };
                return true;
            }
            try {
                const state = await shutdown_state(launched.app);
                if (state.dialogs.length > 0) {
                    terminal = { type: 'refused', state };
                    return true;
                }
                if (process.platform === 'darwin' && state.viewerCount === 0) {
                    terminal = { type: 'closed', state };
                    return true;
                }
            } catch {
                // A last-window close can tear down the Playwright connection
                // before the child-process exit fields update. Poll both again.
            }
            return false;
        },
        { timeout: 30_000 },
    ).toBe(true);
    if (!terminal) throw new Error('missing close terminal');
    if (terminal.type === 'refused') {
        throw new Error(`viewer close was refused: ${JSON.stringify(terminal.state.dialogs)}`);
    }
    expect(terminal.type).toBe(process.platform === 'darwin' ? 'closed' : 'exited');
    if (terminal.type === 'exited') {
        expect(process_handle.exitCode).toBe(0);
        await expect.poll(() => reader_tokens(launched.userData).length).toBe(0);
    } else {
        expect(terminal.state).toEqual({ viewerCount: 0, dialogs: [] });
    }
}

async function leave_edit_mode(
    launched: LifecycleApp,
    scenario: PendingChangeScenario,
): Promise<void> {
    const edit_toggle = launched.page.getByRole('button', { name: 'Edit' });
    await edit_toggle.click();
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => csv_data_row_count(launched.csvPath))
        .toBe(1 + scenario.appendedRows);
    const saved = fs.readFileSync(launched.csvPath, 'utf8');
    for (const marker of scenario.savedMarkers) expect(saved).toContain(marker);
    await expect(edit_toggle).not.toHaveClass(/has-unsaved/);
    const state = await shutdown_state(launched.app);
    expect(state.viewerCount).toBe(1);
    expect(state.dialogs.some((dialog) => dialog.buttons?.join('|')
        === 'Save Edits|Discard Edits|Stay in Edit Mode')).toBe(true);
}

for (const scenario of pending_change_scenarios) {
    test(`leaves edit mode after ${scenario.name}`, async () => {
        await with_lifecycle_app(`tv-edit-exit-${scenario.id}-`, async (launched) => {
            await stage_pending_change(launched.page, scenario);
            await leave_edit_mode(launched, scenario);
        });
    });

    test(`closes the viewer after ${scenario.name}`, async () => {
        await with_lifecycle_app(`tv-window-close-${scenario.id}-`, async (launched) => {
            await stage_pending_change(launched.page, scenario);
            await close_viewer(launched);
        });
    });
}

test('the app quits after staging a filled composer row', async () => {
    const scenario = pending_change_scenarios.find(({ id }) => id === 'composer-filled');
    if (!scenario) throw new Error('missing filled composer scenario');
    await with_lifecycle_app('tv-composer-quit-', async (launched) => {
        await stage_pending_change(launched.page, scenario);
        const process_handle = launched.app.process();
        await launched.app.evaluate(({ app: electron_app }) => electron_app.quit()).catch(() => {
            // The quit can close the harness connection first. The process and
            // reader-token polls below are the shutdown signals.
        });
        await expect.poll(
            () => process_handle.exitCode !== null || process_handle.signalCode !== null,
            { timeout: 30_000 },
        ).toBe(true);
        await expect.poll(() => reader_tokens(launched.userData).length).toBe(0);
    });
});
