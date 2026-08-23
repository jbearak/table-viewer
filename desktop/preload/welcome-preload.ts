// Preload for the welcome window's renderer (desktop/renderer/welcome.ts).
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
    CHANNEL_GET_THEME,
    CHANNEL_PREFS_GET,
    CHANNEL_SETTINGS_CHANGED,
    CHANNEL_THEME_CHANGED,
    CHANNEL_WELCOME_CLEAR_RECENT,
    CHANNEL_WELCOME_GET_RECENT,
    CHANNEL_WELCOME_OPEN_COMPARE,
    CHANNEL_WELCOME_OPEN_DROPPED,
    CHANNEL_WELCOME_OPEN_FILES,
    CHANNEL_WELCOME_OPEN_PREFERENCES,
    CHANNEL_WELCOME_OPEN_RECENT,
    CHANNEL_WELCOME_RECENT_CHANGED,
} from '../shared/ipc';
import { titlebar_preload_api, type TitlebarApi } from './titlebar-api';
import type { DesktopSettings } from '../main/desktop-config';
import type { RecentEntry } from '../main/recent-documents';
import type { ThemePayload } from '../main/theme';

export interface WelcomeApi extends TitlebarApi {
    open_files(): void;
    open_compare(): void;
    open_preferences(): void;
    /**
     * Open the files behind a drop's `DataTransfer`.
     *
     * Takes the `DataTransferItem`s rather than paths because the renderer
     * cannot resolve them: `File.path` was removed in Electron 32, and its
     * replacement `webUtils.getPathForFile` is only reachable from a preload.
     * Filtering to supported extensions stays in main, which already owns that
     * rule for every other way a file arrives.
     */
    open_dropped(files: readonly File[]): void;
    open_recent(entry: RecentEntry): void;
    clear_recent(): void;
    get_recent(): Promise<readonly RecentEntry[]>;
    on_recent_changed(listener: (entries: readonly RecentEntry[]) => void): void;
    get_theme(): ThemePayload;
    on_theme_changed(listener: (payload: ThemePayload) => void): void;
    get_settings(): Promise<DesktopSettings>;
    on_settings_changed(listener: (settings: DesktopSettings) => void): void;
}

const api: WelcomeApi = {
    ...titlebar_preload_api(),
    open_files: () => ipcRenderer.send(CHANNEL_WELCOME_OPEN_FILES),
    open_compare: () => ipcRenderer.send(CHANNEL_WELCOME_OPEN_COMPARE),
    open_preferences: () => ipcRenderer.send(CHANNEL_WELCOME_OPEN_PREFERENCES),
    open_dropped: (files) => {
        const paths = files
            .map((file) => {
                try {
                    return webUtils.getPathForFile(file);
                } catch {
                    // Not a real filesystem file — a drag from a browser, say.
                    // Dropped rather than reported: the drop carried other
                    // items that may well be openable.
                    return '';
                }
            })
            .filter((file_path) => file_path !== '');
        if (paths.length > 0) ipcRenderer.send(CHANNEL_WELCOME_OPEN_DROPPED, paths);
    },
    open_recent: (entry) => ipcRenderer.send(CHANNEL_WELCOME_OPEN_RECENT, entry),
    clear_recent: () => ipcRenderer.send(CHANNEL_WELCOME_CLEAR_RECENT),
    get_recent: () => ipcRenderer.invoke(CHANNEL_WELCOME_GET_RECENT),
    on_recent_changed: (listener) => {
        ipcRenderer.on(
            CHANNEL_WELCOME_RECENT_CHANGED,
            (_event, entries: readonly RecentEntry[]) => { listener(entries); },
        );
    },
    get_theme: () => ipcRenderer.sendSync(CHANNEL_GET_THEME) as ThemePayload,
    on_theme_changed: (listener) => {
        ipcRenderer.on(CHANNEL_THEME_CHANGED, (_event, payload: ThemePayload) => {
            listener(payload);
        });
    },
    get_settings: () => ipcRenderer.invoke(CHANNEL_PREFS_GET),
    on_settings_changed: (listener) => {
        ipcRenderer.on(CHANNEL_SETTINGS_CHANGED, (_event, settings: DesktopSettings) => {
            listener(settings);
        });
    },
};

contextBridge.exposeInMainWorld('welcomeApi', api);
