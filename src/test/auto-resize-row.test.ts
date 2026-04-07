// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { auto_resize_row_after_edit } from '../webview/auto-resize-row';

function make_table(row_count: number, row_heights: number[]): HTMLTableElement {
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    for (let i = 0; i < row_count; i++) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.textContent = `row ${i}`;
        tr.appendChild(td);
        tbody.appendChild(tr);
        // jsdom doesn't compute layout, so we mock scrollHeight
        Object.defineProperty(tr, 'scrollHeight', { value: row_heights[i], configurable: true });
    }
    return table;
}

describe('auto_resize_row_after_edit', () => {
    it('calls on_row_resize when row scrollHeight exceeds current explicit height', () => {
        const table = make_table(3, [20, 60, 20]);
        const on_row_resize = vi.fn();
        auto_resize_row_after_edit(table, 1, { 1: 30 }, on_row_resize);
        expect(on_row_resize).toHaveBeenCalledWith(1, 60);
    });

    it('does not call on_row_resize when no explicit height is set (browser auto-sizes)', () => {
        const table = make_table(3, [20, 60, 20]);
        const on_row_resize = vi.fn();
        auto_resize_row_after_edit(table, 1, {}, on_row_resize);
        expect(on_row_resize).not.toHaveBeenCalled();
    });

    it('does not call on_row_resize when scrollHeight matches current height', () => {
        const table = make_table(3, [20, 30, 20]);
        const on_row_resize = vi.fn();
        auto_resize_row_after_edit(table, 1, { 1: 30 }, on_row_resize);
        expect(on_row_resize).not.toHaveBeenCalled();
    });

    it('does nothing if the row does not exist in the table', () => {
        const table = make_table(2, [20, 20]);
        const on_row_resize = vi.fn();
        auto_resize_row_after_edit(table, 5, {}, on_row_resize);
        expect(on_row_resize).not.toHaveBeenCalled();
    });
});
