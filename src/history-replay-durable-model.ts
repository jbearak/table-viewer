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
import { hyperlinks_equal, rich_text_equal, type CellHyperlink, type RichText } from './cell-content';
import type {
    WireCellOverlayState,
    WireHistoryValue,
} from './history-replay-protocol';
import {
    dirty_entries_equal,
    dirty_entry_with_observed_file_base,
    make_dirty_entry,
    make_observed_file_base,
    type CellHighlightColor,
    type CsvDirtyEntry,
    type SheetPendingEditCells,
} from './types';

/**
 * The `row:col` source key durable pending edits and highlights share.
 *
 * Delegates to `cell_highlight_key` rather than formatting its own string: the
 * two must agree, and a second formatter would let a key-format change reach
 * highlights while leaving replayed pending edits addressing the old shape.
 * Its coordinate guard is unreachable here — the protocol's `is_source_index`
 * has already rejected anything that is not a non-negative safe integer — so it
 * costs nothing and documents the shared invariant.
 */
export function replay_cell_key(source_row: number, source_column: number): string {
    return cell_highlight_key(source_row, source_column);
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
    | { readonly kind: 'entry'; readonly entry: CsvDirtyEntry }
    /**
     * A durable bare string: the legacy slot form, which is the ONLY durable
     * shape carrying "this edit's base has not been observed yet".
     *
     * `base_pending` is not a field of `CsvDirtyEntry`, and there is exactly one
     * place in the renderer that originates the flag — hydrating a bare durable
     * string, which by construction has no runs and no hyperlink. Every other
     * site only carries an existing flag forward. So writing the string back is a
     * faithful round-trip for the shape that can actually occur.
     *
     * That is a PROVENANCE invariant, not a structural one: the store's hydration
     * retains an explicit `base_pending` found on an incoming object
     * (`edit-session-store.ts`), and persisted state tolerates properties it does
     * not know, so a hand-edited or future-build slot could present a rich
     * base-pending entry this module has never seen. Which is why the refusal
     * below is a live boundary rather than dead code — a
     * base-pending overlay carrying runs or a link stays `unrepresentable`: those
     * would need a durable field that does not exist, and guessing at one would
     * promote an unobserved placeholder to a real base and let a later save
     * compare against content the user never saw.
     */
    | { readonly kind: 'legacy'; readonly value: string };

export function entry_from_wire_overlay(
    overlay: WireCellOverlayState,
): WireOverlayProjection {
    if (overlay.kind === 'absent') return { kind: 'absent' };
    const dimension = overlay.value;
    if (dimension.kind === 'present' && dimension.basePending) {
        // Representable only as the legacy bare string, and only for the shape
        // that string can hold: plain text, no runs on either side, no hyperlink.
        // Anything richer has no durable home for the pending bit.
        const plain = dimension.value.runs === undefined
            && dimension.base.runs === undefined
            && dimension.base.text === ''
            && overlay.hyperlink.kind === 'untouched'
            && dimension.writeValue === undefined
            && dimension.retainValue === undefined
            && dimension.formattingKnown === undefined
            && dimension.movedFrom === undefined
            && dimension.valueEditOrder === undefined;
        return plain
            ? { kind: 'legacy', value: dimension.value.text }
            : { kind: 'unrepresentable' };
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
        dimension.kind === 'present' ? {
            writeValue: dimension.writeValue,
            retainValue: dimension.retainValue,
            formattingKnown: dimension.formattingKnown,
            movedFrom: dimension.movedFrom,
            valueEditOrder: dimension.valueEditOrder,
        } : {},
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
    return make_dirty_entry(
        stored,
        persisted.text,
        stored === persisted.text ? persisted.runs : undefined,
        persisted.runs,
        undefined,
        undefined,
        { formattingKnown: true },
    );
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
    /** The cell's current persisted link, when the host prepared the replay. */
    readonly persistedHyperlink?: CellHyperlink | null;
}

function entry_with_persisted_side(
    entry: CsvDirtyEntry,
    expectation: ReplayCellExpectation,
): CsvDirtyEntry {
    if (entry.link !== undefined && expectation.persistedHyperlink === undefined) return entry;
    return dirty_entry_with_observed_file_base(entry, make_observed_file_base(
        expectation.persisted.text,
        expectation.persisted.runs,
        entry.link !== undefined ? expectation.persistedHyperlink : undefined,
    ));
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
    // A legacy expectation is canonicalized against the same persisted content a
    // legacy STORED slot is, so the two forms of the one fact compare equal
    // rather than one of them reading as a conflict.
    let expected_entry = expected.kind === 'legacy'
        ? stored_entry(expected.value, expectation.persisted)
        : expected.entry;
    if (expected_entry === undefined) return false;
    if (expected.kind === 'entry') {
        expected_entry = entry_with_persisted_side(expected_entry, expectation);
    }
    return dirty_entries_equal(expected_entry, actual);
}

/**
 * One cell's replay write: what to store, or `null` to remove the slot.
 *
 * A bare `string` is the legacy slot form, which the renderer's own hydration
 * reads back as an entry whose base has not been observed. It is how an
 * unresolved base survives a round trip through durable state at all — see
 * `WireOverlayProjection`.
 */
export interface ReplayCellWrite {
    readonly sheetIndex: number;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly entry: string | CsvDirtyEntry | null;
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
        // Compared in each form's own terms rather than canonicalized: the point
        // is only to skip a write that changes nothing durable, and this function
        // has no persisted content to canonicalize a legacy slot against. A
        // string replacing an equal entry (or the reverse) is written, which is
        // correct — the two forms differ in whether the base is observed.
        if (typeof write.entry === 'string') {
            if (stored === write.entry) continue;
        } else if (
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

/**
 * Whether two optional rich-text values carry the same runs.
 *
 * Run comparison delegates to `rich_text_equal`, the shared normalizing
 * comparison, rather than walking runs here: a private definition of run and
 * style equality would drift from the one the rest of the editor uses, and a
 * replay would then call formatting-identical content changed (or the reverse).
 *
 * Absence is compared before delegating, because "no runs" and "empty runs" are
 * not the same observation: an unstyled cell records no runs at all, and reading
 * a missing side as `{runs: []}` would call a styled cell equal to a plain one
 * whose runs normalize away.
 */
function wire_values_equal(left: WireHistoryValue, right: WireHistoryValue): boolean {
    if (left.text !== right.text) return false;
    return runs_equal(left.runs, right.runs);
}

function runs_equal(left: RichText | undefined, right: RichText | undefined): boolean {
    if (left === undefined || right === undefined) return left === right;
    return rich_text_equal(left, right);
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
