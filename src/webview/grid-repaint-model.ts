/**
 * The set of cell keys (`"row:col"`) whose dirty- or conflict-tint differs
 * between two renders — i.e. exactly the cells the grid must repaint when the
 * edit/conflict state changes in bulk.
 *
 * GridShell damages these instead of the whole visible region, so a single-cell
 * commit (which already damages its own cell inline) no longer triggers a
 * full-viewport rebuild, while the genuine bulk transitions still repaint:
 *  - save-clear drops the saved keys,
 *  - "Discard Conflicted" / "Discard All" drop many keys,
 *  - a reload flips cells into (or out of) the conflicted set.
 *
 * Value-only changes (re-editing a dirty cell to a different value) keep the
 * same key and are handled by the inline single-cell damage, not this set.
 */
export function changed_tint_keys(
    prev_dirty: ReadonlySet<string>,
    next_dirty: ReadonlySet<string>,
    prev_conflicted: ReadonlySet<string>,
    next_conflicted: ReadonlySet<string>,
): Set<string> {
    const changed = new Set<string>();
    add_symmetric_difference(changed, prev_dirty, next_dirty);
    add_symmetric_difference(changed, prev_conflicted, next_conflicted);
    return changed;
}

function add_symmetric_difference(
    out: Set<string>,
    a: ReadonlySet<string>,
    b: ReadonlySet<string>,
): void {
    for (const key of a) if (!b.has(key)) out.add(key);
    for (const key of b) if (!a.has(key)) out.add(key);
}
