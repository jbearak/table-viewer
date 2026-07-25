// IPC channel names shared between the electron main process and the
// preload scripts. Keep in one place so both bundles agree.

/** Webview → host viewer protocol messages (WebviewMessage payloads). */
export const CHANNEL_WEBVIEW_MESSAGE = 'tableViewer:webviewMessage';
/** Host → webview viewer protocol messages (HostMessage payloads). */
export const CHANNEL_HOST_MESSAGE = 'tableViewer:hostMessage';
/** Sync request from the viewer preload for the initial theme payload. */
export const CHANNEL_GET_THEME = 'tableViewer:getTheme';
/** Main → viewer: OS appearance changed (ThemePayload). */
export const CHANNEL_THEME_CHANGED = 'tableViewer:themeChanged';

/** Welcome (launcher) window channels. */
export const CHANNEL_WELCOME_OPEN_FILES = 'welcome:openFiles';
export const CHANNEL_WELCOME_OPEN_PREFERENCES = 'welcome:openPreferences';

/** Preferences window channels. */
export const CHANNEL_PREFS_GET = 'prefs:get';
export const CHANNEL_PREFS_SET = 'prefs:set';
/** Main → every renderer: settings were updated (DesktopSettings payload), so
 *  the app chrome can follow the configured font. */
export const CHANNEL_SETTINGS_CHANGED = 'settings:changed';

/** About window channels. */
export const CHANNEL_ABOUT_GET_INFO = 'about:getInfo';
export const CHANNEL_ABOUT_OPEN_LINK = 'about:openLink';
export const CHANNEL_ABOUT_OPEN_NOTICES = 'about:openNotices';
