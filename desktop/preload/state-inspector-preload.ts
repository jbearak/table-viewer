// Preload for the stored-file-state inspector window (src/state-inspector/ui.ts).
//
// Mirrors prefs-preload.ts: the renderer gets a narrow, typed surface over the
// context bridge and no access to Node or Electron beyond it.
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_GET_THEME,
    CHANNEL_STATE_INSPECTOR_REQUEST,
    CHANNEL_THEME_CHANGED,
} from '../shared/ipc';
import { titlebar_preload_api, type TitlebarApi } from './titlebar-api';
import type { ThemePayload } from '../main/theme';
import type {
    StateInspectorRequest,
    StateInspectorResponse,
} from '../../src/state-inspector/protocol';

export interface StateInspectorApi extends TitlebarApi {
    request(request: StateInspectorRequest): Promise<StateInspectorResponse>;
    /** Sync, like the other chrome windows: needed before the first paint. */
    get_theme(): ThemePayload;
    on_theme_changed(listener: (payload: ThemePayload) => void): void;
}

const api: StateInspectorApi = {
    ...titlebar_preload_api(),
    request: (request) => ipcRenderer.invoke(CHANNEL_STATE_INSPECTOR_REQUEST, request),
    get_theme: () => ipcRenderer.sendSync(CHANNEL_GET_THEME) as ThemePayload,
    on_theme_changed: (listener) => {
        ipcRenderer.on(CHANNEL_THEME_CHANGED, (_event, payload: ThemePayload) => {
            listener(payload);
        });
    },
};

contextBridge.exposeInMainWorld('stateInspectorApi', api);
