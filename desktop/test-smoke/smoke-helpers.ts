// Shared helpers for the Electron smoke specs.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

export const repo_dir = path.resolve(__dirname, '..', '..');
export const main_js = path.join(repo_dir, 'dist', 'desktop', 'main.js');

/**
 * A private userData directory for one app launch.
 *
 * `realpathSync.native` because the state backend canonicalizes every path it
 * touches, and on macOS `os.tmpdir()` is a symlink — without this the directory
 * the test inspects and the one the app writes to are spelled differently.
 */
export function isolated_user_data(prefix: string): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Launch the built desktop bundle against `user_data_dir`, opening `files`. */
export function launch_app(
    user_data_dir: string,
    files: readonly string[] = [],
): Promise<ElectronApplication> {
    expect(fs.existsSync(main_js), 'run npm run bundle:desktop first').toBe(true);
    return electron.launch({
        args: [main_js, ...files],
        cwd: repo_dir,
        env: { ...process.env, TABLE_VIEWER_USER_DATA_DIR: user_data_dir },
    });
}

/** The desktop's SQLite file-state database inside `user_data_dir`. */
export function state_database_path(user_data_dir: string): string {
    return path.join(user_data_dir, 'state', 'file-state.sqlite3');
}

/**
 * The recovery gate's directory layout, mirroring `gate_paths` in
 * src/sqlite-open-recovery.ts. Duplicated rather than imported: these specs
 * inspect the app's on-disk residue from outside the app, and a helper that
 * imported the implementation would agree with it by construction even after it
 * had drifted from what the app actually writes.
 */
function gate_directory(user_data_dir: string): string {
    const database = state_database_path(user_data_dir);
    return path.join(path.dirname(database), `.${path.basename(database)}.recovery-gate`);
}

/** Shared-reader tokens currently held against the state database. One per live
 *  connection; only `close()` removes one, so a killed process leaves its own. */
export function reader_tokens(user_data_dir: string): string[] {
    const readers = path.join(gate_directory(user_data_dir), 'readers');
    return fs.existsSync(readers)
        ? fs.readdirSync(readers).filter((name) => name.endsWith('.reader'))
        : [];
}

/** Whether a recovery is claimed or blockaded — either would make the next
 *  launch refuse to open rather than opening the database. */
export function recovery_residue(user_data_dir: string): {
    exclusiveIntent: boolean;
    recoveryBlocked: boolean;
} {
    const gate = gate_directory(user_data_dir);
    return {
        exclusiveIntent: fs.existsSync(path.join(gate, 'exclusive-intent')),
        recoveryBlocked: fs.existsSync(path.join(gate, 'recovery-block.json')),
    };
}

/** Whether a rollback journal is sitting beside the database. Under
 *  `journal_mode = DELETE` one exists only inside a write transaction, so its
 *  presence after a launch settles means an interrupted write is unrecovered. */
export function hot_journal_present(user_data_dir: string): boolean {
    return fs.existsSync(`${state_database_path(user_data_dir)}-journal`);
}

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

/**
 * Open the Preferences window from the menu and return its page.
 *
 * Scans every top-level menu rather than naming one: Preferences… lives on the
 * app menu on macOS and under File elsewhere.
 */
export async function open_preferences(app: ElectronApplication): Promise<Page> {
    const opened = await app.evaluate(({ BrowserWindow, Menu }) => {
        for (const menu of Menu.getApplicationMenu()?.items ?? []) {
            const item = menu.submenu?.items.find((entry) => entry.label === 'Preferences…');
            if (!item?.click) continue;
            item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {});
            return true;
        }
        return false;
    });
    expect(opened, 'a Preferences… menu item exists').toBe(true);
    const prefs_page = () => app.windows().find((page) => page.url().endsWith('prefs.html'));
    await expect.poll(prefs_page, { timeout: 15_000 }).toBeTruthy();
    const page = prefs_page()!;

    // The page appearing is not the window being ready: prefs.js attaches the
    // field listeners and then fills the fields from the stored settings, both
    // after the markup is parseable. Typing in between goes nowhere — the
    // keystrokes land in an input nothing is listening to — so every test here
    // waits for a field to be showing a stored value first. The number inputs are
    // empty in the markup, which is what makes one of them the signal.
    await expect
        .poll(() => page.locator('#csvMaxRows').inputValue(), { timeout: 15_000 })
        .not.toBe('');
    return page;
}

/**
 * Close the Preferences window, if it is open, and wait for it to be gone.
 *
 * Waiting matters: Preferences is a singleton, so a later `open_preferences`
 * racing a close still in flight focuses the dying window instead of creating a
 * new one, and then finds no page.
 */
export async function close_preferences(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
            .find((window) => window.getTitle().includes('Preferences'))
            ?.close();
    });
    await expect
        .poll(() => app.windows().some((page) => page.url().endsWith('prefs.html')),
            { timeout: 15_000 })
        .toBe(false);
}
