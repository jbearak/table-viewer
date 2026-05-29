import type { RenderedCell } from '../data-source/interface';
import type { HostMessage, WebviewMessage } from '../types';
import { PAGE_SIZE, get_needed_page_starts } from './grid-model';

type PostFn = (msg: WebviewMessage) => void;
type RowDataMsg = Extract<HostMessage, { type: 'rowData' }>;

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
    private readonly pages = new Map<number, (RenderedCell | null)[][]>();
    private readonly pending = new Set<number>();
    private _generation = 1;
    private sheet_index = 0;
    private row_count = 0;
    private req_seq = 0;
    private viewport = { start: 0, end: 0 };
    private viewport_set = false;

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
     * generation. Without this, a `metaReload` that keeps the grid mounted
     * would leave the visible region blank until the user happens to scroll
     * (Glide only re-fetches via `onVisibleRegionChanged`, which does not fire
     * when the region is unchanged). The first `configure` of a session has no
     * established viewport yet, so nothing is re-requested — the grid's mount
     * effect drives the initial load.
     */
    configure(sheet_index: number, row_count: number, generation: number): void {
        const changed = sheet_index !== this.sheet_index || generation !== this._generation;
        this.sheet_index = sheet_index;
        this.row_count = row_count;
        this._generation = generation;
        if (changed) {
            this.clear();
            if (this.viewport_set) {
                this.ensure_rows(this.viewport.start, this.viewport.end);
            }
        }
    }

    /** Request any not-yet-resident pages covering the inclusive visible range. */
    ensure_rows(start_row: number, end_row: number): void {
        this.viewport = { start: start_row, end: end_row };
        this.viewport_set = true;
        for (const start of get_needed_page_starts(start_row, end_row)) {
            if (this.row_count > 0 && start >= this.row_count) continue;
            if (this.pages.has(start)) {
                this.touch(start);
                continue;
            }
            if (this.pending.has(start)) continue;
            this.pending.add(start);
            this.post({
                type: 'requestRows',
                sheetIndex: this.sheet_index,
                startRow: start,
                count: PAGE_SIZE,
                requestId: `${this.sheet_index}:${start}:${++this.req_seq}`,
                generation: this._generation,
            });
        }
    }

    /** Ingest a host `rowData` reply. Returns false (and ignores) when stale. */
    on_row_data(msg: RowDataMsg): boolean {
        if (msg.generation !== this._generation) return false;
        if (msg.sheetIndex !== this.sheet_index) return false;
        const start = msg.startRow;
        this.pending.delete(start);
        this.pages.delete(start); // re-insert to mark most-recently-used
        this.pages.set(start, msg.rows);
        this.evict();
        this.on_change();
        return true;
    }

    /**
     * Up to `max` resident rows drawn across all cached pages, for sampling
     * (column auto-fit measures loaded text only — it never forces a fetch).
     * Rows past `row_count` in a partial final page are excluded.
     */
    sample_loaded_rows(max: number): (RenderedCell | null)[][] {
        const out: (RenderedCell | null)[][] = [];
        for (const [start, page] of this.pages) {
            for (let i = 0; i < page.length; i++) {
                if (out.length >= max) return out;
                const abs = start + i;
                if (this.row_count > 0 && abs >= this.row_count) break;
                out.push(page[i]);
            }
        }
        return out;
    }

    /** Cells for an absolute row, or undefined while its page is loading. */
    get_row(row: number): (RenderedCell | null)[] | undefined {
        const start = Math.floor(row / PAGE_SIZE) * PAGE_SIZE;
        const page = this.pages.get(start);
        if (page === undefined) return undefined;
        return page[row - start];
    }

    clear(): void {
        this.pages.clear();
        this.pending.clear();
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
