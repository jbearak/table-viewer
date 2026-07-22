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

export function changed_highlight_keys(
    previous: Readonly<Record<string, string>> | undefined,
    next: Readonly<Record<string, string>> | undefined,
): Set<string> {
    const changed = new Set<string>();
    for (const key of Object.keys(previous ?? {})) {
        if (previous?.[key] !== next?.[key]) changed.add(key);
    }
    for (const key of Object.keys(next ?? {})) {
        if (previous?.[key] !== next?.[key]) changed.add(key);
    }
    return changed;
}

export interface VisibleCellDamage {
    cell: readonly [number, number];
}

/** Map changed canonical source keys to currently visible display cells only. */
export function visible_highlight_damage(
    changed: ReadonlySet<string>,
    visible: { x: number; y: number; width: number; height: number },
    display_column_for_source: (source_column: number) => number | undefined,
    get_source_row: (display_row: number) => number | undefined,
): VisibleCellDamage[] {
    if (changed.size === 0 || visible.width <= 0 || visible.height <= 0) return [];
    const source_to_display_rows = new Map<number, number[]>();
    for (let row = visible.y; row < visible.y + visible.height; row++) {
        const source_row = get_source_row(row);
        if (source_row === undefined) continue;
        const rows = source_to_display_rows.get(source_row);
        if (rows) rows.push(row);
        else source_to_display_rows.set(source_row, [row]);
    }
    const out: VisibleCellDamage[] = [];
    const seen = new Set<string>();
    for (const key of changed) {
        const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(key);
        if (!match) continue;
        const source_row = Number(match[1]);
        const source_column = Number(match[2]);
        const display_column = display_column_for_source(source_column);
        if (
            display_column === undefined
            || display_column < visible.x
            || display_column >= visible.x + visible.width
        ) continue;
        for (const display_row of source_to_display_rows.get(source_row) ?? []) {
            const id = `${display_column}:${display_row}`;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ cell: [display_column, display_row] });
        }
    }
    return out;
}

function add_symmetric_difference(
    out: Set<string>,
    a: ReadonlySet<string>,
    b: ReadonlySet<string>,
): void {
    for (const key of a) if (!b.has(key)) out.add(key);
    for (const key of b) if (!a.has(key)) out.add(key);
}
