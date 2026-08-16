// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellHyperlink } from '../cell-content';
import { HyperlinkDialog, draft_hyperlink } from '../webview/hyperlink-dialog';
import { MAX_HYPERLINK_LENGTH } from '../pending-changes';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
});

function render_dialog(initial: CellHyperlink | null) {
    const on_commit = vi.fn();
    const on_cancel = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(HyperlinkDialog, {
        initial,
        on_commit,
        on_cancel,
    })));
    return { on_commit, on_cancel };
}

function field(id: string): HTMLInputElement | HTMLSelectElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing #${id}`);
    return element as HTMLInputElement | HTMLSelectElement;
}

function button(label: string): HTMLButtonElement {
    const match = Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent === label);
    if (!match) throw new Error(`missing "${label}" button`);
    return match as HTMLButtonElement;
}

function type_into(id: string, value: string): void {
    const input = field(id) as HTMLInputElement;
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe('draft_hyperlink', () => {
    it('normalizes an external target the way the host will at save time', () => {
        expect(draft_hyperlink('external', '  HTTPS://Example.com/a  ', ''))
            .toEqual({ kind: 'external', target: 'https://example.com/a' });
    });

    it('rejects a non-http target rather than offering it', () => {
        expect(draft_hyperlink('external', 'javascript:alert(1)', '')).toBeNull();
        expect(draft_hyperlink('external', 'file:///etc/passwd', '')).toBeNull();
        expect(draft_hyperlink('external', '', '')).toBeNull();
    });

    it('accepts any non-empty internal location and trims it', () => {
        expect(draft_hyperlink('internal', "  'Sheet2'!A1 ", ''))
            .toEqual({ kind: 'internal', location: "'Sheet2'!A1" });
        expect(draft_hyperlink('internal', '   ', '')).toBeNull();
    });

    it('carries a tooltip only when non-blank', () => {
        expect(draft_hyperlink('external', 'https://a.test', ' tip '))
            .toEqual({ kind: 'external', target: 'https://a.test/', tooltip: 'tip' });
        expect(draft_hyperlink('external', 'https://a.test', '   '))
            .toEqual({ kind: 'external', target: 'https://a.test/' });
    });

    it('rejects what host sanitation would strip, rather than accepting it', () => {
        // is_valid_hyperlink bounds every field at 8 KiB; a draft over that is
        // silently dropped downstream, so the dialog must refuse it here.
        const long = 'x'.repeat(MAX_HYPERLINK_LENGTH + 1);
        expect(draft_hyperlink('internal', long, '')).toBeNull();
        expect(draft_hyperlink('internal', 'A1', long)).toBeNull();
        expect(draft_hyperlink('external', `https://a.test/${long}`, '')).toBeNull();
        // Exactly at the bound is still acceptable.
        const at_bound = 'x'.repeat(MAX_HYPERLINK_LENGTH);
        expect(draft_hyperlink('internal', at_bound, '')).not.toBeNull();
    });
});

describe('HyperlinkDialog', () => {
    it('opens with the cell\'s existing link and commits an edited target', () => {
        const { on_commit } = render_dialog({
            kind: 'external',
            target: 'https://old.test/',
            tooltip: 'tip',
        });
        expect((field('hyperlink-kind') as HTMLSelectElement).value).toBe('external');
        expect((field('hyperlink-target') as HTMLInputElement).value)
            .toBe('https://old.test/');
        expect((field('hyperlink-tooltip') as HTMLInputElement).value).toBe('tip');

        type_into('hyperlink-target', 'https://new.test/page');
        act(() => button('Save').click());
        expect(on_commit).toHaveBeenCalledWith({
            kind: 'external',
            target: 'https://new.test/page',
            tooltip: 'tip',
        });
    });

    it('disables Save while the draft is not a valid link and explains why', () => {
        render_dialog(null);
        expect(button('Save').disabled).toBe(true);
        type_into('hyperlink-target', 'not a url');
        expect(button('Save').disabled).toBe(true);
        expect(document.querySelector('.hyperlink-dialog-hint')?.textContent)
            .toContain('http(s)');
        type_into('hyperlink-target', 'https://ok.test');
        expect(button('Save').disabled).toBe(false);
        expect(document.querySelector('.hyperlink-dialog-hint')).toBeNull();
    });

    it('offers Remove link only on a linked cell and commits null', () => {
        render_dialog(null);
        expect(Array.from(document.querySelectorAll('button'))
            .some((candidate) => candidate.textContent === 'Remove link')).toBe(false);
        act(() => root?.unmount());

        const { on_commit } = render_dialog({ kind: 'external', target: 'https://a.test/' });
        act(() => button('Remove link').click());
        expect(on_commit).toHaveBeenCalledWith(null);
    });

    it('cancels on Escape without committing', () => {
        const { on_commit, on_cancel } = render_dialog(null);
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
            }));
        });
        expect(on_cancel).toHaveBeenCalled();
        expect(on_commit).not.toHaveBeenCalled();
    });

    it('commits on Enter in the target field', () => {
        const { on_commit } = render_dialog(null);
        type_into('hyperlink-target', 'https://enter.test');
        const input = field('hyperlink-target');
        act(() => {
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
            }));
        });
        expect(on_commit).toHaveBeenCalledWith({
            kind: 'external',
            target: 'https://enter.test/',
        });
    });

    it('switches to an internal location, which needs no URL scheme', () => {
        const { on_commit } = render_dialog(null);
        const select = field('hyperlink-kind') as HTMLSelectElement;
        act(() => {
            select.value = 'internal';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        type_into('hyperlink-target', "'Sheet2'!B4");
        act(() => button('Save').click());
        expect(on_commit).toHaveBeenCalledWith({
            kind: 'internal',
            location: "'Sheet2'!B4",
        });
    });
});
