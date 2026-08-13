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
    net,
    protocol,
    shell,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import type { OpenedSqliteFileStateStore } from '../../src/sqlite-file-state-persistence';
import {
    canonical_existing_path,
    DesktopConfigStore,
    settings_file_path,
    type DesktopSettings,
} from './desktop-config';
import {
    close_desktop_windows,
    create_app_quit_coordinator,
    ViewerWindowManager,
    type AppQuitShutdownPort,
} from './viewer-windows';
import {
    create_desktop_lifecycle,
    create_desktop_state_backend,
    launcher_steps_aside,
    route_desktop_window_request,
    type DesktopWindowRequest,
} from './desktop-lifecycle';
import {
    desktop_state_database_path,
    desktop_state_diagnostics_directory,
    desktop_state_error_log_line,
    desktop_state_failure_log_line,
    open_desktop_state_database,
    preserve_desktop_state_database,
} from './desktop-state-database';
import { create_state_inspector_handler } from '../../src/state-inspector/host-handler';
import type { StateInspectorRequest } from '../../src/state-inspector/protocol';
import {
    create_state_recovery_flow,
    state_recovery_button_layout,
    state_recovery_choice_at,
    state_recovery_wording,
    type StateRecoveryChoice,
    type StateRecoveryDetail,
    type StateRecoveryDialogs,
} from './state-recovery-dialog';
import {
    resolve_theme_id,
    theme_payload,
    window_background_color,
    type ThemeId,
    type ThemeSetting,
} from './theme';
import { notices_file_path } from './notices-path';
import { save_open_window_paths, take_open_window_paths } from './window-restoration';
import { REPOSITORY_URL, about_link_url } from './about-links';
import {
    create_app_update_coordinator,
    type AppUpdateCoordinator,
} from './app-updates';
import { app_update_failure_dialog } from './app-update-failure';
import {
    acknowledge_windows_portable_update,
    clean_windows_portable_update_transactions,
    create_windows_portable_update_engine,
} from './windows-portable-app-updates';
import {
    portable_update_acknowledgement,
    without_portable_update_arguments,
} from './windows-portable-update-protocol';
import { clamp_zoom_level } from './zoom';
import { TITLEBAR_WINDOW_OPTIONS } from '../shared/titlebar';
import {
    SUPPORTED_FILE_EXTENSIONS,
    register_portable_file_associations,
} from './windows-file-associations';
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
    CHANNEL_STATE_INSPECTOR_REQUEST,
    CHANNEL_THEME_CHANGED,
    CHANNEL_TITLEBAR_ACTIVE,
    CHANNEL_TITLEBAR_ACTIVE_CHANGED,
    CHANNEL_TITLEBAR_ZOOM,
    CHANNEL_TITLEBAR_ZOOM_CHANGED,
    CHANNEL_WELCOME_OPEN_FILES,
    CHANNEL_WELCOME_OPEN_PREFERENCES,
} from '../shared/ipc';

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
declare const __INSTALL_APP_UPDATES__: boolean;

function is_supported_file(file_path: string): boolean {
    const ext = path.extname(file_path).toLowerCase().replace(/^\./, '');
    return SUPPORTED_FILE_EXTENSIONS.some((supported) => supported === ext);
}

function can_restore_file(file_path: string): boolean {
    if (!is_supported_file(file_path)) return false;
    try {
        return fs.statSync(file_path).isFile();
    } catch {
        return false;
    }
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
const STATE_INSPECTOR_PRELOAD = path.join(DESKTOP_DIST_DIR, 'state-inspector-preload.js');

let config_store: DesktopConfigStore;
let viewer_windows: ViewerWindowManager | undefined;
let app_updates: AppUpdateCoordinator | undefined;
let prefs_window: BrowserWindow | undefined;
let about_window: BrowserWindow | undefined;
let state_inspector_window: BrowserWindow | undefined;
/** Open launcher windows; tracked so opening a file can replace the one it was
 *  launched from (a viewer window that opens a file keeps its own file). */
const welcome_windows = new Set<BrowserWindow>();

/** The one startup/shutdown gate. Electron delivers `open-file`,
 *  `second-instance`, and `activate` before the state backend exists — and can
 *  keep delivering them while it is draining — so every request that would make
 *  a viewer window goes through here rather than being tested against
 *  `viewer_windows` directly. */
const lifecycle = create_desktop_lifecycle();

/**
 * The open SQLite file-state backend: who may use it, and who closes it.
 *
 * All the ordering rules live in desktop-lifecycle.ts so they are testable
 * without Electron — publishing into a drain closes the store instead, and a
 * close that fails is reported as its own terminal outcome rather than as a
 * retryable one it cannot actually be. The connection is released on the quit
 * path only after every viewer window has finished its own renderer/backend
 * fence, while *admission* stops at the barrier's first tick — see
 * `create_app_quit_coordinator`.
 */
const state_backend = create_desktop_state_backend<OpenedSqliteFileStateStore>(
    lifecycle,
    () => viewer_windows?.stop_admission(),
    () => viewer_windows?.resume_admission(),
);

function create_packaged_app_updates(portable_executable: string | undefined): AppUpdateCoordinator | undefined {
    if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform)) return undefined;

    const engine = portable_executable
        ? create_windows_portable_update_engine({
            current_version: __APP_VERSION__,
            arch: process.arch,
            portable_executable,
            wrapper_pid: process.ppid,
            user_data_dir: app.getPath('userData'),
            resources_dir: process.resourcesPath,
            is_online: () => net.isOnline(),
            finish_quit: () => app.quit(),
            fail_quit: () => app.exit(1),
        })
        : (() => {
            autoUpdater.autoDownload = false;
            autoUpdater.autoInstallOnAppQuit = false;
            autoUpdater.allowPrerelease = false;
            if (process.platform === 'win32') {
                autoUpdater.channel = process.arch === 'arm64' ? 'latest-arm64' : 'latest';
                // electron-updater's channel setter enables downgrades as a side effect;
                // architecture selection is not permission to install an older release.
                autoUpdater.allowDowngrade = false;
            }
            return {
                check_for_updates: async () => { await autoUpdater.checkForUpdates(); },
                download_update: async () => { await autoUpdater.downloadUpdate(); },
                is_online: () => net.isOnline(),
                quit_and_install: () => {
                    if (process.platform === 'darwin') {
                        // Squirrel fetches the already-downloaded ZIP from
                        // electron-updater's local proxy only after this call. If that
                        // handoff fails, no updater quit follows; the normal backend is
                        // already drained, so exit rather than leave a windowless app
                        // alive over closed state.
                        autoUpdater.once('error', () => app.exit(1));
                        autoUpdater.quitAndInstall();
                    } else {
                        autoUpdater.quitAndInstall(false, true);
                        // BaseUpdater quits only when it successfully starts the
                        // installer. Its API returns void, so retain the old post-drain
                        // terminal guarantee when cached installer state is missing.
                        setImmediate(() => app.quit());
                    }
                },
                on_update_available: (listener: (info: { version: string }) => void) => {
                    autoUpdater.on('update-available', (info) => listener({ version: info.version }));
                },
                on_update_not_available: (listener: () => void) => {
                    autoUpdater.on('update-not-available', listener);
                },
                on_update_downloaded: (listener: (info: { version: string }) => void) => {
                    autoUpdater.on('update-downloaded', (info) => listener({ version: info.version }));
                },
                on_error: (listener: (error: unknown) => void) => {
                    autoUpdater.on('error', (error) => listener(error));
                },
            };
        })();

    const show_update_message_box = (
        options: Electron.MessageBoxOptions,
    ): Promise<Electron.MessageBoxReturnValue> => {
        const window = BrowserWindow.getFocusedWindow();
        return window
            ? dialog.showMessageBox(window, options)
            : dialog.showMessageBox(options);
    };

    const confirm_update = async (
        message: string,
        detail: string,
        affirmative_label: string,
    ): Promise<boolean> => {
        const result = await show_update_message_box({
            type: 'info',
            message,
            detail,
            buttons: [affirmative_label, 'Later'],
            defaultId: 0,
            cancelId: 1,
        });
        return result.response === 0;
    };

    return create_app_update_coordinator(
        engine,
        {
            offer_download: async (version, install_updates) => {
                if (!install_updates) {
                    const result = await show_update_message_box({
                        type: 'info',
                        message: `Table Viewer ${version} is available.`,
                        detail: 'This unsigned local build cannot install updates automatically. Download the latest release from GitHub, then replace this app manually.',
                        buttons: ['Open GitHub Releases', 'OK'],
                        defaultId: 1,
                        cancelId: 1,
                    });
                    if (result.response === 0) {
                        await shell.openExternal(`${REPOSITORY_URL}/releases`);
                    }
                    return false;
                }
                return confirm_update(
                    `Table Viewer ${version} is available.`,
                    'Would you like to download it now?',
                    'Download',
                );
            },
            offer_restart: (version) => confirm_update(
                `Table Viewer ${version} is ready to install.`,
                'Restart Table Viewer to finish installing the update.',
                'Restart and Install',
            ),
            show_up_to_date: async () => {
                await show_update_message_box({
                    type: 'info',
                    message: 'Table Viewer is up to date.',
                    detail: `You are running version ${__APP_VERSION__}.`,
                    buttons: ['OK'],
                });
            },
            show_failure: async (failure) => {
                const wording = app_update_failure_dialog(failure);
                const result = await show_update_message_box({
                    type: 'warning',
                    message: wording.message,
                    detail: wording.detail,
                    buttons: [...wording.buttons],
                    defaultId: wording.defaultId,
                    cancelId: wording.cancelId,
                });
                if (result.response === wording.open_releases_response) {
                    await shell.openExternal(`${REPOSITORY_URL}/releases`);
                }
            },
            show_download_in_progress: async () => {
                await show_update_message_box({
                    type: 'info',
                    message: 'Table Viewer is downloading an update.',
                    detail: 'You will be asked before the app restarts to install it.',
                    buttons: ['OK'],
                });
            },
        },
        () => app.quit(),
        { install_updates: __INSTALL_APP_UPDATES__ },
    );
}

/**
 * The quit barrier's view of the backend.
 *
 * `begin` runs on entry to the barrier rather than after the window fence: a
 * window created during the fence is never fenced (see `close_all`), and would
 * survive the drain holding a controller over a closed connection. `abandon`
 * is the way back for a barrier that ends before the connection closes.
 */
const quit_shutdown: AppQuitShutdownPort = {
    begin: () => state_backend.begin_shutdown(),
    abandon: () => state_backend.abandon_shutdown(),
    drain: () => state_backend.drain(),
    /** The category-free case: the store swallowed its own error, so there is
     *  nothing here that could carry a path. The user is told because the quit
     *  proceeds anyway — a close that failed cannot be re-attempted (the
     *  underlying promise is memoized), so refusing to quit would only trade a
     *  visible warning for an app that can be left only by force-quitting. */
    report_close_failure: () => {
        console.error(
            'Table Viewer could not release its saved view settings cleanly while quitting.'
            + ' The connection was closed; quitting continued because the release cannot be'
            + ' retried.',
        );
    },
};

// Electron's first app.quit() is synchronous, while viewer close is fenced by
// renderer and state-backend acknowledgements. Close every BrowserWindow before
// resuming quit: on macOS, a cancelled window close clears Electron's own quitting
// flag, which otherwise consumes the first Cmd-Q and leaves a windowless process.
// After the windows and SQLite connection are released, the allow-quit guard
// admits the resumed before-quit event.
//
// Constructed at module scope, before either the window manager or the state
// backend exists, so every dependency is read through a closure over a mutable
// module binding rather than captured now.
let quitting_viewer_files: string[] = [];
const coordinate_app_quit = create_app_quit_coordinator(
    () => {
        quitting_viewer_files = viewer_windows?.open_file_paths() ?? [];
        return close_desktop_windows(
            () => viewer_windows?.close_all() ?? Promise.resolve(true),
            () => BrowserWindow.getAllWindows(),
        );
    },
    () => {
        try {
            save_open_window_paths(app.getPath('userData'), quitting_viewer_files);
        } catch {
            try {
                console.error('Table Viewer could not remember its open windows while quitting.');
            } catch {
                // Reporting is best-effort; persistence must never prevent quit.
            }
        }
        const install_result = app_updates?.install_if_requested() ?? 'not-requested';
        if (install_result === 'not-requested') app.quit();
        if (install_result === 'failed') app.exit(1);
    },
    quit_shutdown,
);

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
 * Run one window-creating request: through the lifecycle gate first, then
 * through the pure router.
 *
 * Every path that could put a window on screen goes through this one function —
 * `open-file`, `second-instance`, `activate`, File → Open, File → New Window,
 * and the argv replay at the end of `start_app`. Two separate reasons:
 *
 * - the gate. Before the state backend is open the request is buffered and
 *   replayed; once the app is failing or draining it is dropped. A window whose
 *   controller has no store to read from is worse than no window at all.
 * - the routing. Which of those requests makes a launcher, which opens files,
 *   and which is already satisfied by what is on screen is decided by
 *   `route_desktop_window_request`, which is electron-free and under test.
 *
 * `source` is the window the request came from, if any: a launcher is only a
 * launcher, so it steps aside once it has produced a viewer window.
 */
function submit_window_request(request: DesktopWindowRequest, source?: BrowserWindow): void {
    lifecycle.submit(() => {
        const action = route_desktop_window_request(request, {
            hasViewerWindow: viewer_windows?.has_windows() ?? false,
            hasLauncherWindow: welcome_windows.size > 0,
        });
        if (action.kind === 'none') return;
        if (action.kind === 'show-launcher') {
            const window = show_welcome_window();
            if (action.focus) window.focus();
            return;
        }
        if (!viewer_windows) return;
        let opened_any = false;
        for (const file of action.files) {
            if (viewer_windows.open_file(file)) {
                if (process.platform === 'darwin' || process.platform === 'win32') {
                    app.addRecentDocument(file);
                }
                opened_any = true;
            }
        }
        const from_launcher = source !== undefined && welcome_windows.has(source);
        if (launcher_steps_aside(opened_any, from_launcher) && !source!.isDestroyed()) {
            source!.close();
        }
    });
}

/** Show each supported file in its own window. Unsupported paths are dropped
 *  here rather than in the router, which reasons about counts of files it is
 *  being asked to open. */
function open_files(paths: readonly string[], source?: BrowserWindow): void {
    submit_window_request(
        { kind: 'open-files', files: paths.filter(is_supported_file) },
        source,
    );
}

/** Zoom the window a View-menu item fired for (per-window, like a browser). */
function apply_zoom(delta: number | 'reset', window: Electron.BaseWindow | undefined): void {
    const target = (window as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow();
    const contents = target?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.setZoomLevel(
        delta === 'reset' ? 0 : clamp_zoom_level(contents.getZoomLevel() + delta),
    );
    // macOS themed title bar: the strip stands in for window chrome,
    // which macOS does not scale, so it re-derives its metrics from the new factor.
    contents.send(CHANNEL_TITLEBAR_ZOOM_CHANGED, contents.getZoomFactor());
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
        // macOS themed title bar (desktop/shared/titlebar.ts); the
        // strip is redrawn by this window's renderer.
        ...TITLEBAR_WINDOW_OPTIONS,
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
            { name: 'Tables', extensions: [...SUPPORTED_FILE_EXTENSIONS] },
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
        // macOS themed title bar (desktop/shared/titlebar.ts); the
        // strip is redrawn by this window's renderer.
        ...TITLEBAR_WINDOW_OPTIONS,
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
        // macOS themed title bar (desktop/shared/titlebar.ts); the
        // strip is redrawn by this window's renderer.
        ...TITLEBAR_WINDOW_OPTIONS,
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

/** Browse and trim what Table Viewer has remembered about opened files.
 *  Singleton, like Preferences, and resizable because it lists file paths. */
function show_state_inspector_window(): void {
    if (state_inspector_window && !state_inspector_window.isDestroyed()) {
        state_inspector_window.focus();
        return;
    }
    // Nothing to inspect until the store is open, and the menu item is enabled
    // before then; opening an inspector over no database would show an error
    // where the honest answer is "not yet".
    if (!state_backend.published) return;
    state_inspector_window = new BrowserWindow({
        width: 820,
        height: 560,
        minWidth: 520,
        minHeight: 320,
        title: 'Stored File State',
        // macOS themed title bar (desktop/shared/titlebar.ts); the
        // strip is redrawn by this window's renderer.
        ...TITLEBAR_WINDOW_OPTIONS,
        backgroundColor: window_background_color(current_theme_id()),
        webPreferences: {
            preload: STATE_INSPECTOR_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    state_inspector_window.once('closed', () => {
        state_inspector_window = undefined;
    });
    void state_inspector_window.loadFile(path.join(DESKTOP_DIST_DIR, 'state-inspector.html'));
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

/** Viewer reloads must use the same state-backend fence as close. */
function route_reload(
    ignore_cache: boolean,
    window: Electron.BaseWindow | undefined,
): void {
    const target = (window as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow();
    if (!target) return;
    if (viewer_windows?.reload(target, ignore_cache)) return;
    const contents = target.webContents;
    if (!contents || contents.isDestroyed()) return;
    if (ignore_cache) contents.reloadIgnoringCache();
    else contents.reload();
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
                    ...(app_updates
                        ? [{
                            label: 'Check for Updates…',
                            click: () => app_updates?.check_manually(),
                        }]
                        : []),
                    { type: 'separator' as const },
                    {
                        label: 'Preferences…',
                        accelerator: 'CmdOrCtrl+,',
                        click: () => show_preferences_window(),
                    },
                    {
                        label: 'Stored File State…',
                        click: () => show_state_inspector_window(),
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
                    click: () => submit_window_request({ kind: 'new-window' }),
                },
                {
                    label: 'Open…',
                    accelerator: 'CmdOrCtrl+O',
                    // Opens in a new window, so the window that asked keeps its
                    // own file — except a welcome window, which it replaces.
                    click: (_item, window) =>
                        void show_open_dialog(window as BrowserWindow | undefined),
                },
                ...(is_mac
                    ? [{
                        label: 'Open Recent',
                        role: 'recentDocuments' as const,
                        submenu: [
                            { label: 'Clear Menu', role: 'clearRecentDocuments' as const },
                        ],
                    }]
                    : []),
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
                        {
                            label: 'Stored File State…',
                            click: () => show_state_inspector_window(),
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
                {
                    label: 'Reload',
                    accelerator: 'CmdOrCtrl+R',
                    click: (_item, window) => route_reload(false, window),
                },
                {
                    label: 'Force Reload',
                    accelerator: 'CmdOrCtrl+Shift+R',
                    click: (_item, window) => route_reload(true, window),
                },
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
                ...(!is_mac && app_updates
                    ? [
                        {
                            label: 'Check for Updates…',
                            click: () => app_updates?.check_manually(),
                        },
                        { type: 'separator' as const },
                    ]
                    : []),
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

/**
 * macOS themed title bar: tell each window's strip when it becomes
 * the active window, so the title dims like a native one.
 *
 * Registered once for every window the app will ever create, rather than per
 * window: the strip is chrome that every window has, and a window that opened
 * without being wired would keep an undimmed title forever.
 */
function watch_window_activation(): void {
    app.on('browser-window-created', (_event, window) => {
        const send = (active: boolean) => {
            if (window.isDestroyed()) return;
            const contents = window.webContents;
            if (!contents.isDestroyed()) contents.send(CHANNEL_TITLEBAR_ACTIVE_CHANGED, active);
        };
        window.on('focus', () => send(true));
        window.on('blur', () => send(false));
    });
}

function register_ipc(): void {
    ipcMain.on(CHANNEL_TITLEBAR_ZOOM, (event) => {
        event.returnValue = event.sender.getZoomFactor();
    });
    ipcMain.on(CHANNEL_TITLEBAR_ACTIVE, (event) => {
        event.returnValue = BrowserWindow.fromWebContents(event.sender)?.isFocused() ?? true;
    });
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
    // Built per request rather than once at startup: the store is not open when
    // the IPC handlers are registered, and rebuilding costs nothing next to the
    // database work each request does anyway.
    ipcMain.handle(CHANNEL_STATE_INSPECTOR_REQUEST, async (_event, request: unknown) => {
        const opened = state_backend.published;
        if (!opened) {
            return { kind: 'error', message: 'The state database is not open.' };
        }
        const handler = create_state_inspector_handler({
            maintenance: opened.maintenance,
            databasePath: desktop_state_database_path(app.getPath('userData')),
        });
        return handler(request as StateInspectorRequest);
    });
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
    for (const window of [
        ...welcome_windows,
        prefs_window,
        about_window,
        state_inspector_window,
    ]) {
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

/** Keep the app chrome (welcome, Preferences, About, and Stored File State windows) on the
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

// --- state-backend recovery -------------------------------------------------

/**
 * The recovery flow's dialogs, bound to real electron `dialog` / `shell`.
 *
 * Every modal is parentless: these run before any window exists, from inside
 * `whenReady` and before the first viewer or launcher is created.
 */
const state_recovery_dialogs: StateRecoveryDialogs = {
    // Only the `dialog.showMessageBox` call itself lives here. The prose, the
    // button row, and the index → choice mapping are all electron-free in
    // state-recovery-dialog.ts, where they are under test.
    async show_recovery(detail: StateRecoveryDetail): Promise<StateRecoveryChoice> {
        const { message, detail: body } = state_recovery_wording(detail.kind);
        const layout = state_recovery_button_layout(detail.canPreserve);
        const { response } = await dialog.showMessageBox({
            type: 'error',
            message,
            detail: body,
            buttons: [...layout.buttons],
            defaultId: layout.defaultId,
            cancelId: layout.cancelId,
            noLink: true,
        });
        return state_recovery_choice_at(layout, response);
    },

    /** The second gate on preservation. The affirmative button *is* the
     *  attestation — there is no way for one process to verify from the inside
     *  that no other process holds the database, so it is fail-closed and
     *  explicit, following `run_physical_edit_protocol_setup`. */
    async confirm_preserve(detail: StateRecoveryDetail): Promise<boolean> {
        const attestation = 'I Attest All Table Viewer Windows and Apps Are Closed';
        const { response } = await dialog.showMessageBox({
            type: 'warning',
            message: 'Set the existing saved view settings aside and start a fresh set?',
            detail: 'Do this only after quitting every other Table Viewer window and every'
                + ' other Table Viewer app on this computer. Moving them while another process'
                + ' still has them open can leave both copies unusable. Nothing is deleted:'
                + ' the existing set is moved to a recovery folder next to it and kept for'
                + ' troubleshooting, and Table Viewer starts a new empty one.'
                // Only for a move that really was started. `leftover-setup` is
                // deliberately not included: no move was ever attempted there,
                // and claiming to resume one would be a false statement about
                // what is about to happen.
                + (detail.kind === 'interrupted'
                    ? ' This resumes the move that was interrupted earlier.'
                    : ''),
            buttons: ['Cancel', attestation],
            // Negative by default and on dismissal: an accidental Return or Escape
            // must never be the attestation.
            defaultId: 0,
            cancelId: 0,
            noLink: true,
        });
        return response === 1;
    },

    async open_folder(directory: string): Promise<void> {
        // The one callback that receives a path, and only because the OS needs it
        // to reveal the folder — it is never rendered as text.
        await shell.openPath(directory);
    },

    /** Deliberately does not claim nothing was moved.
     *
     *  Setting the settings aside is a multi-step move, and it can fail partway
     *  — after which some members really are already in the recovery folder.
     *  The honest invariants are the ones the state machine actually guarantees:
     *  the move did not *complete*, nothing was deleted, and the next attempt
     *  resumes this same unfinished move rather than starting a second one. As
     *  everywhere else in this flow, no path, filename, or SQL text appears.
     *
     *  Takes no argument, matching the port: the prose is fixed, and every
     *  invariant it states holds for every kind that can reach it. */
    async show_error(): Promise<void> {
        await dialog.showMessageBox({
            type: 'error',
            message: 'Table Viewer could not finish setting the existing saved view settings'
                + ' aside.',
            detail: 'The move did not complete. Some of the settings may already have been'
                + ' moved into a recovery folder, and nothing was deleted. Table Viewer will'
                + ' resume this same unfinished move the next time you try, so it will not'
                + ' start a second one. This usually means the location ran out of space, is'
                + ' not writable, or another process still has the settings open.',
            buttons: ['OK'],
            noLink: true,
        });
    },
};

// --- app lifecycle ----------------------------------------------------------

// A real production override, not merely a test hook — it is read from the
// environment of any launch, and the Playwright smoke test is only its best-known
// consumer (it points userData at a temp directory so runs are isolated).
//
// Two launches whose values name the same physical directory by different paths —
// a symlink, a `.`-relative path, a case-different spelling on a
// case-insensitive volume — each win `requestSingleInstanceLock()` below, because
// that lock is keyed on the userData path Electron was given rather than on the
// directory it resolves to. Both processes then coordinate through the same
// `state/` tree while each believes it is the only instance, and "Set Aside and
// Start Fresh" carries an attestation that no other process holds the database:
// under attestation the shared backend reclaims the peer's reader token by exact
// id and moves the set out from under its live handle (which is the sanctioned
// trade — reclaiming any other way would mean PID/TTL/heartbeat expiry).
//
// Resolved with `realpathSync` where possible so the ordinary aliasing cases
// collapse to one value and the lock does its job. That closes the aliasing hole
// but not the deliberate one: two genuinely different userData directories whose
// `state/` subdirectories are the same physical directory still both win, and no
// single-process check can see that. Do not set this to a location another Table
// Viewer instance is already using.
const custom_user_data = process.env.TABLE_VIEWER_USER_DATA_DIR;
if (custom_user_data) {
    // `canonical_existing_path` resolves relative to cwd itself, so the old
    // `path.resolve` is subsumed rather than dropped.
    app.setPath('userData', canonical_existing_path(custom_user_data));
}

const got_lock = app.requestSingleInstanceLock();
if (!got_lock) {
    app.quit();
} else {
    app.on('before-quit', coordinate_app_quit);

    // Buffered like every other window-making request: a second launch can arrive
    // while this instance is still opening SQLite, and it must neither be dropped
    // nor make a launcher during the quit drain. What it does once admitted — open
    // its files, or behave like File → New Window and focus — is
    // `route_desktop_window_request`'s `second-instance` arm.
    //
    // The argv is resolved here rather than inside the buffered work: the paths
    // are relative to the *second* process's cwd, which is information only this
    // event carries.
    app.on('second-instance', (_event, argv, working_directory) => {
        submit_window_request({
            kind: 'second-instance',
            // Already filtered to supported extensions by `file_args`.
            files: file_args(argv.slice(1), working_directory),
        });
    });

    // macOS: Finder "Open with", dock drops, and `open` deliver open-file
    // events (possibly before ready).
    app.on('open-file', (event, file_path) => {
        event.preventDefault();
        open_files([file_path]);
    });

    /**
     * Bring the app up, in two stages.
     *
     * Everything that does not need a state backend comes first — the settings
     * store, the appearance preference, the protocol handler, the IPC channels,
     * the settings watcher, the menu, and the nativeTheme listener. That order is
     * load-bearing: a recovery modal below may be the very first thing the user
     * sees, and it has to be shown by an app that is already themed and otherwise
     * functional rather than one that is still half-built.
     *
     * Only then is the SQLite file-state database opened. It is the viewer's
     * authority, not a cache, so there is no silent fallback: a failure goes to
     * the recovery conversation, and a user who chooses to quit gets no window at
     * all.
     */
    async function start_app(): Promise<void> {
        const portable_executable = process.platform === 'win32'
            ? process.env.PORTABLE_EXECUTABLE_FILE
            : undefined;
        if (portable_executable) {
            const registered = await register_portable_file_associations(portable_executable);
            if (!registered) {
                console.warn(
                    'Table Viewer could not register one or more portable file associations;'
                    + ' Windows recent documents may not appear in the Jump List.',
                );
            }
        }
        config_store = new DesktopConfigStore(
            settings_file_path(app.getPath('userData')),
        );
        // Before any window is created, so first paint uses the right palette.
        apply_theme_source(config_store.settings().theme);
        register_app_protocol();
        register_ipc();
        watch_window_activation();
        watch_settings();
        app_updates = create_packaged_app_updates(portable_executable);
        build_menu();
        nativeTheme.on('updated', broadcast_theme);

        const user_data_dir = app.getPath('userData');
        // The one place a state-open failure is logged, so every attempt — the
        // first and each retry the recovery flow makes — leaves a record. This is
        // where `failure.operation` goes: it names the internal stage that failed,
        // which is the only thing that makes two identically-categorized failures
        // distinguishable afterwards, and it is safe to emit because it is already
        // narrowed upstream to a short identifier. It never reaches a modal — see
        // `StateRecoveryFailure`.
        const open_state = async () => {
            const result = await open_desktop_state_database(
                user_data_dir,
                __APP_VERSION__,
                () => config_store.settings().maxStoredFiles,
            );
            if (result.type === 'failed') {
                console.error(
                    'Table Viewer could not open its saved view settings'
                    + ` (${desktop_state_failure_log_line(result.failure)})`,
                );
            }
            return result;
        };
        const first_attempt = await open_state();
        let opened: OpenedSqliteFileStateStore;
        if (first_attempt.type === 'opened') {
            opened = first_attempt.opened;
        } else {
            const flow = create_state_recovery_flow<OpenedSqliteFileStateStore>({
                dialogs: state_recovery_dialogs,
                open: open_state,
                preserve: () => preserve_desktop_state_database(
                    user_data_dir,
                    // The attestation the user gave in `confirm_preserve`, which
                    // the flow only reaches on an affirmative answer.
                    { allProcessesClosed: true },
                ),
                diagnostics_directory: () => desktop_state_diagnostics_directory(user_data_dir),
            });
            const outcome = await flow.run(first_attempt.failure);
            if (outcome.type === 'quit') {
                // Terminal: the buffer is dropped permanently, so a queued
                // `open-file` cannot make a storeless window on the way out. No
                // drain either — there is nothing open to close.
                lifecycle.become_failed();
                app.exit(0);
                return;
            }
            opened = outcome.opened;
        }

        // Cmd-Q can arrive while the open above is still in flight: the drain
        // then runs with nothing to close, and a store published afterwards
        // would never be closed — stranding its writer-session row and leases
        // and possibly leaving a hot journal for the next launch. `publish`
        // closes it instead and answers false, and no window is created.
        if (!await state_backend.publish(opened)) return;
        viewer_windows = new ViewerWindowManager(opened.store, config_store, VIEWER_PRELOAD);
        // After the window manager exists, and before the argv files below: the
        // flush releases whatever `open-file` / `second-instance` / `activate`
        // buffered during startup, and that work looks for a live
        // `viewer_windows`.
        lifecycle.become_ready();

        // This launch's own files, or — when it has none and nothing else has
        // produced a window, a buffered open-file from a Finder double-click
        // included — a launcher. Both are the `startup` arm of the router, and
        // both go through the gate like every other window-creating path, so a
        // drain that began during the flush above cannot be followed by a new
        // window.
        submit_window_request({
            kind: 'startup',
            files: [
                ...take_open_window_paths(user_data_dir, can_restore_file),
                ...file_args(without_portable_update_arguments(
                    process.argv.slice(app.isPackaged ? 1 : 2),
                )),
            ],
        });
        await acknowledge_windows_portable_update(
            user_data_dir,
            portable_update_acknowledgement(process.argv),
        );
        void clean_windows_portable_update_transactions(user_data_dir);
        // Detached from startup: update service/network failures must never turn
        // into a fatal state-backend startup failure.
        setImmediate(() => app_updates?.check_automatically());
    }

    /**
     * Run one best-effort report during startup failure, swallowing anything it
     * throws.
     *
     * Deliberately swallowing: every caller is already on the failure path, and
     * the statements that follow — draining the store and exiting — are the ones
     * that must not be skipped. There is also nowhere left to report a failed
     * report to, since the reporting channels are exactly what just failed.
     */
    const report_startup_failure = (report: () => void): void => {
        try {
            report();
        } catch {
            // Intentionally empty: see above.
        }
    };

    // `start_app` is async, and an unhandled rejection in the main process is
    // fatal — with no window on screen it would be a silent exit. Report it and
    // close the gate instead, so nothing buffered runs against a backend that
    // never arrived.
    void app.whenReady().then(start_app).catch(async (error) => {
        lifecycle.become_failed();
        // A category, never the error. This catch is reachable from a throw out
        // of `viewer_windows.open_file(file)` or `show_welcome_window()`, which
        // run synchronously inside `start_app`, and those errors carry a CSV file
        // path — as does any raw `NodeJS.ErrnoException`, in both `.path` and
        // `.message`. Logging the object would put a user's filenames and the
        // location of their state database into the terminal and into any crash
        // report that scrapes it.
        //
        // Both reports are wrapped for the same reason the quit barrier wraps
        // its own: `console.error` throws EPIPE once the parent has closed
        // stdout, and `showErrorBox` can throw before the GUI is up — and this
        // catch body is an async function whose promise is discarded by the
        // `void` above, so a throw here would skip the drain *and* `app.exit(1)`
        // and surface as an unhandled rejection. Telling the user is best
        // effort; releasing the connection and exiting are not.
        report_startup_failure(() => {
            console.error(`Table Viewer failed to start (${desktop_state_error_log_line(error)})`);
        });
        report_startup_failure(() => {
            dialog.showErrorBox(
                'Table Viewer could not start',
                'An unexpected error prevented Table Viewer from starting. Please try again.',
            );
        });
        // The throw may have happened *after* the store was published, and
        // `app.exit()` does not fire `before-quit` — so without this the process
        // would exit with a live SQLite connection, its writer-session row and
        // leases still claimed and possibly a hot journal left behind. Best
        // effort: exiting is the outcome either way, and a close that also fails
        // must not turn a reported startup failure into a silent hang.
        // No try/catch: `drain` answers with a value rather than rejecting,
        // because a close that failed cannot be re-attempted (the underlying
        // promise is memoized). Either way the process exits — a close that also
        // fails must not turn a reported startup failure into a silent hang.
        if ((await state_backend.drain()).type === 'close-failed') {
            // Wrapped for the same reason, and it matters most here: this is the
            // last statement before `app.exit(1)`, so an EPIPE from it would
            // leave the process running with nothing on screen — the silent hang
            // this whole catch exists to prevent.
            report_startup_failure(() => {
                console.error(
                    'Table Viewer could not release its state backend while failing to start.',
                );
            });
        }
        app.exit(1);
    });

    // macOS dock click with nothing to work in. Preferences deliberately does not
    // count: it is a utility window, so activating with only it open should still
    // produce a launcher.
    //
    // Buffered rather than dropped when it arrives before ready: `activate` can
    // fire during startup, and the user who clicked the dock icon is asking for a
    // window either way — `start_app` checks for one before adding its own.
    app.on('activate', () => {
        submit_window_request({ kind: 'activate' });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
