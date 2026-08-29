import { useEffect, useState } from 'react';
import type { Theme } from './glide-data-grid';
import { DIFF_FALLBACK_COLORS } from './cell-renderer';

/**
 * Builds a Glide `Partial<Theme>` from VS Code's `--vscode-*` CSS variables so
 * the canvas grid matches the active color theme (light/dark/high-contrast).
 *
 * It also derives the two canvas edit tints (pending edit / externally changed)
 * theme's warning and error colors, so they track the active theme instead of
 * being hard-coded amber and red.
 *
 * Both mappings are split into pure `build_*_from_vars(get)` functions —
 * unit-tested with an injected getter, sidestepping jsdom's incomplete
 * custom-property support — and `read_vscode_grid_theme(root)` which feeds them
 * a single `getComputedStyle`. `use_vscode_theme()` re-reads on theme switches
 * via a MutationObserver.
 */

type VarGetter = (name: string) => string;

/** The `--vscode-*` read idiom: trimmed value, or `fallback` when the variable
 *  is absent/blank — which it routinely is in the VS Code webview, where these
 *  are ambient rather than injected. */
function var_reader(get: VarGetter): (name: string, fallback: string) => string {
    return (name, fallback) => get(name).trim() || fallback;
}

/** Base grid/chrome font size when neither the setting nor the host provides
 *  one. Matches the historical hard-coded 13px. */
export const DEFAULT_FONT_SIZE_PX = 13;

export function apply_font_family(
    font_family: string | null,
    root: HTMLElement = document.documentElement,
): void {
    const normalized = font_family?.trim();
    if (normalized) {
        root.style.setProperty('--table-viewer-font-family', normalized);
    } else {
        root.style.removeProperty('--table-viewer-font-family');
    }
}

/** A null/non-positive size means "inherit the host's editor font size", which
 *  the CSS var chain in styles.css already falls back to. */
export function apply_font_size(
    font_size: number | null,
    root: HTMLElement = document.documentElement,
): void {
    if (font_size && Number.isFinite(font_size) && font_size > 0) {
        root.style.setProperty('--table-viewer-font-size', `${font_size}px`);
    } else {
        root.style.removeProperty('--table-viewer-font-size');
    }
}

/** Parse a CSS length that we only ever author in px (`--tv-font-size`). */
export function parse_font_size_px(
    value: string,
    fallback = DEFAULT_FONT_SIZE_PX,
): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Semantic alphas for the two edit tints. Ours, not the theme's: the tint is
 *  painted *under cell text*, so legibility has to be identical on every theme
 *  regardless of what alpha (if any) the source variable carried. */
const DIRTY_TINT_ALPHA = 0.16;
const CONFLICT_TINT_ALPHA = 0.18;

/** Alpha the selection fill (`accentLight`) is clamped to, replacing whatever
 *  alpha `--vscode-editor-selectionBackground` carried. The shipped themes emit
 *  it as opaque hex, and Glide's `blend()` returns an opaque color unchanged —
 *  the selection fill would *replace* the cell background instead of tinting
 *  it, hiding cell highlights and the edit/file-change tints inside a selection.
 *  Translucency of the selection fill is an invariant of the grid: any cell
 *  background (`themeOverride.bgCell`) must stay readable while selected.
 *  High contrast gets a stronger fill, mirroring highlight-theme.ts. */
const SELECTION_TINT_ALPHA = 0.35;
const SELECTION_TINT_ALPHA_HIGH_CONTRAST = 0.5;

/** Fallback channels when `--vscode-editor-selectionBackground` is unset or
 *  unparseable (Dark+'s selection blue). Re-emitted at the clamped alpha, so
 *  the fallback path honours the high-contrast strength too. */
export const SELECTION_BG_FALLBACK_COLOR = '#264f78';

/** The historical hard-coded tints, now the fallback for hosts (the VS Code
 *  webview) where the source variables may be unset. Both round-trip through
 *  `tint_from_color` to themselves. */
export const DIRTY_BG_FALLBACK = 'rgba(204, 167, 0, 0.16)';
export const CONFLICT_BG_FALLBACK = 'rgba(0, 122, 204, 0.18)';

const HEX_RE = /^#([0-9a-f]+)$/i;
const RGB_FN_RE = /^rgba?\(([^)]*)\)$/i;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
/** An alpha may also be a percentage (`rgb(1 2 3 / 50%)`). */
const ALPHA_RE = /^-?\d+(\.\d+)?%?$/;

/**
 * Extract r/g/b from the color notations a `--vscode-*` variable can hold.
 *
 * Deliberately tolerant of more notations than the desktop themes emit (they
 * are all opaque 6-digit hex): in the VS Code webview these variables come from
 * whatever theme extension the user installed, and alpha-bearing hex is already
 * in this codebase's vocabulary (see the `*-background` entries in
 * desktop/main/theme-definitions.ts). Accepted:
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` with comma or
 * space/slash separators. Any alpha present is *read and discarded* — callers
 * re-apply their own. Returns undefined for anything else (named colors,
 * `transparent`, percentages, `color-mix()`, blank), which callers turn into
 * their literal fallback.
 */
export function parse_rgb_channels(value: string): [number, number, number] | undefined {
    const text = value.trim();
    const hex = HEX_RE.exec(text);
    if (hex) {
        const d = hex[1];
        if (d.length === 3 || d.length === 4) {
            return [0, 1, 2].map((i) => Number.parseInt(d[i] + d[i], 16)) as [number, number, number];
        }
        if (d.length === 6 || d.length === 8) {
            return [0, 1, 2].map((i) =>
                Number.parseInt(d.slice(i * 2, i * 2 + 2), 16)) as [number, number, number];
        }
        return undefined;
    }
    const fn = RGB_FN_RE.exec(text);
    if (!fn) return undefined;
    const parts = fn[1].split(/[\s,/]+/).filter((p) => p.length > 0);
    // Exactly three channels plus an optional alpha. Anything longer is
    // malformed, and matching each channel against a decimal literal rather
    // than trusting `Number()` rejects `50%`, `none`, and `0x10` (which
    // `Number()` would happily read as 16).
    if (parts.length !== 3 && parts.length !== 4) return undefined;
    if (!parts.slice(0, 3).every((p) => DECIMAL_RE.test(p))) return undefined;
    // The alpha is discarded, but a junk alpha still means a malformed color:
    // trusting the channels of `rgb(1 2 3 garbage)` would invent a tint.
    if (parts.length === 4 && !ALPHA_RE.test(parts[3])) return undefined;
    return parts.slice(0, 3).map((p) =>
        Math.min(255, Math.max(0, Math.round(Number(p))))) as [number, number, number];
}

/** `color` re-emitted at exactly `alpha`; `fallback` verbatim if unparseable. */
export function tint_from_color(color: string, alpha: number, fallback: string): string {
    const rgb = parse_rgb_channels(color);
    return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : fallback;
}

export interface GridEditTints {
    /** Canvas fill for a cell holding an unsaved edit. */
    dirtyBg: string;
    /** Neutral canvas fill for an edit whose file-side cell changed. */
    conflictBg: string;
}

/** Pure half of the edit-tint derivation (same injected-getter shape as
 *  `build_theme_from_vars`, for the same jsdom reason). */
export function build_edit_tints_from_vars(get: VarGetter): GridEditTints {
    const v = var_reader(get);
    return {
        dirtyBg: tint_from_color(
            v('--vscode-editorWarning-foreground', DIRTY_BG_FALLBACK),
            DIRTY_TINT_ALPHA,
            DIRTY_BG_FALLBACK,
        ),
        conflictBg: tint_from_color(
            v('--vscode-editorInfo-foreground', CONFLICT_BG_FALLBACK),
            CONFLICT_TINT_ALPHA,
            CONFLICT_BG_FALLBACK,
        ),
    };
}

export interface GridDiffColors {
    /** Text color for the "before" side of a Diff-mode cell. */
    diffDeletedFg: string;
    /** Text color for the "after" side of a Diff-mode cell. */
    diffAddedFg: string;
    /** Band color for a row the compare aligner matched across a move. */
    diffMovedFg: string;
}

/**
 * Purple, and the compare window's own token rather than a theme variable.
 *
 * A purely-moved row has no changed cells, so its band is the *only* thing
 * saying it moved — it has to be unmistakably neither added nor deleted.
 * Measured as CIELAB distance from the added and deleted bands at
 * COMPARE_BAND_ALPHA, with added-vs-deleted (11.3 dark / 11.5 light) as the
 * bar for "legibly different", this scores 17.2 and 11.8.
 *
 * `gitDecoration.renamedResourceForeground` is the semantically exact variable
 * and is wrong: VS Code's default for it is a *green* (#73C991), 5-ish from the
 * added band, so a moved row would read as an added one. Amber
 * (`modifiedResourceForeground`) fails for a structural reason rather than a
 * fixable one — it sits between green and red on the hue circle, so every amber
 * tried scored under 6 against its nearer neighbour in at least one mode.
 * Purple is off that axis, and no gitDecoration key is purple. Costless here:
 * GRID_THEME_VARIABLES emits no gitDecoration variables at all, so the desktop
 * window already paints added and deleted from their fallbacks.
 *
 * Defined in styles.css as --tv-compare-moved and read back, the same way the
 * font size is, so the strip's text and the grid's band resolve one value
 * instead of three copies that can silently disagree. The literal here is the
 * fallback for a host that has not applied the stylesheet.
 */
const DIFF_MOVED_FALLBACK = '#9333ea';

/** Diff mode paints text, not tint, so these are the theme's foregrounds read
 *  verbatim — no alpha re-emission (same injected-getter shape as the tints,
 *  for the same jsdom reason). Fallbacks are cell-renderer's own defaults, so
 *  a themed host and a bare one agree on the no-variable colors. */
export function build_diff_colors_from_vars(get: VarGetter): GridDiffColors {
    const v = var_reader(get);
    return {
        diffDeletedFg: v(
            '--vscode-gitDecoration-deletedResourceForeground',
            DIFF_FALLBACK_COLORS.deleted,
        ),
        diffAddedFg: v(
            '--vscode-gitDecoration-addedResourceForeground',
            DIFF_FALLBACK_COLORS.added,
        ),
        diffMovedFg: v('--tv-compare-moved', DIFF_MOVED_FALLBACK),
    };
}

export function build_theme_from_vars(
    get: VarGetter,
    high_contrast = false,
): Partial<Theme> {
    const v = var_reader(get);

    const editor_bg = v('--vscode-editor-background', '#1e1e1e');
    const editor_fg = v('--vscode-editor-foreground', '#d4d4d4');
    const accent = v('--vscode-focusBorder', '#0e639c');
    const accent_fg = v('--vscode-list-activeSelectionForeground', '#ffffff');
    const selection_alpha = high_contrast
        ? SELECTION_TINT_ALPHA_HIGH_CONTRAST
        : SELECTION_TINT_ALPHA;
    const selection_fallback = tint_from_color(
        SELECTION_BG_FALLBACK_COLOR, selection_alpha, SELECTION_BG_FALLBACK_COLOR);
    const accent_light = tint_from_color(
        v('--vscode-editor-selectionBackground', SELECTION_BG_FALLBACK_COLOR),
        selection_alpha,
        selection_fallback,
    );
    const header_bg = v('--vscode-editorGroupHeader-tabsBackground', editor_bg);
    const hover_bg = v('--vscode-list-hoverBackground', header_bg);
    const border = v('--vscode-editorWidget-border', v('--vscode-panel-border', '#454545'));
    const text_medium = v('--vscode-descriptionForeground', editor_fg);
    const text_light = v('--vscode-disabledForeground', text_medium);
    const link = v('--vscode-textLink-foreground', accent);
    const search = v('--vscode-editor-findMatchHighlightBackground', accent_light);
    const font = v(
        '--table-viewer-font-family',
        v('--vscode-editor-font-family', v('--vscode-font-family', 'sans-serif')),
    );
    // styles.css resolves the whole setting → editor-font → default chain into
    // `--tv-font-size`, so the canvas grid and the DOM chrome cannot disagree.
    const font_size_px = parse_font_size_px(
        v('--tv-font-size', `${DEFAULT_FONT_SIZE_PX}px`),
    );

    return {
        accentColor: accent,
        accentFg: accent_fg,
        accentLight: accent_light,
        textDark: editor_fg,
        textMedium: text_medium,
        textLight: text_light,
        textBubble: editor_fg,
        bgIconHeader: header_bg,
        fgIconHeader: editor_fg,
        textHeader: editor_fg,
        textHeaderSelected: accent_fg,
        bgCell: editor_bg,
        bgCellMedium: editor_bg,
        bgHeader: header_bg,
        bgHeaderHasFocus: hover_bg,
        bgHeaderHovered: hover_bg,
        bgBubble: header_bg,
        bgBubbleSelected: accent,
        bgSearchResult: search,
        borderColor: border,
        horizontalBorderColor: border,
        drilldownBorder: border,
        linkColor: link,
        fontFamily: font,
        baseFontStyle: `${font_size_px}px`,
        headerFontStyle: `600 ${font_size_px}px`,
        editorFontSize: `${font_size_px}px`,
    };
}

/** The px size the Glide theme was built with (its `baseFontStyle`). Canvas
 *  measurement and row heights need the number, not the CSS shorthand. */
export function theme_font_size_px(theme: Partial<Theme>): number {
    return parse_font_size_px(theme.baseFontStyle ?? '');
}

export function is_vscode_high_contrast(body: HTMLElement = document.body): boolean {
    return body.classList.contains('vscode-high-contrast')
        || body.classList.contains('vscode-high-contrast-light');
}

export interface VscodeGridTheme extends GridEditTints, GridDiffColors {
    theme: Partial<Theme>;
    highContrast: boolean;
}

/** One `getComputedStyle` feeding both derivations. */
function read_vscode_grid_theme(
    root: HTMLElement = document.documentElement,
    body: HTMLElement = document.body,
): VscodeGridTheme {
    const style = getComputedStyle(root);
    const get: VarGetter = (name) => style.getPropertyValue(name);
    const high_contrast = is_vscode_high_contrast(body);
    return {
        theme: build_theme_from_vars(get, high_contrast),
        ...build_edit_tints_from_vars(get),
        ...build_diff_colors_from_vars(get),
        highContrast: high_contrast,
    };
}

/** React hook: current theme, re-read when VS Code switches color themes
 *  (it mutates the body class / inline custom properties). */
export function use_vscode_theme(): VscodeGridTheme {
    const [value, set_value] = useState<VscodeGridTheme>(read_vscode_grid_theme);
    useEffect(() => {
        const update = () => set_value(read_vscode_grid_theme());
        const observer = new MutationObserver(update);
        const opts: MutationObserverInit = {
            attributes: true,
            attributeFilter: ['class', 'style'],
        };
        observer.observe(document.body, opts);
        observer.observe(document.documentElement, opts);
        return () => observer.disconnect();
    }, []);
    return value;
}
