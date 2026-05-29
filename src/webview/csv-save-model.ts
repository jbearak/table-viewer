/**
 * Pure assembly of the `{ "row:col" → value }` payload posted to the host for
 * saving (Phase E). Extracted from the grid shell so the in-progress-editor
 * folding rule is unit-tested without Glide or the DOM.
 */

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
