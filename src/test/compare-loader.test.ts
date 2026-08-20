import { describe, expect, it, vi } from 'vitest';
import { CompareLoader } from '../webview/compare-loader';
import type { HostMessage } from '../types';

type CompareDiff = Extract<HostMessage, { type: 'compareDiff' }>;

function page(
    startRow: number,
    rowStatus: CompareDiff['rowStatus'],
    changedCells: CompareDiff['changedCells'] = [],
    overrides: Partial<CompareDiff> = {},
): CompareDiff {
    return {
        type: 'compareDiff',
        sheetIndex: 0,
        startRow,
        rowStatus,
        changedCells,
        requestId: 'r',
        generation: 1,
        ...overrides,
    };
}

describe('CompareLoader', () => {
    it('answers row status and cell bases from an ingested page', () => {
        const on_change = vi.fn();
        const loader = new CompareLoader(on_change);
        expect(loader.on_compare_diff(page(
            10,
            ['same', 'added', 'deleted'],
            [{ row: 10, col: 2, base: 'old' }],
        ))).toBe(true);
        expect(on_change).toHaveBeenCalledTimes(1);
        expect(loader.get_status(10)).toBeUndefined();
        expect(loader.get_status(11)).toBe('added');
        expect(loader.get_status(12)).toBe('deleted');
        expect(loader.get_base(10, 2)).toBe('old');
        expect(loader.get_base(10, 1)).toBeUndefined();
    });

    it('drops stale-generation and wrong-sheet pages', () => {
        const loader = new CompareLoader(() => {});
        expect(loader.on_compare_diff(page(0, ['added'], [], { generation: 2 }))).toBe(false);
        expect(loader.on_compare_diff(page(0, ['added'], [], { sheetIndex: 3 }))).toBe(false);
        expect(loader.get_status(0)).toBeUndefined();
    });

    it('clears on sheet switch and generation bump', () => {
        const loader = new CompareLoader(() => {});
        loader.configure(0, 1);
        loader.on_compare_diff(page(0, ['added'], [{ row: 0, col: 0, base: 'b' }]));
        loader.configure(1, 1);
        expect(loader.get_status(0)).toBeUndefined();
        expect(loader.get_base(0, 0)).toBeUndefined();
        expect(loader.on_compare_diff(page(0, ['deleted'], [], { sheetIndex: 1 }))).toBe(true);
        loader.configure(1, 2);
        expect(loader.get_status(0)).toBeUndefined();
    });

    it('replaces a redelivered page, retracting what the old page claimed', () => {
        const loader = new CompareLoader(() => {});
        loader.on_compare_diff(page(0, ['added', 'added'], [{ row: 1, col: 0, base: 'x' }]));
        loader.on_compare_diff(page(0, ['same', 'deleted']));
        expect(loader.get_status(0)).toBeUndefined();
        expect(loader.get_status(1)).toBe('deleted');
        expect(loader.get_base(1, 0)).toBeUndefined();
    });

    it('evicts least-recently ingested pages past the cap', () => {
        const loader = new CompareLoader(() => {}, 2);
        loader.on_compare_diff(page(0, ['added'], [{ row: 0, col: 0, base: 'a' }]));
        loader.on_compare_diff(page(100, ['added']));
        loader.on_compare_diff(page(200, ['added']));
        expect(loader.page_count).toBe(2);
        expect(loader.get_status(0)).toBeUndefined();
        expect(loader.get_base(0, 0)).toBeUndefined();
        expect(loader.get_status(100)).toBe('added');
        expect(loader.get_status(200)).toBe('added');
    });
});
