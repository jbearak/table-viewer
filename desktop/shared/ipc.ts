// IPC channel names shared between the electron main process and the
// preload scripts. Keep in one place so both bundles agree.
import type { ViewerSettingTarget } from '../../src/host-ports';

/** Webview → host viewer protocol messages, wrapped with a document token. */
export const CHANNEL_WEBVIEW_MESSAGE = 'tableViewer:webviewMessage';
/** Sync viewer preload → main request for one loaded document's admission token. */
export const CHANNEL_WEBVIEW_DOCUMENT_TOKEN = 'tableViewer:webviewDocumentToken';
/** Host → viewer preload protocol messages. State-backend acknowledgements carry
 * a desktop receipt request so main waits for renderer delivery, not merely send(). */
export const CHANNEL_HOST_MESSAGE = 'tableViewer:hostMessage';
/** Viewer preload → main confirmation that an acknowledgement reached the page. */
export const CHANNEL_HOST_MESSAGE_RECEIPT = 'tableViewer:hostMessageReceipt';

export interface PendingEditAcknowledgementReceipt {
    receiptId: string;
    rendererGeneration: number;
    editSessionId: string;
    sequence: number;
}

export interface DesktopHostMessageEnvelope {
    rendererGeneration: number;
    message: unknown;
    receipt?: PendingEditAcknowledgementReceipt;
}

/** Desktop-only envelope proving which loaded document produced a viewer message. */
export interface DesktopWebviewMessageEnvelope {
    readonly documentToken: string;
    readonly message: unknown;
}

export function is_desktop_webview_message_envelope(
    value: unknown,
): value is DesktopWebviewMessageEnvelope {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && typeof (value as Record<string, unknown>).documentToken === 'string'
        && Object.prototype.hasOwnProperty.call(value, 'message');
}
/** Sync request from the viewer preload for the initial theme payload. */
export const CHANNEL_GET_THEME = 'tableViewer:getTheme';
/** Main → viewer: OS appearance changed (ThemePayload). */
export const CHANNEL_THEME_CHANGED = 'tableViewer:themeChanged';

/** macOS themed title bar. Sync fetch of this window's title and
 *  file path, so the preload can draw the strip the hidden native bar left behind. */
export const CHANNEL_TITLEBAR_INFO = 'tableViewer:titlebarInfo';
/** Cmd-click or right-click on that strip: pop the ancestor-path menu
 *  AppKit's proxy icon would have shown. */
export const CHANNEL_TITLEBAR_PATH_MENU = 'tableViewer:titlebarPathMenu';
/** Sync read of the sending window's zoom factor. The strip counts as
 *  chrome and must not scale with the page, so it divides its metrics by this.
 *  Asked for rather than assumed to be 1: the dialog windows all load from the
 *  same file:// origin, so a zoom set in one is inherited by the next. */
export const CHANNEL_TITLEBAR_ZOOM = 'tableViewer:titlebarZoom';
/** Main → one window: that window's zoom factor changed. */
export const CHANNEL_TITLEBAR_ZOOM_CHANGED = 'tableViewer:titlebarZoomChanged';
/** Sync read of whether the sending window is the active one. The
 *  title dims when it is not, like a native one. `document.hasFocus()` cannot
 *  answer this: it is true in every window of the app at once. */
export const CHANNEL_TITLEBAR_ACTIVE = 'tableViewer:titlebarActive';
/** Main → one window: it just became active, or stopped being. */
export const CHANNEL_TITLEBAR_ACTIVE_CHANGED = 'tableViewer:titlebarActiveChanged';

/** Welcome (launcher) window channels. */
export const CHANNEL_WELCOME_OPEN_FILES = 'welcome:openFiles';
export const CHANNEL_WELCOME_OPEN_PREFERENCES = 'welcome:openPreferences';

/** Preferences window channels. */
export type PreferencesTarget = Extract<
    ViewerSettingTarget,
    'maxFileSizeMiB' | 'csvMaxRows'
>;
export const CHANNEL_PREFS_FOCUS_TARGET = 'prefs:focusTarget';
export const CHANNEL_PREFS_GET = 'prefs:get';
export const CHANNEL_PREFS_SET = 'prefs:set';
/** Same write, synchronously. Only for the flush the Preferences window does as
 *  it closes: an async invoke there races the renderer's teardown, and losing
 *  that race silently drops the edit the user just typed. */
export const CHANNEL_PREFS_SET_SYNC = 'prefs:setSync';
/** Main → every renderer: settings were updated (DesktopSettings payload), so
 *  the app chrome can follow the configured font. */
export const CHANNEL_SETTINGS_CHANGED = 'settings:changed';

/** Non-modal application-update window channels. */
export const CHANNEL_APP_UPDATE_GET_STATE = 'appUpdate:getState';
export const CHANNEL_APP_UPDATE_STATE_CHANGED = 'appUpdate:stateChanged';
export const CHANNEL_APP_UPDATE_ACTION = 'appUpdate:action';

/** About window channels. */
export const CHANNEL_ABOUT_GET_INFO = 'about:getInfo';
export const CHANNEL_ABOUT_OPEN_LINK = 'about:openLink';
export const CHANNEL_ABOUT_OPEN_NOTICES = 'about:openNotices';

/** Stored-file-state inspector window. One channel carries the whole protocol. */
export const CHANNEL_STATE_INSPECTOR_REQUEST = 'stateInspector:request';
