/**
 * Pure assembly of the `{ "row:col" → value }` payload posted to the host for
 * saving (Phase E). Extracted from the grid shell so the in-progress-editor
 * folding rule is unit-tested without Glide or the DOM.
 */

import type { CsvDirtyEntry, CsvDirtyMap } from '../types';

export type CsvSavePayloadPreflight =
    | {
        status: 'ready';
        edits: Readonly<Record<string, string>>;
        dirtyEdits: CsvDirtyMap;
    }
    | {
        status: 'blocked';
        reason: 'unresolvedBases';
    };

/** A still-open editor's live value and the cell's persisted (original) text. */
export interface LiveEdit {
    /** `"row:col"`. */
    key: string;
    /** Current text in the open editor. */
    value: string;
    /** Persisted raw text at that cell, to detect an in-progress revert. */
    original: string;
}

/**
 * Assemble both host save payloads in one pass, or refuse the whole worksheet
 * while any committed entry still lacks its true conflict base.
 */
export function collect_save_payload(
    dirty: ReadonlyMap<string, CsvDirtyEntry & { base_pending?: boolean }>,
    live: LiveEdit | null,
): CsvSavePayloadPreflight {
    const edits: Record<string, string> = {};
    const exact: Record<string, CsvDirtyEntry> = {};
    for (const [key, entry] of dirty) {
        if (entry.base_pending) {
            return Object.freeze({
                status: 'blocked',
                reason: 'unresolvedBases',
            });
        }
        edits[key] = entry.value;
        exact[key] = Object.freeze({ value: entry.value, base: entry.base });
    }
    if (live) {
        if (live.value !== live.original) {
            edits[live.key] = live.value;
            exact[live.key] = Object.freeze({
                value: live.value,
                base: live.original,
            });
        } else {
            delete edits[live.key];
            delete exact[live.key];
        }
    }
    return Object.freeze({
        status: 'ready',
        edits: Object.freeze(edits),
        dirtyEdits: Object.freeze(exact),
    });
}
