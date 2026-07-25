// Desktop theme adapter: the shared webview reads `--vscode-*` CSS custom
// properties (see src/webview/vscode-theme.ts and styles.css). Outside VS Code
// nothing sets them, so the desktop shell provides light/dark values that the
// viewer preload applies as inline custom properties on <html> before the
// bundle loads. The webview's MutationObserver on the documentElement `style`
// attribute re-reads the Glide theme whenever these are re-applied.
//
// Pure module (no electron import) so it is unit-testable; main.ts feeds it
// `nativeTheme.shouldUseDarkColors`.

export type ThemeKind = 'light' | 'dark';

/** The user's appearance preference. `system` follows the OS (the default) and is
 *  fed straight to Electron's `nativeTheme.themeSource`, which then decides
 *  `shouldUseDarkColors` for us — so the rest of the theming path is unchanged. */
export type ThemeSetting = 'system' | 'light' | 'dark';

export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'light', 'dark'];

export function sanitize_theme_setting(value: unknown): ThemeSetting {
    return THEME_SETTINGS.includes(value as ThemeSetting) ? (value as ThemeSetting) : 'system';
}

/** Variables consumed by src/webview/vscode-theme.ts (the Glide canvas theme). */
const GRID_THEME_VARIABLES = [
    '--vscode-editor-background',
    '--vscode-editor-foreground',
    '--vscode-focusBorder',
    '--vscode-list-activeSelectionForeground',
    '--vscode-editor-selectionBackground',
    '--vscode-editorGroupHeader-tabsBackground',
    '--vscode-list-hoverBackground',
    '--vscode-editorWidget-border',
    '--vscode-panel-border',
    '--vscode-descriptionForeground',
    '--vscode-disabledForeground',
    '--vscode-textLink-foreground',
    '--vscode-editor-findMatchHighlightBackground',
    '--vscode-editor-font-family',
    '--vscode-font-family',
    '--vscode-editor-font-size',
    '--vscode-font-size',
] as const;

/** Variables consumed by src/webview/styles.css and the React chrome. */
const CHROME_THEME_VARIABLES = [
    '--vscode-badge-background',
    '--vscode-badge-foreground',
    '--vscode-button-background',
    '--vscode-button-border',
    '--vscode-button-foreground',
    '--vscode-button-hoverBackground',
    '--vscode-button-secondaryBackground',
    '--vscode-button-secondaryForeground',
    '--vscode-button-secondaryHoverBackground',
    '--vscode-charts-blue',
    '--vscode-contrastBorder',
    '--vscode-editorHoverWidget-background',
    '--vscode-editorHoverWidget-foreground',
    '--vscode-editorInfo-background',
    '--vscode-editorInfo-foreground',
    '--vscode-editorWarning-background',
    '--vscode-editorWarning-foreground',
    '--vscode-editorWidget-background',
    '--vscode-errorForeground',
    '--vscode-foreground',
    '--vscode-input-background',
    '--vscode-input-border',
    '--vscode-input-foreground',
    '--vscode-input-placeholderForeground',
    '--vscode-list-activeSelectionBackground',
    '--vscode-menu-background',
    '--vscode-menu-border',
    '--vscode-menu-foreground',
    '--vscode-menu-selectionBackground',
    '--vscode-menu-selectionForeground',
    '--vscode-menu-separatorBackground',
    '--vscode-textLink-activeForeground',
    '--vscode-widget-border',
] as const;

export const REQUIRED_THEME_VARIABLES: readonly string[] = [
    ...GRID_THEME_VARIABLES,
    ...CHROME_THEME_VARIABLES,
];

const SYSTEM_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Ubuntu', 'Droid Sans', sans-serif";
const MONO_FONT = "Menlo, Monaco, 'Courier New', monospace";
/** Fallback only: the configured desktop font size is injected ahead of this
 *  by the viewer page bootstrap (--table-viewer-font-size). */
const BASE_FONT_SIZE = '13px';

/** Values loosely follow VS Code's default Dark+ theme. */
const DARK: Record<string, string> = {
    '--vscode-editor-background': '#1e1e1e',
    '--vscode-editor-foreground': '#d4d4d4',
    '--vscode-focusBorder': '#007fd4',
    '--vscode-list-activeSelectionForeground': '#ffffff',
    '--vscode-editor-selectionBackground': '#264f78',
    '--vscode-editorGroupHeader-tabsBackground': '#252526',
    '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-editorWidget-border': '#454545',
    '--vscode-panel-border': '#414141',
    '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-disabledForeground': '#6e6e6e',
    '--vscode-textLink-foreground': '#3794ff',
    '--vscode-editor-findMatchHighlightBackground': '#ea5c0055',
    '--vscode-editor-font-family': MONO_FONT,
    '--vscode-font-family': SYSTEM_FONT,
    '--vscode-editor-font-size': BASE_FONT_SIZE,
    '--vscode-font-size': BASE_FONT_SIZE,
    '--vscode-badge-background': '#4d4d4d',
    '--vscode-badge-foreground': '#ffffff',
    '--vscode-button-background': '#0e639c',
    '--vscode-button-border': 'transparent',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#1177bb',
    '--vscode-button-secondaryBackground': '#3a3d41',
    '--vscode-button-secondaryForeground': '#f3f3f3',
    '--vscode-button-secondaryHoverBackground': '#45494e',
    '--vscode-charts-blue': '#3794ff',
    '--vscode-contrastBorder': 'transparent',
    '--vscode-editorHoverWidget-background': '#252526',
    '--vscode-editorHoverWidget-foreground': '#cccccc',
    '--vscode-editorInfo-background': '#063b4966',
    '--vscode-editorInfo-foreground': '#3794ff',
    '--vscode-editorWarning-background': '#35250a66',
    '--vscode-editorWarning-foreground': '#cca700',
    '--vscode-editorWidget-background': '#252526',
    '--vscode-errorForeground': '#f48771',
    '--vscode-foreground': '#cccccc',
    '--vscode-input-background': '#3c3c3c',
    '--vscode-input-border': 'transparent',
    '--vscode-input-foreground': '#cccccc',
    '--vscode-input-placeholderForeground': '#a6a6a6',
    '--vscode-list-activeSelectionBackground': '#04395e',
    '--vscode-menu-background': '#252526',
    '--vscode-menu-border': '#454545',
    '--vscode-menu-foreground': '#cccccc',
    '--vscode-menu-selectionBackground': '#04395e',
    '--vscode-menu-selectionForeground': '#ffffff',
    '--vscode-menu-separatorBackground': '#454545',
    '--vscode-textLink-activeForeground': '#3794ff',
    '--vscode-widget-border': '#454545',
};

/** Values loosely follow VS Code's default Light+ theme. */
const LIGHT: Record<string, string> = {
    '--vscode-editor-background': '#ffffff',
    '--vscode-editor-foreground': '#3b3b3b',
    '--vscode-focusBorder': '#0090f1',
    '--vscode-list-activeSelectionForeground': '#ffffff',
    '--vscode-editor-selectionBackground': '#add6ff',
    '--vscode-editorGroupHeader-tabsBackground': '#f8f8f8',
    '--vscode-list-hoverBackground': '#e8e8e8',
    '--vscode-editorWidget-border': '#c8c8c8',
    '--vscode-panel-border': '#e5e5e5',
    '--vscode-descriptionForeground': '#717171',
    '--vscode-disabledForeground': '#a0a0a0',
    '--vscode-textLink-foreground': '#005fb8',
    '--vscode-editor-findMatchHighlightBackground': '#ea5c0055',
    '--vscode-editor-font-family': MONO_FONT,
    '--vscode-font-family': SYSTEM_FONT,
    '--vscode-editor-font-size': BASE_FONT_SIZE,
    '--vscode-font-size': BASE_FONT_SIZE,
    '--vscode-badge-background': '#cccccc',
    '--vscode-badge-foreground': '#3b3b3b',
    '--vscode-button-background': '#005fb8',
    '--vscode-button-border': 'transparent',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#0258a8',
    '--vscode-button-secondaryBackground': '#e5e5e5',
    '--vscode-button-secondaryForeground': '#3b3b3b',
    '--vscode-button-secondaryHoverBackground': '#cccccc',
    '--vscode-charts-blue': '#005fb8',
    '--vscode-contrastBorder': 'transparent',
    '--vscode-editorHoverWidget-background': '#f8f8f8',
    '--vscode-editorHoverWidget-foreground': '#3b3b3b',
    '--vscode-editorInfo-background': '#dceafc66',
    '--vscode-editorInfo-foreground': '#1a85ff',
    '--vscode-editorWarning-background': '#fff8dc66',
    '--vscode-editorWarning-foreground': '#bf8803',
    '--vscode-editorWidget-background': '#f8f8f8',
    '--vscode-errorForeground': '#f85149',
    '--vscode-foreground': '#3b3b3b',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-border': '#cecece',
    '--vscode-input-foreground': '#3b3b3b',
    '--vscode-input-placeholderForeground': '#767676',
    '--vscode-list-activeSelectionBackground': '#e8e8e8',
    '--vscode-menu-background': '#ffffff',
    '--vscode-menu-border': '#cecece',
    '--vscode-menu-foreground': '#3b3b3b',
    '--vscode-menu-selectionBackground': '#005fb8',
    '--vscode-menu-selectionForeground': '#ffffff',
    '--vscode-menu-separatorBackground': '#d4d4d4',
    '--vscode-textLink-activeForeground': '#005fb8',
    '--vscode-widget-border': '#c8c8c8',
};

/** Native window background, painted before the page loads and repainted when the
 *  appearance changes — otherwise the frame flashes, or keeps, the wrong color. */
export function window_background_color(kind: ThemeKind): string {
    return (kind === 'dark' ? DARK : LIGHT)['--vscode-editor-background'];
}

/** Also set on <html> so the page background matches before CSS loads. */
export function theme_css_variables(kind: ThemeKind): Record<string, string> {
    return { ...(kind === 'dark' ? DARK : LIGHT) };
}

export interface ThemePayload {
    readonly kind: ThemeKind;
    readonly variables: Record<string, string>;
}

export function theme_payload(dark: boolean): ThemePayload {
    const kind: ThemeKind = dark ? 'dark' : 'light';
    return { kind, variables: theme_css_variables(kind) };
}

/**
 * Applies a payload to a viewer document. Used by the viewer preload when the OS
 * appearance changes (the initial palette is baked into the page HTML instead).
 *
 * Deliberately tolerant of a half-built document: a preload script runs before
 * the response is parsed, so `documentElement` and `body` can both still be
 * null, and a throw there aborts the *entire* preload module — which is how the
 * viewer previously lost its theme listener (and thus never switched themes) as
 * well as its first paint.
 */
export function apply_theme_to_document(doc: Document, payload: ThemePayload): void {
    const root = doc.documentElement;
    if (root) {
        for (const [name, value] of Object.entries(payload.variables)) {
            root.style.setProperty(name, value);
        }
        root.style.colorScheme = payload.kind;
    }
    const body = doc.body;
    if (body) {
        body.classList.toggle('vscode-dark', payload.kind === 'dark');
        body.classList.toggle('vscode-light', payload.kind === 'light');
    }
}
