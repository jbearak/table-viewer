// Preload for the Preferences window (desktop/renderer/prefs.ts).
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_GET_THEME,
    CHANNEL_PREFS_GET,
    CHANNEL_PREFS_SET,
    CHANNEL_PREFS_SET_SYNC,
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
import { list_themes, type ThemeId, type ThemeKind, type ThemePayload } from '../main/theme';
import type { DesktopSettings } from '../main/desktop-config';

export interface PrefsApi {
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
    get_settings(): Promise<DesktopSettings>;
    set_settings(partial: Partial<DesktopSettings>): Promise<DesktopSettings>;
    /** Blocking write, for the unload-time flush only: a promise started in
     *  `beforeunload` may never settle before the renderer is torn down. */
    set_settings_sync(partial: Partial<DesktopSettings>): void;
    /** The themes offerable for `kind`. Not IPC: the catalog is compile-time
     *  constant, and preload + main are bundled from the same source by the same
     *  build, so reading it directly is genuinely one source of truth rather
     *  than a fork. If themes ever become user-definable this must become an
     *  IPC fetch. */
    themes_for_kind(kind: ThemeKind): ReadonlyArray<{ id: ThemeId; label: string }>;
    get_theme(): ThemePayload;
    on_theme_changed(listener: (payload: ThemePayload) => void): void;
    on_settings_changed(listener: (settings: DesktopSettings) => void): void;
}

const api: PrefsApi = {
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
    get_settings: () => ipcRenderer.invoke(CHANNEL_PREFS_GET),
    set_settings: (partial) => ipcRenderer.invoke(CHANNEL_PREFS_SET, partial),
    set_settings_sync: (partial) => {
        ipcRenderer.sendSync(CHANNEL_PREFS_SET_SYNC, partial);
    },
    // Only what the dropdown needs, never the variable maps — the renderer paints
    // from the ThemePayload it already receives. `kind` is omitted because it is
    // always the argument the caller just passed.
    themes_for_kind: (kind) => list_themes(kind).map(({ id, label }) => ({ id, label })),
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
