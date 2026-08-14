// Narrow bridge for the independent application-update window.
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_APP_UPDATE_ACTION,
    CHANNEL_APP_UPDATE_GET_STATE,
    CHANNEL_APP_UPDATE_STATE_CHANGED,
    CHANNEL_GET_THEME,
    CHANNEL_PREFS_GET,
    CHANNEL_SETTINGS_CHANGED,
    CHANNEL_THEME_CHANGED,
} from '../shared/ipc';
import { titlebar_preload_api, type TitlebarApi } from './titlebar-api';
import type { AppUpdateWindowAction, AppUpdateWindowState } from '../main/app-update-window';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';

export interface AppUpdateApi extends TitlebarApi {
    get_state(): AppUpdateWindowState | undefined;
    perform(action: AppUpdateWindowAction): void;
    on_state_changed(listener: (state: AppUpdateWindowState) => void): void;
    get_theme(): ThemePayload;
    on_theme_changed(listener: (payload: ThemePayload) => void): void;
    get_settings(): Promise<DesktopSettings>;
    on_settings_changed(listener: (settings: DesktopSettings) => void): void;
}

const api: AppUpdateApi = {
    ...titlebar_preload_api(),
    get_state: () => ipcRenderer.sendSync(CHANNEL_APP_UPDATE_GET_STATE) as
        AppUpdateWindowState | undefined,
    perform: (action) => ipcRenderer.send(CHANNEL_APP_UPDATE_ACTION, action),
    on_state_changed: (listener) => {
        ipcRenderer.on(CHANNEL_APP_UPDATE_STATE_CHANGED, (_event, state: AppUpdateWindowState) => {
            listener(state);
        });
    },
    get_theme: () => ipcRenderer.sendSync(CHANNEL_GET_THEME) as ThemePayload,
    on_theme_changed: (listener) => {
        ipcRenderer.on(CHANNEL_THEME_CHANGED, (_event, payload: ThemePayload) => listener(payload));
    },
    get_settings: () => ipcRenderer.invoke(CHANNEL_PREFS_GET),
    on_settings_changed: (listener) => {
        ipcRenderer.on(CHANNEL_SETTINGS_CHANGED, (_event, settings: DesktopSettings) => {
            listener(settings);
        });
    },
};

contextBridge.exposeInMainWorld('appUpdateApi', api);
