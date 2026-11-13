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

    it('keeps hide visible but disabled for pending rows', () => {
        const items = row_context_menu_items({
            selected_row_count: 2,
            can_hide_rows: false,
            show_disabled_hide_rows: true,
            can_promote_row_to_header: false,
            on_hide_rows: vi.fn(),
            on_promote_row_to_header: vi.fn(),
            on_copy_rows: vi.fn(),
            on_remove_pending_rows: vi.fn(),
        });
        expect(items.filter((item) => item.kind !== 'separator').map((item) => ({
            label: item.label,
            disabled: item.kind === 'submenu' ? false : item.disabled === true,
        }))).toEqual([
            { label: 'Remove 2 pending rows', disabled: false },
            { label: 'Hide 2 rows', disabled: true },
            { label: 'Copy 2 rows', disabled: false },
        ]);
    });

    it('offers both replacement-row actions when both callbacks apply', () => {
        const items = row_context_menu_items({
            selected_row_count: 1,
            can_hide_rows: false,
            show_disabled_hide_rows: true,
            can_promote_row_to_header: false,
            on_hide_rows: vi.fn(),
            on_promote_row_to_header: vi.fn(),
            on_copy_rows: vi.fn(),
            on_remove_pending_rows: vi.fn(),
            on_cancel_row_removals: vi.fn(),
        });
        expect(items.flatMap((item) => item.kind === 'separator' ? [] : [item.label]))
            .toEqual([
                'Remove pending row',
                'Cancel row removal',
                'Hide row',
                'Copy row',
            ]);
    });

    it('keeps remove visible but disabled for a mixed source and pending selection', () => {
        const items = row_context_menu_items({
            selected_row_count: 2,
            can_hide_rows: false,
            show_disabled_hide_rows: true,
            show_disabled_remove_pending_rows: true,
            pending_row_count: 1,
            can_promote_row_to_header: false,
            on_hide_rows: vi.fn(),
            on_promote_row_to_header: vi.fn(),
            on_copy_rows: vi.fn(),
        });
        expect(items.filter((item) => item.kind !== 'separator').map((item) => ({
            label: item.label,
            disabled: item.kind === 'submenu' ? false : item.disabled === true,
        }))).toEqual([
            { label: 'Remove pending row', disabled: true },
            { label: 'Hide 2 rows', disabled: true },
            { label: 'Copy 2 rows', disabled: false },
        ]);
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

describe('row structure items', () => {
    const base = {
        selected_row_count: 2,
        can_hide_rows: true,
        can_promote_row_to_header: false,
        on_hide_rows: vi.fn(),
        on_promote_row_to_header: vi.fn(),
        on_copy_rows: vi.fn(),
    };
    const shown = (items: ReturnType<typeof row_context_menu_items>) =>
        items.flatMap((item) => item.kind === 'separator' || item.kind === 'submenu' ? [] : [{
            label: item.label,
            disabled: item.disabled === true,
            reason: item.disabled_reason,
        }]);

    it('replaces Remove pending rows with Delete, and adds Restore', () => {
        const on_delete = vi.fn();
        const items = row_context_menu_items({
            ...base,
            on_remove_pending_rows: vi.fn(),
            delete_rows: { count: 2, on_click: on_delete },
            restore_rows: { count: 2, on_click: vi.fn() },
        });
        expect(shown(items)).toEqual([
            { label: 'Delete 2 rows', disabled: false, reason: undefined },
            { label: 'Restore 2 rows', disabled: false, reason: undefined },
            { label: 'Hide 2 rows', disabled: false, reason: undefined },
            { label: 'Copy 2 rows', disabled: false, reason: undefined },
        ]);
        const remove = items[0];
        if (remove.kind === 'separator' || remove.kind === 'submenu') throw new Error('not an item');
        remove.on_click({} as never);
        expect(on_delete).toHaveBeenCalledOnce();
    });

    it('keeps a disabled structure item with its reason', () => {
        expect(shown(row_context_menu_items({
            ...base,
            selected_row_count: 1,
            delete_rows: { count: 1, disabled_reason: 'Not available yet' },
        }))[0]).toEqual({ label: 'Delete row', disabled: true, reason: 'Not available yet' });
    });

    it('keeps Cancel row removal for tail removals beside Delete', () => {
        expect(shown(row_context_menu_items({
            ...base,
            selected_row_count: 1,
            delete_rows: { count: 1, disabled_reason: 'Save or redo the row removal first.' },
            on_cancel_row_removals: vi.fn(),
        })).map((item) => item.label)).toEqual([
            'Delete row', 'Cancel row removal', 'Hide row', 'Copy row',
        ]);
    });
});
