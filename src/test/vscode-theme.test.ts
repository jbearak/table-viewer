import { describe, it, expect } from 'vitest';
import {
    apply_font_family,
    build_theme_from_vars,
    is_vscode_high_contrast,
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
