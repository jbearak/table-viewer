// Preload for the welcome window's renderer (desktop/renderer/welcome.ts).
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_GET_THEME,
    CHANNEL_PREFS_GET,
    CHANNEL_SETTINGS_CHANGED,
    CHANNEL_THEME_CHANGED,
    CHANNEL_WELCOME_OPEN_FILES,
    CHANNEL_WELCOME_OPEN_PREFERENCES,
} from '../shared/ipc';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';

export interface WelcomeApi {
    open_files(): void;
    open_preferences(): void;
    get_theme(): ThemePayload;
    on_theme_changed(listener: (payload: ThemePayload) => void): void;
    get_settings(): Promise<DesktopSettings>;
    on_settings_changed(listener: (settings: DesktopSettings) => void): void;
}

const api: WelcomeApi = {
    open_files: () => ipcRenderer.send(CHANNEL_WELCOME_OPEN_FILES),
    open_preferences: () => ipcRenderer.send(CHANNEL_WELCOME_OPEN_PREFERENCES),
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
