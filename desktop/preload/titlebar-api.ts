// The title-bar slice of every chrome window's preload API (About,
// Preferences, Welcome, state inspector). The viewer window is not a consumer:
// its preload installs the strip itself (viewer-preload.ts) instead of exposing
// these members for the renderer to call.
import { ipcRenderer } from 'electron';
import {
    CHANNEL_TITLEBAR_ACTIVE,
    CHANNEL_TITLEBAR_ACTIVE_CHANGED,
    CHANNEL_TITLEBAR_DRAG,
    CHANNEL_TITLEBAR_ZOOM,
    CHANNEL_TITLEBAR_ZOOM_CHANGED,
    CHANNEL_TITLEBAR_ZOOM_WINDOW,
} from '../shared/ipc';
import { TITLEBAR_HEIGHT } from '../shared/titlebar';

export interface TitlebarApi {
    /** macOS themed title bar: the strip height this window's
     *  renderer must draw and inset for, or 0 where the native bar remains. */
    titlebar_inset: number;
    /** macOS themed title bar: whether this window is the active one,
     *  which dims the title when it is not, and a subscription to later changes. */
    titlebar_active(): boolean;
    on_titlebar_active(listener: (active: boolean) => void): void;
    /** macOS themed title bar: this window's zoom factor, which the
     *  strip divides its metrics by so it stays the size of the window chrome it
     *  replaces, and a subscription to later changes. */
    titlebar_zoom(): number;
    on_titlebar_zoom(listener: (zoom: number) => void): void;
    /** macOS themed title bar: a drag over the title text, which main
     *  turns into a window move (the text cannot be a drag region — see
     *  desktop/shared/titlebar.ts). */
    drag_titlebar(phase: 'start' | 'move', x: number, y: number): void;
    /** macOS themed title bar: double-click on the title zooms the
     *  window, like a double-click anywhere else on a title bar. */
    zoom_titlebar_window(): void;
}

export function titlebar_preload_api(): TitlebarApi {
    return {
        titlebar_inset: process.platform === 'darwin' ? TITLEBAR_HEIGHT : 0,
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
