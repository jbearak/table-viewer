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
    CHANNEL_TITLEBAR_ACTIVE,
    CHANNEL_TITLEBAR_DRAG,
    CHANNEL_TITLEBAR_ZOOM_WINDOW,
    CHANNEL_TITLEBAR_ACTIVE_CHANGED,
    CHANNEL_TITLEBAR_ZOOM,
    CHANNEL_TITLEBAR_ZOOM_CHANGED,
} from '../shared/ipc';
import { TITLEBAR_HEIGHT } from '../shared/titlebar';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';

/** Link targets, not URLs: the main process owns the URL list, so the renderer
 *  can never talk shell.openExternal into opening something else. */
export type AboutLink = 'notices' | 'license';

export interface AboutApi {
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
