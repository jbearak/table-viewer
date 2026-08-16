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
 * Persisted in settings.json, so treat these as a stable wire format:
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
    | 'synthwave-84'
    | 'gruvbox-light-hard'
    | 'gruvbox-light-medium'
    | 'gruvbox-light-soft'
    | 'light-high-contrast'
    | 'gruvbox-dark-hard'
    | 'gruvbox-dark-medium'
    | 'gruvbox-dark-soft'
    | 'cyberpunk'
    | 'cyberpunk-scarlet'
    | 'red'
    | 'dark-high-contrast';

export interface ThemeDefinition {
    readonly id: ThemeId;
    readonly kind: ThemeKind;
    /** Shown in the Preferences dropdown. */
    readonly label: string;
    /** The full `--vscode-*` map this theme paints with. */
    readonly variables: Record<string, string>;
    /** Enables the shared webview's high-contrast interaction treatment. */
    readonly highContrast?: boolean;
}

// --- the two hand-tuned themes ---------------------------------------------
//
// HYBRID AUTHORING, DELIBERATE: these two maps are hand-tuned against VS Code's
// real Dark+/Light+ and are kept verbatim, while the ported themes below are
// generated from a SemanticPalette. Please do not "unify" them.
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
// hand-lightened (dark kinds) from `accent` — and a few `hover` fills, hand-mixed
// where upstream's hover tone equals a surface the fill must read against (the
// `hover` invariant on SemanticPalette; the surfaces themselves stay faithful).

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
    // Upstream's hover is base2 = `bgAlt`, an invisible fill on the toolbar
    // and popovers; hand-darkened below `bgElevated` so it reads on both.
    hover: '#cdc5ae',
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
    // Upstream's hover is base02 = `bgAlt`, an invisible fill on the toolbar
    // and popovers; hand-lightened toward `selection` so it reads on both
    // `bgAlt` and `bgElevated` while staying dimmer than a selected row.
    hover: '#0e4756',
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
    // surface1, not surface0: surface0 is `bgElevated`, so secondary buttons
    // would show no hover change (the `hover` invariant on SemanticPalette).
    hover: '#bcc0cc',       // surface1
    link: '#1e66f5',        // blue
    error: '#d20f39',       // red
    warning: '#df8e1d',     // yellow
    info: '#209fb5',        // sapphire
};

const CATPPUCCIN_FRAPPE: SemanticPalette = {
    bg: '#303446',          // base
    bgAlt: '#292c3c',       // mantle
    bgElevated: '#414559',  // surface0
    fg: '#c6d0f5',          // text
    fgMuted: '#a5adce',     // subtext0
    fgSubtle: '#737994',    // overlay0
    border: '#51576d',      // surface1
    accent: '#8caaee',      // blue
    accentHover: '#9fbaf2', // hand-lightened blue
    accentFg: '#232634',    // crust
    selection: '#626880',   // surface2
    // surface1, not surface0: surface0 is `bgElevated`, so secondary buttons
    // would show no hover change (the `hover` invariant on SemanticPalette).
    hover: '#51576d',       // surface1
    link: '#8caaee',        // blue
    error: '#e78284',       // red
    warning: '#e5c890',     // yellow
    info: '#85c1dc',        // sapphire
};

const CATPPUCCIN_MACCHIATO: SemanticPalette = {
    bg: '#24273a',          // base
    bgAlt: '#1e2030',       // mantle
    bgElevated: '#363a4f',  // surface0
    fg: '#cad3f5',          // text
    fgMuted: '#a5adcb',     // subtext0
    fgSubtle: '#6e738d',    // overlay0
    border: '#494d64',      // surface1
    accent: '#8aadf4',      // blue
    accentHover: '#9dbcf7', // hand-lightened blue
    accentFg: '#181926',    // crust
    selection: '#5b6078',   // surface2
    // surface1, not surface0: surface0 is `bgElevated`, so secondary buttons
    // would show no hover change (the `hover` invariant on SemanticPalette).
    hover: '#494d64',       // surface1
    link: '#8aadf4',        // blue
    error: '#ed8796',       // red
    warning: '#eed49f',     // yellow
    info: '#7dc4e4',        // sapphire
};

const CATPPUCCIN_MOCHA: SemanticPalette = {
    bg: '#1e1e2e',          // base
    bgAlt: '#181825',       // mantle
    bgElevated: '#313244',  // surface0
    fg: '#cdd6f4',          // text
    fgMuted: '#a6adc8',     // subtext0
    fgSubtle: '#6c7086',    // overlay0
    border: '#45475a',      // surface1
    accent: '#89b4fa',      // blue
    accentHover: '#9dc0fb', // hand-lightened blue
    accentFg: '#11111b',    // crust
    selection: '#585b70',   // surface2
    // surface1, not surface0: surface0 is `bgElevated`, so secondary buttons
    // would show no hover change (the `hover` invariant on SemanticPalette).
    hover: '#45475a',       // surface1
    link: '#89b4fa',        // blue
    error: '#f38ba8',       // red
    warning: '#f9e2af',     // yellow
    info: '#74c7ec',        // sapphire
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

/* Gruvbox — (c) 2017 Pavel Pertsev, MIT. Palette read from upstream's
   colors/gruvbox.vim; the role mapping follows the VS Code port
   (jdinhify/vscode-theme-gruvbox, MIT) where the two disagree.

   The three contrasts differ ONLY in bg0 — that is gruvbox's own design, not a
   simplification here: `dark0_hard`/`dark0`/`dark0_soft` are three editor
   backgrounds over one shared set of surface, text, and accent tones. So each
   kind is written once and the two off-medium contrasts are that palette with
   `bg` replaced; adding a fourth surface tone to one contrast and not its
   siblings is exactly the drift this avoids.

   Deviations from the port, both because the port's value is invisible in a
   dense grid where ours is a gridline rather than a rarely-seen widget edge:
   - `border` is bg2, not the port's bg1 — bg1 is already `bgAlt` here, so a
     column header and its separators would be the same color.
   - `bgElevated` is bg2, not the port's `input.background` = bg0, which is the
     editor background itself and so cannot read as raised above it.
   `focusBorder` is likewise not ported: upstream sets it to bg1, which as the
   grid's current-cell ring would be nearly invisible, so `accent` is gruvbox's
   blue — the port's own button/link color. */
const GRUVBOX_DARK_MEDIUM: SemanticPalette = {
    bg: '#282828',          // dark0
    bgAlt: '#3c3836',       // dark1
    bgElevated: '#504945',  // dark2
    fg: '#ebdbb2',          // light1
    fgMuted: '#bdae93',     // light3
    fgSubtle: '#928374',    // gray
    border: '#504945',      // dark2
    accent: '#83a598',      // bright_blue
    accentHover: '#9ab5a8', // hand-lightened bright_blue
    accentFg: '#1d2021',    // dark0_hard
    selection: '#665c54',   // dark3
    // Hand-mixed dark1..dark2 midpoint: dark1 is `bgAlt` and dark2 is
    // `bgElevated`, so either verbatim would be an invisible hover fill on
    // one of the surfaces it paints over (the `hover` invariant).
    hover: '#46403d',
    link: '#83a598',        // bright_blue
    error: '#fb4934',       // bright_red
    warning: '#fabd2f',     // bright_yellow
    info: '#458588',        // neutral_blue
};

const GRUVBOX_DARK_HARD: SemanticPalette = { ...GRUVBOX_DARK_MEDIUM, bg: '#1d2021' };
const GRUVBOX_DARK_SOFT: SemanticPalette = { ...GRUVBOX_DARK_MEDIUM, bg: '#32302f' };

/* Light gruvbox is not the dark palette inverted: upstream swaps its accents to
   the `faded_*` family (dark enough to read on cream) while keeping the
   `neutral_*` blue for informational text, so `accent` and `info` differ here in
   the same way they do above. */
const GRUVBOX_LIGHT_MEDIUM: SemanticPalette = {
    bg: '#fbf1c7',          // light0
    bgAlt: '#ebdbb2',       // light1
    bgElevated: '#d5c4a1',  // light2
    fg: '#3c3836',          // dark1
    fgMuted: '#665c54',     // dark3
    fgSubtle: '#928374',    // gray
    border: '#d5c4a1',      // light2
    accent: '#076678',      // faded_blue
    accentHover: '#054f5d', // hand-darkened faded_blue
    accentFg: '#fbf1c7',    // light0
    selection: '#bdae93',   // light3
    // Hand-mixed light1..light2 midpoint: light1 is `bgAlt` and light2 is
    // `bgElevated`, so either verbatim would be an invisible hover fill on
    // one of the surfaces it paints over (the `hover` invariant).
    hover: '#e0cfa9',
    link: '#076678',        // faded_blue
    error: '#9d0006',       // faded_red
    warning: '#b57614',     // faded_yellow
    info: '#458588',        // neutral_blue
};

const GRUVBOX_LIGHT_HARD: SemanticPalette = { ...GRUVBOX_LIGHT_MEDIUM, bg: '#f9f5d7' };
const GRUVBOX_LIGHT_SOFT: SemanticPalette = { ...GRUVBOX_LIGHT_MEDIUM, bg: '#f2e5bc' };

/* Cyberpunk — (c) Max SS, from themes/cyberpunk-color-theme.json (see NOTICE.md
   on which license that repo grants).

   Upstream is a purple editor with neon-green text and a cyan-green emphasis
   color (`badge.background`, `activityBar.foreground`,
   `editorIndentGuide.activeBackground`, `editorLineNumber.activeForeground` are
   all #00ffc8), which is what `accent` takes — `focusBorder` is undefined
   upstream, and the accent draws the grid's current-cell ring. `accentFg` is
   upstream's own `badge.foreground`, the text it pairs with that cyan.

   One translucent color is flattened onto the editor background (#261d45), since
   palette values must be opaque 6-digit hex:
     input.background  #002212ec  →  #032216
   `warning` is `inputValidation.warningBorder`, not `editorWarning.foreground`
   #009550: that green already serves as `input.placeholderForeground` here (our
   `fgSubtle`), and it also tints the find-match highlight, where a dark green
   over the purple background loses the match.
   `border` is the one hand-derived color (as `accentHover` is elsewhere):
   lightened from `bgAlt` toward the Dark+ gridline-to-background ratio, because
   upstream's border tones are either invisible against the purple background
   (`editorGroup.border` #1e2c3f) or the neon #00e676 of `panel.border`, which
   as every gridline in a dense table would fight the text for attention. */
const CYBERPUNK: SemanticPalette = {
    bg: '#261d45',          // editor.background
    bgAlt: '#372963',       // sideBar / tabs background
    bgElevated: '#032216',  // flattened #002212ec
    fg: '#00ff9c',          // editor.foreground
    fgMuted: '#7877b3',     // tab.inactiveForeground
    fgSubtle: '#009550',    // input.placeholderForeground
    border: '#47367d',      // hand-lightened sideBar background
    accent: '#00ffc8',      // badge.background
    accentHover: '#4dffd8', // hand-lightened cyan
    accentFg: '#001107',    // badge.foreground
    selection: '#311b92',   // editor.selectionBackground
    hover: '#100d23',       // list.hoverBackground
    link: '#0084ff',        // textLink.foreground
    error: '#ff3270',       // errorForeground
    warning: '#ff9100',     // inputValidation.warningBorder
    info: '#00c3ff',        // inputValidation.infoBorder
};

/* Cyberpunk Scarlet Protocol — the same extension's scarlet variant (upstream
   labels it "Activate SCARLET protocol"), from
   themes/cyberpunk-scarlet-color-theme.json. Near-black surfaces with scarlet
   text; it shares the cyan `accent`/`warning`/`info` trio with Cyberpunk above,
   which is upstream's arrangement, not a shortcut.

   Upstream's row tints are scarlet at very low alpha over the editor background
   (#101116), and `editor.selectionBackground` is pure #000000. Flattened as
   published, the selected row would be a 1.1:1 fill — invisible in a dense grid
   — so the same #ff0055 tint is flattened at two weights: upstream's own 0x28
   for `hover`, and 0x50 for `selection`, which is where a selected row becomes
   visible while scarlet text on top stays legible.
     list.activeSelectionBackground  #ff005528  →  #360e20   (hover)
     ↑ same tint at 0x50             #ff005550  →  #5b0c2a   (selection) */
const CYBERPUNK_SCARLET: SemanticPalette = {
    bg: '#101116',          // editor.background
    bgAlt: '#0a0b0e',       // sideBar.background
    bgElevated: '#001420',  // input.background
    fg: '#ff0055',          // editor.foreground
    fgMuted: '#ff8ba8',     // sideBarSectionHeader.foreground
    fgSubtle: '#be4e74',    // sideBar.foreground
    border: '#70243d',      // gitDecoration.ignoredResourceForeground
    accent: '#00ffc8',      // badge.background
    accentHover: '#4dffd8', // hand-lightened cyan
    accentFg: '#000807',    // badge.foreground
    selection: '#5b0c2a',   // scarlet tint at 0x50
    hover: '#360e20',       // flattened #ff005528
    link: '#00ffc8',        // textLink.foreground
    error: '#ff3270',       // errorForeground
    warning: '#ff9100',     // inputValidation.warningBorder
    info: '#00c3ff',        // inputValidation.infoBorder
};

/* Red — Copyright (c) Microsoft Corporation, MIT. Ported from VS Code 1.101's
   built-in `vscode.theme-red` (themes/Red-color-theme.json).

   The source theme has separate #330000 tab and #300000 widget surfaces; the
   semantic palette has one shared `bgAlt` role, so the darker widget surface is
   used to preserve contrast with the #580000 raised controls. The source's
   translucent focus border is represented by its opaque #cc3333 badge/progress
   accent, which remains visible as the grid's current-cell ring. VS Code does
   not define button hover, muted/subtle text, warning, or general info colors
   for this theme, so those roles use colors from its token and picker palettes. */
const RED: SemanticPalette = {
    bg: '#390000',          // editor.background
    bgAlt: '#300000',       // editorWidget / editorHoverWidget background
    bgElevated: '#580000',  // input / dropdown background
    fg: '#f8f8f8',          // editor.foreground
    fgMuted: '#cc9999',     // pickerGroup.foreground
    fgSubtle: '#a43f3f',    // editorLineNumber.foreground flattened onto bg
    border: '#611414',      // editorGroup.border flattened onto bg
    accent: '#cc3333',      // badge / progressBar background
    accentHover: '#dc4b4b', // hand-lightened red
    accentFg: '#f8f8f8',
    selection: '#750000',   // editor.selectionBackground
    hover: '#800000',       // list.hoverBackground
    link: '#ffd0aa',        // editorLink.activeForeground
    error: '#ffeaea',       // errorForeground
    warning: '#fec758',     // entity token
    info: '#db7e58',        // inputValidation.infoBorder
};

/* Dark High Contrast — Copyright (c) Microsoft Corporation, MIT. Ported from
   VS Code 1.101's built-in `theme-defaults/themes/hc_black.json` and the
   `hc-black` workbench defaults that accompany it.

   The upstream file intentionally specifies only colors that differ from the
   high-contrast workbench defaults. The semantic roles below combine those
   explicit values (black/white editor, white selection, #383a49 toggled fill)
   with the accompanying HC defaults for focus, links, and status colors. */
const DARK_HIGH_CONTRAST_PALETTE: SemanticPalette = {
    bg: '#000000',          // editor.background
    bgAlt: '#0c0c0c',       // high-contrast secondary surface
    bgElevated: '#1f1f1f',  // high-contrast raised control surface
    fg: '#ffffff',          // editor.foreground
    fgMuted: '#d4d4d4',
    fgSubtle: '#7c7c7c',    // editorWhitespace.foreground
    border: '#ffffff',
    accent: '#f38518',      // hc-black focusBorder
    accentHover: '#ff9a3d', // hand-lightened orange
    accentFg: '#000000',
    selection: '#ffffff',   // editor.selectionBackground
    hover: '#383a49',       // actionBar.toggledBackground
    link: '#21a6ff',        // hc-black textLink.foreground
    error: '#f48771',
    warning: '#ffd370',
    info: '#3794ff',
};

const DARK_HIGH_CONTRAST: Record<string, string> = {
    ...derive_theme_variables(DARK_HIGH_CONTRAST_PALETTE),
    // Unlike ordinary themes, HC controls keep an explicit outline even when
    // their fill already carries the shape.
    '--vscode-button-border': '#6fc3df',
    '--vscode-contrastBorder': '#6fc3df',
    // `editor.selectionBackground` is white upstream, but list selections in
    // hc-black remain black and are distinguished by the cyan contrast border.
    // Reusing white here would paint inherited white labels white-on-white.
    '--vscode-list-activeSelectionBackground': '#000000',
};

/* Light High Contrast — Copyright (c) Microsoft Corporation, MIT. Ported from
   VS Code 1.101's `theme-defaults/themes/hc_light.json` and its `hc-light`
   workbench defaults.

   The upstream JSON is deliberately sparse: most chrome colors are inherited
   from VS Code's workbench. Copying only those sparse overrides into this app
   leaves our explicitly themed toolbar, sheet strip, sort strip, and popovers
   on their dark fallbacks while `foreground` becomes #292929 — dark-on-dark,
   as the regression screenshots in this change demonstrate. This palette
   therefore preserves the upstream white editor, #292929 text, blue focus /
   contrast family, and #dddddd toggled fill while completing them into a light
   surface ladder for the app-specific chrome. */
const LIGHT_HIGH_CONTRAST_PALETTE: SemanticPalette = {
    bg: '#ffffff',
    bgAlt: '#f2f2f2',       // hc-light blockquote/code-block surface
    bgElevated: '#e6e6e6',  // app chrome: raised from bgAlt without going dark
    fg: '#292929',          // hc-light foreground
    fgMuted: '#696969',     // hc-light 70% foreground flattened onto white
    fgSubtle: '#7f7f7f',    // hc-light disabledForeground
    border: '#0f4a85',      // hc-light contrastBorder
    accent: '#006bbd',      // hc-light focusBorder
    accentHover: '#005a9e', // hand-darkened focus blue
    accentFg: '#ffffff',
    selection: '#0f4a85',
    hover: '#dddddd',       // actionBar.toggledBackground
    link: '#0f4a85',        // hc-light textLink.foreground
    error: '#b5200d',       // hc-light errorForeground
    warning: '#895503',
    info: '#0f4a85',        // darkened to keep info-banner text above 4.5:1
};

const LIGHT_HIGH_CONTRAST: Record<string, string> = {
    ...derive_theme_variables(LIGHT_HIGH_CONTRAST_PALETTE),
    '--vscode-button-border': '#0f4a85',
    '--vscode-contrastBorder': '#0f4a85',
    // HC list selections use the page surface plus an explicit focus/contrast
    // outline. A dark filled row would recreate the illegible chrome this port
    // is specifically avoiding.
    '--vscode-list-activeSelectionBackground': '#ffffff',
    '--vscode-list-activeSelectionForeground': '#292929',
    // Keep the upstream disabled tone, but placeholders are readable text rather
    // than disabled controls and need 4.5:1 against the raised input surface.
    '--vscode-input-placeholderForeground': '#5f5f5f',
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
    'gruvbox-light-hard': {
        id: 'gruvbox-light-hard', kind: 'light', label: 'Gruvbox Light Hard',
        variables: derive_theme_variables(GRUVBOX_LIGHT_HARD),
    },
    'gruvbox-light-medium': {
        id: 'gruvbox-light-medium', kind: 'light', label: 'Gruvbox Light Medium',
        variables: derive_theme_variables(GRUVBOX_LIGHT_MEDIUM),
    },
    'gruvbox-light-soft': {
        id: 'gruvbox-light-soft', kind: 'light', label: 'Gruvbox Light Soft',
        variables: derive_theme_variables(GRUVBOX_LIGHT_SOFT),
    },
    'light-high-contrast': {
        id: 'light-high-contrast', kind: 'light', label: 'Light High Contrast',
        variables: LIGHT_HIGH_CONTRAST,
        highContrast: true,
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
    'gruvbox-dark-hard': {
        id: 'gruvbox-dark-hard', kind: 'dark', label: 'Gruvbox Dark Hard',
        variables: derive_theme_variables(GRUVBOX_DARK_HARD),
    },
    'gruvbox-dark-medium': {
        id: 'gruvbox-dark-medium', kind: 'dark', label: 'Gruvbox Dark Medium',
        variables: derive_theme_variables(GRUVBOX_DARK_MEDIUM),
    },
    'gruvbox-dark-soft': {
        id: 'gruvbox-dark-soft', kind: 'dark', label: 'Gruvbox Dark Soft',
        variables: derive_theme_variables(GRUVBOX_DARK_SOFT),
    },
    'synthwave-84': {
        id: 'synthwave-84', kind: 'dark', label: "SynthWave '84",
        variables: derive_theme_variables(SYNTHWAVE_84),
    },
    cyberpunk: {
        id: 'cyberpunk', kind: 'dark', label: 'Cyberpunk',
        variables: derive_theme_variables(CYBERPUNK),
    },
    'cyberpunk-scarlet': {
        id: 'cyberpunk-scarlet', kind: 'dark', label: 'Cyberpunk Scarlet Protocol',
        variables: derive_theme_variables(CYBERPUNK_SCARLET),
    },
    red: {
        id: 'red', kind: 'dark', label: 'Red',
        variables: derive_theme_variables(RED),
    },
    'dark-high-contrast': {
        id: 'dark-high-contrast', kind: 'dark', label: 'Dark High Contrast',
        variables: DARK_HIGH_CONTRAST,
        highContrast: true,
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
 * Color scheme preference feeds) and the "which theme for that mode" decision can
 * never drift apart.
 */
export function resolve_theme_id(slots: ThemeSlots, os_dark: boolean): ThemeId {
    return os_dark ? slots.darkThemeId : slots.lightThemeId;
}
