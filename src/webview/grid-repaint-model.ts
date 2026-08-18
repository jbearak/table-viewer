import { cell_highlight_key } from '../cell-highlights';
import { parse_cell_key } from '../cell-key';

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
        const coordinates = parse_cell_key(key);
        if (coordinates === undefined) continue;
        const { sourceRow: source_row, sourceColumn: source_column } = coordinates;
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

/**
 * Damage for merged blocks whose *anchor* key changed while the anchor cell
 * sits outside the viewport — above it, left of it, or both (an anchor is its
 * block's top-left, so those are the only off-screen directions with the block
 * still visible). `visible_source_key_damage` scans visible display cells, so
 * it can never surface such an anchor — yet the grid paints the whole block
 * from the anchor's content, tint, and highlight. Returns the block's first
 * visible cell per affected merge; the grid's damage expansion repaints the
 * whole block from any member cell.
 *
 * Merges are only supplied under an identity view (no transform, no hidden
 * columns — see GridShell's `merged_ranges`), so source keys compare directly
 * against display-space merge coordinates.
 */
export function offscreen_anchor_merge_damage(
    changed: ReadonlySet<string>,
    visible: { x: number; y: number; width: number; height: number },
    merges: readonly { x: number; y: number; width: number; height: number }[],
): VisibleCellDamage[] {
    if (changed.size === 0 || visible.width <= 0 || visible.height <= 0) return [];
    const out: VisibleCellDamage[] = [];
    for (const m of merges) {
        // Block on screen at all?
        if (m.y >= visible.y + visible.height || m.y + m.height <= visible.y) continue;
        if (m.x >= visible.x + visible.width || m.x + m.width <= visible.x) continue;
        // Anchor itself visible → the visible-cell scan already damages it.
        if (m.y >= visible.y && m.x >= visible.x) continue;
        if (!changed.has(cell_highlight_key(m.y, m.x))) continue;
        out.push({ cell: [Math.max(m.x, visible.x), Math.max(m.y, visible.y)] });
    }
    return out;
}

/**
 * The full damage set for changed source keys: the visible-cell scan plus the
 * off-screen-anchor merge repair. Both source-keyed repaint effects (dirty /
 * conflict tints and cell highlights) must use the same pipeline, so it lives
 * here rather than being assembled twice at the call sites.
 */
export function source_key_damage(
    changed: ReadonlySet<string>,
    visible: { x: number; y: number; width: number; height: number },
    display_column_for_source: (source_column: number) => number | undefined,
    get_source_row: (display_row: number) => number | undefined,
    merges: readonly { x: number; y: number; width: number; height: number }[],
): VisibleCellDamage[] {
    return [
        ...visible_source_key_damage(
            changed,
            visible,
            display_column_for_source,
            get_source_row,
        ),
        ...offscreen_anchor_merge_damage(changed, visible, merges),
    ];
}

function add_symmetric_difference(
    out: Set<string>,
    a: ReadonlySet<string>,
    b: ReadonlySet<string>,
): void {
    for (const key of a) if (!b.has(key)) out.add(key);
    for (const key of b) if (!a.has(key)) out.add(key);
}
