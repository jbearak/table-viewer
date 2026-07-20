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

function row_data(
    sheetIndex: number,
    startRow: number,
    generation: number,
    requestId: string,
    count = PAGE_SIZE,
): RowData {
    return { type: 'rowData', sheetIndex, startRow, rows: make_page(startRow, count), requestId, generation };
}

function last_request(post: ReturnType<typeof vi.fn>, startRow?: number): RequestRows {
    const requests = post.mock.calls.map((call) => call[0] as RequestRows);
    const request = startRow === undefined
        ? requests.at(-1)
        : [...requests].reverse().find((candidate) => candidate.startRow === startRow);
    if (!request) throw new Error(`No row request${startRow === undefined ? '' : ` for ${startRow}`}`);
    return request;
}

function reply_for(
    post: ReturnType<typeof vi.fn>,
    sheetIndex: number,
    startRow: number,
    generation: number,
    count = PAGE_SIZE,
): RowData {
    return row_data(
        sheetIndex,
        startRow,
        generation,
        last_request(post, startRow).requestId,
        count,
    );
}

describe('RowLoader', () => {
    it('does not request a page when the effective row count is zero', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, vi.fn());
        loader.configure(0, 0, 1);
        loader.ensure_rows(0, 40);
        expect(post).not.toHaveBeenCalled();
    });

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
        expect(loader.on_row_data(reply_for(post, 0, 0, 1))).toBe(true);
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
        expect(loader.on_row_data(row_data(0, 0, 1, last_request(post).requestId))).toBe(false); // gen 1 != 2
        expect(on_change).not.toHaveBeenCalled();
        expect(loader.get_row(0)).toBeUndefined();
    });

    it('drops rowData for a different sheet', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(1, 1000, 1);
        loader.ensure_rows(0, 10);
        expect(loader.on_row_data(row_data(0, 0, 1, last_request(post).requestId))).toBe(false);
        expect(loader.get_row(0)).toBeUndefined();
    });

    it('clears cached pages when the sheet switches', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);
        loader.on_row_data(reply_for(post, 0, 0, 1));
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
        loader.on_row_data(reply_for(post, 0, 0, 1));
        expect(loader.get_row(0)).toBeDefined();

        loader.configure(0, 1000, 2); // reload bumps generation
        expect(loader.get_row(0)).toBeUndefined();
    });

    it('re-requests the current visible region after a generation bump', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 10_000, 1);
        // User scrolled past page 0: the visible region sits on rows ~500-540.
        loader.ensure_rows(500, 540);
        loader.on_row_data(reply_for(post, 0, 500, 1));
        expect(loader.get_row(510)).toBeDefined();
        post.mockClear();

        // A snapshot refresh bumps the generation. The cache clears; the visible
        // region must be re-fetched at the NEW generation without waiting for a
        // scroll, otherwise the grid paints blanks until the user scrolls.
        loader.configure(0, 10_000, 2);
        expect(loader.get_row(510)).toBeUndefined();

        const reqs = post.mock.calls.map((c) => c[0] as RequestRows);
        const page500 = reqs.find((r) => r.startRow === 500);
        expect(page500).toBeDefined();
        expect(page500!.generation).toBe(2);
    });

    it('does not re-request anything on the initial configure (no viewport yet)', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 10_000, 1); // first mount: sheet/gen "change" from defaults
        expect(post).not.toHaveBeenCalled();
    });

    it('records the viewport without requesting rows while disabled', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 10_000, 1, false);
        loader.ensure_rows(500, 540);
        expect(post).not.toHaveBeenCalled();

        loader.configure(0, 10_000, 2, false);
        expect(post).not.toHaveBeenCalled();

        loader.configure(0, 10_000, 2, true);
        expect(post).not.toHaveBeenCalled();

        loader.ensure_rows(0, 40);
        expect(last_request(post).startRow).toBe(0);
        expect(last_request(post).generation).toBe(2);
    });

    it('preserves resident rows across disable and re-enable', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);
        loader.on_row_data(reply_for(post, 0, 0, 1));
        post.mockClear();

        loader.configure(0, 1000, 1, false);
        expect(loader.get_row(0)).toBeDefined();
        loader.configure(0, 1000, 1, true);
        expect(loader.get_row(0)).toBeDefined();
        expect(post).not.toHaveBeenCalled();
    });

    it('evicts least-recently-used pages beyond the cap, protecting the viewport', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {}, 3); // cap = 3
        loader.configure(0, 100_000, 1);
        // Load pages 0,100,200,300 while keeping the viewport on the last one.
        for (const start of [0, 100, 200, 300]) {
            loader.ensure_rows(start, start + 10);
            loader.on_row_data(reply_for(post, 0, start, 1));
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
            const post = vi.fn();
            const loader = new RowLoader(post, () => {});
            loader.configure(0, 1000, 1);
            loader.ensure_rows(0, 10);
            loader.on_row_data(reply_for(post, 0, 0, 1));
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
            const post = vi.fn();
            const loader = new RowLoader(post, () => {});
            loader.configure(0, 3, 1); // only 3 rows, but a full page is delivered
            loader.ensure_rows(0, 2);
            loader.on_row_data(reply_for(post, 0, 0, 1));
            expect(loader.sample_loaded_rows(100).length).toBe(3);
        });

        it('draws from multiple resident pages', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {});
            loader.configure(0, 100_000, 1);
            loader.ensure_rows(0, 10);
            loader.on_row_data(reply_for(post, 0, 0, 1));
            loader.ensure_rows(PAGE_SIZE, PAGE_SIZE + 10);
            loader.on_row_data(reply_for(post, 0, PAGE_SIZE, 1));
            // Ask for more than one page's worth so the second page contributes.
            const sample = loader.sample_loaded_rows(PAGE_SIZE + 5);
            expect(sample.length).toBe(PAGE_SIZE + 5);
        });
    });

    it('rejects a stale same-generation reply after clear and re-request', () => {
        const post = vi.fn();
        const on_change = vi.fn();
        const loader = new RowLoader(post, on_change);
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);
        const stale = last_request(post);

        loader.clear();
        loader.ensure_rows(0, 10);
        const current = last_request(post);
        expect(current.requestId).not.toBe(stale.requestId);

        expect(loader.on_row_data(row_data(0, 0, 1, stale.requestId))).toBe(false);
        expect(loader.get_row(0)).toBeUndefined();
        expect(on_change).not.toHaveBeenCalled();

        expect(loader.on_row_data(row_data(0, 0, 1, current.requestId))).toBe(true);
        expect(loader.get_row(0)).toBeDefined();
    });

    it('uses request identities unique across loader instances', () => {
        const first_post = vi.fn();
        const first = new RowLoader(first_post, vi.fn());
        first.configure(0, 1000, 1);
        first.ensure_rows(0, 10);
        const first_request = last_request(first_post);

        const second_post = vi.fn();
        const second = new RowLoader(second_post, vi.fn());
        second.configure(0, 1000, 1);
        second.ensure_rows(0, 10);
        const second_request = last_request(second_post);

        expect(second_request.requestId).not.toBe(first_request.requestId);
        expect(second.on_row_data(row_data(0, 0, 1, first_request.requestId))).toBe(false);
        expect(second.on_row_data(row_data(0, 0, 1, second_request.requestId))).toBe(true);
    });

    it('rejects unsolicited same-sheet same-generation row data', () => {
        const loader = new RowLoader(vi.fn(), vi.fn());
        loader.configure(0, 1000, 1);
        expect(loader.on_row_data(row_data(0, 0, 1, 'unsolicited'))).toBe(false);
    });
});
