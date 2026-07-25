// One window per open file. Each viewer window is a plain BrowserWindow whose
// page is the shared webview bundle, wired to the shared viewer controller
// (`attach_viewer`) through a per-window IPC transport.
//
// Windows rather than tabs: a spreadsheet can then be resized, moved, and shown
// side by side with another one, which is both more flexible and what an Excel
// user expects. It also means the window *is* the view — no tab strip to lay
// out around, and zoom is simply per-window.
import * as path from 'path';
import {
    BrowserWindow,
    dialog,
    ipcMain,
    nativeTheme,
    screen,
} from 'electron';
import { attach_viewer, profile_for } from '../../src/viewer-controller';
import type { AuthorityFileStateStore } from '../../src/state';
import type { Disposable, ViewerHost } from '../../src/host-ports';
import { canonical_file_key } from '../../src/resource-identity';
import { node_file_refresh_watcher_factory } from '../../src/node-file-refresh-watcher';
import type { HostMessage, WebviewMessage } from '../../src/types';
import { create_desktop_ui_port, node_file_system_port } from './desktop-host-ports';
import type { DesktopConfigStore } from './desktop-config';
import { create_viewer_panel, type DesktopViewerPanel } from './viewer-panel';
import { dirty_from_host_message, dirty_from_webview_message } from './dirty-state';
import { resolve_theme_id, window_background_color, type ThemePayload } from './theme';
import { CHANNEL_HOST_MESSAGE, CHANNEL_WEBVIEW_MESSAGE } from '../shared/ipc';
import { viewer_url } from './viewer-html';
import {
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
    next_window_bounds,
} from './window-geometry';

interface ViewerWindow {
    readonly fileKey: string;
    readonly window: BrowserWindow;
    readonly panel: DesktopViewerPanel;
    readonly controller: Disposable;
    /** Drops the unsaved-edits watcher (see `dirty_from_webview_message`). */
    readonly stop_watching_dirty: () => void;
}

const IS_MAC = process.platform === 'darwin';

/** How long a drag has to settle before the new size is persisted. A resize
 *  fires continuously, and each write is a synchronous rewrite of the settings
 *  file. */
const RESIZE_SETTLE_MS = 250;

/** Feeds the per-window viewer host (see `viewer_url`); never reused, so a
 *  closed window's zoom level is not inherited by the next one. */
let next_window_id = 1;

export class ViewerWindowManager {
    /** Open windows in the order they were created (the last one is cascaded
     *  from when the next window opens). */
    private readonly windows: ViewerWindow[] = [];

    constructor(
        private readonly state_store: AuthorityFileStateStore,
        private readonly config_store: DesktopConfigStore,
        private readonly viewer_preload_path: string,
    ) {}

    /**
     * Show `file_path` in its own window, or focus the window already showing
     * it. Returns the window either way.
     */
    open_file(file_path: string): BrowserWindow {
        const file_key = canonical_file_key(file_path);
        const existing = this.windows.find((entry) => entry.fileKey === file_key);
        if (existing) {
            const window = existing.window;
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
            return window;
        }

        const title = path.basename(file_path);
        const window = new BrowserWindow({
            ...this.bounds_for_new_window(),
            minWidth: MIN_WINDOW_WIDTH,
            minHeight: MIN_WINDOW_HEIGHT,
            title,
            // resolve_theme_id is the one place "which theme is active" is
            // decided (see theme-definitions.ts); main.ts wraps it too.
            backgroundColor: window_background_color(
                resolve_theme_id(this.config_store.settings(), nativeTheme.shouldUseDarkColors),
            ),
            webPreferences: {
                preload: this.viewer_preload_path,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
            },
        });
        const web_contents = window.webContents;
        if (process.platform === 'darwin') window.setRepresentedFilename(file_path);

        // Unsaved CSV edits are durable (the controller persists them per file), so
        // this only makes them visible: macOS puts a dot in an edited document's
        // close button, and other platforms get a marked title.
        let dirty = false;
        const apply_window_state = () => {
            if (window.isDestroyed()) return;
            // The shared viewer page's <title> is the app name; the file name goes
            // in the title bar instead. Re-asserted rather than merely prevented:
            // the document title is adopted on load regardless.
            window.setTitle(!IS_MAC && dirty ? `• ${title}` : title);
            window.setDocumentEdited(dirty); // macOS only; a no-op elsewhere.
        };
        const set_dirty = (next: boolean | undefined) => {
            if (next === undefined || next === dirty) return;
            dirty = next;
            apply_window_state();
        };
        web_contents.on('page-title-updated', (event) => {
            event.preventDefault();
            apply_window_state();
        });

        // Per-window transport: host messages go out over this window's
        // webContents; webview messages come back on the shared channel,
        // filtered by sender.
        const panel = create_viewer_panel({
            send: (message: HostMessage) => {
                if (web_contents.isDestroyed()) return false;
                set_dirty(dirty_from_host_message(message));
                web_contents.send(CHANNEL_HOST_MESSAGE, message);
                return true;
            },
            on_message: (listener: (message: WebviewMessage) => void) => {
                const handler = (
                    event: Electron.IpcMainEvent,
                    message: WebviewMessage,
                ) => {
                    if (event.sender !== web_contents) return;
                    listener(message);
                };
                ipcMain.on(CHANNEL_WEBVIEW_MESSAGE, handler);
                return () => ipcMain.removeListener(CHANNEL_WEBVIEW_MESSAGE, handler);
            },
        });

        // Watched independently of the panel's own subscriptions, which belong to
        // the controller and may come and go.
        const dirty_watcher = (
            event: Electron.IpcMainEvent,
            message: WebviewMessage,
        ) => {
            if (event.sender !== web_contents) return;
            set_dirty(dirty_from_webview_message(message));
        };
        ipcMain.on(CHANNEL_WEBVIEW_MESSAGE, dirty_watcher);

        const controller = attach_viewer(
            panel,
            file_path,
            this.state_store,
            profile_for(file_path, this.config_store.config_port()),
            this.viewer_host(window),
        );

        const entry: ViewerWindow = {
            fileKey: file_key,
            window,
            panel,
            controller,
            stop_watching_dirty: () =>
                ipcMain.removeListener(CHANNEL_WEBVIEW_MESSAGE, dirty_watcher),
        };
        this.windows.push(entry);
        // Track the size as the user drags, not only on close: opening a second
        // file without closing the first should still match the size just set.
        let settle_timer: ReturnType<typeof setTimeout> | undefined;
        window.on('resize', () => {
            if (settle_timer) clearTimeout(settle_timer);
            settle_timer = setTimeout(() => {
                settle_timer = undefined;
                this.remember_size(window, 'resize');
            }, RESIZE_SETTLE_MS);
        });
        // 'close' still has live bounds to remember; 'closed' is where the
        // controller and its subscriptions go away.
        window.on('close', () => {
            if (settle_timer) clearTimeout(settle_timer);
            this.remember_size(window, 'close');
        });
        window.once('closed', () => this.teardown(entry));
        // Closing the window mid-load aborts the navigation, which rejects; an
        // unhandled rejection in the main process is fatal, so swallow it.
        web_contents.loadURL(viewer_url(next_window_id++)).catch((error) => {
            if (!window.isDestroyed()) console.error('Failed to load the viewer', error);
        });
        return window;
    }

    /** Whether any file is open, i.e. the app has a document window on screen. */
    has_windows(): boolean {
        return this.windows.length > 0;
    }

    /**
     * Hand a menu-issued Copy / Select All to `window`'s viewer, which routes it
     * to its focused text field or its grid. Returns false when `window` is not
     * a viewer window, so the caller can fall back to the native editing
     * command (see `route_edit_command` in main.ts).
     */
    send_edit_command(window: BrowserWindow, command: 'copy' | 'selectAll'): boolean {
        const entry = this.windows.find((candidate) => candidate.window === window);
        if (!entry || entry.window.webContents.isDestroyed()) return false;
        // postMessage is Thenable in the shared panel contract, but delivery to
        // a live window is what "claimed" means here.
        void entry.panel.webview.postMessage({ type: 'editCommand', command });
        return true;
    }

    /**
     * Repaint each viewer window's frame for a new OS appearance. Delivering the
     * palette to the pages themselves is main.ts's job — it broadcasts to every
     * window (viewer, welcome, preferences) in one pass.
     */
    apply_theme(payload: ThemePayload): void {
        for (const entry of this.windows) {
            if (!entry.window.isDestroyed()) {
                entry.window.setBackgroundColor(window_background_color(payload.themeId));
            }
        }
    }

    private bounds_for_new_window() {
        const settings = this.config_store.settings();
        const previous = this.windows
            .map((entry) => entry.window)
            .filter((window) => !window.isDestroyed())
            .pop();
        const previous_bounds = previous?.getNormalBounds() ?? null;
        const work_area = (previous_bounds
            ? screen.getDisplayMatching(previous_bounds)
            : screen.getPrimaryDisplay()
        ).workArea;
        // The stored pair, never `previous_bounds`: `previous` is the most
        // recently *created* window, which is not the most recently *resized*
        // one. Sizing from it would contradict both what is tracked and what
        // Preferences shows the moment the user resizes any other window.
        // `previous_bounds` is for the cascade placement only.
        return next_window_bounds(
            work_area,
            { width: settings.windowWidth, height: settings.windowHeight },
            previous_bounds,
        );
    }

    /**
     * Adopt the size of the window most recently created as the tracked one.
     *
     * For the switch into `match-last`: until that moment resizes were
     * deliberately ignored, so the stored pair is whatever was last typed under
     * `fixed` rather than any window's size, and without this the first window
     * opened afterwards would still use it.
     */
    adopt_current_size(): void {
        const window = this.windows
            .map((entry) => entry.window)
            .filter((candidate) => !candidate.isDestroyed())
            .pop();
        // 'resize' rather than 'close': this samples a window that stays open,
        // and it is the measurement that leaves a focused window undisturbed.
        if (window) this.remember_size(window, 'resize');
    }

    /**
     * Remember this window's size so the next one opens at the same size — the
     * `match-last` half of the new-window-size preference.
     *
     * The two callers have to measure differently:
     *
     * - `close` is the last chance to record anything, so it reads
     *   `getNormalBounds()` — the restored size, which is the one worth keeping
     *   even when the window is maximized, fullscreen or minimized as it goes.
     * - `resize` fires mid-drag on a focused window, and `getNormalBounds()`
     *   there disturbs it enough to swallow keystrokes into an open cell editor
     *   (the desktop smoke suite catches this). It reads `getBounds()` instead
     *   and skips the states where that would report something other than the
     *   restored size, which costs nothing: `close` always runs afterwards.
     */
    private remember_size(window: BrowserWindow, source: 'resize' | 'close'): void {
        if (window.isDestroyed()) return;
        const settings = this.config_store.settings();
        // Under `fixed` the stored size is the user's typed preference, so
        // dragging a window must not quietly overwrite it.
        if (settings.newWindowSize === 'fixed') return;
        const transient = window.isMaximized() || window.isFullScreen() || window.isMinimized();
        if (source === 'resize' && transient) return;
        const { width, height } = source === 'close'
            ? window.getNormalBounds()
            : window.getBounds();
        if (settings.windowWidth === width && settings.windowHeight === height) return;
        try {
            this.config_store.update({ windowWidth: width, windowHeight: height });
        } catch (error) {
            // Best-effort convenience: one caller is the window's 'close'
            // handler, where an unwritable userData directory would otherwise
            // take down the whole app on the way out.
            console.error('Failed to remember the window size', error);
        }
    }

    private teardown(entry: ViewerWindow): void {
        const index = this.windows.indexOf(entry);
        if (index >= 0) this.windows.splice(index, 1);
        entry.stop_watching_dirty();
        try {
            entry.controller.dispose();
        } catch {
            // Never let one window's teardown failure leak into the others.
        }
        entry.panel.dispose();
    }

    private viewer_host(window: BrowserWindow): ViewerHost {
        // Dialogs are sheeted on the window whose file they are about.
        const message_box = (
            options: Electron.MessageBoxOptions,
        ): Promise<Electron.MessageBoxReturnValue> => (
            window.isDestroyed()
                ? dialog.showMessageBox(options)
                : dialog.showMessageBox(window, options)
        );
        return {
            fs: node_file_system_port,
            ui: create_desktop_ui_port({
                show_warning: (message) => {
                    void message_box({ type: 'warning', message });
                },
                show_error: (message) => {
                    void message_box({ type: 'error', message });
                },
                show_save_discard_dialog: async () => {
                    const { response } = await message_box({
                        type: 'warning',
                        message: 'You have unsaved changes.',
                        buttons: ['Save', 'Discard', 'Cancel'],
                        defaultId: 0,
                        cancelId: 2,
                        noLink: true,
                    });
                    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
                },
            }),
            config: this.config_store.config_port(),
            refreshWatcherFactory: node_file_refresh_watcher_factory,
        };
    }
}
