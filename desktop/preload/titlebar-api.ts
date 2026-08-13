// The title-bar slice of every window's preload API. The four chrome windows
// (About, Preferences, Welcome, state inspector) spread it into the API they
// expose over the context bridge; the viewer consumes it directly in its own
// preload, which installs the strip itself (viewer-preload.ts).
import { ipcRenderer } from 'electron';
import {
    CHANNEL_TITLEBAR_ACTIVE,
    CHANNEL_TITLEBAR_ACTIVE_CHANGED,
    CHANNEL_TITLEBAR_DRAG,
    CHANNEL_TITLEBAR_ZOOM,
    CHANNEL_TITLEBAR_ZOOM_CHANGED,
    CHANNEL_TITLEBAR_ZOOM_WINDOW,
} from '../shared/ipc';
import { titlebar_inset, type TitlebarWindowApi } from '../shared/titlebar';

export type TitlebarApi = TitlebarWindowApi;

export function titlebar_preload_api(): TitlebarApi {
    return {
        titlebar_inset: titlebar_inset(),
        titlebar_active: () => ipcRenderer.sendSync(CHANNEL_TITLEBAR_ACTIVE) as boolean,
        on_titlebar_active: (listener) => {
            ipcRenderer.on(CHANNEL_TITLEBAR_ACTIVE_CHANGED, (_event, active: boolean) => {
                listener(active);
            });
        },
        titlebar_zoom: () => ipcRenderer.sendSync(CHANNEL_TITLEBAR_ZOOM) as number,
        on_titlebar_zoom: (listener) => {
            ipcRenderer.on(CHANNEL_TITLEBAR_ZOOM_CHANGED, (_event, zoom: number) =>
                listener(zoom),
            );
        },
        drag_titlebar: (phase, x, y) => ipcRenderer.send(CHANNEL_TITLEBAR_DRAG, phase, x, y),
        zoom_titlebar_window: () => ipcRenderer.send(CHANNEL_TITLEBAR_ZOOM_WINDOW),
    };
}
