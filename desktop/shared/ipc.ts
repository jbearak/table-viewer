// IPC channel names shared between the electron main process and the
// preload scripts. Keep in one place so both bundles agree.

/** Webview → host viewer protocol messages (WebviewMessage payloads). */
export const CHANNEL_WEBVIEW_MESSAGE = 'tableViewer:webviewMessage';
/** Host → webview viewer protocol messages (HostMessage payloads). */
export const CHANNEL_HOST_MESSAGE = 'tableViewer:hostMessage';
/** Main → viewer: native File > Save was invoked (synthesize Cmd/Ctrl+S). */
export const CHANNEL_MENU_SAVE = 'tableViewer:menuSave';
/** Sync request from the viewer preload for the initial theme payload. */
export const CHANNEL_GET_THEME = 'tableViewer:getTheme';
/** Main → viewer: OS appearance changed (ThemePayload). */
export const CHANNEL_THEME_CHANGED = 'tableViewer:themeChanged';

/** Shell (tab bar) renderer channels. */
export const CHANNEL_SHELL_GET_TABS = 'shell:getTabs';
export const CHANNEL_SHELL_TABS_CHANGED = 'shell:tabsChanged';
export const CHANNEL_SHELL_ACTIVATE_TAB = 'shell:activateTab';
export const CHANNEL_SHELL_CLOSE_TAB = 'shell:closeTab';
export const CHANNEL_SHELL_OPEN_FILES = 'shell:openFiles';
/** Renderer → main: show the Preferences window (empty-state button). */
export const CHANNEL_SHELL_OPEN_PREFERENCES = 'shell:openPreferences';

/** Preferences window channels. */
export const CHANNEL_PREFS_GET = 'prefs:get';
export const CHANNEL_PREFS_SET = 'prefs:set';
/** Main → every renderer: settings were updated (DesktopSettings payload), so
 *  the app chrome can follow the configured font. */
export const CHANNEL_SETTINGS_CHANGED = 'settings:changed';

export interface ShellTabInfo {
    readonly id: number;
    readonly title: string;
    readonly filePath: string;
    readonly active: boolean;
}
