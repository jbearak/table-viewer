import { describe, it, expect, vi } from 'vitest';
import { RowLoader } from '../webview/row-loader';
import { PAGE_SIZE } from '../webview/grid-model';
import type { RenderedCell } from '../data-source/interface';
import type { WebviewMessage, HostMessage } from '../types';

type RequestRows = Extract<WebviewMessage, { type: 'requestRows' }>;
type RowData = Extract<HostMessage, { type: 'rowData' }>;

const cell = (s: string): RenderedCell => ({ raw: s, formatted: s, bold: false, italic: false });

function make_page(start: number, count: number, cols = 2): (RenderedCell | null)[][] {
    return Array.from({ length: count }, (_, i) =>
        Array.from({ length: cols }, (_, c) => cell(`r${start + i}c${c}`))
    );
}

function row_data(sheetIndex: number, startRow: number, generation: number, count = PAGE_SIZE): RowData {
    return { type: 'rowData', sheetIndex, startRow, rows: make_page(startRow, count), requestId: 'x', generation };
}

describe('RowLoader', () => {
    it('requests the first page when the viewport opens', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);
        expect(post).toHaveBeenCalledTimes(1);
        const msg = post.mock.calls[0][0] as RequestRows;
        expect(msg.type).toBe('requestRows');
        expect(msg.sheetIndex).toBe(0);
        expect(msg.startRow).toBe(0);
        expect(msg.count).toBe(PAGE_SIZE);
        expect(msg.generation).toBe(1);
    });

    it('does not re-request a page that is already pending', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);
        loader.ensure_rows(0, 10);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('caches a delivered page: get_row returns cells, no re-request', () => {
        const post = vi.fn();
        const on_change = vi.fn();
        const loader = new RowLoader(post, on_change);
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);
        expect(loader.on_row_data(row_data(0, 0, 1))).toBe(true);
        expect(on_change).toHaveBeenCalledTimes(1);
        expect(loader.get_row(5)?.[1]?.raw).toBe('r5c1');
        // Already cached: a repeat ensure must not post again.
        loader.ensure_rows(0, 10);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('drops rowData from a stale generation', () => {
        const post = vi.fn();
        const on_change = vi.fn();
        const loader = new RowLoader(post, on_change);
        loader.configure(0, 1000, 2);
        loader.ensure_rows(0, 10);
        expect(loader.on_row_data(row_data(0, 0, 1))).toBe(false); // gen 1 != 2
        expect(on_change).not.toHaveBeenCalled();
        expect(loader.get_row(0)).toBeUndefined();
    });

    it('drops rowData for a different sheet', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(1, 1000, 1);
        expect(loader.on_row_data(row_data(0, 0, 1))).toBe(false);
        expect(loader.get_row(0)).toBeUndefined();
    });

    it('clears cached pages when the sheet switches', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);
        loader.on_row_data(row_data(0, 0, 1));
        expect(loader.get_row(0)).toBeDefined();

        loader.configure(1, 1000, 1); // sheet switch
        expect(loader.get_row(0)).toBeUndefined();
        loader.ensure_rows(0, 10);
        const last = post.mock.calls.at(-1)![0] as RequestRows;
        expect(last.sheetIndex).toBe(1);
    });

    it('clears cached pages when the generation bumps (reload)', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);
        loader.on_row_data(row_data(0, 0, 1));
        expect(loader.get_row(0)).toBeDefined();

        loader.configure(0, 1000, 2); // reload bumps generation
        expect(loader.get_row(0)).toBeUndefined();
    });

    it('evicts least-recently-used pages beyond the cap, protecting the viewport', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {}, 3); // cap = 3
        loader.configure(0, 100_000, 1);
        // Load pages 0,100,200,300 while keeping the viewport on the last one.
        for (const start of [0, 100, 200, 300]) {
            loader.ensure_rows(start, start + 10);
            loader.on_row_data(row_data(0, start, 1));
        }
        expect(loader.page_count).toBe(3);
        // Page 0 (oldest, not in viewport) was evicted.
        expect(loader.get_row(0)).toBeUndefined();
        // The current viewport page survives.
        expect(loader.get_row(300)).toBeDefined();
    });

    it('does not request pages past the row count', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 50, 1); // only 50 rows -> single page at 0
        loader.ensure_rows(0, 500);
        expect(post).toHaveBeenCalledTimes(1);
        expect((post.mock.calls[0][0] as RequestRows).startRow).toBe(0);
    });

    describe('sample_loaded_rows', () => {
        it('returns resident rows, capped at max', () => {
            const loader = new RowLoader(vi.fn(), () => {});
            loader.configure(0, 1000, 1);
            loader.ensure_rows(0, 10);
            loader.on_row_data(row_data(0, 0, 1));
            const sample = loader.sample_loaded_rows(5);
            expect(sample.length).toBe(5);
            expect(sample[0]?.[0]?.raw).toBe('r0c0');
        });

        it('is empty when no page is resident', () => {
            const loader = new RowLoader(vi.fn(), () => {});
            loader.configure(0, 1000, 1);
            expect(loader.sample_loaded_rows(10)).toEqual([]);
        });

        it('excludes rows past row_count in a partial final page', () => {
            const loader = new RowLoader(vi.fn(), () => {});
            loader.configure(0, 3, 1); // only 3 rows, but a full page is delivered
            loader.ensure_rows(0, 2);
            loader.on_row_data(row_data(0, 0, 1));
            expect(loader.sample_loaded_rows(100).length).toBe(3);
        });

        it('draws from multiple resident pages', () => {
            const loader = new RowLoader(vi.fn(), () => {});
            loader.configure(0, 100_000, 1);
            loader.ensure_rows(0, 10);
            loader.on_row_data(row_data(0, 0, 1));
            loader.ensure_rows(PAGE_SIZE, PAGE_SIZE + 10);
            loader.on_row_data(row_data(0, PAGE_SIZE, 1));
            // Ask for more than one page's worth so the second page contributes.
            const sample = loader.sample_loaded_rows(PAGE_SIZE + 5);
            expect(sample.length).toBe(PAGE_SIZE + 5);
        });
    });
});
