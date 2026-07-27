/**
 * Pure variable-row-height helpers (Phase D). Heights live in a sparse
 * `Record<number, number>` keyed by row index. Rows without an override use the
 * default. No DOM, no Glide imports: fully unit-testable.
 *
 * The record the renderer reads is *display*-keyed: it is the host's projection of
 * the durable, canonical-source-keyed `PerFileState.rowHeights` into the display
 * space of the view currently installed (`WorkbookSnapshot.rowHeightProjection`,
 * `transformInstalled.rowHeights`). The webview never holds the durable map and
 * never writes it — see `PerFileState.rowHeights` and the `setRowHeights` message.
 * Rendering therefore needs the optimistic-overlay machinery at the bottom of this
 * file: a committed resize is visible immediately, before the durable write and its
 * re-delivery have round-tripped.
 */

import type { DisplayRowInterval } from '../types';

/** Default row height; matches Glide's Phase C constant. */
export const DEFAULT_ROW_HEIGHT_PX = 24;

/** Font size the default row height (and line height) were sized for. */
export const BASE_ROW_FONT_SIZE_PX = 13;

/** Floor for a user-resized row, mirroring the old renderer's `Math.max(20, …)`. */
export const MIN_ROW_HEIGHT_PX = 20;

/**
 * Ceiling for a row height, durable or optimistic.
 *
 * A corruption guard rather than a tuning knob, so the value is chosen to be unreachable by
 * intent and reachable only by accident, and the two ends of that are both concrete.
 *
 * *Far above deliberate use.* A 4K display is 2160px tall, so a row at this bound is
 * already close to twice a full-screen viewport — nothing a user drags a boundary to on
 * purpose comes near it. The realistic way to reach it is not a malformed message but the
 * multiline auto-grow path (`natural_row_height`, `lines * line_height + padding`), which
 * needs roughly 227 hard newlines in one cell to get here; a row showing 227 lines is not
 * a table row anyone reads, so clamping there loses nothing either.
 *
 * *Far below where the arithmetic stops meaning anything.* Glide sums `rowHeight(r)` over
 * every row to get the total scroll height, so an unbounded height is the one input that
 * can make that sum absurd. At the bound, a sheet holding the maximum
 * `MAX_PERSISTED_ROW_HEIGHTS` overrides contributes about 41 million pixels — exact in
 * double arithmetic and still a scrollbar, where a height of `1e300` is neither.
 *
 * A power of two, so it reads as a guard rather than as a measured value somebody tuned.
 */
export const MAX_ROW_HEIGHT_PX = 4096;

/**
 * Default row height for a configured font size, keeping the stock 24px at the
 * 13px base so existing files look unchanged. Persisted per-row overrides are
 * unaffected — only rows without one follow the font.
 */
export function default_row_height_for_font(
    font_size_px: number = BASE_ROW_FONT_SIZE_PX,
): number {
    if (!Number.isFinite(font_size_px) || font_size_px <= 0) {
        return DEFAULT_ROW_HEIGHT_PX;
    }
    return Math.max(
        MIN_ROW_HEIGHT_PX,
        Math.round(DEFAULT_ROW_HEIGHT_PX * (font_size_px / BASE_ROW_FONT_SIZE_PX)),
    );
}

/** Per-line text height for a configured font size (see
 *  {@link DEFAULT_LINE_HEIGHT_PX}). */
export function line_height_for_font(
    font_size_px: number = BASE_ROW_FONT_SIZE_PX,
): number {
    if (!Number.isFinite(font_size_px) || font_size_px <= 0) {
        return DEFAULT_LINE_HEIGHT_PX;
    }
    return Math.max(
        1,
        Math.round(DEFAULT_LINE_HEIGHT_PX * (font_size_px / BASE_ROW_FONT_SIZE_PX)),
    );
}

export type RowHeightOverrides = Record<number, number>;

/** Override for `row` if present, else `default_height`. */
export function row_height(
    overrides: RowHeightOverrides,
    row: number,
    default_height = DEFAULT_ROW_HEIGHT_PX,
): number {
    const v = overrides[row];
    return v !== undefined ? v : default_height;
}

/** Sum of row heights over the inclusive range [start_row, end_row]. */
export function span_height(
    overrides: RowHeightOverrides,
    start_row: number,
    end_row: number,
    default_height = DEFAULT_ROW_HEIGHT_PX,
): number {
    let total = 0;
    for (let r = start_row; r <= end_row; r++) {
        total += row_height(overrides, r, default_height);
    }
    return total;
}

/**
 * Clamp a height into the allowed range.
 *
 * Both ends matter and for different reasons. The floor keeps a row from losing the edge
 * the user would have to grab to undo the resize; the ceiling keeps a row from growing past
 * any viewport that could show its bottom edge, which leaves the same boundary unreachable
 * from the other direction (see {@link MAX_ROW_HEIGHT_PX}).
 *
 * One function for both the host and the webview deliberately: the host clamps before it
 * persists, and the webview clamps the value it paints optimistically, and the overlay is
 * reconciled against the delivered projection *by value*. Two clamps that disagreed by a
 * pixel would leave a layer that no delivery can ever agree with, masking the stored height
 * for the rest of the generation.
 */
export function clamp_row_height(height: number): number {
    return Math.min(MAX_ROW_HEIGHT_PX, Math.max(MIN_ROW_HEIGHT_PX, height));
}

/** Per-line text height used when growing a row to fit multiline content. */
export const DEFAULT_LINE_HEIGHT_PX = 18;
/** Vertical padding added around the text block of a multiline row. */
export const DEFAULT_ROW_PADDING_PX = 6;

/**
 * Natural height needed to display `text` given its explicit line breaks.
 * Counts `\n`-separated lines (empty text is one line) and returns
 * `lines * line_height + padding`, floored at {@link DEFAULT_ROW_HEIGHT_PX} so a
 * single line keeps the standard height. Soft wrapping of long single lines is
 * not modeled — only hard newlines (the Shift+Alt+Enter editing case) grow rows.
 */
export function natural_row_height(
    text: string,
    line_height = DEFAULT_LINE_HEIGHT_PX,
    padding = DEFAULT_ROW_PADDING_PX,
    default_height = DEFAULT_ROW_HEIGHT_PX,
): number {
    const lines = text.length === 0 ? 1 : text.split('\n').length;
    return Math.max(default_height, lines * line_height + padding);
}

/** Return a new overrides record with `row` set to a clamped `height`. */
export function set_row_height(
    overrides: RowHeightOverrides,
    row: number,
    height: number,
): RowHeightOverrides {
    return { ...overrides, [row]: clamp_row_height(height) };
}

/**
 * One committed resize, awaiting the host's answer: the display rows it named and
 * the height it set them to.
 *
 * Held as *intervals* rather than an expanded `Record<number, number>`, and that is
 * the whole point of the shape. A resize commits the user's entire row selection,
 * which can be select-all: expanding that into entries is O(rows) in time and memory
 * on every commit, on a sheet that may have millions of them, to describe a single
 * number. The intervals are what the request itself carries
 * (`setRowHeights.rows`), so this is also the same value, not a second encoding of
 * it. The cost moves to the read — resolving one row scans the layers — which is
 * bounded by the number of *in-flight* resizes rather than by the sheet.
 */
export interface RowHeightLayer {
    /** Inclusive display-row intervals, disjoint and ascending. */
    readonly rows: readonly Readonly<DisplayRowInterval>[];
    readonly height: number;
}

/**
 * The resizes this panel has committed but not yet seen answered, for one sheet, tagged
 * with the view generation their display rows were read off.
 *
 * Which sheet is *not* a field here: App holds these per sheet, indexed by sheet, so a
 * record stored at one index cannot claim to be about another. One overlay per sheet rather
 * than one overlay is what the panel actually needs — a resize commits the active sheet's
 * row selection, but nothing makes the request and its answer finish before the user opens
 * another tab and drags a boundary there, and a single slot let the second resize discard
 * the first.
 */
export interface RowHeightOverlay {
    readonly generation: number;
    readonly layers: readonly RowHeightLayer[];
}

/**
 * Every sheet's overlay put through `next_for`, or the same array back when no sheet's
 * verdict changed anything.
 *
 * The reference-identity guarantee is the reason this is a function rather than a
 * `.map()`. Both events that reconcile overlays — a delivery and an install ack — arrive
 * far more often than they change one, and App keeps these in React state: an array
 * rebuilt on every delivery is a new prop identity on every delivery, which re-renders the
 * grid for nothing. `undefined` slots are skipped rather than passed through, so a caller
 * cannot accidentally invent an overlay for a sheet that has none.
 */
export function mapped_row_height_overlays(
    previous: readonly (RowHeightOverlay | undefined)[],
    next_for: (
        overlay: RowHeightOverlay,
        sheet_index: number,
    ) => RowHeightOverlay | undefined,
): readonly (RowHeightOverlay | undefined)[] {
    let next: (RowHeightOverlay | undefined)[] | undefined;
    for (let sheet_index = 0; sheet_index < previous.length; sheet_index += 1) {
        const overlay = previous[sheet_index];
        if (overlay === undefined) continue;
        const replacement = next_for(overlay, sheet_index);
        if (replacement === overlay) continue;
        next ??= [...previous];
        next[sheet_index] = replacement;
    }
    return next ?? previous;
}

/**
 * The overlay that survives an event which moved the core generation to
 * `next_generation`, rebased onto it — or `undefined` if its display keys can no longer
 * be trusted.
 *
 * `sheet_mapping_generation` is the generation at which *the overlay's own sheet's*
 * display→source mapping last moved, and it is the entire decision. The rule is the
 * host's rule, character for character: the host accepts a display-keyed write iff
 * `msg.generation >= core.mapping_generation(sheet)`; this keeps a display-keyed overlay
 * iff `sheet_mapping_generation <= previous.generation`. One predicate, evaluated on both
 * sides of the protocol against the same numbers, which is the only way the two can be
 * guaranteed not to disagree — and a disagreement here is user-visible in both
 * directions. Host accepts and webview discards: the row snaps back at the end of the
 * drag and then silently springs to its new height when the write is delivered. Host
 * refuses and webview keeps: the row shows a height no file holds until the generation
 * next moves.
 *
 * ## Why the generation alone is not enough
 *
 * A permutation is per sheet but the generation is core-wide, so plenty of events move
 * the generation without moving one display row on the overlay's sheet: an install for a
 * sibling sheet, and — the case that motivated delivering this — a terminal transform
 * reconciliation, where a background sort finishing bumps the generation while
 * `commit_transform_reconciliation` rewrites only the reconciled sheet's indices.
 *
 * ## Why the local `sourceGeneration` heuristic was rejected
 *
 * "Discard only when `sourceGeneration` moved too" needs nothing delivered and is
 * unsound. An unchanged source generation with a bumped view generation means *some*
 * sheet's permutation moved and the webview cannot tell which; when the sheet that moved
 * *is* this overlay's sheet, that rule paints old display keys onto a new arrangement —
 * the right height on the wrong row, silently, and looking exactly like durable state.
 * Which sheet moved is information only the host has, so the host sends it
 * (`WorkbookSnapshot.mappingGenerations`).
 *
 * ## The three verdicts
 *
 * - **Unknown** (`undefined`): the delivery has no entry for this sheet, so the workbook
 *   no longer has it. Nothing vouches for the keys; discard.
 * - **Moved after the overlay was created**: its display keys named the old arrangement.
 *   Discard. Adoption reaches this arm without a special case — `adopt_source` raises
 *   `mapping_generation_floor` to the generation it installs, so *every* sheet reports
 *   having moved, which is right: adoption replaces the rows themselves.
 * - **Otherwise**: retain, and rebase onto `next_generation`. The rebase is not
 *   bookkeeping — the render site only paints an overlay whose generation equals the
 *   current one, so an overlay retained without being rebased is an overlay silently not
 *   drawn.
 *
 * Reconciliation by value against the delivered projection is *not* done here and remains
 * the caller's, because the two callers read the projection from different places (a
 * delivery's `rowHeightProjection`, an install's `rowHeights`). See
 * `row_height_layers_for_delivery`.
 */
export function retained_row_height_overlay(
    previous: RowHeightOverlay | undefined,
    next_generation: number,
    sheet_mapping_generation: number | undefined,
): RowHeightOverlay | undefined {
    if (previous === undefined) return undefined;
    if (sheet_mapping_generation === undefined) return undefined;
    if (sheet_mapping_generation > previous.generation) return undefined;
    return previous.generation === next_generation
        ? previous
        : { ...previous, generation: next_generation };
}

/**
 * Height for `row`: the newest overlay layer that names it, else the delivered
 * projection, else the default.
 *
 * Layers are display-keyed, like the projection they sit over, so no mapping is
 * needed here — which is the reason the optimistic value is recorded in display space
 * even though what gets persisted is source-keyed. The webview cannot map
 * display→source for a select-all resize anyway (those rows were never loaded), and
 * a display-keyed overlay is only ever valid for one permutation: see
 * `row_height_layers_for_delivery` for how that is enforced.
 */
export function resolved_row_height(
    overrides: RowHeightOverrides,
    layers: readonly RowHeightLayer[] | undefined,
    row: number,
    default_height = DEFAULT_ROW_HEIGHT_PX,
): number {
    if (layers !== undefined) {
        for (let index = layers.length - 1; index >= 0; index -= 1) {
            const layer = layers[index];
            for (const interval of layer.rows) {
                if (row >= interval.start && row <= interval.end) return layer.height;
            }
        }
    }
    return row_height(overrides, row, default_height);
}

/** Total rows an overlay layer names. */
function layer_row_count(layer: RowHeightLayer): number {
    let total = 0;
    for (const interval of layer.rows) total += interval.end - interval.start + 1;
    return total;
}

/**
 * Whether a delivered projection already says what this layer says, in which case
 * the layer is redundant and must be dropped — left in place it would keep masking
 * that row for the rest of the generation, so a *later* height for the same row (a
 * sibling panel's write, a plan edit) would never become visible.
 *
 * Counted from the projection's side, never the layer's: the projection is sparse
 * and bounded by `MAX_PERSISTED_ROW_HEIGHTS`, while the layer can name every row of
 * the sheet. Agreement over the whole layer is then "as many projection entries at
 * this height fall inside the intervals as the intervals contain rows", which cannot
 * over-count because projection keys are unique.
 *
 * The invariant that actually matters is *cost bounded by the projection, never by the
 * sheet*, and mutation testing is why that is worth stating separately: a layer-side walk
 * that returns on the first row the projection does not answer is bounded the same way
 * (every row it does walk is a distinct projection key), so it survives the select-all read
 * budget rather than being caught by it. Counting is chosen over walking because it is
 * bounded without needing that early-exit argument — a shape whose cost is evident beats
 * one whose cost is a proof. A walk with no early exit *is* O(rows) and the budget does
 * catch it.
 */
function projection_agrees_with_layer(
    overrides: RowHeightOverrides,
    layer: RowHeightLayer,
): boolean {
    let matched = 0;
    for (const [key, height] of Object.entries(overrides)) {
        if (height !== layer.height) continue;
        const row = Number(key);
        if (layer.rows.some(
            (interval) => row >= interval.start && row <= interval.end,
        )) matched += 1;
    }
    return matched === layer_row_count(layer);
}

/**
 * How many unanswered resizes an overlay keeps. Reached only when the host is
 * refusing writes (over the persisted-heights cap) or a delivery is yet to arrive for
 * several drags running; the ordinary depth is one. Dropping the *oldest* layer on
 * overflow is the conservative direction: a layer only ever hides the delivered
 * projection, so dropping one reveals what is actually persisted.
 */
export const MAX_ROW_HEIGHT_LAYERS = 8;

/** Add a committed resize to a layer list, newest last. */
export function row_height_layers_with(
    layers: readonly RowHeightLayer[],
    layer: RowHeightLayer,
): readonly RowHeightLayer[] {
    const next = [...layers, layer];
    return next.length > MAX_ROW_HEIGHT_LAYERS
        ? next.slice(next.length - MAX_ROW_HEIGHT_LAYERS)
        : next;
}

/**
 * The layers still worth keeping once `overrides` has been delivered for the sheet
 * they belong to: those the delivery does not already agree with.
 *
 * This is the *value*-based reconciliation that replaces a request id. Nothing
 * correlates a `setRowHeights` with the delivery that answers it, and nothing needs
 * to: a projection that already names these rows at this height has answered,
 * whichever write produced it.
 *
 * Not a substitute for discarding the overlay on a generation change, which callers
 * must still do — a delivery on a *new* permutation says nothing about display rows
 * read off the old one, so the whole overlay is void rather than partly satisfied.
 *
 * ## Agreement with a layer retires every layer older than it
 *
 * The scan runs newest-first and, at the first layer the delivery agrees with, keeps only
 * what is *newer* than it. It deliberately does not ask the question of each layer
 * independently, and that is not an optimization — asking independently is a bug once
 * layers overlap:
 *
 * 1. A resize is refused on the accumulated-map bound. Nothing will ever agree with its
 *    layer (see the residue below), so it stays.
 * 2. The user resizes an *overlapping* row, and that one is persisted and delivered. An
 *    independent filter drops the newer, agreed layer and keeps the older refused one.
 * 3. `resolved_row_height` resolves newest-first, so the surviving older layer is now the
 *    newest one naming those rows: it paints its refused height *over* the height that was
 *    just persisted, masking authoritative state for the rest of the generation. The
 *    reconciliation would have caused exactly the failure it exists to prevent.
 *
 * What licenses dropping the older ones is that webview→host resize writes are strictly
 * ordered. `postMessage` preserves order and the host's `setRowHeights` handler reaches
 * `enqueue_layout_write` synchronously, before its first await, so requests join the single
 * serialized layout-write tail in the order they were posted; layers are appended in that
 * same order, in the same synchronous block that posts. So by the time a write for layer
 * *N* has been processed, every write older than *N* has been processed too, and each of
 * those older requests is therefore already dead: either it was persisted (so the delivery
 * that carries *N* carries it too, unless something later overwrote it — in which case the
 * newer durable value is precisely what should win) or it was refused (so its intent never
 * became durable, and it must not keep painting).
 *
 * The one gap in that argument, stated rather than papered over: agreement is by value, so
 * a delivery can agree with layer *N* without *N*'s own write having run — a sibling panel
 * could persist the same height for the same rows first. Then an older layer still in
 * flight is dropped early and its rows show the durable height until their own write lands
 * and delivers. That is a brief flicker in a race that requires another writer to have
 * chosen the same rows *and* the same height, and it is the same value-based inference the
 * newest layer has always been reconciled by — not a new class of unsoundness. Masking a
 * persisted height indefinitely is the worse failure of the two.
 *
 * ## The one residue this leaves, and why it is left
 *
 * Reconciling by value means a layer is kept until a delivery *agrees* with it, which is
 * right for the ordinary case (the answer has not arrived yet) and wrong for exactly one:
 * a write the host refused on the accumulated-map bound
 * (`MAX_PERSISTED_ROW_HEIGHTS`). No delivery will ever agree with that layer, because
 * nothing was persisted and the refusal path delivers nothing at all; so it sits over the
 * projection, showing a height no file holds, until the view generation next moves and the
 * whole overlay is discarded — or until a *newer* layer is answered, which retires it along
 * with everything else that old (see above). The user does learn what happened — the host
 * warns, naming the limit — but the row they dragged keeps its new size on screen meanwhile.
 *
 * Three fixes were considered and all three cost more than the residue:
 *
 * - *Tell the webview it was refused.* A refusal reply is a new protocol message on the
 *   hot path of every drag, and every reader of it would then have to reason about a
 *   reply arriving after the generation it named has gone. A whole round-trip shape for a
 *   stale rectangle.
 * - *Predict it here.* The webview never holds the durable map — that is the point of the
 *   design — and cannot recover its size from the projection, which omits every source
 *   row the installed view does not show. Any estimate would sometimes drop a layer whose
 *   write actually succeeded, turning a cosmetic residue into a visible flicker on the
 *   common path.
 * - *Drop the layer on any delivery that disagrees.* This is the tempting one-liner and
 *   it is wrong: the common case for "delivered, disagrees" is a delivery provoked by
 *   something else (a sibling's write, an edit commit) racing ahead of the answer to this
 *   resize. Dropping then makes every in-flight resize flicker.
 *
 * Deferring the write for a retry is not on the list: replaying a refused user request is
 * forbidden by design, and the request would be refused again anyway — the bound it hit
 * does not lift on its own.
 */
export function row_height_layers_for_delivery(
    layers: readonly RowHeightLayer[],
    overrides: RowHeightOverrides,
): readonly RowHeightLayer[] {
    // Newest-first, stopping at the first agreement: everything older than an answered
    // layer is dead by the ordering argument above, so there is nothing to ask about it.
    // Returning `layers` itself when nothing agreed is load-bearing — App compares by
    // reference to decide whether the overlay state needs replacing at all.
    for (let index = layers.length - 1; index >= 0; index -= 1) {
        if (projection_agrees_with_layer(overrides, layers[index])) {
            return layers.slice(index + 1);
        }
    }
    return layers;
}
