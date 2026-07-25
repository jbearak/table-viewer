// The registry of every theme the desktop app ships: the single source of truth
// for what themes exist, what kind (light/dark) each is, and what palette each
// paints with. Pure module (no electron, no fs) so it is unit-testable and safe
// to bundle into the Preferences preload, which reads the catalog directly.
import {
    BASE_FONT_SIZE,
    MONO_FONT,
    SYSTEM_FONT,
    derive_theme_variables,
    type SemanticPalette,
} from './theme-palette';

/** Which of the two OS appearances a theme belongs to. A theme is only ever
 *  offered while the resolved appearance matches its kind, which is why every
 *  lookup here is keyed by id and reads `kind` off the definition rather than
 *  taking it as a parameter that could disagree. */
export type ThemeKind = 'light' | 'dark';

/**
 * Theme ids are named after the theme, not prefixed by kind (`solarized-light`,
 * not `light-solarized`), because `kind` is an explicit field below — a prefix
 * would be a second, desyncable copy of it.
 *
 * Persisted in settings.v1.json, so treat these as a stable wire format:
 * renaming one silently resets a user's choice (`sanitize_theme_id` rejects the
 * unknown value).
 */
export type ThemeId =
    | 'light'
    | 'solarized-light'
    | 'catppuccin-latte'
    | 'dark'
    | 'solarized-dark'
    | 'catppuccin-frappe'
    | 'catppuccin-macchiato'
    | 'catppuccin-mocha'
    | 'synthwave-84';

export interface ThemeDefinition {
    readonly id: ThemeId;
    readonly kind: ThemeKind;
    /** Shown in the Preferences dropdown. */
    readonly label: string;
    /** The full `--vscode-*` map this theme paints with. */
    readonly variables: Record<string, string>;
}

// --- the two hand-tuned themes ---------------------------------------------
//
// HYBRID AUTHORING, DELIBERATE: these two maps are hand-tuned against VS Code's
// real Dark+/Light+ and are kept verbatim, while the seven ported themes below
// are generated from a SemanticPalette. Please do not "unify" them.
//
// The hand-tuning carries information a 16-role derivation cannot: e.g.
// `--vscode-list-activeSelectionBackground: #04395e` is deliberately a
// different blue from `--vscode-editor-selectionBackground: #264f78`. Rederiving
// them would flatten those distinctions in the app's two most-used themes, churn
// tests that pin exact hex values, and change nothing a user asked for.
// Consumers cannot tell the difference: both kinds end up as ThemeDefinitions.

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

// --- the ported themes ------------------------------------------------------
// Faithful ports, not approximations: the hex values come from upstream (see
// NOTICE.md for attribution and licenses). Where upstream specifies an
// alpha-bearing color, it is flattened onto that theme's own editor background,
// because SemanticPalette values must be opaque 6-digit hex. Where upstream has
// no distinct tone for a role, an in-family tone is reused rather than inventing
// a color; the exceptions are the `accentHover` shades, which upstream themes
// simply do not define and which are hand-darkened (light kinds) or
// hand-lightened (dark kinds) from `accent`.

/* Solarized — (c) 2011 Ethan Schoonover, MIT. base03..base3 + accents.
   Solarized has only a few surface tones by design, so `border`,
   `bgElevated`, and `selection` share values in places. */
const SOLARIZED_LIGHT: SemanticPalette = {
    bg: '#fdf6e3',          // base3
    bgAlt: '#eee8d5',       // base2
    bgElevated: '#ddd6c1',  // the darker base2 upstream's editor port uses for inputs
    fg: '#657b83',          // base00
    fgMuted: '#93a1a1',     // base1
    fgSubtle: '#93a1a1',    // base1 again: no lighter text tone exists
    border: '#ddd6c1',
    accent: '#268bd2',      // blue
    accentHover: '#1f74ad', // hand-darkened blue
    accentFg: '#fdf6e3',    // base3
    selection: '#ddd6c1',
    hover: '#eee8d5',       // base2
    link: '#268bd2',        // blue
    error: '#dc322f',       // red
    warning: '#b58900',     // yellow
    info: '#2aa198',        // cyan
};

const SOLARIZED_DARK: SemanticPalette = {
    bg: '#002b36',          // base03
    bgAlt: '#073642',       // base02
    bgElevated: '#003847',
    fg: '#839496',          // base0
    fgMuted: '#586e75',     // base01
    fgSubtle: '#586e75',    // base01 again: no dimmer text tone exists
    border: '#586e75',      // base01
    accent: '#268bd2',      // blue
    accentHover: '#3fa0e0', // hand-lightened blue
    accentFg: '#fdf6e3',    // base3
    selection: '#005a6f',
    hover: '#073642',       // base02
    link: '#268bd2',
    error: '#dc322f',
    warning: '#b58900',
    info: '#2aa198',
};

/* Catppuccin — (c) 2021 Catppuccin, MIT. palette.json v1.8.0.
   Role mapping follows Catppuccin's own port guidance: base/mantle/surface0 for
   surfaces, text/subtext0/overlay0 for text, surface1 for borders, blue for the
   accent with crust (dark flavors) or base (latte) as the text on it. */
const CATPPUCCIN_LATTE: SemanticPalette = {
    bg: '#eff1f5',          // base
    bgAlt: '#e6e9ef',       // mantle
    bgElevated: '#ccd0da',  // surface0
    fg: '#4c4f69',          // text
    fgMuted: '#6c6f85',     // subtext0
    fgSubtle: '#9ca0b0',    // overlay0
    border: '#bcc0cc',      // surface1
    accent: '#1e66f5',      // blue
    accentHover: '#1a56d0', // hand-darkened blue
    accentFg: '#eff1f5',    // base
    selection: '#acb0be',   // surface2
    hover: '#ccd0da',       // surface0
    link: '#1e66f5',        // blue
    error: '#d20f39',       // red
    warning: '#df8e1d',     // yellow
    info: '#209fb5',        // sapphire
};

const CATPPUCCIN_FRAPPE: SemanticPalette = {
    bg: '#303446', bgAlt: '#292c3c', bgElevated: '#414559',
    fg: '#c6d0f5', fgMuted: '#a5adce', fgSubtle: '#737994',
    border: '#51576d',
    accent: '#8caaee', accentHover: '#9fbaf2', accentFg: '#232634', // crust
    selection: '#626880',   // surface2
    hover: '#414559',       // surface0
    link: '#8caaee', error: '#e78284', warning: '#e5c890', info: '#85c1dc',
};

const CATPPUCCIN_MACCHIATO: SemanticPalette = {
    bg: '#24273a', bgAlt: '#1e2030', bgElevated: '#363a4f',
    fg: '#cad3f5', fgMuted: '#a5adcb', fgSubtle: '#6e738d',
    border: '#494d64',
    accent: '#8aadf4', accentHover: '#9dbcf7', accentFg: '#181926', // crust
    selection: '#5b6078',
    hover: '#363a4f',
    link: '#8aadf4', error: '#ed8796', warning: '#eed49f', info: '#7dc4e4',
};

const CATPPUCCIN_MOCHA: SemanticPalette = {
    bg: '#1e1e2e', bgAlt: '#181825', bgElevated: '#313244',
    fg: '#cdd6f4', fgMuted: '#a6adc8', fgSubtle: '#6c7086',
    border: '#45475a',
    accent: '#89b4fa', accentHover: '#9dc0fb', accentFg: '#11111b', // crust
    selection: '#585b70',
    hover: '#313244',
    link: '#89b4fa', error: '#f38ba8', warning: '#f9e2af', info: '#74c7ec',
};

/* SynthWave '84 — (c) 2019 Robb Owen, MIT.
   Two upstream colors are translucent and are flattened onto the editor
   background (#262335), since palette values must be opaque 6-digit hex:
     editor.selectionBackground  #ffffff20 →  #413f4e
     list.hoverBackground        #37294d99 →  #302743
   `accent` is the signature neon pink (upstream's textLink.activeForeground)
   rather than upstream's focusBorder #1f212b, which is nearly invisible against
   the background — and focusBorder is what draws the grid's current-cell ring. */
const SYNTHWAVE_84: SemanticPalette = {
    bg: '#262335',          // editor.background
    bgAlt: '#241b2f',       // sideBar / tabs background
    bgElevated: '#2a2139',  // input / badge background
    fg: '#ffffff',
    fgMuted: '#b6b1b1',     // punctuation token
    fgSubtle: '#848bbd',    // comment token
    border: '#495495',      // editorGroup.border
    accent: '#ff7edb',
    accentHover: '#ff9ee4', // hand-lightened pink
    accentFg: '#262335',    // dark text on the neon accent
    selection: '#413f4e',   // flattened #ffffff20
    hover: '#302743',       // flattened #37294d99
    link: '#ff7edb',
    error: '#fe4450',       // errorForeground
    warning: '#fede5d',     // keyword token
    info: '#36f9f6',        // function token
};

// --- the registry -----------------------------------------------------------

export const THEME_DEFINITIONS: Record<ThemeId, ThemeDefinition> = {
    light: { id: 'light', kind: 'light', label: 'Light', variables: LIGHT },
    'solarized-light': {
        id: 'solarized-light', kind: 'light', label: 'Solarized Light',
        variables: derive_theme_variables(SOLARIZED_LIGHT),
    },
    'catppuccin-latte': {
        id: 'catppuccin-latte', kind: 'light', label: 'Catppuccin Latte',
        variables: derive_theme_variables(CATPPUCCIN_LATTE),
    },
    dark: { id: 'dark', kind: 'dark', label: 'Dark', variables: DARK },
    'solarized-dark': {
        id: 'solarized-dark', kind: 'dark', label: 'Solarized Dark',
        variables: derive_theme_variables(SOLARIZED_DARK),
    },
    'catppuccin-frappe': {
        id: 'catppuccin-frappe', kind: 'dark', label: 'Catppuccin Frappé',
        variables: derive_theme_variables(CATPPUCCIN_FRAPPE),
    },
    'catppuccin-macchiato': {
        id: 'catppuccin-macchiato', kind: 'dark', label: 'Catppuccin Macchiato',
        variables: derive_theme_variables(CATPPUCCIN_MACCHIATO),
    },
    'catppuccin-mocha': {
        id: 'catppuccin-mocha', kind: 'dark', label: 'Catppuccin Mocha',
        variables: derive_theme_variables(CATPPUCCIN_MOCHA),
    },
    'synthwave-84': {
        id: 'synthwave-84', kind: 'dark', label: "SynthWave '84",
        variables: derive_theme_variables(SYNTHWAVE_84),
    },
};

/** Declaration order is dropdown order: the built-in first, then the ports. */
export const THEME_IDS: readonly ThemeId[] = Object.keys(THEME_DEFINITIONS) as ThemeId[];

/** The theme each mode falls back to — the two hand-tuned VS Code look-alikes. */
export const DEFAULT_THEME_ID: Record<ThemeKind, ThemeId> = {
    light: 'light',
    dark: 'dark',
};

/** Themes offerable while the resolved appearance is `kind`. */
export function list_themes(kind: ThemeKind): ThemeDefinition[] {
    return THEME_IDS
        .map((id) => THEME_DEFINITIONS[id])
        .filter((definition) => definition.kind === kind);
}

/**
 * Coerce an untrusted id into a usable one *of the requested kind*.
 *
 * Rejecting a wrong-kind id matters as much as rejecting an unknown one: the two
 * settings slots are validated against their own fixed kind on every read, so a
 * hand-edited settings file that put `synthwave-84` in `lightThemeId` is caught
 * now rather than the moment the OS flips to light and the app tries to paint a
 * dark theme as its light one.
 */
export function sanitize_theme_id(value: unknown, kind: ThemeKind): ThemeId {
    const definition = typeof value === 'string'
        ? THEME_DEFINITIONS[value as ThemeId]
        : undefined;
    return definition && definition.kind === kind ? definition.id : DEFAULT_THEME_ID[kind];
}

/** The two per-mode theme slots, structurally: a local type rather than
 *  `Pick<DesktopSettings, …>` because desktop-config.ts imports *this* module
 *  (via theme.ts) and the reverse import would close a cycle. */
export interface ThemeSlots {
    readonly lightThemeId: ThemeId;
    readonly darkThemeId: ThemeId;
}

/**
 * Which theme is active right now. The ONLY place this is computed — every
 * background color, page palette, and IPC payload goes through it, so the
 * "which mode" decision (already made by Electron's nativeTheme, which the
 * Appearance preference feeds) and the "which theme for that mode" decision can
 * never drift apart.
 */
export function resolve_theme_id(slots: ThemeSlots, os_dark: boolean): ThemeId {
    return os_dark ? slots.darkThemeId : slots.lightThemeId;
}
