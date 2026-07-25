// Electron main process for the standalone Table Viewer desktop app.
// Reuses the shared viewer controller, state store, and webview bundle from
// the VS Code extension; only the shell (windows, menus, dialogs, protocol)
// is desktop-specific.
//
// Each open file gets its own window (desktop/main/viewer-windows.ts), so
// spreadsheets can be resized and placed side by side. With no file open the app
// shows a small welcome window instead — the launcher for File → Open and
// File → New Window.
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
import { DesktopConfigStore, settings_file_path, type DesktopSettings } from './desktop-config';
import { ViewerWindowManager } from './viewer-windows';
import {
    resolve_theme_id,
    theme_payload,
    window_background_color,
    type ThemeId,
    type ThemeSetting,
} from './theme';
import { notices_file_path } from './notices-path';
import { REPOSITORY_URL, about_link_url } from './about-links';
import { clamp_zoom_level } from './zoom';
import {
    APP_SCHEME,
    WEBVIEW_HOST,
    build_desktop_viewer_html,
    is_viewer_host,
} from './viewer-html';
import {
    CHANNEL_ABOUT_GET_INFO,
    CHANNEL_ABOUT_OPEN_LINK,
    CHANNEL_ABOUT_OPEN_NOTICES,
    CHANNEL_GET_THEME,
    CHANNEL_PREFS_GET,
    CHANNEL_PREFS_SET,
    CHANNEL_PREFS_SET_SYNC,
    CHANNEL_SETTINGS_CHANGED,
    CHANNEL_THEME_CHANGED,
    CHANNEL_WELCOME_OPEN_FILES,
    CHANNEL_WELCOME_OPEN_PREFERENCES,
} from '../shared/ipc';

const SUPPORTED_EXTENSIONS = ['csv', 'tsv', 'xlsx', 'xls'];

/**
 * The app's version, injected by desktop/build.mjs from the root package.json.
 *
 * Deliberately not `app.getVersion()`: the dev run launches the app as
 * `electron dist/desktop/main.js`, and dist/desktop has no package.json, so
 * Electron falls back to reporting *its own* version (the About window showed
 * Electron 39.x instead of the app's). Only a packaged build — where
 * electron-builder generates an app package.json — happens to answer correctly,
 * which is exactly the mode nobody watches while developing.
 */
declare const __APP_VERSION__: string;

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
const WELCOME_PRELOAD = path.join(DESKTOP_DIST_DIR, 'welcome-preload.js');
const PREFS_PRELOAD = path.join(DESKTOP_DIST_DIR, 'prefs-preload.js');
const ABOUT_PRELOAD = path.join(DESKTOP_DIST_DIR, 'about-preload.js');

let config_store: DesktopConfigStore;
let viewer_windows: ViewerWindowManager | undefined;
let prefs_window: BrowserWindow | undefined;
let about_window: BrowserWindow | undefined;
/** Open launcher windows; tracked so opening a file can replace the one it was
 *  launched from (a viewer window that opens a file keeps its own file). */
const welcome_windows = new Set<BrowserWindow>();
/** Files requested before the app was ready (macOS `open-file` fires early). */
const pending_open_paths: string[] = [];

// The viewer page and the shared webview bundle are served from a privileged
// custom scheme so the CSP model matches VS Code's webview loader (no file://).
protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
]);

/** The theme to paint with right now: the appearance preference has already been
 *  handed to Electron (`apply_theme_source`), so `shouldUseDarkColors` is the
 *  resolved mode, and the settings hold one theme per mode. Every theme lookup
 *  in this file goes through here — a call site that recomputes the mode itself
 *  gets the mode right and silently ignores the user's theme choice. */
function current_theme_id(): ThemeId {
    return resolve_theme_id(config_store.settings(), nativeTheme.shouldUseDarkColors);
}

function register_app_protocol(): void {
    const webview_assets = new Map<string, { file: string; mime: string }>([
        ['index.js', { file: path.join(WEBVIEW_DIST_DIR, 'index.js'), mime: 'text/javascript' }],
        ['index.css', { file: path.join(WEBVIEW_DIST_DIR, 'index.css'), mime: 'text/css' }],
    ]);
    protocol.handle(APP_SCHEME, async (request) => {
        const url = new URL(request.url);
        if (is_viewer_host(url.host)) {
            const config = config_store.config_port();
            const html = build_desktop_viewer_html(
                config.font_family(),
                config.font_size(),
                theme_payload(current_theme_id()),
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

/**
 * Show each supported file in its own window. `source` is the window the request
 * came from, if any: a welcome window is only a launcher, so it steps aside once
 * it has produced a viewer window.
 */
function open_files(paths: string[], source?: BrowserWindow): void {
    const files = paths.filter(is_supported_file);
    if (files.length === 0) return;
    if (!viewer_windows) {
        // Before app-ready there is no state store yet; replay once there is.
        pending_open_paths.push(...files);
        return;
    }
    for (const file of files) viewer_windows.open_file(file);
    if (source && welcome_windows.has(source) && !source.isDestroyed()) source.close();
}

/** Zoom the window a View-menu item fired for (per-window, like a browser). */
function apply_zoom(delta: number | 'reset', window: Electron.BaseWindow | undefined): void {
    const target = (window as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow();
    const contents = target?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.setZoomLevel(
        delta === 'reset' ? 0 : clamp_zoom_level(contents.getZoomLevel() + delta),
    );
}

/** The launcher shown with no file open, and by File → New Window. Several may
 *  be open at once; each is independent. */
function show_welcome_window(): BrowserWindow {
    const window = new BrowserWindow({
        width: 520,
        height: 300,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        title: 'Table Viewer',
        backgroundColor: window_background_color(current_theme_id()),
        webPreferences: {
            preload: WELCOME_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    welcome_windows.add(window);
    window.once('closed', () => welcome_windows.delete(window));
    void window.loadFile(path.join(DESKTOP_DIST_DIR, 'welcome.html'));
    return window;
}

async function show_open_dialog(source?: BrowserWindow): Promise<void> {
    const options: Electron.OpenDialogOptions = {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Tables', extensions: SUPPORTED_EXTENSIONS },
            { name: 'All Files', extensions: ['*'] },
        ],
    };
    const { canceled, filePaths } = await (source && !source.isDestroyed()
        ? dialog.showOpenDialog(source, options)
        : dialog.showOpenDialog(options));
    if (!canceled) open_files(filePaths, source);
}

function show_preferences_window(): void {
    if (prefs_window && !prefs_window.isDestroyed()) {
        prefs_window.focus();
        return;
    }
    prefs_window = new BrowserWindow({
        width: 460,
        // Fixed size, so the height must cover every field; the color-theme
        // field pushed the last controls (and the font-size input, the only way
        // back from an unreadable font) below the fold at 600.
        height: 640,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title: 'Table Viewer Preferences',
        backgroundColor: window_background_color(current_theme_id()),
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

/** A custom About window rather than the native panel: GPLv3 expects an
 *  interactive program to surface its license and warranty notice, and the
 *  native macOS About panel cannot host the links that makes practical.
 *  Singleton, like Preferences. */
function show_about_window(): void {
    if (about_window && !about_window.isDestroyed()) {
        about_window.focus();
        return;
    }
    about_window = new BrowserWindow({
        width: 380,
        height: 400,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title: 'About Table Viewer',
        backgroundColor: window_background_color(current_theme_id()),
        webPreferences: {
            preload: ABOUT_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    about_window.once('closed', () => {
        about_window = undefined;
    });
    void about_window.loadFile(path.join(DESKTOP_DIST_DIR, 'about.html'));
}

/**
 * Copy / Select All. In a viewer window the file's own view decides what they
 * mean (its focused text field, else the grid). In any other window — the
 * welcome window, or Preferences, whose fields are ordinary text inputs — fall
 * back to the native editing command.
 *
 * The window Electron reports with the menu click is the routing signal;
 * sampling focus separately is racy and can silently drop the command.
 */
function route_edit_command(
    command: 'copy' | 'selectAll',
    window: Electron.BaseWindow | undefined,
): void {
    const target = (window as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow();
    if (!target) return;
    if (viewer_windows?.send_edit_command(target, command)) return;
    const contents = target.webContents;
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
                    {
                        label: 'About Table Viewer',
                        click: () => show_about_window(),
                    },
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
                    label: 'New Window',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => void show_welcome_window(),
                },
                {
                    label: 'Open…',
                    accelerator: 'CmdOrCtrl+O',
                    // Opens in a new window, so the window that asked keeps its
                    // own file — except a welcome window, which it replaces.
                    click: (_item, window) =>
                        void show_open_dialog(window as BrowserWindow | undefined),
                },
                { type: 'separator' },
                { role: 'close' },
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
                // Deliberately not the zoom roles, which ignore the clamped
                // range in zoom.ts.
                {
                    label: 'Actual Size',
                    accelerator: 'CmdOrCtrl+0',
                    click: (_item, window) => apply_zoom('reset', window),
                },
                {
                    label: 'Zoom In',
                    accelerator: 'CmdOrCtrl+Plus',
                    click: (_item, window) => apply_zoom(1, window),
                },
                // Hidden twin so the unshifted '=' key also zooms in (a menu
                // item carries a single accelerator).
                {
                    label: 'Zoom In',
                    accelerator: 'CmdOrCtrl+=',
                    visible: false,
                    acceleratorWorksWhenHidden: true,
                    click: (_item, window) => apply_zoom(1, window),
                },
                {
                    label: 'Zoom Out',
                    accelerator: 'CmdOrCtrl+-',
                    click: (_item, window) => apply_zoom(-1, window),
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
                    click: () => void shell.openExternal(REPOSITORY_URL),
                },
                // macOS already has About on the app menu, and a mac Help menu
                // does not customarily duplicate it.
                ...(is_mac
                    ? []
                    : [
                        { type: 'separator' as const },
                        {
                            label: 'About Table Viewer',
                            click: () => show_about_window(),
                        },
                    ]),
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function update_settings(partial: unknown): DesktopSettings {
    return config_store.update(
        (partial && typeof partial === 'object' ? partial : {}) as Record<string, never>,
    );
}

function register_ipc(): void {
    ipcMain.on(CHANNEL_GET_THEME, (event) => {
        event.returnValue = theme_payload(current_theme_id());
    });
    ipcMain.on(CHANNEL_WELCOME_OPEN_FILES, (event) => {
        void show_open_dialog(BrowserWindow.fromWebContents(event.sender) ?? undefined);
    });
    ipcMain.on(CHANNEL_WELCOME_OPEN_PREFERENCES, () => show_preferences_window());
    ipcMain.handle(CHANNEL_PREFS_GET, () => config_store.settings());
    ipcMain.handle(CHANNEL_PREFS_SET, (_event, partial: unknown) => update_settings(partial));
    // The closing Preferences window's last write; see CHANNEL_PREFS_SET_SYNC.
    //
    // The try is not decoration. A sync listener gets none of `handle`'s error
    // plumbing: an unwritable settings file would throw past this, leaving the
    // renderer blocked forever inside `sendSync` — on a window the user is trying
    // to close — and taking the main process down with an uncaught exception. A
    // failed save must cost the user their last edit, and nothing more.
    ipcMain.on(CHANNEL_PREFS_SET_SYNC, (event, partial: unknown) => {
        try {
            event.returnValue = update_settings(partial);
        } catch (error) {
            console.error('failed to save preferences on close', error);
            event.returnValue = null;
        }
    });
    // Sync, matching CHANNEL_GET_THEME: the renderer needs it before first paint.
    // Only the version — the display name is hardcoded in about.html because
    // `app.name` is the package name (`table-viewer`) outside a packaged build,
    // and the version is the build-time constant rather than `app.getVersion()`
    // for the reason documented on __APP_VERSION__.
    ipcMain.on(CHANNEL_ABOUT_GET_INFO, (event) => {
        event.returnValue = { version: __APP_VERSION__ };
    });
    ipcMain.on(CHANNEL_ABOUT_OPEN_LINK, (_event, target: unknown) => {
        const url = about_link_url(target);
        if (url) void shell.openExternal(url);
    });
    ipcMain.on(CHANNEL_ABOUT_OPEN_NOTICES, () => {
        const file = notices_file_path(
            app.isPackaged,
            // Not on the `types: ["node"]` Process type — electron adds it.
            (process as { resourcesPath?: string }).resourcesPath ?? '',
            DESKTOP_DIST_DIR,
        );
        // openPath resolves to a non-empty *error string* rather than rejecting;
        // in a dev tree the file only exists once collect-licenses.mjs has run,
        // so say so loudly instead of no-oping.
        void shell.openPath(file).then((error) => {
            if (error) {
                dialog.showErrorBox(
                    'Could not open the third-party notices',
                    `${file}\n\n${error}`,
                );
            }
        });
    });
}

/** Push the current palette to every window: the page CSS over the theme channel,
 *  and the native window background separately — viewer windows through the window
 *  manager, the chrome windows here. A frame whose background is not repainted
 *  keeps the old color behind and around its page. */
function broadcast_theme(): void {
    const payload = theme_payload(current_theme_id());
    const background = window_background_color(payload.themeId);
    viewer_windows?.apply_theme(payload);
    for (const window of [...welcome_windows, prefs_window, about_window]) {
        if (window && !window.isDestroyed()) window.setBackgroundColor(background);
    }
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CHANNEL_THEME_CHANGED, payload);
    }
}

/** Hand the appearance preference to Electron: `system` restores OS following,
 *  the other two pin `shouldUseDarkColors`, which is what the whole theming path
 *  already reads. */
function apply_theme_source(theme: ThemeSetting): void {
    nativeTheme.themeSource = theme;
}

/** Keep the app chrome (welcome, Preferences, and About windows) on the
 *  configured font, matching how the extension's font settings style its entire
 *  UI, and keep every window's palette in step with the appearance preference
 *  and the two per-mode theme slots.
 *
 *  Sent to every window rather than a tracked chrome list: only the chrome
 *  preloads listen for this channel, and viewer windows get font changes through
 *  their controller's ConfigPort instead (as a `fontChanged` host message). */
function watch_settings(): void {
    config_store.on_change((previous, next) => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(CHANNEL_SETTINGS_CHANGED, next);
            }
        }
        const appearance_changed = previous.theme !== next.theme;
        const palette_changed = previous.lightThemeId !== next.lightThemeId
            || previous.darkThemeId !== next.darkThemeId;
        // nativeTheme only emits `updated` when the resolved appearance actually
        // flips (system → light while already light does not), so push the
        // palette from here rather than relying on that event.
        if (appearance_changed) apply_theme_source(next.theme);
        // A change to the *inactive* slot broadcasts harmlessly: broadcast_theme
        // recomputes current_theme_id(), which is unchanged in that case.
        if (appearance_changed || palette_changed) broadcast_theme();
        if (previous.newWindowSize === 'fixed' && next.newWindowSize === 'match-last') {
            // Deferred, because adopting a size writes settings, and a write
            // from inside a change listener notifies before this one finishes:
            // the stale `next` above would then be the *last* payload every
            // window received, leaving Preferences showing the size just
            // replaced.
            setImmediate(() => viewer_windows?.adopt_current_size());
        }
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
        const files = file_args(argv.slice(1), working_directory);
        // A second launch with no file behaves like File → New Window.
        if (files.length === 0) show_welcome_window().focus();
        else open_files(files);
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
        // Before any window is created, so first paint uses the right palette.
        apply_theme_source(config_store.settings().theme);
        register_app_protocol();
        register_ipc();
        watch_settings();
        build_menu();
        nativeTheme.on('updated', broadcast_theme);
        viewer_windows = new ViewerWindowManager(
            create_json_file_state_store(
                json_state_file_path(app.getPath('userData')),
                () => config_store.settings().maxStoredFiles,
            ),
            config_store,
            VIEWER_PRELOAD,
        );
        const files = [
            ...pending_open_paths.splice(0),
            ...file_args(process.argv.slice(app.isPackaged ? 1 : 2)),
        ];
        if (files.length > 0) open_files(files);
        else show_welcome_window();
    });

    // macOS dock click with nothing to work in. Preferences deliberately does not
    // count: it is a utility window, so activating with only it open should still
    // produce a launcher.
    app.on('activate', () => {
        if (!app.isReady()) return;
        const has_document_window = (viewer_windows?.has_windows() ?? false)
            || welcome_windows.size > 0;
        if (!has_document_window) show_welcome_window();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
