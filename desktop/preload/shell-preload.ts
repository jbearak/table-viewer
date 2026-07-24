// Preload for the main window's tab bar renderer (desktop/renderer/shell.ts).
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_GET_THEME,
    CHANNEL_SHELL_ACTIVATE_TAB,
    CHANNEL_SHELL_CLOSE_TAB,
    CHANNEL_SHELL_GET_TABS,
    CHANNEL_SHELL_OPEN_FILES,
    CHANNEL_SHELL_TABS_CHANGED,
    CHANNEL_THEME_CHANGED,
    type ShellTabInfo,
} from '../shared/ipc';
import type { ThemePayload } from '../main/theme';

export interface ShellApi {
    get_tabs(): Promise<ShellTabInfo[]>;
    activate_tab(id: number): void;
    close_tab(id: number): void;
    open_files(): void;
    on_tabs_changed(listener: (tabs: ShellTabInfo[]) => void): void;
    get_theme(): ThemePayload;
    on_theme_changed(listener: (payload: ThemePayload) => void): void;
}

const api: ShellApi = {
    get_tabs: () => ipcRenderer.invoke(CHANNEL_SHELL_GET_TABS),
    activate_tab: (id) => ipcRenderer.send(CHANNEL_SHELL_ACTIVATE_TAB, id),
    close_tab: (id) => ipcRenderer.send(CHANNEL_SHELL_CLOSE_TAB, id),
    open_files: () => ipcRenderer.send(CHANNEL_SHELL_OPEN_FILES),
    on_tabs_changed: (listener) => {
        ipcRenderer.on(CHANNEL_SHELL_TABS_CHANGED, (_event, tabs: ShellTabInfo[]) => {
            listener(tabs);
        });
    },
    get_theme: () => ipcRenderer.sendSync(CHANNEL_GET_THEME) as ThemePayload,
    on_theme_changed: (listener) => {
        ipcRenderer.on(CHANNEL_THEME_CHANGED, (_event, payload: ThemePayload) => {
            listener(payload);
        });
    },
};

contextBridge.exposeInMainWorld('shellApi', api);
