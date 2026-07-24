// Preload for the Preferences window (desktop/renderer/prefs.ts).
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_GET_THEME,
    CHANNEL_PREFS_GET,
    CHANNEL_PREFS_SET,
    CHANNEL_SETTINGS_CHANGED,
    CHANNEL_THEME_CHANGED,
} from '../shared/ipc';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';

export interface PrefsApi {
    get_settings(): Promise<DesktopSettings>;
    set_settings(partial: Partial<DesktopSettings>): Promise<DesktopSettings>;
    get_theme(): ThemePayload;
    on_theme_changed(listener: (payload: ThemePayload) => void): void;
    on_settings_changed(listener: (settings: DesktopSettings) => void): void;
}

const api: PrefsApi = {
    get_settings: () => ipcRenderer.invoke(CHANNEL_PREFS_GET),
    set_settings: (partial) => ipcRenderer.invoke(CHANNEL_PREFS_SET, partial),
    get_theme: () => ipcRenderer.sendSync(CHANNEL_GET_THEME) as ThemePayload,
    on_theme_changed: (listener) => {
        ipcRenderer.on(CHANNEL_THEME_CHANGED, (_event, payload: ThemePayload) => {
            listener(payload);
        });
    },
    on_settings_changed: (listener) => {
        ipcRenderer.on(CHANNEL_SETTINGS_CHANGED, (_event, settings: DesktopSettings) => {
            listener(settings);
        });
    },
};

contextBridge.exposeInMainWorld('prefsApi', api);
