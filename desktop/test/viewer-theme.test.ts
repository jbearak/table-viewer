// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { apply_theme_to_document, theme_payload } from '../main/theme';

describe('apply_theme_to_document', () => {
    it('applies the palette, color-scheme, and body class for each kind', () => {
        const doc = document.implementation.createHTMLDocument('t');
        apply_theme_to_document(doc, theme_payload('light'));
        expect(doc.documentElement.style.getPropertyValue('--vscode-editor-background'))
            .toBe('#ffffff');
        expect(doc.documentElement.style.colorScheme).toBe('light');
        expect(doc.body.classList.contains('vscode-light')).toBe(true);
        expect(doc.body.classList.contains('vscode-dark')).toBe(false);

        apply_theme_to_document(doc, theme_payload('dark'));
        expect(doc.documentElement.style.getPropertyValue('--vscode-editor-background'))
            .toBe('#1e1e1e');
        expect(doc.documentElement.style.colorScheme).toBe('dark');
        expect(doc.body.classList.contains('vscode-dark')).toBe(true);
        expect(doc.body.classList.contains('vscode-light')).toBe(false);
        expect(doc.body.classList.contains('vscode-high-contrast')).toBe(false);

        apply_theme_to_document(doc, theme_payload('dark-high-contrast'));
        expect(doc.documentElement.style.colorScheme).toBe('dark');
        expect(doc.body.classList.contains('vscode-dark')).toBe(true);
        expect(doc.body.classList.contains('vscode-high-contrast')).toBe(true);

        apply_theme_to_document(doc, theme_payload('light'));
        expect(doc.body.classList.contains('vscode-high-contrast')).toBe(false);

        apply_theme_to_document(doc, theme_payload('light-high-contrast'));
        expect(doc.documentElement.style.colorScheme).toBe('light');
        expect(doc.body.classList.contains('vscode-light')).toBe(true);
        expect(doc.body.classList.contains('vscode-high-contrast')).toBe(false);
        expect(doc.body.classList.contains('vscode-high-contrast-light')).toBe(true);

        apply_theme_to_document(doc, theme_payload('dark-high-contrast'));
        expect(doc.body.classList.contains('vscode-high-contrast')).toBe(true);
        expect(doc.body.classList.contains('vscode-high-contrast-light')).toBe(false);
    });

    // Regression: the viewer preload calls this before the response is parsed,
    // where documentElement and body are both null. Throwing there aborted the
    // whole preload module, taking the theme-changed IPC listener with it — so
    // the viewer never followed the OS light/dark setting at all.
    it('tolerates a document that has no documentElement or body yet', () => {
        const empty = { documentElement: null, body: null } as unknown as Document;
        expect(() => apply_theme_to_document(empty, theme_payload('light'))).not.toThrow();
    });
});
