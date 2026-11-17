/**
 * `performance.mark`s for the desktop latency spec
 * (`desktop/test-performance/history-latency.spec.ts`). Emitted only when the
 * spec has set the page's test flag, so a window in use keeps no mark buffer.
 */

declare global {
    // eslint-disable-next-line no-var
    var __TABLE_VIEWER_PERF_MARKS__: boolean | undefined;
}

export type PerfMarkName =
    /** A press of Undo or Redo reached the window. */
    | 'tv:press'
    /** The history store changed. */
    | 'tv:history-changed'
    /** The host settled a view request, by request id. */
    | 'tv:view-request-settled'
    /** The person's view action ended: every request it sent is settled. */
    | 'tv:view-action-ended'
    /** The grid rendered a new view generation. */
    | 'tv:view-generation-rendered';

export function perf_mark(name: PerfMarkName, detail?: Record<string, unknown>): void {
    if (globalThis.__TABLE_VIEWER_PERF_MARKS__ !== true) return;
    performance.mark(name, detail === undefined ? undefined : { detail });
}
