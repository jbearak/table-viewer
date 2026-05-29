import { describe, it, expect } from 'vitest';
import { build_theme_from_vars } from '../webview/vscode-theme';

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
