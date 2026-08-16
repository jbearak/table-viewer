/**
 * Pure assembly of the `{ "row:col" → value }` payload posted to the host for
 * saving (Phase E). Extracted from the grid shell so the in-progress-editor
 * folding rule is unit-tested without Glide or the DOM.
 */

import { make_dirty_entry, type CsvDirtyEntry, type CsvDirtyMap } from '../types';

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

/**
 * Assemble both host save payloads in one pass, or refuse the whole worksheet
 * while any committed entry still lacks its true conflict base.
 */
export function collect_save_payload(
    dirty: ReadonlyMap<string, CsvDirtyEntry & { base_pending?: boolean }>,
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
        // Runs ride along: the xlsx save plan reads `valueRuns` off the exact
        // entry to write styled inline strings; string-only consumers ignore it.
        exact[key] = Object.freeze(
            make_dirty_entry(entry.value, entry.base, entry.valueRuns, entry.baseRuns),
        );
    }
    return Object.freeze({
        status: 'ready',
        edits: Object.freeze(edits),
        dirtyEdits: Object.freeze(exact),
    });
}
