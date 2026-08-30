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

interface ComposerApp {
    readonly app: ElectronApplication;
    readonly root: string;
    readonly userData: string;
    readonly page: Page;
}

interface ShutdownState {
    readonly viewerCount: number;
    readonly dialogs: readonly {
        readonly message?: string;
        readonly detail?: string;
    }[];
}

type CloseTerminal =
    | { readonly type: 'closed'; readonly state: ShutdownState }
    | { readonly type: 'exited' }
    | { readonly type: 'refused'; readonly state: ShutdownState };

async function launch_composer_app(prefix: string): Promise<ComposerApp> {
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
                }>;
            };
            main.__tableViewerShutdownDialogs = [];
            dialog.showMessageBox = (async (...args: unknown[]) => {
                const options = (args.length === 1 ? args[0] : args[1]) as {
                    message?: string;
                    detail?: string;
                };
                main.__tableViewerShutdownDialogs?.push({
                    message: options.message,
                    detail: options.detail,
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
        return { app, root, userData: user_data, page };
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

async function stage_composed_row(page: Page): Promise<void> {
    const rows = page.locator('tbody tr');
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    const initial_row_count = await rows.count();
    const edit_toggle = page.getByRole('button', { name: 'Edit' });
    await edit_toggle.click();
    await expect(edit_toggle).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Compose row…' }).click();
    const composer = page.getByRole('dialog', {
        name: 'Compose a row from the visible columns',
    });
    await expect(composer).toBeVisible();
    await composer.locator('#append-composer-0-0').fill('Pears');
    await composer.getByRole('button', { name: 'Stage row' }).click();

    await expect(composer).toHaveCount(0);
    await expect(rows).toHaveCount(initial_row_count + 1);
    await expect(edit_toggle).toHaveClass(/has-unsaved/);
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

test('a viewer closes after staging a row with the composer', async () => {
    let launched: ComposerApp | undefined;
    try {
        launched = await launch_composer_app('tv-composer-close-');
        await stage_composed_row(launched.page);
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
                    const state = await shutdown_state(launched!.app);
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
            await expect.poll(() => reader_tokens(launched!.userData).length).toBe(0);
        } else {
            expect(terminal.state).toEqual({ viewerCount: 0, dialogs: [] });
        }
    } finally {
        await force_exit(launched?.app);
        if (launched) fs.rmSync(launched.root, { recursive: true, force: true });
    }
});

test('the app quits after staging a row with the composer', async () => {
    let launched: ComposerApp | undefined;
    try {
        launched = await launch_composer_app('tv-composer-quit-');
        await stage_composed_row(launched.page);
        const process_handle = launched.app.process();

        await launched.app.evaluate(({ app: electron_app }) => electron_app.quit()).catch(() => {
            // The quit can close the harness connection first. The process and
            // reader-token polls below are the shutdown signals.
        });
        await expect.poll(
            () => process_handle.exitCode !== null || process_handle.signalCode !== null,
            { timeout: 30_000 },
        ).toBe(true);
        await expect.poll(
            () => reader_tokens(launched!.userData).length,
            { timeout: 30_000 },
        ).toBe(0);
    } finally {
        await force_exit(launched?.app);
        if (launched) fs.rmSync(launched.root, { recursive: true, force: true });
    }
});
