/**
 * Pure assembly of the `{ "row:col" → value }` payload posted to the host for
 * saving (Phase E). Extracted from the grid shell so the in-progress-editor
 * folding rule is unit-tested without Glide or the DOM.
 */

import type { CsvDirtyEntry, CsvDirtyMap } from '../types';

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
 * Build the save map from the committed dirty entries (value only), then fold in
 * an optionally-open editor: included when its live value differs from the
 * cell's original, removed when it matches (an in-progress revert must not save).
 */
export function collect_save_edits(
    dirty: ReadonlyMap<string, { value: string }>,
    live: LiveEdit | null,
): Record<string, string> {
    const edits: Record<string, string> = {};
    for (const [key, entry] of dirty) edits[key] = entry.value;
    if (live) {
        if (live.value !== live.original) edits[live.key] = live.value;
        else delete edits[live.key];
    }
    return edits;
}

/** Freeze the complete dirty map, folding in the open overlay with its base. */
export function collect_exact_dirty_edits(
    dirty: ReadonlyMap<string, CsvDirtyEntry & { base_pending?: boolean }>,
    live: LiveEdit | null,
): CsvDirtyMap | undefined {
    const entries: Record<string, CsvDirtyEntry> = {};
    for (const [key, entry] of dirty) {
        if (entry.base_pending) return undefined;
        entries[key] = { value: entry.value, base: entry.base };
    }
    if (live) {
        if (live.value !== live.original) {
            entries[live.key] = { value: live.value, base: live.original };
        } else {
            delete entries[live.key];
        }
    }
    return Object.freeze(Object.fromEntries(
        Object.entries(entries).map(([key, entry]) => [key, Object.freeze(entry)]),
    ));
}
