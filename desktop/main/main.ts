// Electron main process for the standalone Table Viewer desktop app.
// Reuses the shared viewer controller, state store, and webview bundle from
// the VS Code extension; only the shell (windows, menus, dialogs, protocol)
// is desktop-specific.
import * as fs from 'fs';
import * as path from 'path';
import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    nativeTheme,
    protocol,
    shell,
} from 'electron';
import {
    create_json_file_state_store,
    json_state_file_path,
} from '../../src/json-file-state-store';
import { DesktopConfigStore, settings_file_path } from './desktop-config';
import { TabManager } from './tabs';
import { theme_payload } from './theme';
import { clamp_zoom_level } from './zoom';
import {
    APP_SCHEME,
    VIEWER_HOST,
    WEBVIEW_HOST,
    build_desktop_viewer_html,
} from './viewer-html';
import {
    CHANNEL_GET_THEME,
    CHANNEL_PREFS_GET,
    CHANNEL_PREFS_SET,
    CHANNEL_SETTINGS_CHANGED,
    CHANNEL_SHELL_ACTIVATE_TAB,
    CHANNEL_SHELL_CLOSE_TAB,
    CHANNEL_SHELL_GET_TABS,
    CHANNEL_SHELL_OPEN_FILES,
    CHANNEL_SHELL_OPEN_PREFERENCES,
    CHANNEL_THEME_CHANGED,
} from '../shared/ipc';

const SUPPORTED_EXTENSIONS = ['csv', 'tsv', 'xlsx', 'xls'];

function is_supported_file(file_path: string): boolean {
    const ext = path.extname(file_path).toLowerCase().replace(/^\./, '');
    return SUPPORTED_EXTENSIONS.includes(ext);
}

/** File arguments from a command line (drop flags and the electron/app paths).
 *  Relative paths resolve against `base_dir` (the invoking process's cwd). */
function file_args(argv: string[], base_dir: string = process.cwd()): string[] {
    return argv
        .filter((arg) => !arg.startsWith('-') && is_supported_file(arg))
        .map((arg) => path.resolve(base_dir, arg));
}

// dist/desktop/main.js → repo (or app) root two levels up.
const DIST_DIR = path.join(__dirname, '..');
const WEBVIEW_DIST_DIR = path.join(DIST_DIR, 'webview');
const DESKTOP_DIST_DIR = path.join(DIST_DIR, 'desktop');
const VIEWER_PRELOAD = path.join(DESKTOP_DIST_DIR, 'viewer-preload.js');
const SHELL_PRELOAD = path.join(DESKTOP_DIST_DIR, 'shell-preload.js');
const PREFS_PRELOAD = path.join(DESKTOP_DIST_DIR, 'prefs-preload.js');

let config_store: DesktopConfigStore;
let tab_manager: TabManager | undefined;
let main_window: BrowserWindow | undefined;
let prefs_window: BrowserWindow | undefined;
/** Files requested before the app/window was ready. */
const pending_open_paths: string[] = [];
/** One zoom level for the whole app: the tab bar and every tab view scale
 *  together instead of whichever webContents happens to be focused. */
let zoom_level = 0;

// The viewer page and the shared webview bundle are served from a privileged
// custom scheme so the CSP model matches VS Code's webview loader (no file://).
protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
]);

function register_app_protocol(): void {
    const webview_assets = new Map<string, { file: string; mime: string }>([
        ['index.js', { file: path.join(WEBVIEW_DIST_DIR, 'index.js'), mime: 'text/javascript' }],
        ['index.css', { file: path.join(WEBVIEW_DIST_DIR, 'index.css'), mime: 'text/css' }],
    ]);
    protocol.handle(APP_SCHEME, async (request) => {
        const url = new URL(request.url);
        if (url.host === VIEWER_HOST) {
            const config = config_store.config_port();
            const html = build_desktop_viewer_html(
                config.font_family(),
                config.font_size(),
            );
            return new Response(html, {
                headers: { 'content-type': 'text/html; charset=utf-8' },
            });
        }
        if (url.host === WEBVIEW_HOST) {
            // Fixed allow-list: never serve arbitrary paths from disk.
            const name = path.posix.basename(url.pathname);
            const asset = webview_assets.get(name);
            if (asset) {
                try {
                    const body = await fs.promises.readFile(asset.file);
                    return new Response(new Uint8Array(body), {
                        headers: { 'content-type': asset.mime },
                    });
                } catch {
                    return new Response('missing webview bundle — run npm run bundle:webview', { status: 404 });
                }
            }
        }
        return new Response('not found', { status: 404 });
    });
}

function open_files(paths: string[]): void {
    const files = paths.filter(is_supported_file);
    if (files.length === 0) return;
    if (!tab_manager) {
        pending_open_paths.push(...files);
        if (app.isReady()) ensure_main_window();
        return;
    }
    for (const file of files) tab_manager.open_file(file);
    if (main_window) {
        if (main_window.isMinimized()) main_window.restore();
        main_window.show();
    }
}

/** Push the shared zoom level to the tab bar and every open tab view. */
function apply_zoom_level(next: number): void {
    zoom_level = clamp_zoom_level(next);
    if (main_window && !main_window.isDestroyed()) {
        main_window.webContents.setZoomLevel(zoom_level);
    }
    // TabManager also rescales the tab-bar strip, whose height is expressed in
    // the (now zoomed) renderer's CSS pixels.
    tab_manager?.set_zoom_level(zoom_level);
}

function ensure_main_window(): BrowserWindow {
    if (main_window && !main_window.isDestroyed()) return main_window;
    const window = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 480,
        minHeight: 320,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
        webPreferences: {
            preload: SHELL_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    main_window = window;
    const state_store = create_json_file_state_store(
        json_state_file_path(app.getPath('userData')),
        () => config_store.settings().maxStoredFiles,
    );
    tab_manager = new TabManager(window, state_store, config_store, VIEWER_PRELOAD);
    window.once('closed', () => {
        if (main_window === window) {
            main_window = undefined;
            tab_manager = undefined;
        }
    });
    void window.loadFile(path.join(DESKTOP_DIST_DIR, 'shell.html'));
    window.webContents.once('did-finish-load', () => {
        apply_zoom_level(zoom_level);
        for (const file of pending_open_paths.splice(0)) {
            tab_manager?.open_file(file);
        }
    });
    return window;
}

async function show_open_dialog(): Promise<void> {
    const window = ensure_main_window();
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Tables', extensions: SUPPORTED_EXTENSIONS },
            { name: 'All Files', extensions: ['*'] },
        ],
    });
    if (!canceled) open_files(filePaths);
}

function show_preferences_window(): void {
    if (prefs_window && !prefs_window.isDestroyed()) {
        prefs_window.focus();
        return;
    }
    prefs_window = new BrowserWindow({
        width: 460,
        height: 520,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title: 'Table Viewer Preferences',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
        webPreferences: {
            preload: PREFS_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    prefs_window.once('closed', () => {
        prefs_window = undefined;
    });
    void prefs_window.loadFile(path.join(DESKTOP_DIST_DIR, 'prefs.html'));
}

/**
 * Copy / Select All. In the main window the active viewer tab decides what they
 * mean (its focused text field, else the grid). In any other window — today
 * that is Preferences, whose fields are ordinary text inputs — fall back to the
 * native editing command.
 *
 * The window Electron reports with the menu click is the routing signal;
 * sampling focus separately is racy and can silently drop the command.
 */
function route_edit_command(
    command: 'copy' | 'selectAll',
    window: Electron.BaseWindow | undefined,
): void {
    const target = window as BrowserWindow | undefined;
    const is_main = !target || (!!main_window && target === main_window);
    if (is_main && tab_manager?.send_edit_command(command)) return;
    const contents = target?.webContents;
    if (!contents || contents.isDestroyed()) return;
    if (command === 'copy') contents.copy();
    else contents.selectAll();
}

function build_menu(): void {
    const is_mac = process.platform === 'darwin';
    const template: Electron.MenuItemConstructorOptions[] = [
        ...(is_mac
            ? [{
                label: app.name,
                submenu: [
                    { role: 'about' as const },
                    { type: 'separator' as const },
                    {
                        label: 'Preferences…',
                        accelerator: 'CmdOrCtrl+,',
                        click: () => show_preferences_window(),
                    },
                    { type: 'separator' as const },
                    { role: 'services' as const },
                    { type: 'separator' as const },
                    { role: 'hide' as const },
                    { role: 'hideOthers' as const },
                    { role: 'unhide' as const },
                    { type: 'separator' as const },
                    { role: 'quit' as const },
                ],
            }]
            : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'Open…',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => void show_open_dialog(),
                },
                { type: 'separator' },
                {
                    label: 'Close Tab',
                    accelerator: 'CmdOrCtrl+W',
                    click: (_item, window) => {
                        const focused = window as BrowserWindow | undefined;
                        // From a secondary window (e.g. Preferences), close it.
                        if (focused && focused !== main_window) {
                            focused.close();
                            return;
                        }
                        if (tab_manager?.close_active_tab()) return;
                        focused?.close();
                    },
                },
                {
                    label: 'Close Window',
                    accelerator: 'Shift+CmdOrCtrl+W',
                    click: (_item, window) =>
                        (window as BrowserWindow | undefined)?.close(),
                },
                ...(is_mac
                    ? []
                    : [
                        { type: 'separator' as const },
                        {
                            label: 'Preferences…',
                            accelerator: 'CmdOrCtrl+,',
                            click: () => show_preferences_window(),
                        },
                        { type: 'separator' as const },
                        { role: 'quit' as const },
                    ]),
            ],
        },
        {
            // Not `role: 'editMenu'`: its Undo/Redo/Delete/Paste-and-Match-Style
            // items have nothing to act on (there is no undo model, and the grid
            // is a canvas with no DOM selection), and its Copy/Select All roles
            // would claim Cmd/Ctrl+C and Cmd/Ctrl+A before the page could run
            // its own. Cut and Paste keep their native roles because the only
            // place they mean anything — the CSV cell editor's text field — is
            // exactly what those roles operate on.
            label: 'Edit',
            submenu: [
                { role: 'cut' },
                {
                    label: 'Copy',
                    accelerator: 'CmdOrCtrl+C',
                    click: (_item, window) => route_edit_command('copy', window),
                },
                { role: 'paste' },
                { type: 'separator' },
                {
                    label: 'Select All',
                    accelerator: 'CmdOrCtrl+A',
                    click: (_item, window) => route_edit_command('selectAll', window),
                },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                // Deliberately not the zoom roles: those act on the focused
                // webContents only, which would scale the tab bar or the table
                // in isolation.
                {
                    label: 'Actual Size',
                    accelerator: 'CmdOrCtrl+0',
                    click: () => apply_zoom_level(0),
                },
                {
                    label: 'Zoom In',
                    accelerator: 'CmdOrCtrl+Plus',
                    enabled: true,
                    click: () => apply_zoom_level(zoom_level + 1),
                },
                // Hidden twin so the unshifted '=' key also zooms in (a menu
                // item carries a single accelerator).
                {
                    label: 'Zoom In',
                    accelerator: 'CmdOrCtrl+=',
                    visible: false,
                    acceleratorWorksWhenHidden: true,
                    click: () => apply_zoom_level(zoom_level + 1),
                },
                {
                    label: 'Zoom Out',
                    accelerator: 'CmdOrCtrl+-',
                    click: () => apply_zoom_level(zoom_level - 1),
                },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        { label: 'Window', role: 'windowMenu' },
        {
            label: 'Help',
            role: 'help',
            submenu: [
                {
                    label: 'Table Viewer on GitHub',
                    click: () =>
                        void shell.openExternal('https://github.com/jbearak/table-viewer'),
                },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function register_ipc(): void {
    ipcMain.on(CHANNEL_GET_THEME, (event) => {
        event.returnValue = theme_payload(nativeTheme.shouldUseDarkColors);
    });
    ipcMain.handle(CHANNEL_SHELL_GET_TABS, () => tab_manager?.tab_infos() ?? []);
    ipcMain.on(CHANNEL_SHELL_ACTIVATE_TAB, (_event, tab_id: number) => {
        if (typeof tab_id === 'number') tab_manager?.activate_tab(tab_id);
    });
    ipcMain.on(CHANNEL_SHELL_CLOSE_TAB, (_event, tab_id: number) => {
        if (typeof tab_id === 'number') tab_manager?.close_tab(tab_id);
    });
    ipcMain.on(CHANNEL_SHELL_OPEN_FILES, () => void show_open_dialog());
    ipcMain.on(CHANNEL_SHELL_OPEN_PREFERENCES, () => show_preferences_window());
    ipcMain.handle(CHANNEL_PREFS_GET, () => config_store.settings());
    ipcMain.handle(CHANNEL_PREFS_SET, (_event, partial: unknown) => {
        return config_store.update(
            (partial && typeof partial === 'object' ? partial : {}) as Record<string, never>,
        );
    });
}

/** Keep the app chrome (tab bar, Preferences window) on the configured font,
 *  matching how the extension's font settings style its entire UI. */
function watch_settings(): void {
    config_store.on_change((previous, next) => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(CHANNEL_SETTINGS_CHANGED, next);
            }
        }
        // A larger font makes the tab bar taller, so the tab views move down.
        if (previous.fontSize !== next.fontSize) tab_manager?.relayout();
    });
}

// --- app lifecycle ----------------------------------------------------------

// Test hook: the Playwright smoke test points userData at a temp directory so
// runs are isolated (state store, settings, and the single-instance lock all
// live under userData).
const custom_user_data = process.env.TABLE_VIEWER_USER_DATA_DIR;
if (custom_user_data) {
    app.setPath('userData', path.resolve(custom_user_data));
}

const got_lock = app.requestSingleInstanceLock();
if (!got_lock) {
    app.quit();
} else {
    app.on('second-instance', (_event, argv, working_directory) => {
        ensure_main_window();
        open_files(file_args(argv.slice(1), working_directory));
        if (main_window) {
            if (main_window.isMinimized()) main_window.restore();
            main_window.focus();
        }
    });

    // macOS: Finder "Open with", dock drops, and `open` deliver open-file
    // events (possibly before ready).
    app.on('open-file', (event, file_path) => {
        event.preventDefault();
        open_files([file_path]);
    });

    void app.whenReady().then(() => {
        config_store = new DesktopConfigStore(
            settings_file_path(app.getPath('userData')),
        );
        register_app_protocol();
        register_ipc();
        watch_settings();
        build_menu();
        nativeTheme.on('updated', () => {
            tab_manager?.broadcast_theme();
            const payload = theme_payload(nativeTheme.shouldUseDarkColors);
            for (const window of BrowserWindow.getAllWindows()) {
                window.webContents.send(CHANNEL_THEME_CHANGED, payload);
            }
        });
        ensure_main_window();
        open_files(file_args(process.argv.slice(app.isPackaged ? 1 : 2)));
    });

    app.on('activate', () => {
        if (app.isReady()) ensure_main_window();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
