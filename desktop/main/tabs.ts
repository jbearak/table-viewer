// Multi-tab manager for the desktop main window: one WebContentsView per open
// file, each wired to the shared viewer controller (`attach_viewer`) through a
// per-tab IPC transport. The tab bar itself lives in the window's own renderer
// (desktop/renderer/shell.ts) and drives this manager over IPC.
import * as path from 'path';
import {
    BrowserWindow,
    WebContentsView,
    dialog,
    ipcMain,
    nativeTheme,
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
import { theme_payload } from './theme';
import {
    CHANNEL_HOST_MESSAGE,
    CHANNEL_SHELL_TABS_CHANGED,
    CHANNEL_THEME_CHANGED,
    CHANNEL_WEBVIEW_MESSAGE,
    type ShellTabInfo,
} from '../shared/ipc';
import { APP_SCHEME, VIEWER_HOST } from './viewer-html';
import { tab_bar_height } from '../shared/chrome';
import { clamp_zoom_level, zoom_factor } from './zoom';

/** Tab-bar height at the default font size; kept for reference/tests. */
export const TAB_BAR_HEIGHT = tab_bar_height();

interface Tab {
    readonly id: number;
    readonly filePath: string;
    readonly fileKey: string;
    readonly view: WebContentsView;
    readonly panel: DesktopViewerPanel;
    readonly controller: Disposable;
}

let next_tab_id = 1;

export class TabManager {
    private readonly tabs: Tab[] = [];
    private active_tab_id: number | undefined;
    private disposed = false;
    /** One zoom level for the whole window (tab bar + every tab view). */
    private zoom_level = 0;

    constructor(
        private readonly window: BrowserWindow,
        private readonly state_store: AuthorityFileStateStore,
        private readonly config_store: DesktopConfigStore,
        private readonly viewer_preload_path: string,
    ) {
        const relayout = () => this.layout();
        window.on('resize', relayout);
        window.once('closed', () => this.dispose());
    }

    private viewer_host(): ViewerHost {
        return {
            fs: node_file_system_port,
            ui: create_desktop_ui_port({
                show_warning: (message) => {
                    void dialog.showMessageBox(this.window, {
                        type: 'warning',
                        message,
                    });
                },
                show_error: (message) => {
                    void dialog.showMessageBox(this.window, {
                        type: 'error',
                        message,
                    });
                },
                show_save_discard_dialog: async () => {
                    const { response } = await dialog.showMessageBox(this.window, {
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

    /** Open `file_path` in a new tab, or activate the existing one. */
    open_file(file_path: string): void {
        if (this.disposed) return;
        const file_key = canonical_file_key(file_path);
        const existing = this.tabs.find((tab) => tab.fileKey === file_key);
        if (existing) {
            this.activate_tab(existing.id);
            return;
        }

        const view = new WebContentsView({
            webPreferences: {
                preload: this.viewer_preload_path,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
            },
        });
        view.setBackgroundColor(
            nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
        );
        const web_contents = view.webContents;

        // Per-tab transport: host messages go out over this tab's webContents;
        // webview messages come back on the shared channel filtered by sender.
        const panel = create_viewer_panel({
            send: (message: HostMessage) => {
                if (web_contents.isDestroyed()) return false;
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

        const controller = attach_viewer(
            panel,
            file_path,
            this.state_store,
            profile_for(file_path, this.config_store.config_port()),
            this.viewer_host(),
        );

        const tab: Tab = {
            id: next_tab_id++,
            filePath: file_path,
            fileKey: file_key,
            view,
            panel,
            controller,
        };
        this.tabs.push(tab);
        this.window.contentView.addChildView(view);
        // Zoom is per-webContents and resets across navigations, so the shared
        // level is (re)applied once the new view has committed its page.
        const apply_zoom = () => {
            if (!web_contents.isDestroyed()) {
                web_contents.setZoomLevel(this.zoom_level);
            }
        };
        web_contents.on('did-finish-load', apply_zoom);
        void web_contents.loadURL(`${APP_SCHEME}://${VIEWER_HOST}/index.html`);
        apply_zoom();
        this.activate_tab(tab.id);
    }

    /** Apply the window-wide zoom level to every tab view and relayout. */
    set_zoom_level(level: number): void {
        this.zoom_level = clamp_zoom_level(level);
        for (const tab of this.tabs) {
            const contents = tab.view.webContents;
            if (!contents.isDestroyed()) contents.setZoomLevel(this.zoom_level);
        }
        this.layout();
    }

    /** Re-run layout, e.g. after the configured font size changed the tab bar. */
    relayout(): void {
        this.layout();
    }

    activate_tab(tab_id: number): void {
        if (this.disposed) return;
        const tab = this.tabs.find((entry) => entry.id === tab_id);
        if (!tab) return;
        this.active_tab_id = tab.id;
        for (const entry of this.tabs) {
            entry.view.setVisible(entry.id === tab.id);
        }
        this.layout();
        tab.view.webContents.focus();
        this.notify_tabs_changed();
    }

    close_tab(tab_id: number): void {
        const index = this.tabs.findIndex((entry) => entry.id === tab_id);
        if (index < 0) return;
        const [tab] = this.tabs.splice(index, 1);
        this.teardown_tab(tab);
        if (this.active_tab_id === tab.id) {
            const fallback = this.tabs[Math.min(index, this.tabs.length - 1)];
            this.active_tab_id = undefined;
            if (fallback) this.activate_tab(fallback.id);
        }
        this.notify_tabs_changed();
    }

    close_active_tab(): boolean {
        if (this.active_tab_id === undefined) return false;
        this.close_tab(this.active_tab_id);
        return true;
    }

    /**
     * Hand a menu-issued Copy / Select All to the active tab, which routes it to
     * its focused text field or its grid. Returns false when there is no tab to
     * receive it, so the caller can fall back to the native editing command.
     *
     * Whether this window should get the command at all is the caller's call
     * (see `route_edit_command` in main.ts) — it knows which window the menu
     * fired for, which is more reliable than sampling focus here.
     */
    send_edit_command(command: 'copy' | 'selectAll'): boolean {
        if (this.disposed) return false;
        const tab = this.tabs.find((entry) => entry.id === this.active_tab_id);
        const contents = tab?.view.webContents;
        if (!tab || !contents || contents.isDestroyed()) return false;
        // postMessage is Thenable in the shared panel contract, but delivery to a
        // live tab is what "claimed" means here.
        void tab.panel.webview.postMessage({ type: 'editCommand', command });
        return true;
    }

    broadcast_theme(): void {
        const payload = theme_payload(nativeTheme.shouldUseDarkColors);
        for (const tab of this.tabs) {
            const contents = tab.view.webContents;
            if (!contents.isDestroyed()) {
                tab.view.setBackgroundColor(
                    payload.kind === 'dark' ? '#1e1e1e' : '#ffffff',
                );
                contents.send(CHANNEL_THEME_CHANGED, payload);
            }
        }
    }

    tab_infos(): ShellTabInfo[] {
        return this.tabs.map((tab) => ({
            id: tab.id,
            title: path.basename(tab.filePath),
            filePath: tab.filePath,
            active: tab.id === this.active_tab_id,
        }));
    }

    is_empty(): boolean {
        return this.tabs.length === 0;
    }

    private layout(): void {
        if (this.disposed || this.window.isDestroyed()) return;
        const [width, height] = this.window.getContentSize();
        // The tab bar is sized in the shell renderer's CSS pixels, which the
        // zoom factor scales; these bounds are in unscaled window pixels.
        const bar_height = Math.round(
            tab_bar_height(this.config_store.settings().fontSize)
            * zoom_factor(this.zoom_level),
        );
        const bounds = {
            x: 0,
            y: bar_height,
            width,
            height: Math.max(0, height - bar_height),
        };
        for (const tab of this.tabs) {
            if (tab.id === this.active_tab_id) tab.view.setBounds(bounds);
        }
    }

    private notify_tabs_changed(): void {
        if (this.window.isDestroyed()) return;
        this.window.webContents.send(CHANNEL_SHELL_TABS_CHANGED, this.tab_infos());
    }

    private teardown_tab(tab: Tab): void {
        try {
            tab.controller.dispose();
        } catch {
            // Never let one tab's teardown failure leak into the others.
        }
        tab.panel.dispose();
        if (!this.window.isDestroyed()) {
            this.window.contentView.removeChildView(tab.view);
        }
        if (!tab.view.webContents.isDestroyed()) {
            tab.view.webContents.close();
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const tab of this.tabs.splice(0)) this.teardown_tab(tab);
    }
}
