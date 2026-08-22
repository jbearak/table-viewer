// Preload for the Compare Files dialog (desktop/renderer/compare.ts).
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_COMPARE_BROWSE,
    CHANNEL_COMPARE_CANCEL,
    CHANNEL_COMPARE_CHECK_PATH,
    CHANNEL_COMPARE_SUBMIT,
    CHANNEL_GET_THEME,
    CHANNEL_PREFS_GET,
    CHANNEL_SETTINGS_CHANGED,
    CHANNEL_THEME_CHANGED,
    type ComparePathCheck,
    type CompareFilesRequest,
    type CompareSubmitResult,
} from '../shared/ipc';
import { titlebar_preload_api, type TitlebarApi } from './titlebar-api';
import type { ThemePayload } from '../main/theme';
import type { DesktopSettings } from '../main/desktop-config';

export interface CompareApi extends TitlebarApi {
    /** Native picker for one side; resolves undefined when cancelled. */
    browse(side: 'original' | 'modified'): Promise<string | undefined>;
    check_path(path: string): Promise<ComparePathCheck>;
    submit(request: CompareFilesRequest): Promise<CompareSubmitResult>;
    cancel(): void;
    get_settings(): Promise<DesktopSettings>;
    get_theme(): ThemePayload;
    on_theme_changed(listener: (payload: ThemePayload) => void): void;
    on_settings_changed(listener: (settings: DesktopSettings) => void): void;
}

const api: CompareApi = {
    ...titlebar_preload_api(),
    browse: (side) => ipcRenderer.invoke(CHANNEL_COMPARE_BROWSE, side),
    check_path: (path) => ipcRenderer.invoke(CHANNEL_COMPARE_CHECK_PATH, path),
    submit: (request) => ipcRenderer.invoke(CHANNEL_COMPARE_SUBMIT, request),
    cancel: () => ipcRenderer.send(CHANNEL_COMPARE_CANCEL),
    get_settings: () => ipcRenderer.invoke(CHANNEL_PREFS_GET),
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

contextBridge.exposeInMainWorld('compareApi', api);
