// Semantic color roles and the mechanical expansion of them into the
// `--vscode-*` custom properties the app actually paints with.
//
// Why a 16-role intermediate at all: a theme in this app *is* a map of ~50
// `--vscode-*` variables (see desktop/main/theme.ts and src/webview/styles.css).
// Hand-authoring 50 entries per theme is where a port silently omits one and the
// grid falls back to a hardcoded dark color, so ported themes declare 16 roles
// and this module fills in all 50 — one place to get right, and the
// "every theme provides every required variable" test then covers every theme.
//
// Pure module (no electron, no fs) so it is unit-testable and safe to bundle
// into a preload script.

/**
 * A theme's colors, expressed as roles rather than as VS Code variable names.
 *
 * INVARIANT: every value must be a plain opaque 6-digit hex color (`#rrggbb`).
 * `derive_theme_variables` builds a few translucent variables by *concatenating*
 * a two-digit alpha suffix onto these strings, which is only valid for 6-digit
 * hex. Upstream themes that specify an 8-digit (alpha-bearing) color must be
 * flattened onto their own background before being written here; the ported
 * definitions note where that was done.
 *
 * INVARIANT: colors only. Fonts are deliberately absent — the app font is a
 * user preference that applies to the whole app, so a theme must never be able
 * to change it. `derive_theme_variables` hardcodes the font variables.
 */
export interface SemanticPalette {
    /** Editor / page background: the largest surface. */
    readonly bg: string;
    /** Secondary surface: column headers, menus, hover widgets, popovers. */
    readonly bgAlt: string;
    /** Raised controls that must read as "on top of" a surface: inputs,
     *  badges, secondary buttons. */
    readonly bgElevated: string;
    /** Primary text. */
    readonly fg: string;
    /** De-emphasized text: descriptions, hints. */
    readonly fgMuted: string;
    /** Barely-there text: disabled controls, input placeholders. */
    readonly fgSubtle: string;
    /** Separators, gridlines, control outlines. */
    readonly border: string;
    /** The theme's accent: focus rings, primary buttons, selected headers. */
    readonly accent: string;
    /** Accent under the pointer (primary button hover). */
    readonly accentHover: string;
    /** Text drawn *on* `accent`; must contrast with it, not with `bg`. */
    readonly accentFg: string;
    /** Selected-cell / selected-row fill. Drawn over `bg`, with `fg` text on
     *  top, so it must stay legible rather than maximally visible. */
    readonly selection: string;
    /** Row/control hover fill. */
    readonly hover: string;
    /** Hyperlinks. */
    readonly link: string;
    readonly error: string;
    readonly warning: string;
    readonly info: string;
}

// Fonts are app-wide preferences, not theme data — see the SemanticPalette
// invariant. These live here rather than in theme.ts only so that
// theme-definitions.ts (which needs them for the two hand-tuned literal maps)
// can reach them without importing theme.ts, which imports it back.
export const SYSTEM_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Ubuntu', 'Droid Sans', sans-serif";
export const MONO_FONT = "Menlo, Monaco, 'Courier New', monospace";

/** Keep an unavailable configured face on the same fallback as an empty
 * preference. CSS otherwise falls all the way back to its initial serif face
 * when a non-empty family name cannot be resolved. */
export function font_family_with_fallback(configured: string, fallback: string): string {
    const family = configured.trim();
    return family ? `${family}, ${fallback}` : fallback;
}
/** Fallback only: the configured desktop font size is injected ahead of this
 *  by the viewer page bootstrap (--table-viewer-font-size). */
export const BASE_FONT_SIZE = '13px';

/** Alpha suffixes for the handful of variables VS Code themes define as
 *  translucent tints over the editor background. Concatenated onto 6-digit hex
 *  (see the SemanticPalette invariant). */
const HIGHLIGHT_ALPHA = '55';
const BANNER_ALPHA = '33';

/**
 * Expand 16 roles into every entry of `REQUIRED_THEME_VARIABLES`.
 *
 * Kept mechanical on purpose: no color math, only lookups, two literals, and
 * three alpha concatenations. Anything cleverer would need a color library in
 * the main process for no visible gain.
 */
export function derive_theme_variables(palette: SemanticPalette): Record<string, string> {
    const p = palette;
    return {
        // --- grid (src/webview/vscode-theme.ts) ---
        '--vscode-editor-background': p.bg,
        '--vscode-editor-foreground': p.fg,
        '--vscode-focusBorder': p.accent,
        '--vscode-list-activeSelectionForeground': p.accentFg,
        '--vscode-editor-selectionBackground': p.selection,
        '--vscode-editorGroupHeader-tabsBackground': p.bgAlt,
        '--vscode-list-hoverBackground': p.hover,
        '--vscode-editorWidget-border': p.border,
        '--vscode-panel-border': p.border,
        '--vscode-descriptionForeground': p.fgMuted,
        '--vscode-disabledForeground': p.fgSubtle,
        '--vscode-textLink-foreground': p.link,
        // A translucent tint so the matched text stays readable through it.
        '--vscode-editor-findMatchHighlightBackground': `${p.warning}${HIGHLIGHT_ALPHA}`,
        // Fonts never come from the palette — see the SemanticPalette invariant.
        '--vscode-editor-font-family': MONO_FONT,
        '--vscode-font-family': SYSTEM_FONT,
        '--vscode-editor-font-size': BASE_FONT_SIZE,
        '--vscode-font-size': BASE_FONT_SIZE,

        // --- chrome (src/webview/styles.css + the React toolbar) ---
        '--vscode-badge-background': p.bgElevated,
        '--vscode-badge-foreground': p.fg,
        '--vscode-button-background': p.accent,
        // Matches the two hand-tuned themes: the fill carries the shape.
        '--vscode-button-border': 'transparent',
        '--vscode-button-foreground': p.accentFg,
        '--vscode-button-hoverBackground': p.accentHover,
        '--vscode-button-secondaryBackground': p.bgElevated,
        '--vscode-button-secondaryForeground': p.fg,
        '--vscode-button-secondaryHoverBackground': p.hover,
        '--vscode-charts-blue': p.info,
        // Only meaningful in high-contrast themes, which we do not ship.
        '--vscode-contrastBorder': 'transparent',
        '--vscode-editorHoverWidget-background': p.bgAlt,
        '--vscode-editorHoverWidget-foreground': p.fg,
        '--vscode-editorInfo-background': `${p.info}${BANNER_ALPHA}`,
        '--vscode-editorInfo-foreground': p.info,
        '--vscode-editorWarning-background': `${p.warning}${BANNER_ALPHA}`,
        '--vscode-editorWarning-foreground': p.warning,
        '--vscode-editorWidget-background': p.bgAlt,
        '--vscode-errorForeground': p.error,
        '--vscode-foreground': p.fg,
        '--vscode-input-background': p.bgElevated,
        '--vscode-input-border': p.border,
        '--vscode-input-foreground': p.fg,
        '--vscode-input-placeholderForeground': p.fgSubtle,
        // A subtle fill: styles.css draws it under normal-colored text
        // (.highlight-swatch.selected), so accent-on-accentFg would be wrong.
        '--vscode-list-activeSelectionBackground': p.selection,
        '--vscode-menu-background': p.bgAlt,
        '--vscode-menu-border': p.border,
        '--vscode-menu-foreground': p.fg,
        // The one place a background and its foreground are set as a pair
        // (styles.css .context-menu-item:hover), so use the accent pair —
        // `selection` is tuned for normal text on top, not accentFg.
        '--vscode-menu-selectionBackground': p.accent,
        '--vscode-menu-selectionForeground': p.accentFg,
        '--vscode-menu-separatorBackground': p.border,
        '--vscode-textLink-activeForeground': p.link,
        '--vscode-widget-border': p.border,
    };
}
