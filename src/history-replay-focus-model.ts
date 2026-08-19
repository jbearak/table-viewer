/**
 * Where a committed replay lands in the installed display view.
 *
 * The host resolves this, not the renderer, and resolves it at the commit: it is
 * the only place holding both the mutation that just landed and the sort/filter
 * mapping currently installed. The renderer's row loader maps display to source
 * and has no inverse, and scanning its resident pages could not answer the
 * question anyway — a 1M-row workbook keeps only a window resident, so a row
 * that is merely unloaded is indistinguishable there from one filtered out.
 */

import type {
    HistoryReplayDisplayFocus,
    HistoryReplayHighlightInput,
    HistoryReplayPreparedCell,
} from './history-replay-protocol';

/** What the replay touched, as the lease retained it. */
export interface ReplayFocusInputs {
    readonly cells: readonly HistoryReplayPreparedCell[];
    readonly highlights: readonly HistoryReplayHighlightInput[];
    /** Each prepared highlight's resolved sheet, by ordinal. */
    readonly highlightSheetIndices: ReadonlyMap<number, number>;
    readonly focusSheetIndex: number;
}

/**
 * The exact source rows the replay touched on the focus sheet.
 *
 * The exact rows, deliberately, never the focus interval's endpoints walked
 * through: the focus is a bounding box, and an action spanning rows 0 and
 * 999_999 of a filtered sheet would otherwise cost a million lookups to answer a
 * question about two cells. History retains what it changed, so this is O(cells
 * touched).
 *
 * A gesture that spans sheets contributes only its focus-sheet rows; the cursor
 * lands on one sheet and the focus names which.
 */
function touched_source_rows(inputs: ReplayFocusInputs): ReadonlySet<number> {
    const rows = new Set<number>();
    for (const cell of inputs.cells) {
        if (cell.resolvedSheetIndex === inputs.focusSheetIndex) rows.add(cell.sourceRow);
    }
    for (const highlight of inputs.highlights) {
        const sheet_index = inputs.highlightSheetIndices.get(highlight.ordinal);
        if (sheet_index === inputs.focusSheetIndex) rows.add(highlight.sourceRow);
    }
    return rows;
}

/**
 * The display-row interval the replay occupies, or `null` when none of its rows
 * has a position in the installed view.
 *
 * `null` is a success, not a refusal — the durable state changed either way. It
 * means the cursor has nowhere truthful to go, and the caller says so rather
 * than dropping the user somewhere the replay did not touch. A partially visible
 * region reports the bounds of the VISIBLE rows only, for the same reason.
 */
export function resolve_replay_display_focus(
    inputs: ReplayFocusInputs,
    display_row_for_source: (sheet_index: number, source_row: number) => number | undefined,
    mapping_generation: number,
): HistoryReplayDisplayFocus | null {
    let start: number | undefined;
    let end: number | undefined;
    for (const source_row of touched_source_rows(inputs)) {
        const display_row = display_row_for_source(inputs.focusSheetIndex, source_row);
        if (display_row === undefined) continue;
        if (start === undefined || display_row < start) start = display_row;
        if (end === undefined || display_row > end) end = display_row;
    }
    if (start === undefined || end === undefined) return null;
    return Object.freeze({
        displayRowStart: start,
        displayRowEnd: end,
        mappingGeneration: mapping_generation,
    });
}
