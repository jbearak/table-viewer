import { describe, expect, it, vi } from 'vitest';
import { row_context_menu_items } from '../webview/row-context-menu';

function labels(
    selected_row_count: number,
    can_hide_rows = true,
    can_promote_row_to_header = false,
): string[] {
    return row_context_menu_items({
        selected_row_count,
        can_hide_rows,
        can_promote_row_to_header,
        on_hide_rows: vi.fn(),
        on_promote_row_to_header: vi.fn(),
        on_copy_rows: vi.fn(),
    }).flatMap((item) => item.kind === 'separator' ? [] : [item.label]);
}

describe('row context menu model', () => {
    it('pluralizes and normalizes row counts', () => {
        expect(labels(0)).toEqual(['Hide row', 'Copy row']);
        expect(labels(1)).toEqual(['Hide row', 'Copy row']);
        expect(labels(3)).toEqual(['Hide 3 rows', 'Copy 3 rows']);
    });

    it('omits hide when row transforms are unavailable', () => {
        expect(labels(4, false)).toEqual(['Copy 4 rows']);
    });

    it('offers Excel row promotion independently of a multi-row selection', () => {
        expect(labels(3, true, true)).toEqual([
            'Use row as header', 'Hide 3 rows', 'Copy 3 rows',
        ]);
    });

    it('wires promotion, hide, and copy callbacks', () => {
        const on_hide_rows = vi.fn();
        const on_promote_row_to_header = vi.fn();
        const on_copy_rows = vi.fn();
        const items = row_context_menu_items({
            selected_row_count: 2,
            can_hide_rows: true,
            can_promote_row_to_header: true,
            on_hide_rows,
            on_promote_row_to_header,
            on_copy_rows,
        });
        for (const item of items) {
            if (item.kind !== 'separator' && item.kind !== 'submenu') item.on_click({} as never);
        }
        expect(on_hide_rows).toHaveBeenCalledOnce();
        expect(on_promote_row_to_header).toHaveBeenCalledOnce();
        expect(on_copy_rows).toHaveBeenCalledOnce();
    });
});
