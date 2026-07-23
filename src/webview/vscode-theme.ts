import { useEffect, useState } from 'react';
import type { Theme } from '@glideapps/glide-data-grid';

/**
 * Builds a Glide `Partial<Theme>` from VS Code's `--vscode-*` CSS variables so
 * the canvas grid matches the active color theme (light/dark/high-contrast).
 *
 * The mapping is split into a pure `build_theme_from_vars(get)` — unit-tested
 * with an injected getter, sidestepping jsdom's incomplete custom-property
 * support — and `build_vscode_theme(root)` which feeds it `getComputedStyle`.
 * `use_vscode_theme()` re-reads on theme switches via a MutationObserver.
 */

type VarGetter = (name: string) => string;

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

export function build_theme_from_vars(get: VarGetter): Partial<Theme> {
    const v = (name: string, fallback: string): string => {
        const value = get(name).trim();
        return value || fallback;
    };

    const editor_bg = v('--vscode-editor-background', '#1e1e1e');
    const editor_fg = v('--vscode-editor-foreground', '#d4d4d4');
    const accent = v('--vscode-focusBorder', '#0e639c');
    const accent_fg = v('--vscode-list-activeSelectionForeground', '#ffffff');
    const accent_light = v('--vscode-editor-selectionBackground', 'rgba(14, 99, 156, 0.25)');
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
        baseFontStyle: '13px',
        headerFontStyle: '600 13px',
        editorFontSize: '13px',
    };
}

export function build_vscode_theme(
    root: HTMLElement = document.documentElement,
): Partial<Theme> {
    const style = getComputedStyle(root);
    return build_theme_from_vars((name) => style.getPropertyValue(name));
}

export function is_vscode_high_contrast(body: HTMLElement = document.body): boolean {
    return body.classList.contains('vscode-high-contrast')
        || body.classList.contains('vscode-high-contrast-light');
}

export interface VscodeGridTheme {
    theme: Partial<Theme>;
    highContrast: boolean;
}

function read_vscode_grid_theme(): VscodeGridTheme {
    return {
        theme: build_vscode_theme(),
        highContrast: is_vscode_high_contrast(),
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
