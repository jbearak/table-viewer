import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { RenderedCell } from '../data-source/interface';
import type { HostMessage } from '../types';
import { vscode_api } from './use-state-sync';
import { RowLoader } from './row-loader';

export { RowLoader };

export interface UseRowLoader {
    ensure_rows(start_row: number, end_row: number): void;
    get_row(row: number): (RenderedCell | null)[] | undefined;
    /** Canonical source-row identity for a resident display row. */
    get_source_row(row: number): number | undefined;
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
        ref.current = new RowLoader((m) => vscode_api.postMessage(m), bump);
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
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [loader]);

    const ensure_rows = useCallback((s: number, en: number) => loader.ensure_rows(s, en), [loader]);
    const get_row = useCallback((r: number) => loader.get_row(r), [loader]);
    const get_source_row = useCallback((r: number) => loader.get_source_row(r), [loader]);
    const sample_loaded_rows = useCallback((max: number) => loader.sample_loaded_rows(max), [loader]);

    return {
        ensure_rows,
        get_row,
        get_source_row,
        sample_loaded_rows,
        version,
    };
}
