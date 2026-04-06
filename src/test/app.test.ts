// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
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
    vi.unstubAllGlobals();
}

afterEach(() => {
    cleanup();
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
