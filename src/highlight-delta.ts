/**
 * The cells one highlight gesture actually moved.
 *
 * Computed where the authority is. The host holds both sides at its
 * compare-and-set — the state it read and the state it is about to write — so a
 * delta taken there names exactly the cells this gesture changed. The renderer
 * cannot derive the same fact from the state it gets back: the reply carries the
 * WHOLE state, and a change another window committed while the request was in
 * flight would be indistinguishable from part of this gesture, so undoing it
 * would revert someone else's highlight.
 *
 * The shape itself is `HighlightCellDelta` in `types.ts`, because it crosses the
 * host/renderer wire; only the computation lives here.
 */

import { parse_cell_highlight_key } from './cell-highlights';
import type {
    CellHighlightColor,
    CellHighlightState,
    HighlightCellDelta,
    SheetCellHighlightState,
} from './types';

/**
 * Every cell whose colour differs between two highlight states.
 *
 * A sheet whose `schema` moved is SKIPPED rather than diffed. The schema is the
 * sheet's row/column identity fingerprint, so pairing keys across a change in it
 * would name a transition between two different cells — and an undo built from
 * that would repaint cells the user never touched. A side with no highlights at
 * all carries no schema to disagree with, so it is comparable with anything.
 *
 * A malformed key is skipped too, on the same reasoning: a coordinate guessed
 * from one would name some other cell.
 */
export function* highlight_state_deltas(
    before: CellHighlightState | undefined,
    after: CellHighlightState | undefined,
): Generator<HighlightCellDelta> {
    const count = Math.max(before?.sheets.length ?? 0, after?.sheets.length ?? 0);
    for (let sheet_index = 0; sheet_index < count; sheet_index += 1) {
        const left = before?.sheets[sheet_index];
        const right = after?.sheets[sheet_index];
        if (!comparable(left, right)) continue;
        const before_cells = left?.cells ?? {};
        const after_cells = right?.cells ?? {};
        // Every key on either side, so a cell the gesture CLEARED is reported as
        // surely as one it painted.
        const keys = new Set([...Object.keys(before_cells), ...Object.keys(after_cells)]);
        for (const key of keys) {
            const coordinates = parse_cell_highlight_key(key);
            if (coordinates === undefined) continue;
            const before_color: CellHighlightColor | null = before_cells[key] ?? null;
            const after_color: CellHighlightColor | null = after_cells[key] ?? null;
            if (before_color === after_color) continue;
            yield Object.freeze({
                sheetIndex: sheet_index,
                sourceRow: coordinates.sourceRow,
                sourceColumn: coordinates.sourceColumn,
                before: before_color,
                after: after_color,
            });
        }
    }
}

function comparable(
    left: SheetCellHighlightState | undefined,
    right: SheetCellHighlightState | undefined,
): boolean {
    if (left === undefined || right === undefined) return true;
    return left.schema === right.schema;
}
