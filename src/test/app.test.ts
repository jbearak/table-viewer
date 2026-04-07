// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellData, HostMessage, WorkbookData } from '../types';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function make_cell(text: string): CellData {
    return {
        raw: text,
        formatted: text,
        bold: false,
        italic: false,
    };
}

function make_workbook(sheet_names: string[]): WorkbookData {
    return {
        hasFormatting: true,
        sheets: sheet_names.map((name) => ({
            name,
            rows: [[make_cell(`${name} value`)]],
            merges: [],
            columnCount: 1,
            rowCount: 1,
        })),
    };
}

function make_preview_workbook(row_count: number): WorkbookData {
    return {
        hasFormatting: false,
        sheets: [{
            name: 'Sheet1',
            rows: Array.from({ length: row_count }, (_, row_index) => [
                make_cell(`row ${row_index}`),
            ]),
            merges: [],
            columnCount: 1,
            rowCount: row_count,
        }],
    };
}

async function render_app() {
    vi.resetModules();
    const post_message = vi.fn();

    vi.stubGlobal('acquireVsCodeApi', () => ({
        postMessage: post_message,
        getState: vi.fn(),
        setState: vi.fn(),
    }));

    const { App } = await import('../webview/app');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
        root!.render(React.createElement(App));
    });

    return { post_message };
}

async function dispatch_host_message(msg: HostMessage) {
    await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: msg }));
    });
}

function get_button(label: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === label
    );
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
}

async function click_button(label: string) {
    await act(async () => {
        get_button(label).click();
    });
}

function workbook_data_message(workbook: WorkbookData): HostMessage {
    return {
        type: 'workbookData',
        data: workbook,
        state: {},
        defaultTabOrientation: 'horizontal',
    };
}

function reload_message(workbook: WorkbookData): HostMessage {
    return {
        type: 'reload',
        data: workbook,
    };
}

function cleanup() {
    act(() => {
        root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
}

function stub_rect(
    element: Element,
    rect: { top: number; bottom: number }
) {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            top: rect.top,
            bottom: rect.bottom,
            left: 0,
            right: 200,
            width: 200,
            height: rect.bottom - rect.top,
            x: 0,
            y: rect.top,
            toJSON() {
                return this;
            },
        }),
    });
}

afterEach(() => {
    cleanup();
});

describe('bold and italic rendering', () => {
    it('renders bold cells with <b> tag when formatting is on', async () => {
        await render_app();
        const workbook: WorkbookData = {
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                rows: [[
                    { raw: 'Normal', formatted: 'Normal', bold: false, italic: false },
                    { raw: 'Bold', formatted: 'Bold', bold: true, italic: false },
                ]],
                merges: [],
                columnCount: 2,
                rowCount: 1,
            }],
        };
        await dispatch_host_message(workbook_data_message(workbook));

        const tds = container!.querySelectorAll('.data-table td');
        expect(tds.length).toBe(2);

        // Normal cell should NOT have <b> tag
        expect(tds[0].querySelector('b')).toBeNull();

        // Bold cell should have <b> tag
        const bold_tag = tds[1].querySelector('b');
        expect(bold_tag).not.toBeNull();
        expect(bold_tag!.textContent).toBe('Bold');
    });

    it('renders bold+italic cells with <b><i> tags', async () => {
        await render_app();
        const workbook: WorkbookData = {
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                rows: [[
                    { raw: 'BoldItalic', formatted: 'BoldItalic', bold: true, italic: true },
                ]],
                merges: [],
                columnCount: 1,
                rowCount: 1,
            }],
        };
        await dispatch_host_message(workbook_data_message(workbook));

        const td = container!.querySelector('.data-table td');
        expect(td).not.toBeNull();

        const bold_tag = td!.querySelector('b');
        expect(bold_tag).not.toBeNull();
        const italic_tag = bold_tag!.querySelector('i');
        expect(italic_tag).not.toBeNull();
        expect(italic_tag!.textContent).toBe('BoldItalic');
    });

    it('renders italic-only cells with <i> tag', async () => {
        await render_app();
        const workbook: WorkbookData = {
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                rows: [[
                    { raw: 'Italic', formatted: 'Italic', bold: false, italic: true },
                ]],
                merges: [],
                columnCount: 1,
                rowCount: 1,
            }],
        };
        await dispatch_host_message(workbook_data_message(workbook));

        const td = container!.querySelector('.data-table td');
        expect(td).not.toBeNull();

        expect(td!.querySelector('b')).toBeNull();
        const italic_tag = td!.querySelector('i');
        expect(italic_tag).not.toBeNull();
        expect(italic_tag!.textContent).toBe('Italic');
    });

    it('hides bold/italic when formatting toggle is off', async () => {
        await render_app();
        const workbook: WorkbookData = {
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                rows: [[
                    { raw: 'Bold', formatted: 'Bold', bold: true, italic: false },
                ]],
                merges: [],
                columnCount: 1,
                rowCount: 1,
            }],
        };
        await dispatch_host_message(workbook_data_message(workbook));

        // Bold should render initially (show_formatting defaults to true)
        let td = container!.querySelector('.data-table td');
        expect(td!.querySelector('b')).not.toBeNull();

        // Toggle formatting off
        await click_button('Formatting');

        // Bold should be removed
        td = container!.querySelector('.data-table td');
        expect(td!.querySelector('b')).toBeNull();
        expect(td!.textContent).toContain('Bold');
    });
});

describe('App auto-fit state', () => {
    it('clears auto-fit state when a new workbook loads', async () => {
        await render_app();
        await dispatch_host_message(
            workbook_data_message(make_workbook(['First sheet']))
        );

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);

        await dispatch_host_message(
            workbook_data_message(make_workbook(['Second sheet']))
        );

        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
    });

    it('clears auto-fit state on live reload', async () => {
        await render_app();
        await dispatch_host_message(
            workbook_data_message(make_workbook(['Reload source']))
        );

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);

        await dispatch_host_message(
            reload_message(make_workbook(['Reloaded workbook']))
        );

        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
    });
});

describe('truncation banner', () => {
    it('renders truncation banner when truncationMessage is present', async () => {
        await render_app();

        await dispatch_host_message({
            type: 'workbookData',
            data: {
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1',
                    rows: [[make_cell('a')]],
                    merges: [],
                    columnCount: 1,
                    rowCount: 1,
                }],
            },
            state: {},
            defaultTabOrientation: 'horizontal',
            truncationMessage: 'Showing 10,000 of 50,000 rows',
            csvEditingSupported: true,
        });

        const banner = container!.querySelector('.truncation-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toBe('Showing 10,000 of 50,000 rows. Editing is disabled for truncated files.');
    });

    it('omits editing-disabled text in preview mode (editing never available)', async () => {
        await render_app();

        await dispatch_host_message({
            type: 'workbookData',
            data: {
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1',
                    rows: [[make_cell('a')]],
                    merges: [],
                    columnCount: 1,
                    rowCount: 1,
                }],
            },
            state: {},
            defaultTabOrientation: 'horizontal',
            truncationMessage: 'Showing 10,000 of 50,000 rows',
            // No csvEditable, no csvEditingSupported — this is preview mode
        });

        const banner = container!.querySelector('.truncation-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toBe('Showing 10,000 of 50,000 rows');
    });

    it('shows editing-disabled text when csvEditingSupported and truncated', async () => {
        await render_app();

        await dispatch_host_message({
            type: 'workbookData',
            data: {
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1',
                    rows: [[make_cell('a')]],
                    merges: [],
                    columnCount: 1,
                    rowCount: 1,
                }],
            },
            state: {},
            defaultTabOrientation: 'horizontal',
            truncationMessage: 'Showing 10,000 of 50,000 rows',
            csvEditable: false,
            csvEditingSupported: true,
        });

        const banner = container!.querySelector('.truncation-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toBe('Showing 10,000 of 50,000 rows. Editing is disabled for truncated files.');
    });

    it('does not render truncation banner when truncationMessage is absent', async () => {
        await render_app();

        await dispatch_host_message({
            type: 'workbookData',
            data: {
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1',
                    rows: [[make_cell('a')]],
                    merges: [],
                    columnCount: 1,
                    rowCount: 1,
                }],
            },
            state: {},
            defaultTabOrientation: 'horizontal',
        });

        const banner = container!.querySelector('.truncation-banner');
        expect(banner).toBeNull();
    });

    it('disables editing when file is truncated', async () => {
        await render_app();

        await dispatch_host_message({
            type: 'workbookData',
            data: make_csv_workbook(),
            state: {},
            defaultTabOrientation: 'horizontal',
            truncationMessage: 'Showing 10,000 of 50,000 rows',
            csvEditable: false,
        });

        // Edit button should not be visible
        const buttons = Array.from(container!.querySelectorAll('button'));
        const edit_button = buttons.find(b => b.textContent === 'Edit');
        expect(edit_button).toBeUndefined();

        // Context menu should not contain "Edit cell"
        const cell = container!.querySelector('td') as HTMLTableCellElement;
        await act(async () => {
            cell.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                clientX: 50,
                clientY: 50,
            }));
        });
        const menu = container!.querySelector('.context-menu');
        expect(menu).not.toBeNull();
        const items = Array.from(menu!.querySelectorAll('.context-menu-item'))
            .map(el => el.textContent);
        expect(items).not.toContain('Edit cell');
    });

    it('disables editing when a reload introduces truncation', async () => {
        await render_app();

        // Initial load: editable, no truncation
        await dispatch_host_message({
            type: 'workbookData',
            data: make_csv_workbook(),
            state: {},
            defaultTabOrientation: 'horizontal',
            csvEditable: true,
        });

        // Edit button should be visible
        const buttons_before = Array.from(container!.querySelectorAll('button'));
        expect(buttons_before.find(b => b.textContent === 'Edit')).toBeDefined();

        // Reload with truncation
        await dispatch_host_message({
            type: 'reload',
            data: make_csv_workbook(),
            truncationMessage: 'Showing 10,000 of 50,000 rows',
            csvEditable: false,
        });

        // Edit button should be gone
        const buttons_after = Array.from(container!.querySelectorAll('button'));
        expect(buttons_after.find(b => b.textContent === 'Edit')).toBeUndefined();
    });
});

describe('preview scroll sync', () => {
    it('posts visibleRowChanged only when the top visible row changes', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'requestAnimationFrame',
            (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
        );
        vi.stubGlobal(
            'cancelAnimationFrame',
            (handle: number) => clearTimeout(handle)
        );

        const { post_message } = await render_app();

        await dispatch_host_message({
            ...workbook_data_message(make_preview_workbook(3)),
            previewMode: true,
        });
        post_message.mockClear();

        const scroller = container!.querySelector('.table-container') as HTMLDivElement;
        const rows = Array.from(
            container!.querySelectorAll('tbody tr')
        ) as HTMLElement[];

        const scroller_rect = { top: 100, bottom: 260 };
        const row_rects = [
            { top: 90, bottom: 120 },
            { top: 120, bottom: 150 },
            { top: 150, bottom: 180 },
        ];

        stub_rect(scroller, scroller_rect);
        rows.forEach((row, index) => stub_rect(row, row_rects[index]));

        await act(async () => {
            scroller.dispatchEvent(new Event('scroll'));
            vi.runAllTimers();
        });
        expect(post_message).toHaveBeenCalledWith({
            type: 'visibleRowChanged',
            row: 0,
        });

        post_message.mockClear();
        await act(async () => {
            scroller.dispatchEvent(new Event('scroll'));
            vi.runAllTimers();
        });
        expect(post_message).not.toHaveBeenCalled();

        row_rects[0].top = 20;
        row_rects[0].bottom = 40;
        row_rects[1].top = 80;
        row_rects[1].bottom = 140;
        row_rects[2].top = 140;
        row_rects[2].bottom = 200;

        await act(async () => {
            scroller.dispatchEvent(new Event('scroll'));
            vi.runAllTimers();
        });
        expect(post_message).toHaveBeenCalledWith({
            type: 'visibleRowChanged',
            row: 1,
        });
    });

    it('scrolls the preview to the requested row', async () => {
        await render_app();

        await dispatch_host_message({
            ...workbook_data_message(make_preview_workbook(3)),
            previewMode: true,
        });

        const scroller = container!.querySelector('.table-container') as HTMLDivElement;
        const rows = Array.from(
            container!.querySelectorAll('tbody tr')
        ) as HTMLElement[];

        scroller.scrollTop = 50;
        stub_rect(scroller, { top: 100, bottom: 260 });
        stub_rect(rows[2], { top: 170, bottom: 200 });

        await dispatch_host_message({ type: 'scrollToRow', row: 2 });

        expect(scroller.scrollTop).toBe(120);
    });

    it('resets scroll position on workbookData when there is no saved state', async () => {
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            cb(0);
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        await render_app();

        await dispatch_host_message({
            ...workbook_data_message(make_preview_workbook(3)),
            previewMode: true,
            state: {
                scrollPosition: [{ top: 120, left: 35 }],
            },
        });

        const scroller = container!.querySelector('.table-container') as HTMLDivElement;
        scroller.scrollTop = 120;
        scroller.scrollLeft = 35;

        await dispatch_host_message({
            ...workbook_data_message(make_preview_workbook(2)),
            previewMode: true,
            state: {},
        });

        expect(scroller.scrollTop).toBe(0);
        expect(scroller.scrollLeft).toBe(0);
    });
});

function make_csv_workbook(): WorkbookData {
    return {
        hasFormatting: false,
        sheets: [{
            name: 'Sheet1',
            rows: [
                [make_cell('a'), make_cell('b')],
                [make_cell('c'), make_cell('d')],
            ],
            merges: [],
            columnCount: 2,
            rowCount: 2,
        }],
    };
}

function csv_workbook_data_message(workbook: WorkbookData): HostMessage {
    return {
        type: 'workbookData',
        data: workbook,
        state: {},
        defaultTabOrientation: 'horizontal',
        csvEditable: true,
    };
}

describe('Context menu edit item', () => {
    it('marks non-editing cells as display-mode cells and removes that state while editing', async () => {
        await render_app();
        await dispatch_host_message(csv_workbook_data_message(make_csv_workbook()));

        const cells = container!.querySelectorAll('td');
        expect(cells[0].classList.contains('display-cell')).toBe(true);
        expect(cells[1].classList.contains('display-cell')).toBe(true);

        await click_button('Edit');
        await act(async () => {
            cells[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });

        expect(cells[0].classList.contains('display-cell')).toBe(false);
        expect(container!.querySelector('.cell-editor-input')).not.toBeNull();
    });
    it('shows "Edit cell" in context menu when csvEditable is true', async () => {
        await render_app();
        await dispatch_host_message(csv_workbook_data_message(make_csv_workbook()));

        // Right-click a cell to open the context menu
        const cell = container!.querySelector('td') as HTMLTableCellElement;
        await act(async () => {
            cell.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                clientX: 50,
                clientY: 50,
            }));
        });

        const menu = container!.querySelector('.context-menu');
        expect(menu).not.toBeNull();
        const items = Array.from(menu!.querySelectorAll('.context-menu-item'))
            .map(el => el.textContent);
        expect(items).toContain('Edit cell');
    });

    it('does not show "Edit cell" when csvEditable is false', async () => {
        await render_app();
        await dispatch_host_message(workbook_data_message(make_csv_workbook()));

        const cell = container!.querySelector('td') as HTMLTableCellElement;
        await act(async () => {
            cell.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                clientX: 50,
                clientY: 50,
            }));
        });

        const menu = container!.querySelector('.context-menu');
        expect(menu).not.toBeNull();
        const items = Array.from(menu!.querySelectorAll('.context-menu-item'))
            .map(el => el.textContent);
        expect(items).not.toContain('Edit cell');
    });

    it('clicking "Edit cell" enters edit mode and starts editing the cell', async () => {
        await render_app();
        await dispatch_host_message(csv_workbook_data_message(make_csv_workbook()));

        // Right-click cell at row 0, col 1
        const cells = container!.querySelectorAll('td');
        const target_cell = cells[1]; // second cell (0,1)
        await act(async () => {
            target_cell.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                clientX: 50,
                clientY: 50,
            }));
        });

        // Click "Edit cell"
        const menu_items = container!.querySelectorAll('.context-menu-item');
        const edit_item = Array.from(menu_items).find(el => el.textContent === 'Edit cell');
        expect(edit_item).toBeDefined();
        await act(async () => {
            (edit_item as HTMLButtonElement).click();
        });

        // Should now have an Edit button active in the toolbar
        const edit_button = get_button('Edit');
        expect(edit_button.classList.contains('active')).toBe(true);

        // Should have the cell editor input visible
        const editor_input = container!.querySelector('.cell-editor-input');
        expect(editor_input).not.toBeNull();
        expect((editor_input as HTMLInputElement).value).toBe('b');
    });

    it('clicking inside the cell editor does not dismiss the editor', async () => {
        await render_app();
        await dispatch_host_message(csv_workbook_data_message(make_csv_workbook()));

        // Enter edit mode and start editing
        await click_button('Edit');
        const cell = container!.querySelector('td') as HTMLTableCellElement;
        await act(async () => {
            cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });

        const editor_input = container!.querySelector('.cell-editor-input') as HTMLInputElement;
        expect(editor_input).not.toBeNull();
        editor_input.focus();
        expect(document.activeElement).toBe(editor_input);

        // Click inside the editor (mousedown bubbles through React's event system)
        await act(async () => {
            editor_input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        });

        // The editor input should still have focus (table's mousedown didn't steal it)
        expect(document.activeElement).toBe(editor_input);
        // And the editor should still be visible
        expect(container!.querySelector('.cell-editor-input')).not.toBeNull();
    });

    it('pressing Enter on a selected cell starts editing it', async () => {
        await render_app();
        await dispatch_host_message(csv_workbook_data_message(make_csv_workbook()));

        // Click cell (0,0) to select it
        const cells = container!.querySelectorAll('td');
        await act(async () => {
            cells[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        });
        await act(async () => {
            cells[0].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        });

        // Press Enter on the table container
        const table_container = container!.querySelector('.table-container') as HTMLDivElement;
        await act(async () => {
            table_container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });

        // Should have enabled edit mode
        const edit_button = get_button('Edit');
        expect(edit_button.classList.contains('active')).toBe(true);

        // Should have the cell editor input visible with cell (0,0) value
        const editor_input = container!.querySelector('.cell-editor-input');
        expect(editor_input).not.toBeNull();
        expect((editor_input as HTMLInputElement).value).toBe('a');
    });

    it('Enter does not start editing when csvEditable is false', async () => {
        await render_app();
        await dispatch_host_message(workbook_data_message(make_csv_workbook()));

        // Click cell (0,0) to select it
        const cells = container!.querySelectorAll('td');
        await act(async () => {
            cells[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        });
        await act(async () => {
            cells[0].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        });

        // Press Enter
        const table_container = container!.querySelector('.table-container') as HTMLDivElement;
        await act(async () => {
            table_container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });

        // Should NOT have the cell editor
        const editor_input = container!.querySelector('.cell-editor-input');
        expect(editor_input).toBeNull();
    });

    it('clicking another cell commits the current edit', async () => {
        await render_app();
        await dispatch_host_message(csv_workbook_data_message(make_csv_workbook()));

        // Enter edit mode and double-click cell (0,0) to edit
        await click_button('Edit');
        const cells = container!.querySelectorAll('td');
        await act(async () => {
            cells[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });

        // Type a new value
        const editor_input = container!.querySelector('.cell-editor-input') as HTMLInputElement;
        expect(editor_input).not.toBeNull();
        await act(async () => {
            // Simulate typing by changing the input value via React's onChange
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            )!.set!;
            nativeInputValueSetter.call(editor_input, 'EDITED');
            editor_input.dispatchEvent(new Event('input', { bubbles: true }));
        });

        // Click on a different cell (0,1) — should commit the edit
        await act(async () => {
            cells[1].dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                button: 0,
            }));
        });

        // The editor should be closed
        expect(container!.querySelector('.cell-editor-input')).toBeNull();

        // The first cell should show the edited value and have a dirty indicator
        const first_cell = cells[0];
        expect(first_cell.textContent).toBe('EDITED');
        expect(first_cell.classList.contains('dirty-cell')).toBe(true);
    });

    it('Escape cancels edit and returns focus to the table container', async () => {
        await render_app();
        await dispatch_host_message(csv_workbook_data_message(make_csv_workbook()));

        // Enter edit mode and double-click cell (0,0) to edit
        await click_button('Edit');
        const cells = container!.querySelectorAll('td');
        await act(async () => {
            cells[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });

        // Editor should be open
        const editor_input = container!.querySelector('.cell-editor-input') as HTMLInputElement;
        expect(editor_input).not.toBeNull();

        // Press Escape to cancel
        await act(async () => {
            editor_input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });

        // Editor should be closed
        expect(container!.querySelector('.cell-editor-input')).toBeNull();

        // Focus should be on the table container
        const table_container = container!.querySelector('.table-container') as HTMLDivElement;
        expect(document.activeElement).toBe(table_container);
    });
});

describe('conflict banner', () => {
    it('re-shows banner when new conflicts appear after Keep All dismissal', async () => {
        await render_app();

        // Load workbook with pre-existing pending edits on cells (0,0) and (0,1)
        await dispatch_host_message({
            type: 'workbookData',
            data: make_csv_workbook(),
            state: {
                pendingEdits: {
                    '0:0': { value: 'X', base: 'a' },
                    '0:1': { value: 'Y', base: 'b' },
                },
            },
            defaultTabOrientation: 'horizontal',
            csvEditable: true,
        });

        // Both cells should be dirty
        expect(container!.querySelectorAll('.dirty-cell').length).toBe(2);

        // Reload: cell (0,0) changed externally → conflict on 0:0
        await dispatch_host_message({
            type: 'reload',
            data: {
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1',
                    rows: [
                        [make_cell('z'), make_cell('b')],
                        [make_cell('c'), make_cell('d')],
                    ],
                    merges: [],
                    columnCount: 2,
                    rowCount: 2,
                }],
            },
        });

        // Banner should be visible (0:0 is conflicted)
        expect(container!.querySelector('.conflict-banner')).not.toBeNull();

        // Dismiss with Keep All
        await click_button('Keep All');
        expect(container!.querySelector('.conflict-banner')).toBeNull();

        // Second reload: cell (0,1) ALSO changed externally → new conflict on 0:1
        await dispatch_host_message({
            type: 'reload',
            data: {
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1',
                    rows: [
                        [make_cell('z'), make_cell('w')],
                        [make_cell('c'), make_cell('d')],
                    ],
                    merges: [],
                    columnCount: 2,
                    rowCount: 2,
                }],
            },
        });

        // Banner should reappear because the conflict set changed (0:1 now conflicted too)
        expect(container!.querySelector('.conflict-banner')).not.toBeNull();
    });
});
