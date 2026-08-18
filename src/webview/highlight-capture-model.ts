/**
 * A highlight gesture, recovered by diffing the state the host sends back.
 *
 * Highlights are unlike cell edits: an edit is committed into a webview store
 * this window owns, so the writer knows the before and after at gesture time. A
 * highlight round-trips through the host — the renderer posts a selection and a
 * mutation, the host resolves it against display-to-source row mapping it alone
 * holds, and answers with the whole new state. So the gesture's cells are not
 * knowable locally, and the delta is recovered by comparing the state that came
 * back against the one it replaced.
 *
 * Which is also why capture is keyed to the request: `cellHighlightsChanged`
 * arrives for changes this window never made — another window's edit, an external
 * reload, a rebase after a save — and none of those belong in this window's undo
 * history. Only a reply carrying the request id this window is waiting on is a
 * gesture, and only its diff is recorded.
 *
 * A sheet whose `schema` moved is SKIPPED rather than diffed. The schema is the
 * sheet's row/column identity fingerprint, so a diff across a change in it would
 * pair up coordinates that no longer mean the same cell — recording an undo that
 * would repaint the wrong cells.
 */

import { parse_cell_highlight_key } from '../cell-highlights';
import type {
    CellHighlightColor,
    CellHighlightState,
    SheetCellHighlightState,
    WorksheetIdentityInput,
    WorksheetTarget,
} from '../types';
import { target_for_sheet } from './edit-session-registry';
import type { HistoryChange } from './history-stack-model';

/** A sheet's highlighted cells, or nothing when the sheet has none. */
type SheetHighlights = SheetCellHighlightState | undefined;

export interface HighlightCaptureInput {
    /** The state before the gesture, as this window last held it. */
    readonly before: CellHighlightState | undefined;
    /** The state the host answered with. */
    readonly after: CellHighlightState | undefined;
    /** Sheet identities, for recording a worksheet target rather than an index. */
    readonly sheets: readonly WorksheetIdentityInput[];
}

/**
 * The changes a highlight gesture records: one per cell whose colour moved.
 *
 * A generator, on the same reasoning as the discard's: clearing every highlight
 * in a file can reach the 100_000-cell ceiling, and the recorder's budget stops
 * mid-walk rather than after a full materialization.
 */
export function* highlight_history_source(
    input: HighlightCaptureInput,
): Generator<HistoryChange> {
    const { before, after, sheets } = input;
    const count = Math.max(before?.sheets.length ?? 0, after?.sheets.length ?? 0);
    for (let sheet_index = 0; sheet_index < count; sheet_index += 1) {
        const sheet = sheets[sheet_index];
        // No identity to record the change against. A bare index would name a
        // different worksheet after a sheet move, so the cell is left uncapturable
        // rather than recorded against a target that could drift.
        if (sheet === undefined) continue;
        const left = before?.sheets[sheet_index];
        const right = after?.sheets[sheet_index];
        if (!comparable(left, right)) continue;
        const target = target_for_sheet(sheet_index, sheet);
        for (const change of sheet_changes(target, left, right)) yield change;
    }
}

/**
 * Whether two versions of one sheet's highlights describe the same cells.
 *
 * Two states with different schemas disagree about what `row:column` MEANS — a
 * column inserted, a header promoted — so pairing their keys would record a
 * transition between two different cells. Only a real difference disqualifies:
 * a side with no highlights at all carries no schema to disagree with.
 */
function comparable(left: SheetHighlights, right: SheetHighlights): boolean {
    if (left === undefined || right === undefined) return true;
    return left.schema === right.schema;
}

function* sheet_changes(
    worksheet: WorksheetTarget,
    left: SheetHighlights,
    right: SheetHighlights,
): Generator<HistoryChange> {
    const before_cells = left?.cells ?? {};
    const after_cells = right?.cells ?? {};
    // Every key on either side, so a cell cleared by the gesture is recorded as
    // surely as one painted by it.
    const keys = new Set([...Object.keys(before_cells), ...Object.keys(after_cells)]);
    for (const key of keys) {
        const coordinates = parse_cell_highlight_key(key);
        // Fail closed, exactly as the discard's source does: a coordinate guessed
        // from a malformed key would name some other cell for undo to repaint.
        if (coordinates === undefined) continue;
        const before_color: CellHighlightColor | null = before_cells[key] ?? null;
        const after_color: CellHighlightColor | null = after_cells[key] ?? null;
        if (before_color === after_color) continue;
        yield Object.freeze({
            kind: 'highlight' as const,
            delta: Object.freeze({
                worksheet,
                sourceRow: coordinates.sourceRow,
                sourceColumn: coordinates.sourceColumn,
                before: before_color,
                after: after_color,
            }),
        });
    }
}
