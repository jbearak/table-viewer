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
    CHANNEL_MENU_SAVE,
    CHANNEL_SHELL_TABS_CHANGED,
    CHANNEL_THEME_CHANGED,
    CHANNEL_WEBVIEW_MESSAGE,
    type ShellTabInfo,
} from '../shared/ipc';
import { APP_SCHEME, VIEWER_HOST } from './viewer-html';

export const TAB_BAR_HEIGHT = 38;

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
        void web_contents.loadURL(`${APP_SCHEME}://${VIEWER_HOST}/index.html`);
        this.activate_tab(tab.id);
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

    active_web_contents(): Electron.WebContents | undefined {
        const tab = this.tabs.find((entry) => entry.id === this.active_tab_id);
        const contents = tab?.view.webContents;
        return contents && !contents.isDestroyed() ? contents : undefined;
    }

    /** Trigger the webview's own Cmd/Ctrl+S save path in the active tab. */
    request_save_active(): void {
        this.active_web_contents()?.send(CHANNEL_MENU_SAVE);
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
        const bounds = {
            x: 0,
            y: TAB_BAR_HEIGHT,
            width,
            height: Math.max(0, height - TAB_BAR_HEIGHT),
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
