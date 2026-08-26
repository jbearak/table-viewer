import type { RenderedCell } from '../data-source/interface';
import type { HostMessage, WebviewMessage } from '../types';
import type { CompareRowStatus } from '../diff-compare/compare-source';
import { PAGE_SIZE, get_needed_page_starts } from './grid-model';

type PostFn = (msg: WebviewMessage) => void;
type RowDataMsg = Extract<HostMessage, { type: 'rowData' }>;
type CompareDiffMsg = Extract<HostMessage, { type: 'compareDiff' }>;
type Row = (RenderedCell | null)[];

interface CompareCellBase {
    readonly raw: string;
    readonly formatted: string;
}

/** One display row's git-compare diff: its band, and the original-side raw and
 * formatted text of changed cells keyed by canonical source column. */
export interface CompareRowDiff {
    readonly status?: Exclude<CompareRowStatus, 'same'>;
    readonly bases?: ReadonlyMap<number, CompareCellBase>;
}

interface CachedPage {
    readonly rows: Row[];
    readonly source_rows: number[];
    /** The requestRows id this page answered — the compareDiff sidecar echoes
     *  it, which is what pairs the diff to exactly this delivery. */
    readonly request_id: string;
    /** Git-compare sidecar for this page's rows, by offset. Ingested after the
     *  page (the host posts compareDiff right behind rowData), and living on
     *  the page so eviction, clear, and replacement can never strand it. */
    compare_rows?: (CompareRowDiff | undefined)[];
}

let next_loader_id = 0;
const MAX_CELLS_PER_PAGE = 64 * 1024;
const DEFAULT_MAX_CACHED_CELLS = 1_000_000;
/** Keep bulk operations from synchronously flooding the extension host. */
export const MAX_PENDING_PAGE_REQUESTS = 16;

/**
 * Demand-paged row store for the Glide grid. Pure (no React, no vscode import):
 * `post` and `on_change` are injected, so the whole fetch/cache/generation/LRU
 * logic is unit-testable with plain spies. The `use_row_loader` hook
 * (use-row-loader.ts) wires it to the host bridge and a forced re-render.
 *
 * - Pages are PAGE_SIZE-aligned windows keyed by their start row.
 * - `generation` guards against `rowData` belonging to a superseded document
 *   version (bumped by the host on every reload); stale or wrong-sheet windows
 *   are dropped.
 * - An LRU cap bounds memory; pages intersecting the current viewport are never
 *   evicted so the visible region always has a chance to stay resident. Explicit
 *   {@link pin_rows} holds add to that protection for a range whose identity
 *   something outside the viewport depends on (an open cell editor).
 */
export class RowLoader {
    private readonly pages = new Map<number, CachedPage>();
    /**
     * Reverse index: canonical source row → the resident page (and offset within
     * it) that currently claims it. Durable CSV edit keys are source-keyed, so
     * conflict detection has to read a cell by *source* row without knowing which
     * display row it landed on; scanning resident pages per read would be
     * O(resident rows) on a hot path.
     *
     * Maintained incrementally (on_row_data / evict / clear) rather than derived
     * lazily: a lazily-built map would be discarded and rebuilt on every page
     * landing during a scroll — O(resident rows) per page instead of O(PAGE_SIZE).
     *
     * Bound: this tracks resident *rows*, not a fixed page cap. Steady state is
     * `max_pages` x PAGE_SIZE (50 x 100 = 5,000 rows). Bulk-copy waiters may
     * temporarily exceed that cap because their pages are eviction-protected;
     * the caller invokes {@link trim} immediately after serialization.
     *
     * Deliberately total rather than injective, so no assertion here. Nothing we
     * ship produces a non-injective projection — `transform_indices` is a
     * permutation and Excel header promotion only drops rows — but `sourceRows` is
     * host-supplied and only shape-validated on ingest, so a host bug must not
     * crash the webview. The rule is therefore **last ingest wins**: the most
     * recent page to claim a source row owns it, and a page being replaced or
     * evicted retracts only entries that still point at itself
     * (see {@link unindex_page}).
     */
    private readonly source_to_page = new Map<number, { start: number; offset: number }>();
    private readonly pending = new Map<number, string>();
    private readonly loader_id = ++next_loader_id;
    private _generation = 1;
    private sheet_index = 0;
    private row_count = 0;
    private req_seq = 0;
    private viewport = { start: 0, end: 0 };
    private viewport_set = false;
    private enabled = true;
    private page_size = PAGE_SIZE;
    private column_count = 1;
    // Outstanding bulk-copy loads: each holds its own range's pages resident
    // until that range is fully cached and the promise settles.
    private load_waiters: Array<{
        start: number;
        end: number;
        resolve: (loaded: boolean) => void;
    }> = [];
    /**
     * Explicit eviction holds, keyed by an opaque token the caller releases (see
     * {@link pin_rows}). Separate from `load_waiters` because a pin has no
     * promise to settle it: its lifetime is a UI state (an open cell editor), so
     * only the caller knows when it ends.
     */
    private readonly pins = new Map<symbol, { start: number; end: number }>();

    constructor(
        private readonly post: PostFn,
        private readonly on_change: () => void,
        private readonly max_pages = 50,
        private readonly max_cached_cells = DEFAULT_MAX_CACHED_CELLS,
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
     *
     * Needs no separate `source_to_page` handling: the only path here that drops
     * pages is `clear()`, which empties the source index too.
     */
    configure(
        sheet_index: number,
        row_count: number,
        generation: number,
        enabled = true,
        column_count = 1,
    ): void {
        const next_column_count = Math.max(1, Math.floor(column_count));
        const next_page_size = Math.min(
            PAGE_SIZE,
            Math.max(1, Math.floor(MAX_CELLS_PER_PAGE / next_column_count)),
        );
        const source_changed =
            sheet_index !== this.sheet_index
            || generation !== this._generation
            || next_page_size !== this.page_size;
        this.sheet_index = sheet_index;
        this.row_count = row_count;
        this._generation = generation;
        this.enabled = enabled;
        this.column_count = next_column_count;
        this.page_size = next_page_size;
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
        this.pump_requests();
    }

    /** Whether every page covering the inclusive range is already resident. */
    private range_resident(start_row: number, end_row: number): boolean {
        if (this.row_count <= 0) return true;
        for (const start of get_needed_page_starts(start_row, end_row, this.page_size)) {
            if (start >= this.row_count) continue;
            if (!this.pages.has(start)) return false;
        }
        return true;
    }

    /**
     * Send requests for missing pages in a range until the global in-flight cap
     * is full. Returns early at the cap; each accepted reply pumps the next page.
     */
    private request_missing_pages(start_row: number, end_row: number): void {
        for (const start of get_needed_page_starts(start_row, end_row, this.page_size)) {
            if (start >= this.row_count) continue;
            if (this.pages.has(start)) {
                this.touch(start);
                continue;
            }
            if (this.pending.has(start)) continue;
            if (this.pending.size >= MAX_PENDING_PAGE_REQUESTS) return;
            const request_id = `${this.loader_id}:${this.sheet_index}:${start}:${++this.req_seq}`;
            this.pending.set(start, request_id);
            this.post({
                type: 'requestRows',
                sheetIndex: this.sheet_index,
                startRow: start,
                count: this.page_size,
                requestId: request_id,
                generation: this._generation,
            });
        }
    }

    /** Fill available request slots, prioritizing the visible range over copies. */
    private pump_requests(): void {
        if (!this.enabled || this.row_count <= 0) return;
        if (this.viewport_set) {
            this.request_missing_pages(this.viewport.start, this.viewport.end);
        }
        for (const waiter of this.load_waiters) {
            if (this.pending.size >= MAX_PENDING_PAGE_REQUESTS) return;
            this.request_missing_pages(waiter.start, waiter.end);
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
            this.pump_requests();
        });
    }

    /** Drop completed bulk-load pages back to the normal LRU/cell cap. */
    trim(): void {
        this.evict();
    }

    /**
     * Hold every page covering the inclusive range resident until the returned
     * token is passed to {@link unpin_rows}. Unlike {@link ensure_rows_loaded}
     * this requests nothing and promises nothing about *becoming* resident — it
     * only refuses to let {@link evict} drop what is already there.
     *
     * Why this exists: the protect set was the current viewport plus in-flight
     * bulk copies, and neither covers the row under an *open cell editor*. Glide's
     * overlay does not close on scroll, so a user can type into display row 12,
     * scroll thousands of rows away (evicting row 12's page and retracting its
     * source-row claims), and then press Enter. The commit needs that row's
     * canonical identity and its persisted text — pinning is what keeps both
     * readable. GridShell captures the identity too, so a pin that could not be
     * taken (page already gone) still does not lose the typed text.
     *
     * A pin is a leak if it is never released, so the token is deliberately
     * opaque and single-purpose: one open editor, one token, released on close,
     * on unmount, and by {@link clear} (a sheet switch or reload throws the pages
     * away regardless, so holding their pins would protect nothing and outlive
     * the editor). Releasing an unknown or already-released token is a no-op, so
     * a double release cannot strand another editor's pin.
     */
    pin_rows(start_row: number, end_row: number): symbol {
        const token = Symbol('row-pin');
        this.pins.set(token, { start: start_row, end: end_row });
        return token;
    }

    /** Release a {@link pin_rows} hold. Unknown/stale tokens are ignored. */
    unpin_rows(token: symbol): void {
        this.pins.delete(token);
    }

    /** For tests: number of outstanding {@link pin_rows} holds. */
    get pin_count(): number {
        return this.pins.size;
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

        // Every validation early-return above runs before any indexing below, so a
        // rejected (stale / malformed) page can never pollute the source index.
        const page: CachedPage = {
            rows: msg.rows,
            source_rows: msg.sourceRows,
            request_id: msg.requestId,
        };
        this.pending.delete(start);
        // Retract-before-insert. A page replaced in place must give up the claims
        // its replacement no longer covers (a shorter or renamed redelivery),
        // otherwise the stale entries outlive the rows they named.
        //
        // Defensive, exactly like the `pages.delete(start)` below it: replacing a
        // *resident* page is unreachable today, because a request is only posted
        // when the page is absent (`request_missing_pages`) and its pending id is
        // consumed by the first reply, so no second reply for a now-resident page
        // can pass the guard above. Kept because the alternative to one Map read
        // is a silent leak the moment that residency/pending invariant changes.
        // The reachable path — evict, re-request, redeliver with different
        // identities — is retracted by `evict` and covered in the tests.
        const previous = this.pages.get(start);
        if (previous !== undefined) this.unindex_page(start, previous);
        this.pages.delete(start); // re-insert to mark most-recently-used
        this.pages.set(start, page);
        this.index_page(start, page);
        // Index before evicting so `evict` (which retracts what it drops) sees a
        // map consistent with `pages`.
        this.evict();
        this.on_change();
        this.settle_load_waiters();
        this.pump_requests();
        return true;
    }

    /**
     * Ingest the git-compare sidecar the host posts right behind a `rowData`
     * window. It attaches to the resident page whose `requestId` it echoes, so
     * it can never describe rows other than the ones that delivery carried —
     * and it shares that page's whole lifecycle (LRU, clear, replacement) for
     * free. Returns false (and ignores) when no such page is resident.
     */
    on_compare_diff(msg: CompareDiffMsg): boolean {
        if (msg.generation !== this._generation) return false;
        if (msg.sheetIndex !== this.sheet_index) return false;
        const page = this.pages.get(msg.startRow);
        if (page === undefined || page.request_id !== msg.requestId) return false;
        if (!Array.isArray(msg.rowStatus) || !Array.isArray(msg.changedCells)) return false;
        const records: (
            { status?: CompareRowDiff['status']; bases?: Map<number, CompareCellBase> } | undefined
        )[] =
            new Array<undefined>(page.rows.length);
        for (let offset = 0; offset < msg.rowStatus.length && offset < page.rows.length; offset++) {
            const status = msg.rowStatus[offset];
            // 'same' carries no band, so it is retained as absent rather than
            // stored. Anything else is dropped: an unknown status from a newer
            // host must not paint an arbitrary band.
            if (status === 'added' || status === 'deleted' || status === 'moved') {
                records[offset] = { status };
            }
        }
        for (const cell of msg.changedCells) {
            const offset = cell.row - msg.startRow;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset >= page.rows.length) continue;
            if (!Number.isSafeInteger(cell.col) || cell.col < 0) continue;
            if (typeof cell.base !== 'string') continue;
            const formatted = typeof cell.formattedBase === 'string'
                ? cell.formattedBase
                : cell.base;
            const record = records[offset] ?? (records[offset] = {});
            (record.bases ?? (record.bases = new Map())).set(cell.col, {
                raw: cell.base,
                formatted,
            });
        }
        page.compare_rows = records;
        this.on_change();
        return true;
    }

    /** Git-compare band ('added'/'deleted') for a display row, when resident. */
    get_compare_status(row: number): CompareRowDiff['status'] | undefined {
        return this.compare_row(row)?.status;
    }

    /** Original-side text of a changed cell in git compare mode, when resident. */
    get_compare_base(
        row: number,
        col: number,
        show_formatting = false,
    ): string | undefined {
        const base = this.compare_row(row)?.bases?.get(col);
        return show_formatting ? base?.formatted : base?.raw;
    }

    private compare_row(row: number): CompareRowDiff | undefined {
        const location = this.locate(row);
        return location?.page.compare_rows?.[location.offset];
    }

    /**
     * Resolve any bulk-copy waiters whose range is now fully resident. Runs after
     * `evict()` — which still sees the waiter, so the just-loaded pages are kept.
     * Once serialization finishes, the caller explicitly invokes {@link trim}.
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

    /**
     * A cell's raw text addressed by **canonical source row**, mirroring
     * `get_cell_raw`'s contract exactly (see `GetCellRaw` in
     * edit-session-store.ts): a resident-but-blank cell yields `''`, and a source
     * row whose page is not resident — evicted, not yet fetched, or filtered out
     * of the current view — yields `undefined`. Conflict detection depends on that
     * distinction: `undefined` means "unknown", never "changed".
     */
    get_cell_raw_for_source(source_row: number, col: number): string | undefined {
        const cell = this.get_cell_for_source(source_row, col);
        if (cell === undefined) return undefined;
        return cell ? String(cell.raw ?? '') : '';
    }

    /**
     * The full loaded cell addressed by **canonical source row**, with the same
     * residency contract as {@link get_cell_raw_for_source}: `null` for a
     * resident-but-blank cell, `undefined` for a non-resident source row. The
     * markdown edit path reads this to build edit text and conflict bases from
     * the cell's effective rich content, not just its raw string.
     */
    get_cell_for_source(source_row: number, col: number): RenderedCell | null | undefined {
        const claim = this.source_to_page.get(source_row);
        if (claim === undefined) return undefined;
        const page = this.pages.get(claim.start);
        if (page === undefined) return undefined;
        const cells = page.rows[claim.offset];
        if (cells === undefined) return undefined;
        return cells[col] ?? null;
    }

    /** Whether a canonical source row is currently resident on some cached page. */
    has_source_row(source_row: number): boolean {
        return this.source_to_page.has(source_row);
    }

    clear(): void {
        this.pages.clear();
        this.source_to_page.clear();
        this.pending.clear();
        // Drop every pin. The pages they protected are gone, so keeping them would
        // protect nothing while permanently shrinking the effective LRU cap if the
        // pin holder's release never arrives (a sheet switch can unmount the editor
        // without a close callback). The holder's own release is still safe —
        // unpin_rows ignores unknown tokens.
        this.pins.clear();
        // Abandon any in-flight bulk copy: the cache it was accumulating is gone,
        // so let the awaiting copy proceed with whatever is left (it will report
        // the usual clip warning) rather than hang forever.
        const waiters = this.load_waiters;
        this.load_waiters = [];
        for (const waiter of waiters) waiter.resolve(false);
    }

    /** Claim every source row this page carries (last ingest wins). */
    private index_page(start: number, page: CachedPage): void {
        for (let offset = 0; offset < page.source_rows.length; offset++) {
            this.source_to_page.set(page.source_rows[offset], { start, offset });
        }
    }

    /**
     * Retract this page's claims. Only entries that still point at `start` are
     * removed: a later page may already have taken a duplicated source row over,
     * and dropping the newer claim would strand a resident row as unreadable.
     */
    private unindex_page(start: number, page: CachedPage): void {
        for (let offset = 0; offset < page.source_rows.length; offset++) {
            const claim = this.source_to_page.get(page.source_rows[offset]);
            if (claim?.start === start) this.source_to_page.delete(page.source_rows[offset]);
        }
    }

    private locate(row: number): { page: CachedPage; offset: number } | undefined {
        const start = Math.floor(row / this.page_size) * this.page_size;
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
        const page_cells = this.page_size * this.column_count;
        const effective_max_pages = Math.min(
            this.max_pages,
            Math.max(1, Math.floor(this.max_cached_cells / page_cells)),
        );
        if (this.pages.size <= effective_max_pages) return;
        const protect = new Set(
            get_needed_page_starts(
                this.viewport.start, this.viewport.end, this.page_size,
            ),
        );
        // Each outstanding bulk copy load may hold far more than the cap
        // resident; never evict the pages any of them is still assembling.
        // Protecting per waiter (rather than one merged envelope) keeps the gap
        // between disjoint loads evictable and shrinks protection as each settles.
        for (const waiter of this.load_waiters) {
            for (const start of get_needed_page_starts(
                waiter.start, waiter.end, this.page_size,
            )) {
                protect.add(start);
            }
        }
        // Explicit holds (an open cell editor's row) — see pin_rows. Same shape as
        // the waiter loop above: per pin, so releasing one stops protecting only
        // its own range.
        for (const pin of this.pins.values()) {
            for (const start of get_needed_page_starts(
                pin.start, pin.end, this.page_size,
            )) {
                protect.add(start);
            }
        }
        while (this.pages.size > effective_max_pages) {
            let removed = false;
            for (const key of this.pages.keys()) {
                if (protect.has(key)) continue;
                const page = this.pages.get(key)!;
                this.pages.delete(key);
                this.unindex_page(key, page);
                removed = true;
                break;
            }
            if (!removed) break; // everything left is protected by the viewport
        }
    }
}
