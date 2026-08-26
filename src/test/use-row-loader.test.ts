import { describe, it, expect, vi } from 'vitest';
import { MAX_PENDING_PAGE_REQUESTS, RowLoader } from '../webview/row-loader';
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
    sourceRows = Array.from({ length: count }, (_, i) => startRow + i),
): RowData {
    return {
        type: 'rowData',
        sheetIndex,
        startRow,
        rows: make_page(startRow, count),
        sourceRows,
        requestId,
        generation,
    };
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

    it('shrinks row pages for a very wide dataset', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, () => {});
        loader.configure(0, 1000, 1, true, 5_972);

        loader.ensure_rows(0, 20);

        const requests = post.mock.calls.map((call) => call[0] as RequestRows);
        expect(requests.map(({ startRow, count }) => ({ startRow, count }))).toEqual([
            { startRow: 0, count: 10 },
            { startRow: 10, count: 10 },
            { startRow: 20, count: 10 },
        ]);
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

    it('keeps rendered rows aligned with their canonical source-row identities', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, vi.fn());
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);

        const reply = row_data(
            0,
            0,
            1,
            last_request(post).requestId,
            3,
            [42, 7, 99],
        );
        expect(loader.on_row_data(reply)).toBe(true);
        expect(loader.get_row(1)?.[0]?.raw).toBe('r1c0');
        expect(loader.get_source_row(0)).toBe(42);
        expect(loader.get_source_row(1)).toBe(7);
        expect(loader.get_source_row(2)).toBe(99);
        expect(loader.get_source_row(3)).toBeUndefined();
    });

    // Durable CSV edit keys are source-keyed, so conflict detection reads cells by
    // canonical source row. Every test here permutes sourceRows away from the
    // identity mapping: under identity a source-keyed read and a display-keyed one
    // are indistinguishable, so an identity fixture would assert nothing.
    describe('source-row index', () => {
        it('reads a cell by canonical source row under a permuted page', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, vi.fn());
            loader.configure(0, 1000, 1);
            loader.ensure_rows(0, 10);
            expect(loader.on_row_data(
                row_data(0, 0, 1, last_request(post).requestId, 3, [42, 7, 99]),
            )).toBe(true);

            // Source row 7 sits at display offset 1, whose cells are r1c*.
            expect(loader.get_cell_raw_for_source(7, 0)).toBe('r1c0');
            expect(loader.get_cell_raw_for_source(42, 1)).toBe('r0c1');
            expect(loader.get_cell_raw_for_source(99, 0)).toBe('r2c0');
            // Display rows are not source rows: 1 and 2 are not claimed at all.
            expect(loader.has_source_row(7)).toBe(true);
            expect(loader.has_source_row(1)).toBe(false);
            expect(loader.get_cell_raw_for_source(1, 0)).toBeUndefined();
        });

        it('distinguishes a resident-blank cell from a non-resident source row', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, vi.fn());
            loader.configure(0, 1000, 1);
            loader.ensure_rows(0, 10);
            const reply = row_data(0, 0, 1, last_request(post).requestId, 2, [42, 7]);
            // A blank cell and an absent cell must both read as '' when resident:
            // that is exactly get_cell_raw's contract, which the source reader
            // mirrors so `undefined` keeps meaning "unknown, never a conflict".
            reply.rows = [[cell(''), null], [cell('x'), cell('y')]];
            expect(loader.on_row_data(reply)).toBe(true);

            expect(loader.get_cell_raw_for_source(42, 0)).toBe('');
            expect(loader.get_cell_raw_for_source(42, 1)).toBe('');
            expect(loader.get_cell_raw_for_source(7, 0)).toBe('x');
            // Not resident at all — distinct from a resident blank.
            expect(loader.get_cell_raw_for_source(500, 0)).toBeUndefined();
            expect(loader.has_source_row(500)).toBe(false);
        });

        it('drops source claims when a page is evicted', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, vi.fn(), 2); // cap = 2
            loader.configure(0, 100_000, 1);
            for (const start of [0, 100]) {
                loader.ensure_rows(start, start + 10);
                loader.on_row_data(
                    row_data(0, start, 1, last_request(post, start).requestId, 2,
                        [start + 1000, start + 1001]),
                );
            }
            expect(loader.has_source_row(1000)).toBe(true);

            // Push page 0 out: viewport is on 200, so nothing protects it.
            loader.ensure_rows(200, 210);
            loader.on_row_data(
                row_data(0, 200, 1, last_request(post, 200).requestId, 2, [1200, 1201]),
            );

            // Assert residency, not the read: a leaked claim pointing at an evicted
            // page still reads undefined, so a read-only assertion would pass with
            // the retraction removed.
            expect(loader.has_source_row(1000)).toBe(false);
            expect(loader.has_source_row(1001)).toBe(false);
            expect(loader.has_source_row(1100)).toBe(true);
            expect(loader.has_source_row(1200)).toBe(true);
        });

        it('retracts stale claims when a page is redelivered with different identities', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, vi.fn(), 2); // cap = 2
            loader.configure(0, 100_000, 1);
            loader.ensure_rows(0, 10);
            expect(loader.on_row_data(
                row_data(0, 0, 1, last_request(post, 0).requestId, 3, [42, 7, 99]),
            )).toBe(true);

            // Push page 0 out of the cache, then scroll back to it. Replacing a
            // still-resident page is unreachable (a request is only posted for an
            // absent page, and its pending id is consumed by the first reply), so
            // evict-then-refetch is the reachable route to a page start being
            // re-claimed — e.g. a refresh under a changed transform renames the
            // rows it covers and drops one.
            for (const start of [100, 200]) {
                loader.ensure_rows(start, start + 10);
                loader.on_row_data(
                    row_data(0, start, 1, last_request(post, start).requestId, 2,
                        [start + 1000, start + 1001]),
                );
            }
            expect(loader.has_source_row(42)).toBe(false);

            loader.ensure_rows(0, 10);
            expect(loader.on_row_data(
                row_data(0, 0, 1, last_request(post, 0).requestId, 2, [42, 55]),
            )).toBe(true);

            expect(loader.has_source_row(42)).toBe(true);
            expect(loader.has_source_row(55)).toBe(true);
            // 7 and 99 were page 0's before; nothing claims them now.
            expect(loader.has_source_row(7)).toBe(false);
            expect(loader.has_source_row(99)).toBe(false);
            expect(loader.get_cell_raw_for_source(55, 0)).toBe('r1c0');
        });

        it('empties the source index on clear', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, vi.fn());
            loader.configure(0, 1000, 1);
            loader.ensure_rows(0, 10);
            loader.on_row_data(
                row_data(0, 0, 1, last_request(post).requestId, 2, [42, 7]),
            );
            expect(loader.has_source_row(42)).toBe(true);

            loader.clear();
            expect(loader.has_source_row(42)).toBe(false);
            expect(loader.has_source_row(7)).toBe(false);
            expect(loader.get_cell_raw_for_source(42, 0)).toBeUndefined();
        });

        it('lets the last ingest win a duplicated source row, and keeps it when the older page is evicted', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, vi.fn(), 2); // cap = 2
            loader.configure(0, 100_000, 1);
            // Two pages both claiming source row 500. Only a host bug produces this
            // (transform_indices is a permutation), but the map must stay total.
            loader.ensure_rows(0, 10);
            loader.on_row_data(
                row_data(0, 0, 1, last_request(post, 0).requestId, 2, [500, 501]),
            );
            loader.ensure_rows(100, 110);
            loader.on_row_data(
                row_data(0, 100, 1, last_request(post, 100).requestId, 2, [500, 601]),
            );
            // Last ingest wins: page 100's offset 0 renders r100c0.
            expect(loader.get_cell_raw_for_source(500, 0)).toBe('r100c0');

            // Evicting the OLDER page must not retract the newer claim.
            loader.ensure_rows(200, 210);
            loader.on_row_data(
                row_data(0, 200, 1, last_request(post, 200).requestId, 2, [700, 701]),
            );
            expect(loader.has_source_row(501)).toBe(false); // page 0 is gone
            expect(loader.has_source_row(500)).toBe(true);
            expect(loader.get_cell_raw_for_source(500, 0)).toBe('r100c0');
        });

        it('leaves the source index untouched when an ingest is rejected', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, vi.fn());
            loader.configure(0, 1000, 1);
            loader.ensure_rows(0, 10);
            loader.on_row_data(row_data(0, 0, 1, last_request(post, 0).requestId, 2, [42, 7]));

            // Page 100's reply is malformed: length mismatch, then a negative
            // identity. Every validation early-return must run before any indexing,
            // so neither may leave a partial claim behind — nor disturb page 0's.
            loader.ensure_rows(100, 110);
            const request_id = last_request(post, 100).requestId;
            expect(loader.on_row_data(row_data(0, 100, 1, request_id, 3, [900, 901]))).toBe(false);
            expect(loader.on_row_data(row_data(0, 100, 1, request_id, 2, [900, -1]))).toBe(false);

            expect(loader.has_source_row(900)).toBe(false);
            expect(loader.has_source_row(901)).toBe(false);
            expect(loader.has_source_row(42)).toBe(true);
            expect(loader.get_cell_raw_for_source(7, 0)).toBe('r1c0');

            // The request was never consumed, so the retry still lands.
            expect(loader.on_row_data(row_data(0, 100, 1, request_id, 2, [900, 901]))).toBe(true);
            expect(loader.has_source_row(900)).toBe(true);
        });
    });

    it('rejects mismatched rows and sourceRows atomically without consuming the request', () => {
        const post = vi.fn();
        const on_change = vi.fn();
        const loader = new RowLoader(post, on_change);
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);
        const request_id = last_request(post).requestId;

        expect(loader.on_row_data(row_data(0, 0, 1, request_id, 3, [10, 11]))).toBe(false);
        expect(loader.page_count).toBe(0);
        expect(loader.get_row(0)).toBeUndefined();
        expect(loader.get_source_row(0)).toBeUndefined();
        expect(on_change).not.toHaveBeenCalled();

        expect(loader.on_row_data(row_data(0, 0, 1, request_id, 3, [10, 11, 12]))).toBe(true);
        expect(loader.get_row(0)).toBeDefined();
        expect(loader.get_source_row(0)).toBe(10);
        expect(on_change).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed source-row identities without consuming the request', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, vi.fn());
        loader.configure(0, 1000, 1);
        loader.ensure_rows(0, 10);
        const request_id = last_request(post).requestId;

        expect(loader.on_row_data(row_data(0, 0, 1, request_id, 1, [-1]))).toBe(false);
        expect(loader.get_row(0)).toBeUndefined();
        expect(loader.get_source_row(0)).toBeUndefined();

        const sparse_source_rows = new Array<number>(1);
        expect(loader.on_row_data(row_data(0, 0, 1, request_id, 1, sparse_source_rows))).toBe(false);
        expect(loader.get_row(0)).toBeUndefined();
        expect(loader.get_source_row(0)).toBeUndefined();

        expect(loader.on_row_data(row_data(0, 0, 1, request_id, 1, [25]))).toBe(true);
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
        expect(loader.get_source_row(0)).toBe(0);

        loader.configure(1, 1000, 1); // sheet switch
        expect(loader.get_row(0)).toBeUndefined();
        expect(loader.get_source_row(0)).toBeUndefined();
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
        expect(loader.get_source_row(0)).toBe(0);

        loader.configure(0, 1000, 2); // reload bumps generation
        expect(loader.get_row(0)).toBeUndefined();
        expect(loader.get_source_row(0)).toBeUndefined();
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
        // Page 0 (oldest, not in viewport) and its identities were evicted together.
        expect(loader.get_row(0)).toBeUndefined();
        expect(loader.get_source_row(0)).toBeUndefined();
        // The current viewport page and its aligned identity survive.
        expect(loader.get_row(300)).toBeDefined();
        expect(loader.get_source_row(300)).toBe(300);
    });

    it('touches a resident page as one LRU unit with its source-row identities', () => {
        const post = vi.fn();
        const loader = new RowLoader(post, vi.fn(), 2);
        loader.configure(0, 100_000, 1);

        for (const start of [0, 100]) {
            loader.ensure_rows(start, start + 10);
            const request_id = last_request(post, start).requestId;
            loader.on_row_data(row_data(0, start, 1, request_id, 2, [start + 1000, start + 1001]));
        }

        loader.ensure_rows(0, 10); // Touch page 0; page 100 becomes least-recently-used.
        loader.ensure_rows(200, 210);
        loader.on_row_data(row_data(0, 200, 1, last_request(post, 200).requestId, 2, [1200, 1201]));

        expect(loader.get_row(0)).toBeDefined();
        expect(loader.get_source_row(0)).toBe(1000);
        expect(loader.get_row(100)).toBeUndefined();
        expect(loader.get_source_row(100)).toBeUndefined();
        expect(loader.get_row(200)).toBeDefined();
        expect(loader.get_source_row(200)).toBe(1200);
    });

    // Explicit eviction holds. An open cell editor is the motivating case: Glide's
    // overlay does not close on scroll, so the row whose identity the pending commit
    // needs can be scrolled clean out of the viewport, and the viewport is the only
    // thing `evict` protects by default.
    describe('pin_rows', () => {
        it('protects a pinned page that has left the viewport', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {}, 2); // cap = 2
            loader.configure(0, 100_000, 1);

            loader.ensure_rows(0, 10);
            loader.on_row_data(reply_for(post, 0, 0, 1));
            loader.pin_rows(0, 0);

            // Scroll away far enough that page 0 is neither in the viewport nor the
            // most recently used, so without the pin it is the eviction victim.
            for (const start of [100, 200]) {
                loader.ensure_rows(start, start + 10);
                loader.on_row_data(reply_for(post, 0, start, 1));
            }

            expect(loader.pin_count).toBe(1);
            expect(loader.get_row(0)).toBeDefined();
            expect(loader.get_source_row(0)).toBe(0);
            // The pin adds to the protected set rather than raising the cap: some
            // other page paid for page 0's survival.
            expect(loader.page_count).toBe(2);
        });

        it('lets the cap reclaim a page once its pin is released', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {}, 2);
            loader.configure(0, 100_000, 1);

            loader.ensure_rows(0, 10);
            loader.on_row_data(reply_for(post, 0, 0, 1));
            const pin = loader.pin_rows(0, 0);

            loader.ensure_rows(100, 110);
            loader.on_row_data(reply_for(post, 0, 100, 1));

            loader.unpin_rows(pin);
            expect(loader.pin_count).toBe(0);
            // Releasing does not itself evict (there is no call site for that); the
            // next page landing is what trims, and now nothing shields page 0.
            loader.ensure_rows(200, 210);
            loader.on_row_data(reply_for(post, 0, 200, 1));

            expect(loader.get_row(0)).toBeUndefined();
            expect(loader.get_source_row(0)).toBeUndefined();
            expect(loader.page_count).toBe(2);

            // Releasing an already-released token is a no-op, so GridShell's
            // belt-and-braces release legs cannot corrupt the map.
            loader.unpin_rows(pin);
            expect(loader.pin_count).toBe(0);
        });

        it('drops every pin on clear so a sheet switch cannot shrink the cap forever', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {}, 2);
            loader.configure(0, 100_000, 1);
            loader.ensure_rows(0, 10);
            loader.on_row_data(reply_for(post, 0, 0, 1));
            loader.pin_rows(0, 0);
            expect(loader.pin_count).toBe(1);

            loader.clear();

            expect(loader.pin_count).toBe(0);
        });
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

    describe('ensure_rows_loaded', () => {
        it('resolves true immediately when the range is already resident', async () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {});
            loader.configure(0, 1000, 1);
            loader.ensure_rows(0, 10);
            loader.on_row_data(reply_for(post, 0, 0, 1));
            post.mockClear();
            await expect(loader.ensure_rows_loaded(0, 40)).resolves.toBe(true);
            expect(post).not.toHaveBeenCalled();
        });

        it('reports false when it cannot load a disabled sheet', async () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {});
            loader.configure(0, 1000, 1, false); // disabled, nothing resident
            await expect(loader.ensure_rows_loaded(0, 40)).resolves.toBe(false);
            expect(post).not.toHaveBeenCalled();
        });

        it('resolves only after every covering page is delivered', async () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {});
            loader.configure(0, 1000, 1);
            let settled: boolean | null = null;
            const done = loader.ensure_rows_loaded(0, 250).then((v) => { settled = v; });
            expect(post.mock.calls.map((c) => (c[0] as RequestRows).startRow).sort((a, b) => a - b))
                .toEqual([0, 100, 200]);
            loader.on_row_data(reply_for(post, 0, 0, 1));
            await Promise.resolve();
            expect(settled).toBeNull();
            loader.on_row_data(reply_for(post, 0, 100, 1));
            loader.on_row_data(reply_for(post, 0, 200, 1));
            await done;
            expect(settled).toBe(true);
            expect(loader.get_row(0)).toBeDefined();
            expect(loader.get_row(150)).toBeDefined();
            expect(loader.get_row(250)).toBeDefined();
        });

        it('backpressures bulk loads and replenishes slots as replies arrive', () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {});
            loader.configure(0, 100_000, 1);
            void loader.ensure_rows_loaded(0, 9_999);

            expect(post).toHaveBeenCalledTimes(MAX_PENDING_PAGE_REQUESTS);
            loader.on_row_data(reply_for(post, 0, 0, 1));
            expect(post).toHaveBeenCalledTimes(MAX_PENDING_PAGE_REQUESTS + 1);
            expect(last_request(post).startRow).toBe(MAX_PENDING_PAGE_REQUESTS * PAGE_SIZE);
        });

        it('holds more than the cache cap resident until the bulk load resolves', async () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {}, 2); // cap = 2
            loader.configure(0, 1000, 1);
            const done = loader.ensure_rows_loaded(0, 250); // needs 3 pages > cap
            for (const start of [0, 100, 200]) loader.on_row_data(reply_for(post, 0, start, 1));
            await done;
            expect(loader.page_count).toBe(3);
            expect(loader.get_row(0)).toBeDefined();
            expect(loader.get_row(100)).toBeDefined();
            expect(loader.get_row(200)).toBeDefined();
        });

        it('trims back to the cap on demand once the protected copy completes', async () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {}, 2);
            loader.configure(0, 1000, 1);
            const done = loader.ensure_rows_loaded(0, 250);
            for (const start of [0, 100, 200]) loader.on_row_data(reply_for(post, 0, start, 1));
            await done;
            expect(loader.page_count).toBe(3);
            loader.trim();
            expect(loader.page_count).toBe(2);
        });

        it('resolves false (does not hang) when the cache is cleared mid-load', async () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {});
            loader.configure(0, 1000, 1);
            const done = loader.ensure_rows_loaded(0, 250);
            loader.on_row_data(reply_for(post, 0, 0, 1)); // one page in…
            loader.clear();                               // …then the sheet switches
            await expect(done).resolves.toBe(false);
        });

        it('protects each pending load individually, not the gap between them', async () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {}, 1); // cap = 1
            loader.configure(0, 2000, 1);
            // Two disjoint bulk loads in flight: page 0 and page 1900, both
            // still awaiting their host reply.
            const done_low = loader.ensure_rows_loaded(0, 40);
            const done_high = loader.ensure_rows_loaded(1900, 1940);
            // Scroll a page in the gap between them into view and load it…
            loader.ensure_rows(1000, 1040);
            loader.on_row_data(reply_for(post, 0, 1000, 1));
            expect(loader.get_row(1000)).toBeDefined();
            // …then scroll on. The old viewport page (1000) is neither in view
            // nor part of either pending load, so it must be evictable — the two
            // waiters protect only pages 0 and 1900, not the span between them.
            loader.ensure_rows(1100, 1140);
            loader.on_row_data(reply_for(post, 0, 1100, 1));
            expect(loader.get_row(1000)).toBeUndefined();
            expect(loader.get_row(1100)).toBeDefined();
            // Deliver both loads' pages to settle their promises.
            loader.on_row_data(reply_for(post, 0, 0, 1));
            loader.on_row_data(reply_for(post, 0, 1900, 1));
            await expect(done_low).resolves.toBe(true);
            await expect(done_high).resolves.toBe(true);
        });

        it('does not move the display viewport', async () => {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {});
            loader.configure(0, 10_000, 1);
            loader.ensure_rows(500, 540); // viewport sits on page 500
            loader.on_row_data(reply_for(post, 0, 500, 1));
            const done = loader.ensure_rows_loaded(0, 40); // bulk-load an unrelated range
            loader.on_row_data(reply_for(post, 0, 0, 1));
            await done;
            post.mockClear();
            // A generation bump re-requests the viewport (500), not the copy range.
            loader.configure(0, 10_000, 2);
            const reqs = post.mock.calls.map((c) => c[0] as RequestRows);
            expect(reqs.some((r) => r.startRow === 500)).toBe(true);
            expect(reqs.some((r) => r.startRow === 0)).toBe(false);
        });
    });

    describe('compare sidecar', () => {
        type CompareDiff = Extract<HostMessage, { type: 'compareDiff' }>;
        function compare_diff(
            startRow: number,
            requestId: string,
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
                requestId,
                generation: 1,
                ...overrides,
            };
        }

        function loaded_loader(): { loader: RowLoader; post: ReturnType<typeof vi.fn> } {
            const post = vi.fn();
            const loader = new RowLoader(post, () => {});
            loader.configure(0, 1_000, 1);
            loader.ensure_rows(0, 10);
            loader.on_row_data(reply_for(post, 0, 0, 1));
            return { loader, post };
        }

        it('retains a moved status rather than dropping it as unknown', () => {
            // The loader whitelists status strings, so a new one that is not
            // added here is silently discarded and the band never paints.
            const { loader, post } = loaded_loader();
            expect(loader.on_compare_diff(compare_diff(
                0,
                last_request(post, 0).requestId,
                ['moved', 'same'],
                [],
            ))).toBe(true);
            expect(loader.get_compare_status(0)).toBe('moved');
            expect(loader.get_compare_status(1)).toBeUndefined();
        });

        it('answers row status and cell bases from an ingested sidecar', () => {
            const { loader, post } = loaded_loader();
            expect(loader.on_compare_diff(compare_diff(
                0,
                last_request(post, 0).requestId,
                ['same', 'added', 'deleted'],
                [{ row: 0, col: 1, base: 'old' }],
            ))).toBe(true);
            expect(loader.get_compare_status(0)).toBeUndefined();
            expect(loader.get_compare_status(1)).toBe('added');
            expect(loader.get_compare_status(2)).toBe('deleted');
            expect(loader.get_compare_base(0, 1)).toBe('old');
            expect(loader.get_compare_base(0, 0)).toBeUndefined();
        });

        it('bumps on_change when a sidecar lands so the grid repaints', () => {
            const post = vi.fn();
            const on_change = vi.fn();
            const loader = new RowLoader(post, on_change);
            loader.configure(0, 1_000, 1);
            loader.ensure_rows(0, 10);
            loader.on_row_data(reply_for(post, 0, 0, 1));
            on_change.mockClear();
            loader.on_compare_diff(compare_diff(
                0, last_request(post, 0).requestId, ['added']));
            expect(on_change).toHaveBeenCalledTimes(1);
        });

        it('drops a sidecar whose requestId does not match the resident page', () => {
            const { loader } = loaded_loader();
            expect(loader.on_compare_diff(
                compare_diff(0, 'someone-else', ['added']),
            )).toBe(false);
            expect(loader.get_compare_status(0)).toBeUndefined();
        });

        it('drops stale-generation and wrong-sheet sidecars', () => {
            const { loader, post } = loaded_loader();
            const id = last_request(post, 0).requestId;
            expect(loader.on_compare_diff(
                compare_diff(0, id, ['added'], [], { generation: 2 }),
            )).toBe(false);
            expect(loader.on_compare_diff(
                compare_diff(0, id, ['added'], [], { sheetIndex: 3 }),
            )).toBe(false);
            expect(loader.get_compare_status(0)).toBeUndefined();
        });

        it('drops a sidecar for a page that is not resident', () => {
            const { loader } = loaded_loader();
            expect(loader.on_compare_diff(
                compare_diff(PAGE_SIZE, 'anything', ['added']),
            )).toBe(false);
        });

        it('dies with its page: clear() forgets the compare data', () => {
            const { loader, post } = loaded_loader();
            loader.on_compare_diff(compare_diff(
                0,
                last_request(post, 0).requestId,
                ['added'],
                [{ row: 0, col: 0, base: 'b' }],
            ));
            loader.configure(1, 1_000, 1); // sheet switch clears
            expect(loader.get_compare_status(0)).toBeUndefined();
            expect(loader.get_compare_base(0, 0)).toBeUndefined();
        });

        it('ignores out-of-page and malformed changed cells', () => {
            const { loader, post } = loaded_loader();
            expect(loader.on_compare_diff(compare_diff(
                0,
                last_request(post, 0).requestId,
                ['same'],
                [
                    { row: -1, col: 0, base: 'x' },
                    { row: PAGE_SIZE + 5, col: 0, base: 'x' },
                    { row: 0, col: -2, base: 'x' },
                    { row: 0, col: 1, base: 'kept' },
                ],
            ))).toBe(true);
            expect(loader.get_compare_base(0, 1)).toBe('kept');
            expect(loader.get_compare_base(0, 0)).toBeUndefined();
        });
    });
});
