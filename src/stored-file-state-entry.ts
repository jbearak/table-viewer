/**
 * What one stored entry looks like, and how old it counts as.
 *
 * Its own module because both sides of the inspector need it: the maintenance
 * layer, to decide what an age-based trim selects, and the browser UI, to show
 * the "Last used" column. Those two answers have to agree — a row the list calls
 * recent must not be swept up as stale — and the only way to guarantee that is
 * one definition.
 *
 * Deliberately free of `node:` imports so the webview and desktop renderer
 * bundles can import it; the maintenance module it would otherwise live in pulls
 * in `node:fs`.
 */

export interface StoredFileStateEntry {
    readonly path: string;
    readonly sizeBytes: number;
    readonly hasPendingEdits: boolean;
    /** Held by an open window, or by a session that has not released it. */
    readonly isLeased: boolean;
    /**
     * The file this entry remembers is gone from disk.
     *
     * Undefined when it was not checked — the listing pays for a stat per entry,
     * so the selectors that do not need the answer do not ask. Always false for
     * a provider-backed key, which names no file that could go missing.
     */
    readonly isMissing?: boolean;
    readonly updatedAtMs?: number;
    readonly touchedAtMs?: number;
}

/**
 * When an entry was last active.
 *
 * `touchedAtMs` is the more recent signal, but an entry written and never
 * reopened only carries `updatedAtMs`, so take whichever is later. Undefined
 * means the row has neither — which age-based trimming treats as "not evidence
 * of staleness" rather than as infinitely old.
 */
export function entry_activity_timestamp(entry: StoredFileStateEntry): number | undefined {
    const stamps = [entry.touchedAtMs, entry.updatedAtMs]
        .filter((value): value is number => value !== undefined);
    return stamps.length === 0 ? undefined : Math.max(...stamps);
}
