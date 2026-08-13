// Preload for the stored-file-state inspector window (src/state-inspector/ui.ts).
//
// Mirrors prefs-preload.ts: the renderer gets a narrow, typed surface over the
// context bridge and no access to Node or Electron beyond it.
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_GET_THEME,
    CHANNEL_STATE_INSPECTOR_REQUEST,
    CHANNEL_THEME_CHANGED,
    CHANNEL_TITLEBAR_ACTIVE,
    CHANNEL_TITLEBAR_DRAG,
    CHANNEL_TITLEBAR_ZOOM_WINDOW,
    CHANNEL_TITLEBAR_ACTIVE_CHANGED,
    CHANNEL_TITLEBAR_ZOOM,
    CHANNEL_TITLEBAR_ZOOM_CHANGED,
} from '../shared/ipc';
import { TITLEBAR_HEIGHT } from '../shared/titlebar';
import type { ThemePayload } from '../main/theme';
import type {
    StateInspectorRequest,
    StateInspectorResponse,
} from '../../src/state-inspector/protocol';

export interface StateInspectorApi {
    /** macOS themed title bar: the strip height this window's
     *  renderer must draw and inset for, or 0 where the native bar remains. */
    titlebar_inset: number;
    /** macOS themed title bar: this window's zoom factor, which the
     *  strip divides its metrics by so it stays the size of the window chrome it
     *  replaces, and a subscription to later changes. */
    /** macOS themed title bar: whether this window is the active one,
     *  which dims the title when it is not, and a subscription to later changes. */
    titlebar_active(): boolean;
    on_titlebar_active(listener: (active: boolean) => void): void;
    titlebar_zoom(): number;
    /** macOS themed title bar: a drag over the title text, which main
     *  turns into a window move (the text cannot be a drag region — see
     *  desktop/shared/titlebar.ts). */
    drag_titlebar(phase: 'start' | 'move', x: number, y: number): void;
    /** macOS themed title bar: double-click on the title zooms the
     *  window, like a double-click anywhere else on a title bar. */
    zoom_titlebar_window(): void;
    on_titlebar_zoom(listener: (zoom: number) => void): void;
    request(request: StateInspectorRequest): Promise<StateInspectorResponse>;
    /** Sync, like the other chrome windows: needed before the first paint. */
    get_theme(): ThemePayload;
    on_theme_changed(listener: (payload: ThemePayload) => void): void;
}

const api: StateInspectorApi = {
    zoom_titlebar_window: () => ipcRenderer.send(CHANNEL_TITLEBAR_ZOOM_WINDOW),
    drag_titlebar: (phase, x, y) => ipcRenderer.send(CHANNEL_TITLEBAR_DRAG, phase, x, y),
    titlebar_active: () => ipcRenderer.sendSync(CHANNEL_TITLEBAR_ACTIVE) as boolean,
    on_titlebar_active: (listener) => {
        ipcRenderer.on(CHANNEL_TITLEBAR_ACTIVE_CHANGED, (_event, active: boolean) => {
            listener(active);
        });
    },
    titlebar_zoom: () => ipcRenderer.sendSync(CHANNEL_TITLEBAR_ZOOM) as number,
    on_titlebar_zoom: (listener) => {
        ipcRenderer.on(CHANNEL_TITLEBAR_ZOOM_CHANGED, (_event, zoom: number) => listener(zoom));
    },
    titlebar_inset: process.platform === 'darwin' ? TITLEBAR_HEIGHT : 0,
    request: (request) => ipcRenderer.invoke(CHANNEL_STATE_INSPECTOR_REQUEST, request),
    get_theme: () => ipcRenderer.sendSync(CHANNEL_GET_THEME) as ThemePayload,
    on_theme_changed: (listener) => {
        ipcRenderer.on(CHANNEL_THEME_CHANGED, (_event, payload: ThemePayload) => {
            listener(payload);
        });
    },
};

contextBridge.exposeInMainWorld('stateInspectorApi', api);
