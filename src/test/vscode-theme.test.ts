import { describe, it, expect } from 'vitest';
import {
    apply_font_family,
    apply_font_size,
    build_edit_tints_from_vars,
    build_theme_from_vars,
    is_vscode_high_contrast,
    theme_font_size_px,
} from '../webview/vscode-theme';

describe('build_theme_from_vars', () => {
    it('maps core VS Code variables onto Glide theme keys', () => {
        const vars: Record<string, string> = {
            '--vscode-editor-background': '#101010',
            '--vscode-editor-foreground': '#eeeeee',
            '--vscode-focusBorder': '#3794ff',
            '--vscode-editor-font-family': 'Fira Code',
        };
        const theme = build_theme_from_vars((name) => vars[name] ?? '');
        expect(theme.bgCell).toBe('#101010');
        expect(theme.textDark).toBe('#eeeeee');
        expect(theme.textHeader).toBe('#eeeeee');
        expect(theme.accentColor).toBe('#3794ff');
        expect(theme.fontFamily).toBe('Fira Code');
    });

    it('prefers the configured table font over the editor font', () => {
        const vars: Record<string, string> = {
            '--table-viewer-font-family': 'Atkinson Hyperlegible',
            '--vscode-editor-font-family': 'Fira Code',
        };
        const theme = build_theme_from_vars((name) => vars[name] ?? '');
        expect(theme.fontFamily).toBe('Atkinson Hyperlegible');
    });

    it('falls back to defaults when a variable is missing/blank', () => {
        const theme = build_theme_from_vars(() => '');
        // Non-empty fallbacks for the essentials.
        expect(theme.bgCell).toBeTruthy();
        expect(theme.textDark).toBeTruthy();
        expect(theme.accentColor).toBeTruthy();
        expect(theme.fontFamily).toBeTruthy();
    });

    it('trims surrounding whitespace from variable values', () => {
        const theme = build_theme_from_vars((name) =>
            name === '--vscode-editor-background' ? '  #abcdef  ' : ''
        );
        expect(theme.bgCell).toBe('#abcdef');
    });

    it('sizes the canvas text from the resolved --tv-font-size', () => {
        const theme = build_theme_from_vars((name) =>
            name === '--tv-font-size' ? '17px' : ''
        );
        expect(theme.baseFontStyle).toBe('17px');
        expect(theme.headerFontStyle).toBe('600 17px');
        expect(theme.editorFontSize).toBe('17px');
        expect(theme_font_size_px(theme)).toBe(17);
    });

    it('falls back to the 13px base when no size is resolvable', () => {
        const theme = build_theme_from_vars(() => '');
        expect(theme.baseFontStyle).toBe('13px');
        expect(theme_font_size_px({})).toBe(13);
    });

    it('clamps an opaque selection background to the translucent fill alpha', () => {
        // Dark+ ships #264f78 opaque; Glide's blend() would let it *replace*
        // the cell background, hiding highlights and edit tints under selection.
        const theme = build_theme_from_vars((name) =>
            name === '--vscode-editor-selectionBackground' ? '#264f78' : ''
        );
        expect(theme.accentLight).toBe('rgba(38, 79, 120, 0.35)');
    });

    it('uses a stronger selection fill alpha in high contrast', () => {
        const theme = build_theme_from_vars(
            (name) => name === '--vscode-editor-selectionBackground' ? '#264f78' : '',
            true,
        );
        expect(theme.accentLight).toBe('rgba(38, 79, 120, 0.5)');
    });

    it('falls back to the default selection fill when the variable is unparseable', () => {
        const theme = build_theme_from_vars((name) =>
            name === '--vscode-editor-selectionBackground' ? 'color-mix(in srgb, red, blue)' : ''
        );
        expect(theme.accentLight).toBe('rgba(38, 79, 120, 0.35)');
    });
});

describe('build_edit_tints_from_vars', () => {
    const from = (vars: Record<string, string>) =>
        build_edit_tints_from_vars((name) => vars[name] ?? '');
    const dirty = (value: string) =>
        from({ '--vscode-editorWarning-foreground': value }).dirtyBg;
    const conflict = (value: string) =>
        from({ '--vscode-errorForeground': value }).conflictBg;

    it('derives both tints from the theme warning/error colors', () => {
        const tints = from({
            '--vscode-editorWarning-foreground': '#df8e1d',
            '--vscode-errorForeground': '#d20f39',
        });
        expect(tints.dirtyBg).toBe('rgba(223, 142, 29, 0.16)');
        expect(tints.conflictBg).toBe('rgba(210, 15, 57, 0.22)');
    });

    it('keeps the historical VS Code appearance when the vars are unset', () => {
        // In the VS Code webview these variables are ambient rather than
        // injected, so they routinely read blank. The tints there must stay
        // byte-identical to the previously hard-coded amber/red.
        const tints = build_edit_tints_from_vars(() => '');
        expect(tints.dirtyBg).toBe('rgba(204, 167, 0, 0.16)');
        expect(tints.conflictBg).toBe('rgba(229, 75, 75, 0.22)');
    });

    it('treats whitespace-only values as unset', () => {
        const tints = from({
            '--vscode-editorWarning-foreground': '   ',
            '--vscode-errorForeground': '\t\n',
        });
        expect(tints.dirtyBg).toBe('rgba(204, 167, 0, 0.16)');
        expect(tints.conflictBg).toBe('rgba(229, 75, 75, 0.22)');
    });

    it('discards any alpha carried by the source color', () => {
        expect(dirty('#df8e1d80')).toBe(dirty('#df8e1d'));
        expect(dirty('#f9e2af00')).toBe(dirty('#f9e2af'));
    });

    it('expands 3- and 4-digit hex', () => {
        expect(dirty('#fc0')).toBe('rgba(255, 204, 0, 0.16)');
        expect(dirty('#fc08')).toBe('rgba(255, 204, 0, 0.16)');
    });

    it('accepts rgb()/rgba() and replaces their alpha', () => {
        expect(conflict('rgba(229, 75, 75, 0.9)')).toBe('rgba(229, 75, 75, 0.22)');
        expect(dirty('rgb(1 2 3 / 50%)')).toBe('rgba(1, 2, 3, 0.16)');
    });

    it('falls back for notations we deliberately do not parse', () => {
        for (const value of [
            'red',
            'transparent',
            'var(--x)',
            '#12345',
            'rgb(50%, 10%, 10%)',
            'color-mix(in srgb, red, blue)',
            // A malformed argument list must not derive a tint from whatever
            // prefix happens to parse.
            'rgb(1 2 3 garbage)',
            'rgb(1, 2, 3, 4, 5)',
            'rgb(0x10 0 0)',
            'rgb(1 2 none)',
        ]) {
            expect(dirty(value), value).toBe('rgba(204, 167, 0, 0.16)');
        }
    });

    it('trims surrounding whitespace from variable values', () => {
        expect(dirty('  #cca700  ')).toBe('rgba(204, 167, 0, 0.16)');
    });
});

describe('apply_font_family', () => {
    function fake_root() {
        const values = new Map<string, string>();
        return {
            style: {
                setProperty: (name: string, value: string) => values.set(name, value),
                removeProperty: (name: string) => values.delete(name),
                getPropertyValue: (name: string) => values.get(name) ?? '',
            },
        } as unknown as HTMLElement;
    }

    it('sets a trimmed override and removes it to restore inheritance', () => {
        const root = fake_root();
        apply_font_family('  Atkinson Hyperlegible  ', root);
        expect(root.style.getPropertyValue('--table-viewer-font-family'))
            .toBe('Atkinson Hyperlegible');

        apply_font_family(null, root);
        expect(root.style.getPropertyValue('--table-viewer-font-family')).toBe('');
    });

    it('writes a px override and clears it for the editor-size fallback', () => {
        const root = fake_root();
        apply_font_size(16, root);
        expect(root.style.getPropertyValue('--table-viewer-font-size')).toBe('16px');

        apply_font_size(null, root);
        expect(root.style.getPropertyValue('--table-viewer-font-size')).toBe('');

        // 0 is the "follow the editor" sentinel, not a real size.
        apply_font_size(16, root);
        apply_font_size(0, root);
        expect(root.style.getPropertyValue('--table-viewer-font-size')).toBe('');
    });
});

describe('is_vscode_high_contrast', () => {
    const body = (class_name: string) => ({
        classList: { contains: (name: string) => class_name.split(' ').includes(name) },
    }) as HTMLElement;

    it('detects both VS Code high-contrast classes', () => {
        expect(is_vscode_high_contrast(body('vscode-high-contrast'))).toBe(true);
        expect(is_vscode_high_contrast(body('vscode-high-contrast-light'))).toBe(true);
        expect(is_vscode_high_contrast(body('vscode-dark'))).toBe(false);
    });
});
