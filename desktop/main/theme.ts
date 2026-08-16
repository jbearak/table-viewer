// Desktop theme adapter: the shared webview reads `--vscode-*` CSS custom
// properties (see src/webview/vscode-theme.ts and styles.css). Outside VS Code
// nothing sets them, so the desktop shell provides light/dark values that the
// viewer preload applies as inline custom properties on <html> before the
// bundle loads. The webview's MutationObserver on the documentElement `style`
// attribute re-reads the Glide theme whenever these are re-applied.
//
// Pure module (no electron import) so it is unit-testable; main.ts feeds it a
// `ThemeId` resolved by `resolve_theme_id` — the color scheme preference decides
// the *mode*, and the per-mode theme settings decide which theme paints it.
// The registry of shipped themes lives in desktop/main/theme-definitions.ts.
import {
    DEFAULT_THEME_ID,
    THEME_DEFINITIONS,
    type ThemeDefinition,
    type ThemeId,
    type ThemeKind,
} from './theme-definitions';

// Re-exported so callers keep getting the whole theming vocabulary from this
// module; the registry itself lives in theme-definitions.ts.
export type { ThemeId, ThemeKind };
export {
    DEFAULT_THEME_ID,
    THEME_DEFINITIONS,
    THEME_IDS,
    list_themes,
    resolve_theme_id,
    sanitize_theme_id,
    type ThemeDefinition,
} from './theme-definitions';

/** The user's color scheme preference. `system` follows the OS (the default) and is
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

/** Native window background, painted before the page loads and repainted when the
 *  appearance changes — otherwise the frame flashes, or keeps, the wrong color. */
export function window_background_color(id: ThemeId): string {
    return theme_variables(id)['--vscode-editor-background'];
}

/** Unknown ids cannot come from the settings store (it sanitizes both slots),
 *  but this module is also reachable from tests and future callers, so fall back
 *  to Dark rather than throwing in the middle of a first paint. */
function theme_definition(id: ThemeId): ThemeDefinition {
    return THEME_DEFINITIONS[id] ?? THEME_DEFINITIONS[DEFAULT_THEME_ID.dark];
}

function theme_variables(id: ThemeId): Record<string, string> {
    return theme_definition(id).variables;
}

export interface ThemePayload {
    /** Which theme, so a repaint can look up its own colors rather than
     *  re-deriving them from `kind` (which would lose the selection). */
    readonly themeId: ThemeId;
    readonly kind: ThemeKind;
    readonly highContrast: boolean;
    readonly variables: Record<string, string>;
}

export function theme_payload(id: ThemeId): ThemePayload {
    const definition = theme_definition(id);
    return {
        themeId: definition.id,
        // Derived from the registry, never passed in: `kind` and `themeId`
        // disagreeing is exactly the bug this refactor removes.
        kind: definition.kind,
        highContrast: definition.highContrast === true,
        variables: { ...definition.variables },
    };
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
        body.classList.toggle('vscode-high-contrast', payload.highContrast);
        body.classList.toggle('vscode-high-contrast-light', false);
    }
}
