import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { RenderedCell } from '../data-source/interface';
import type { HostMessage } from '../types';
import { host_bridge } from './host-bridge';
import { RowLoader } from './row-loader';

export { RowLoader };

export interface UseRowLoader {
    ensure_rows(start_row: number, end_row: number): void;
    /**
     * Load every page covering the range. Resolves `true` once all are resident,
     * or `false` if the cache is cleared mid-load (sheet switch/reload) so the
     * caller can abandon the operation.
     */
    ensure_rows_loaded(start_row: number, end_row: number): Promise<boolean>;
    /**
     * Hold the pages covering the inclusive range resident until the returned
     * token is released. For a row whose identity something outside the viewport
     * depends on — an open cell editor — since the viewport-based protection in
     * `evict` cannot see it.
     */
    pin_rows(start_row: number, end_row: number): symbol;
    /** Release a {@link pin_rows} hold. Unknown/stale tokens are ignored. */
    unpin_rows(token: symbol): void;
    get_row(row: number): (RenderedCell | null)[] | undefined;
    /** Canonical source-row identity for a resident display row. */
    get_source_row(row: number): number | undefined;
    /**
     * A cell's persisted raw text addressed by canonical source row. `''` for a
     * resident-but-blank cell, `undefined` when the source row is not resident —
     * the contract source-keyed conflict detection reads through (see
     * `GetCellRaw` in edit-session-store.ts).
     */
    get_cell_raw_for_source(source_row: number, col: number): string | undefined;
    /** The full loaded cell by canonical source row — same residency contract;
     *  `null` = resident but blank. The markdown edit path builds edit text and
     *  bases from the cell's effective rich content through this. */
    get_cell_for_source(source_row: number, col: number): RenderedCell | null | undefined;
    /** Whether a canonical source row is currently resident on some cached page. */
    has_source_row(source_row: number): boolean;
    /** Git-compare band ('added'/'deleted') for a display row, when resident. */
    get_compare_status(row: number): 'added' | 'deleted' | undefined;
    /** Original-side text of a changed cell in git compare mode, when resident. */
    get_compare_base(row: number, col: number): string | undefined;
    /** Up to `max` resident rows for sampling (column auto-fit). */
    sample_loaded_rows(max: number): (RenderedCell | null)[][];
    /** Bumps on every ingested page so consumers can re-key Glide redraws. */
    readonly version: number;
}

/**
 * React binding for {@link RowLoader}. Threads `sheet_index`/`generation` in,
 * subscribes to host `rowData` messages, and forces a re-render (which the grid
 * shell uses to repaint freshly-loaded cells). On a sheet switch or reload the
 * cache is cleared and the loader immediately re-requests the currently-visible
 * region at the new generation (see {@link RowLoader.configure}), so a remount-
 * generation refresh never leaves the visible rows blank until the next scroll.
 */
export function use_row_loader(
    sheet_index: number,
    row_count: number,
    generation: number,
    enabled = true,
): UseRowLoader {
    const [version, bump] = useReducer((n: number) => n + 1, 0);
    const ref = useRef<RowLoader | null>(null);
    if (ref.current === null) {
        ref.current = new RowLoader((m) => host_bridge.postMessage(m), bump);
    }
    const loader = ref.current;

    useEffect(() => {
        loader.configure(sheet_index, row_count, generation, enabled);
    }, [loader, sheet_index, row_count, generation, enabled]);

    useEffect(() => {
        const handler = (e: MessageEvent) => {
            const data: unknown = e.data;
            if (data === null || typeof data !== 'object') return;
            const msg = data as HostMessage;
            if (msg.type === 'rowData') loader.on_row_data(msg);
            else if (msg.type === 'compareDiff') loader.on_compare_diff(msg);
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [loader]);

    // On unmount the message listener is gone, so no further rowData can settle a
    // bulk copy load. Clear the loader so any outstanding ensure_rows_loaded
    // promise resolves (false) instead of dangling — GridShell is keyed by sheet
    // and generation, so a switch/reload unmounts rather than reconfigures.
    useEffect(() => () => loader.clear(), [loader]);

    const ensure_rows = useCallback((s: number, en: number) => loader.ensure_rows(s, en), [loader]);
    const ensure_rows_loaded = useCallback(
        (s: number, en: number) => loader.ensure_rows_loaded(s, en),
        [loader],
    );
    const pin_rows = useCallback(
        (s: number, en: number) => loader.pin_rows(s, en),
        [loader],
    );
    const unpin_rows = useCallback((token: symbol) => loader.unpin_rows(token), [loader]);
    const get_row = useCallback((r: number) => loader.get_row(r), [loader]);
    const get_source_row = useCallback((r: number) => loader.get_source_row(r), [loader]);
    const get_cell_raw_for_source = useCallback(
        (source_row: number, col: number) => loader.get_cell_raw_for_source(source_row, col),
        [loader],
    );
    const get_cell_for_source = useCallback(
        (source_row: number, col: number) => loader.get_cell_for_source(source_row, col),
        [loader],
    );
    const has_source_row = useCallback((source_row: number) => loader.has_source_row(source_row), [loader]);
    const get_compare_status = useCallback(
        (row: number) => loader.get_compare_status(row),
        [loader],
    );
    const get_compare_base = useCallback(
        (row: number, col: number) => loader.get_compare_base(row, col),
        [loader],
    );
    const sample_loaded_rows = useCallback((max: number) => loader.sample_loaded_rows(max), [loader]);

    return {
        ensure_rows,
        ensure_rows_loaded,
        pin_rows,
        unpin_rows,
        get_row,
        get_source_row,
        get_cell_raw_for_source,
        get_cell_for_source,
        has_source_row,
        get_compare_status,
        get_compare_base,
        sample_loaded_rows,
        version,
    };
}
