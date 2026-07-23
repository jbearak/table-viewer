import type { RenderedCell } from '../data-source/interface';
import type { HostMessage, WebviewMessage } from '../types';
import { PAGE_SIZE, get_needed_page_starts } from './grid-model';

type PostFn = (msg: WebviewMessage) => void;
type RowDataMsg = Extract<HostMessage, { type: 'rowData' }>;
type Row = (RenderedCell | null)[];

interface CachedPage {
    readonly rows: Row[];
    readonly source_rows: number[];
}

let next_loader_id = 0;

/**
 * Demand-paged row store for the Glide grid. Pure (no React, no vscode import):
 * `post` and `on_change` are injected, so the whole fetch/cache/generation/LRU
 * logic is unit-testable with plain spies. The `use_row_loader` hook
 * (use-row-loader.ts) wires it to `vscode_api` and a forced re-render.
 *
 * - Pages are PAGE_SIZE-aligned windows keyed by their start row.
 * - `generation` guards against `rowData` belonging to a superseded document
 *   version (bumped by the host on every reload); stale or wrong-sheet windows
 *   are dropped.
 * - An LRU cap bounds memory; pages intersecting the current viewport are never
 *   evicted so the visible region always has a chance to stay resident.
 */
export class RowLoader {
    private readonly pages = new Map<number, CachedPage>();
    private readonly pending = new Map<number, string>();
    private readonly loader_id = ++next_loader_id;
    private _generation = 1;
    private sheet_index = 0;
    private row_count = 0;
    private req_seq = 0;
    private viewport = { start: 0, end: 0 };
    private viewport_set = false;
    private enabled = true;
    // Outstanding bulk-copy loads: each holds its own range's pages resident
    // until that range is fully cached and the promise settles.
    private load_waiters: Array<{
        start: number;
        end: number;
        resolve: (loaded: boolean) => void;
    }> = [];

    constructor(
        private readonly post: PostFn,
        private readonly on_change: () => void,
        private readonly max_pages = 50,
    ) {}

    get generation(): number {
        return this._generation;
    }

    /** For tests: number of resident pages. */
    get page_count(): number {
        return this.pages.size;
    }

    /**
     * Point the loader at a sheet + generation. Clears the cache whenever either
     * changes so stale rows never bleed across a sheet switch or a reload.
     * Idempotent: safe to call on every render.
     *
     * When a sheet switch or reload (generation bump) clears the cache, the
     * currently-visible pages are immediately re-requested at the new
     * generation. Without this, a snapshot refresh that keeps the grid mounted
     * would leave the visible region blank until the user happens to scroll
     * (Glide only re-fetches via `onVisibleRegionChanged`, which does not fire
     * when the region is unchanged). The first `configure` of a session has no
     * established viewport yet, so nothing is re-requested — the grid's mount
     * effect drives the initial load.
     */
    configure(
        sheet_index: number,
        row_count: number,
        generation: number,
        enabled = true,
    ): void {
        const source_changed =
            sheet_index !== this.sheet_index || generation !== this._generation;
        this.sheet_index = sheet_index;
        this.row_count = row_count;
        this._generation = generation;
        this.enabled = enabled;
        if (source_changed) {
            this.clear();
        }
        if (source_changed && this.viewport_set && enabled) {
            this.ensure_rows(this.viewport.start, this.viewport.end);
        }
    }

    /** Request any not-yet-resident pages covering the inclusive visible range. */
    ensure_rows(start_row: number, end_row: number): void {
        this.viewport = { start: start_row, end: end_row };
        this.viewport_set = true;
        if (!this.enabled || this.row_count <= 0) return;
        this.request_missing_pages(start_row, end_row);
    }

    /** Whether every page covering the inclusive range is already resident. */
    private range_resident(start_row: number, end_row: number): boolean {
        if (this.row_count <= 0) return true;
        for (const start of get_needed_page_starts(start_row, end_row)) {
            if (start >= this.row_count) continue;
            if (!this.pages.has(start)) return false;
        }
        return true;
    }

    /** Send requests for any not-yet-resident, not-yet-pending pages in range. */
    private request_missing_pages(start_row: number, end_row: number): void {
        for (const start of get_needed_page_starts(start_row, end_row)) {
            if (start >= this.row_count) continue;
            if (this.pages.has(start)) {
                this.touch(start);
                continue;
            }
            if (this.pending.has(start)) continue;
            const request_id = `${this.loader_id}:${this.sheet_index}:${start}:${++this.req_seq}`;
            this.pending.set(start, request_id);
            this.post({
                type: 'requestRows',
                sheetIndex: this.sheet_index,
                startRow: start,
                count: PAGE_SIZE,
                requestId: request_id,
                generation: this._generation,
            });
        }
    }

    /**
     * Request every page covering the inclusive range and resolve once they are
     * all resident. Unlike {@link ensure_rows} this does not move the display
     * viewport — it is for whole-selection copies that must serialize rows the
     * user never scrolled into view (e.g. "Copy sheet" on a freshly switched-to
     * sheet, whose pages are still in flight).
     *
     * The range's pages are protected from LRU eviction until this promise
     * settles (see {@link evict}), so a bulk copy can hold more than `max_pages`
     * pages resident at once. Resolves `true` once the whole range is resident.
     * Resolves `false` if a sheet switch or reload clears the cache mid-load, so
     * the caller can abandon the copy rather than serialize a now-empty cache
     * into the clipboard.
     */
    ensure_rows_loaded(start_row: number, end_row: number): Promise<boolean> {
        if (!this.enabled || this.row_count <= 0) {
            return Promise.resolve(this.range_resident(start_row, end_row));
        }
        const start = Math.max(0, start_row);
        const end = Math.min(end_row, this.row_count - 1);
        if (this.range_resident(start, end)) {
            this.request_missing_pages(start, end); // touch for LRU recency
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            // Register the waiter before requesting, so its range is protected
            // from eviction the moment any of its pages start arriving.
            this.load_waiters.push({ start, end, resolve });
            this.request_missing_pages(start, end);
        });
    }

    /** Ingest a host `rowData` reply. Returns false (and ignores) when stale or malformed. */
    on_row_data(msg: RowDataMsg): boolean {
        if (msg.generation !== this._generation) return false;
        if (msg.sheetIndex !== this.sheet_index) return false;
        const start = msg.startRow;
        if (this.pending.get(start) !== msg.requestId) return false;
        if (!Array.isArray(msg.rows) || !Array.isArray(msg.sourceRows)) return false;
        if (msg.rows.length !== msg.sourceRows.length) return false;
        for (let i = 0; i < msg.rows.length; i++) {
            if (!(i in msg.rows) || !(i in msg.sourceRows)) return false;
            if (!Array.isArray(msg.rows[i])) return false;
            const source_row = msg.sourceRows[i];
            if (!Number.isSafeInteger(source_row) || source_row < 0) return false;
        }

        const page: CachedPage = {
            rows: msg.rows,
            source_rows: msg.sourceRows,
        };
        this.pending.delete(start);
        this.pages.delete(start); // re-insert to mark most-recently-used
        this.pages.set(start, page);
        this.evict();
        this.on_change();
        this.settle_load_waiters();
        return true;
    }

    /**
     * Resolve any bulk-copy waiters whose range is now fully resident. Runs after
     * `evict()` — which still sees the waiter, so the just-loaded pages are kept.
     * A resolved waiter drops out of {@link load_waiters}, so its pages become
     * evictable again; but its `await` continuation is a microtask that runs
     * before the next `rowData` macrotask, so the awaiting copy serializes those
     * pages before any later ingest can trim them.
     */
    private settle_load_waiters(): void {
        if (this.load_waiters.length === 0) return;
        this.load_waiters = this.load_waiters.filter((waiter) => {
            if (!this.range_resident(waiter.start, waiter.end)) return true;
            waiter.resolve(true);
            return false;
        });
    }

    /**
     * Up to `max` resident rows drawn across all cached pages, for sampling
     * (column auto-fit measures loaded text only — it never forces a fetch).
     * Rows past `row_count` in a partial final page are excluded.
     */
    sample_loaded_rows(max: number): Row[] {
        const out: Row[] = [];
        for (const [start, page] of this.pages) {
            for (let i = 0; i < page.rows.length; i++) {
                if (out.length >= max) return out;
                const abs = start + i;
                if (this.row_count > 0 && abs >= this.row_count) break;
                out.push(page.rows[i]);
            }
        }
        return out;
    }

    /** Cells for an absolute display row, or undefined while its page is loading. */
    get_row(row: number): Row | undefined {
        const location = this.locate(row);
        return location?.page.rows[location.offset];
    }

    /** Canonical source-row identity for an absolute display row, when resident. */
    get_source_row(row: number): number | undefined {
        const location = this.locate(row);
        return location?.page.source_rows[location.offset];
    }

    clear(): void {
        this.pages.clear();
        this.pending.clear();
        // Abandon any in-flight bulk copy: the cache it was accumulating is gone,
        // so let the awaiting copy proceed with whatever is left (it will report
        // the usual clip warning) rather than hang forever.
        const waiters = this.load_waiters;
        this.load_waiters = [];
        for (const waiter of waiters) waiter.resolve(false);
    }

    private locate(row: number): { page: CachedPage; offset: number } | undefined {
        const start = Math.floor(row / PAGE_SIZE) * PAGE_SIZE;
        const page = this.pages.get(start);
        if (page === undefined) return undefined;
        return { page, offset: row - start };
    }

    private touch(start: number): void {
        const page = this.pages.get(start);
        if (page === undefined) return;
        this.pages.delete(start);
        this.pages.set(start, page);
    }

    private evict(): void {
        if (this.pages.size <= this.max_pages) return;
        const protect = new Set(
            get_needed_page_starts(this.viewport.start, this.viewport.end),
        );
        // Each outstanding bulk copy load may hold far more than the cap
        // resident; never evict the pages any of them is still assembling.
        // Protecting per waiter (rather than one merged envelope) keeps the gap
        // between disjoint loads evictable and shrinks protection as each settles.
        for (const waiter of this.load_waiters) {
            for (const start of get_needed_page_starts(waiter.start, waiter.end)) {
                protect.add(start);
            }
        }
        while (this.pages.size > this.max_pages) {
            let removed = false;
            for (const key of this.pages.keys()) {
                if (protect.has(key)) continue;
                this.pages.delete(key);
                removed = true;
                break;
            }
            if (!removed) break; // everything left is protected by the viewport
        }
    }
}
