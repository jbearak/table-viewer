// Shared helpers for the Electron smoke specs.
import * as path from 'path';
import { expect } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

export const repo_dir = path.resolve(__dirname, '..', '..');
export const main_js = path.join(repo_dir, 'dist', 'desktop', 'main.js');

/**
 * Invoke an application-menu item by label, the way the native menu would.
 *
 * Electron calls a menu item's `click` with `(menuItem, focusedWindow, event)`,
 * and the handlers route on that window (see `route_edit_command` in main.ts), so
 * the focused window is passed here too. Calling `click()` bare would leave it
 * undefined and exercise only the handlers' no-window fallback.
 */
export async function click_menu_item(
    app: ElectronApplication,
    menu_label: string,
    item_label: string,
): Promise<void> {
    const clicked = await app.evaluate(
        ({ BrowserWindow, Menu }, labels) => {
            const menu = Menu.getApplicationMenu()
                ?.items.find((item) => item.label === labels.menu);
            const target = menu?.submenu?.items.find(
                (item) => item.label === labels.item,
            );
            if (!target?.click) return false;
            target.click(target, BrowserWindow.getFocusedWindow() ?? undefined, {});
            return true;
        },
        { menu: menu_label, item: item_label },
    );
    expect(clicked, `${menu_label} > ${item_label} exists`).toBe(true);
}
