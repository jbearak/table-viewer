import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { HostMessage } from '../types';
import { CompareLoader, type CompareRowStatus } from './compare-loader';

export interface UseCompareLoader {
    /** 'added' / 'deleted' band for a display row; undefined = unchanged/unknown. */
    get_status(row: number): CompareRowStatus | undefined;
    /** The original-side text of a changed cell; undefined = unchanged/unknown. */
    get_base(row: number, col: number): string | undefined;
    /** Bumps on every ingested page so consumers can re-key Glide redraws. */
    readonly version: number;
}

const INERT: UseCompareLoader = {
    get_status: () => undefined,
    get_base: () => undefined,
    version: 0,
};

/**
 * React binding for {@link CompareLoader}, mirroring use_row_loader: threads
 * `sheet_index`/`generation` in, subscribes to host `compareDiff` messages, and
 * forces a re-render so the grid shell repaints freshly-diffed cells. Pages
 * arrive unsolicited beside every rowData window, so unlike the row loader
 * there is nothing to request. When `enabled` is false (not in compare mode)
 * the loader is never constructed and the shared inert instance is returned.
 */
export function use_compare_loader(
    sheet_index: number,
    generation: number,
    enabled: boolean,
): UseCompareLoader {
    const [version, bump] = useReducer((n: number) => n + 1, 0);
    const ref = useRef<CompareLoader | null>(null);
    if (enabled && ref.current === null) {
        ref.current = new CompareLoader(bump);
    }
    const loader = enabled ? ref.current : null;

    useEffect(() => {
        loader?.configure(sheet_index, generation);
    }, [loader, sheet_index, generation]);

    useEffect(() => {
        if (loader === null) return;
        const handler = (e: MessageEvent) => {
            const data: unknown = e.data;
            if (data === null || typeof data !== 'object') return;
            const msg = data as HostMessage;
            if (msg.type === 'compareDiff') loader.on_compare_diff(msg);
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [loader]);

    const get_status = useCallback(
        (row: number) => loader?.get_status(row),
        [loader],
    );
    const get_base = useCallback(
        (row: number, col: number) => loader?.get_base(row, col),
        [loader],
    );

    return enabled ? { get_status, get_base, version } : INERT;
}
