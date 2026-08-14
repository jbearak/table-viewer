import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { isolated_user_data, launch_app } from './smoke-helpers';

const PREVIEW_ENV = { TABLE_VIEWER_TEST_UPDATE_PREVIEW: 'downloading' };
const READY_EVENT = 'table-viewer:test-update-ready';
const GATE_MARKER = '.update-startup-gate-evaluated';

async function close(app: ElectronApplication | undefined): Promise<void> {
    if (app) await app.close();
}

test('the startup preference gates the independent update window', async () => {
    const root = isolated_user_data('tv-update-disabled-');
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
        automaticallyCheckForUpdates: false,
    }));
    let app: ElectronApplication | undefined;
    try {
        app = await launch_app(root, [], PREVIEW_ENV);
        await expect.poll(() => fs.existsSync(path.join(root, GATE_MARKER))).toBe(true);
        expect(fs.readFileSync(path.join(root, GATE_MARKER), 'utf8')).toBe('disabled');
        await expect.poll(
            () => app!.windows().some((page) => page.url().endsWith('welcome.html')),
        ).toBe(true);
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(
            (window) => window.getTitle() === 'Table Viewer Update',
        ))).toBe(false);
    } finally {
        await close(app);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('update progress and readiness use one non-modal top-level window', async () => {
    const root = isolated_user_data('tv-update-window-');
    let app: ElectronApplication | undefined;
    try {
        app = await launch_app(root, [], PREVIEW_ENV);
        const update_page = () => app!.windows().find(
            (page) => page.url().endsWith('app-update.html'),
        );
        await expect.poll(update_page).toBeTruthy();
        const page = update_page()!;
        await expect(page.locator('#heading')).toHaveText('Downloading Table Viewer 2.0.0');
        await expect(page.locator('#progressBar')).toHaveAttribute('value', '46');

        const window_state = await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows().find(
                (candidate) => candidate.webContents.getURL().endsWith('app-update.html'),
            );
            if (!window) return null;
            return {
                id: window.id,
                modal: window.isModal(),
                parent: window.getParentWindow()?.id ?? null,
                alwaysOnTop: window.isAlwaysOnTop(),
                minimizable: window.isMinimizable(),
            };
        });
        expect(window_state).toMatchObject({
            modal: false,
            parent: null,
            alwaysOnTop: false,
            minimizable: true,
        });

        await app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows().find(
                (window) => window.webContents.getURL().endsWith('app-update.html'),
            )?.minimize();
        });
        await expect.poll(() => app!.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().find(
                (window) => window.webContents.getURL().endsWith('app-update.html'),
            )?.isMinimized() ?? false)).toBe(true);

        await app.evaluate(({ ipcMain }, event) => { ipcMain.emit(event, {}); }, READY_EVENT);
        await expect(page.locator('#heading')).toHaveText('Update ready to install');
        await expect.poll(() => app!.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows().find(
                (candidate) => candidate.webContents.getURL().endsWith('app-update.html'),
            );
            return window ? { id: window.id, minimized: window.isMinimized() } : null;
        })).toEqual({ id: window_state!.id, minimized: false });

        await page.locator('#secondary').click();
        await expect.poll(update_page).toBeFalsy();
        await expect.poll(
            () => app!.windows().some((candidate) => candidate.url().endsWith('welcome.html')),
        ).toBe(true);
    } finally {
        await close(app);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
