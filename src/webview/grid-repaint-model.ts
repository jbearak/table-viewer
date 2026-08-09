/**
 * The set of cell keys (`"row:col"`) whose rendered edit state differs between
 * two immutable store snapshots. Membership changes alter the tint and value;
 * an already-dirty entry whose value changes also needs damage because Glide
 * may otherwise retain its cached cell contents.
 *
 * GridShell damages these instead of the whole visible region. Local commits
 * also damage their cell inline, but authoritative document patches mutate the
 * shared store directly and rely on this value-aware diff.
 */
export function changed_edit_keys(
    prev_dirty: ReadonlyMap<string, { readonly value: string }>,
    next_dirty: ReadonlyMap<string, { readonly value: string }>,
    prev_conflicted: ReadonlySet<string>,
    next_conflicted: ReadonlySet<string>,
): Set<string> {
    const changed = new Set<string>();
    for (const [key, previous] of prev_dirty) {
        const next = next_dirty.get(key);
        if (!next || next.value !== previous.value) changed.add(key);
    }
    for (const key of next_dirty.keys()) {
        if (!prev_dirty.has(key)) changed.add(key);
    }
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

/**
 * Map changed canonical source keys (`"source_row:source_column"`) to currently
 * visible display cells only. Shared by both source-keyed repaint effects — cell
 * highlights and dirty/conflict tints — hence the space-neutral name.
 *
 * Builds a source→display map over the visible rows rather than consulting a
 * reverse display lookup: one source row can legitimately occupy several display
 * rows, and every one of them has to be damaged.
 */
export function visible_source_key_damage(
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
