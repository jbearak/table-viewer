// Preload for the About window (desktop/renderer/about.ts).
//
// The links go out over IPC rather than calling shell.openExternal here: this
// window is a sandboxed renderer (it clones the Preferences window's
// webPreferences), where only ipcRenderer/contextBridge are available — and the
// main process is where a failure can raise a dialog anyway.
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_ABOUT_GET_INFO,
    CHANNEL_ABOUT_OPEN_LINK,
    CHANNEL_ABOUT_OPEN_NOTICES,
    CHANNEL_GET_THEME,
    CHANNEL_PREFS_GET,
    CHANNEL_SETTINGS_CHANGED,
    CHANNEL_THEME_CHANGED,
} from '../shared/ipc';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';

/** Link targets, not URLs: the main process owns the URL list, so the renderer
 *  can never talk shell.openExternal into opening something else. */
export type AboutLink = 'notices' | 'license';

export interface AboutApi {
    /** Sync, like CHANNEL_GET_THEME: needed before the first paint. */
    get_info(): { version: string };
    open_link(target: AboutLink): void;
    /** Opens the bundled THIRD_PARTY_NOTICES.txt in the system text editor. */
    open_notices(): void;
    get_theme(): ThemePayload;
    on_theme_changed(listener: (payload: ThemePayload) => void): void;
    get_settings(): Promise<DesktopSettings>;
    on_settings_changed(listener: (settings: DesktopSettings) => void): void;
}

const api: AboutApi = {
    get_info: () => ipcRenderer.sendSync(CHANNEL_ABOUT_GET_INFO) as { version: string },
    open_link: (target) => ipcRenderer.send(CHANNEL_ABOUT_OPEN_LINK, target),
    open_notices: () => ipcRenderer.send(CHANNEL_ABOUT_OPEN_NOTICES),
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

contextBridge.exposeInMainWorld('aboutApi', api);
