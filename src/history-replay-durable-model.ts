/**
 * The host's half of a replay's compare-and-swap, as pure functions over
 * durable state.
 *
 * The controller owns *when* a replay may proceed — the adoption, the file, the
 * lease. This module owns the narrower question of whether the durable state
 * still holds what the preparation verified, and what it looks like once the
 * replay's writes are applied. Kept out of the controller because it is the part
 * with real branches per overlay arm, and the part whose failure mode is silent:
 * a comparison that is too permissive lets a replay overwrite an edit it never
 * saw, which no test of the controller's plumbing would notice.
 *
 * ## Why the host compares an overlay to an entry at all
 *
 * The webview's compare-and-swap runs against `CellOverlayState`, but the
 * document's durable state stores `CsvDirtyEntry`. Those are not the same
 * fact — an entry cannot say which of three intents wrote it (see
 * `ValueDimensionIntent`) — and this module does not try to make them so. It
 * asks the only question the host can answer soundly: does the entry the
 * renderer *says* is in the cell project to the entry that is actually stored?
 * Projection is total and direction-free (`dirty_entry_from_overlay_state`),
 * so an overlay that projects to the stored entry is an overlay consistent with
 * durable state, whatever intent produced it. The renderer's own overlay-level
 * check is the one that distinguishes intents, and it has already run.
 *
 * ## Membership is its own fact
 *
 * `{value: 'A', base: 'A'}` compares equal to an unedited cell and is still
 * genuinely in the map — tinted, persisted, saved. So an absent overlay is
 * checked against the ABSENCE of a key, never against an entry that happens to
 * look untouched, and a present overlay against the presence of one. Reading
 * "does this cell differ from disk" in place of "is there an entry here" is the
 * bug this separation exists to prevent.
 */

import { cell_highlight_key } from './cell-highlights';
import { hyperlinks_equal, type CellHyperlink, type RichText } from './cell-content';
import type {
    WireCellOverlayState,
    WireHistoryValue,
} from './history-replay-protocol';
import {
    dirty_entries_equal,
    make_dirty_entry,
    type CellHighlightColor,
    type CsvDirtyEntry,
    type SheetPendingEditCells,
} from './types';

/** The `row:col` source key durable pending edits and highlights share. */
export function replay_cell_key(source_row: number, source_column: number): string {
    return `${source_row}:${source_column}`;
}

/**
 * The entry a wire overlay projects to.
 *
 * `{kind: 'absent'}` for an absent overlay and `{kind: 'unrepresentable'}` for
 * one the host cannot hold: durable state has no `base_pending` flag, so a
 * base-pending overlay names a state this module could neither verify nor write.
 * The renderer's own planner already refuses such a cell (`base-pending`), so
 * reaching here means a stale or buggy renderer — and the safe answer is to
 * match nothing rather than to compare a flag away and authorize a write over an
 * edit whose true base was never captured.
 *
 * Otherwise deliberately the same derivation as the webview's
 * `dirty_entry_from_overlay_state`, and the round trip in
 * `history-replay-wire-model.ts` is what keeps the two honest. Reimplemented
 * rather than imported because the host must not depend on webview modules.
 */
export type WireOverlayProjection =
    | { readonly kind: 'absent' }
    | { readonly kind: 'unrepresentable' }
    | { readonly kind: 'entry'; readonly entry: CsvDirtyEntry };

export function entry_from_wire_overlay(
    overlay: WireCellOverlayState,
): WireOverlayProjection {
    if (overlay.kind === 'absent') return { kind: 'absent' };
    const dimension = overlay.value;
    if (dimension.kind === 'present' && dimension.basePending) {
        return { kind: 'unrepresentable' };
    }
    const value: WireHistoryValue = dimension.kind === 'untouched'
        ? dimension.anchor
        : dimension.value;
    const base: WireHistoryValue = dimension.kind === 'untouched'
        ? dimension.anchor
        : dimension.base;
    const link = overlay.hyperlink;
    const entry = make_dirty_entry(
        value.text,
        base.text,
        value.runs,
        base.runs,
        link.kind === 'present' ? link.value : undefined,
        link.kind === 'present' ? link.base : undefined,
    );
    return { kind: 'entry', entry };
}

/**
 * A durable cell's entry in canonical form.
 *
 * Legacy slots store a bare string for "this cell's text was replaced", which is
 * the same fact as an entry whose base is the cell's original text — but the
 * original is not recorded in the string form, so the two cannot be compared
 * without one. `persisted` supplies it: the content the host materialized from
 * the verified source, which is exactly what such an edit was made on top of.
 */
export function stored_entry(
    stored: string | CsvDirtyEntry | undefined,
    persisted: WireHistoryValue,
): CsvDirtyEntry | undefined {
    if (stored === undefined) return undefined;
    if (typeof stored !== 'string') return stored;
    return make_dirty_entry(stored, persisted.text, undefined, persisted.runs);
}

/** What one cell must currently hold for its replay write to be authorized. */
export interface ReplayCellExpectation {
    readonly sheetIndex: number;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    /** The overlay the renderer reported and the host verified at preparation. */
    readonly overlay: WireCellOverlayState;
    /** The cell's content in the verified source, for canonicalizing legacy slots. */
    readonly persisted: WireHistoryValue;
}

/**
 * Whether a cell still holds what preparation verified.
 *
 * `cells` is the sheet's durable map as `pending_edits_for_sheet` returns it —
 * `undefined` when the slot is empty or belongs to another worksheet, which is
 * indistinguishable from "no entry for this cell" for this question and
 * deliberately so: both mean the replay's absent-overlay expectation holds and
 * its present-overlay expectation does not.
 */
export function replay_cell_matches(
    cells: SheetPendingEditCells | undefined,
    expectation: ReplayCellExpectation,
): boolean {
    const key = replay_cell_key(expectation.sourceRow, expectation.sourceColumn);
    const stored = cells !== undefined
        && Object.prototype.hasOwnProperty.call(cells, key)
        ? cells[key]
        : undefined;
    const expected = entry_from_wire_overlay(expectation.overlay);
    if (expected.kind === 'unrepresentable') return false;
    const actual = stored_entry(stored, expectation.persisted);
    // Membership first, and on both sides: an entry that projects equal to
    // nothing is still an entry, and nothing is not an entry that looks
    // untouched.
    if (expected.kind === 'absent' || actual === undefined) {
        return expected.kind === 'absent' && actual === undefined;
    }
    return dirty_entries_equal(expected.entry, actual);
}

/** One cell's replay write: the entry to store, or `null` to remove it. */
export interface ReplayCellWrite {
    readonly sheetIndex: number;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly entry: CsvDirtyEntry | null;
}

/**
 * One sheet's map with a replay's writes applied.
 *
 * Returns the input unchanged when nothing moves, so a caller inside
 * `update_file_state` can let an unchanged updater report a no-op rather than
 * writing an identical map.
 */
export function pending_edits_with_replay_writes(
    cells: SheetPendingEditCells | undefined,
    writes: readonly ReplayCellWrite[],
): SheetPendingEditCells | undefined {
    if (writes.length === 0) return cells;
    const next: Record<string, string | CsvDirtyEntry> = { ...(cells ?? {}) };
    let changed = false;
    for (const write of writes) {
        const key = replay_cell_key(write.sourceRow, write.sourceColumn);
        const had = Object.prototype.hasOwnProperty.call(next, key);
        if (write.entry === null) {
            if (!had) continue;
            delete next[key];
            changed = true;
            continue;
        }
        const stored = had ? next[key] : undefined;
        if (
            stored !== undefined
            && typeof stored !== 'string'
            && dirty_entries_equal(stored, write.entry)
        ) continue;
        next[key] = write.entry;
        changed = true;
    }
    if (!changed) return cells;
    for (const _ in next) return next;
    // Every key removed. An empty map is not the same as no map to
    // `with_pending_edits_for_sheet`, which reads the latter as "this worksheet
    // has no draft" and clears the slot — which is what a fully undone sheet is.
    return undefined;
}

/** What one highlight must currently hold for its replay write to be authorized. */
export interface ReplayHighlightExpectation {
    readonly sheetIndex: number;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly expected: CellHighlightColor | null;
    readonly desired: CellHighlightColor | null;
}

/**
 * Whether a highlight still holds what preparation verified.
 *
 * `cells` is one sheet's highlight map. Absence and `null` are the same fact
 * here — a cell with no highlight — unlike pending edits, where membership
 * carries meaning of its own.
 */
export function replay_highlight_matches(
    cells: Readonly<Record<string, CellHighlightColor>> | undefined,
    expectation: ReplayHighlightExpectation,
): boolean {
    const key = cell_highlight_key(expectation.sourceRow, expectation.sourceColumn);
    const current = cells?.[key];
    return (current ?? null) === expectation.expected;
}

/**
 * A replay's highlight writes as one patch per sheet, in
 * `apply_cell_highlight_patch`'s shape.
 *
 * Grouped by sheet because that function patches a single sheet, and a
 * workbook-wide action can touch several. Ordered by sheet index for a stable
 * application order.
 */
export function replay_highlight_patches(
    writes: readonly ReplayHighlightExpectation[],
): readonly { readonly sheetIndex: number; readonly cells: Record<string, CellHighlightColor | null> }[] {
    const by_sheet = new Map<number, Record<string, CellHighlightColor | null>>();
    for (const write of writes) {
        const cells = by_sheet.get(write.sheetIndex) ?? {};
        // Last write wins within a sheet, which matches the replay order the
        // plan is walked in: an action that highlights a cell and then clears it
        // must land on cleared.
        cells[cell_highlight_key(write.sourceRow, write.sourceColumn)] = write.desired;
        by_sheet.set(write.sheetIndex, cells);
    }
    return Object.freeze([...by_sheet.entries()]
        .sort(([left], [right]) => left - right)
        .map(([sheetIndex, cells]) => Object.freeze({ sheetIndex, cells })));
}

/** Whether two optional rich-text values carry the same runs. */
function wire_values_equal(left: WireHistoryValue, right: WireHistoryValue): boolean {
    if (left.text !== right.text) return false;
    return runs_equal(left.runs, right.runs);
}

function runs_equal(left: RichText | undefined, right: RichText | undefined): boolean {
    if (left === undefined || right === undefined) return left === right;
    if (left.runs.length !== right.runs.length) return false;
    return left.runs.every((run, index) => {
        const other = right.runs[index];
        return other !== undefined
            && run.text === other.text
            && JSON.stringify(run.style ?? {}) === JSON.stringify(other.style ?? {});
    });
}

/**
 * Whether the content the host just materialized still equals what a lease was
 * issued against.
 *
 * The physical digest check proves the FILE has not moved; this proves the
 * host's reading of it has not, which is a different thing when a projection or
 * a header promotion has changed how a source row is reached. Cheap enough to
 * run at commit for every prepared cell, and it is the last chance to notice.
 */
export function prepared_content_unchanged(
    prepared: readonly { readonly persisted: WireHistoryValue; readonly persistedHyperlink: CellHyperlink | null }[],
    current: readonly { readonly persisted: WireHistoryValue; readonly persistedHyperlink: CellHyperlink | null }[],
): boolean {
    if (prepared.length !== current.length) return false;
    return prepared.every((cell, index) => {
        const now = current[index];
        return now !== undefined
            && wire_values_equal(cell.persisted, now.persisted)
            && hyperlinks_equal(cell.persistedHyperlink, now.persistedHyperlink);
    });
}
