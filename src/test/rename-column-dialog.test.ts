// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenameColumnDialog } from '../webview/rename-column-dialog';
import { button, field, set_input_value } from './helpers/dom-interaction';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

function render_dialog() {
    // As App's is: an unchanged name commits nothing, so it reports false.
    const on_commit = vi.fn((value: string) => value !== 'Name');
    const on_cancel = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(RenameColumnDialog, {
        initial: 'Name',
        column_names: ['Name', 'Age'],
        source_column: 0,
        on_commit,
        on_cancel,
    })));
    return { on_commit, on_cancel, input: field('rename-column-name') as HTMLInputElement };
}

const press_enter = (input: HTMLInputElement) => act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
});

describe('RenameColumnDialog', () => {
    it.each([
        ['as it opened', undefined],
        ['with only surrounding spaces added', '  Name '],
    ])('closes on Enter with the name unchanged (%s), as Cancel would', (_case, typed) => {
        const { on_commit, on_cancel, input } = render_dialog();
        if (typed !== undefined) act(() => set_input_value(input, typed));
        expect(button('Rename').disabled).toBe(true);

        press_enter(input);

        expect(on_commit).not.toHaveBeenCalled();
        expect(on_cancel).toHaveBeenCalledTimes(1);
    });

    it('commits a changed name on Enter and closes', () => {
        const { on_commit, on_cancel, input } = render_dialog();
        act(() => set_input_value(input, 'Full name'));

        press_enter(input);

        expect(on_commit).toHaveBeenCalledWith('Full name');
        expect(on_cancel).toHaveBeenCalledTimes(1);
    });

    it('keeps the dialog open on Enter while the name is invalid', () => {
        const { on_commit, on_cancel, input } = render_dialog();
        act(() => set_input_value(input, 'Age'));

        press_enter(input);

        expect(on_commit).not.toHaveBeenCalled();
        expect(on_cancel).not.toHaveBeenCalled();
    });
});
