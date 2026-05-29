import { useEffect, useReducer, useRef } from 'react';
import type { RenderedCell } from '../data-source/interface';
import type { HostMessage } from '../types';
import { vscode_api } from './use-state-sync';
import { RowLoader } from './row-loader';

export { RowLoader };

export interface UseRowLoader {
    ensure_rows(start_row: number, end_row: number): void;
    get_row(row: number): (RenderedCell | null)[] | undefined;
    /** Up to `max` resident rows for sampling (column auto-fit). */
    sample_loaded_rows(max: number): (RenderedCell | null)[][];
    /** Bumps on every ingested page so consumers can re-key Glide redraws. */
    readonly version: number;
}

/**
 * React binding for {@link RowLoader}. Threads `sheet_index`/`generation` in,
 * subscribes to host `rowData` messages, and forces a re-render (which the grid
 * shell uses to repaint freshly-loaded cells). On a sheet switch or reload the
 * cache is cleared; the grid re-requests the visible region on its next
 * `onVisibleRegionChanged`.
 */
export function use_row_loader(
    sheet_index: number,
    row_count: number,
    generation: number,
): UseRowLoader {
    const [version, bump] = useReducer((n: number) => n + 1, 0);
    const ref = useRef<RowLoader | null>(null);
    if (ref.current === null) {
        ref.current = new RowLoader((m) => vscode_api.postMessage(m), bump);
    }
    const loader = ref.current;
    loader.configure(sheet_index, row_count, generation);

    useEffect(() => {
        const handler = (e: MessageEvent) => {
            const msg = e.data as HostMessage;
            if (msg.type === 'rowData') loader.on_row_data(msg);
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [loader]);

    return {
        ensure_rows: (s, en) => loader.ensure_rows(s, en),
        get_row: (r) => loader.get_row(r),
        sample_loaded_rows: (max) => loader.sample_loaded_rows(max),
        version,
    };
}
