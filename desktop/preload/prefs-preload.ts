// Preload for the Preferences window (desktop/renderer/prefs.ts).
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_GET_THEME,
    CHANNEL_PREFS_GET,
    CHANNEL_PREFS_SET,
    CHANNEL_SETTINGS_CHANGED,
    CHANNEL_THEME_CHANGED,
} from '../shared/ipc';
import { list_themes, type ThemeId, type ThemeKind, type ThemePayload } from '../main/theme';
import type { DesktopSettings } from '../main/desktop-config';

export interface PrefsApi {
    get_settings(): Promise<DesktopSettings>;
    set_settings(partial: Partial<DesktopSettings>): Promise<DesktopSettings>;
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
    get_settings: () => ipcRenderer.invoke(CHANNEL_PREFS_GET),
    set_settings: (partial) => ipcRenderer.invoke(CHANNEL_PREFS_SET, partial),
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
