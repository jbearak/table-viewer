/**
 * The wire boundary for replaying one undo/redo action.
 *
 * Undo in this app is not a webview-local operation. The history is
 * workbook-wide, so a replay may need cells on a sheet that is not on screen
 * and pages that were never resident; the host owns the document, the loader
 * and the durable workspace state. So the webview asks the host to PREPARE a
 * replay, plans against what the host hands back, and asks it to COMMIT — and
 * the host must be able to tell that the commit it receives corresponds to the
 * state it prepared. That correspondence is the lease.
 *
 * Two properties shape every type here.
 *
 * **The webview sends the overlay; the host echoes it.** `plan_history_replay`
 * compare-and-swaps against each cell's live `CellOverlayState`, and an overlay
 * cannot be re-derived host-side from a `CsvDirtyEntry`: `{value: A, base: A,
 * link}` is written by three different intents that undo differently (see
 * `ValueDimensionIntent`). Rather than teach the host those rules, the request
 * carries the renderer's exact overlay, the host validates and owns it, checks
 * it against durable state, and echoes it back. The planner then reads the
 * frozen snapshot the lease was issued against, never a store that may have
 * moved since.
 *
 * **Commit addresses nothing new.** A commit names cells by the `ordinal` the
 * prepare request assigned. Coordinates, worksheets and resolved sheet indices
 * come only from the retained prepared request, so a commit cannot reach a cell
 * preparation never verified — which is what makes the lease a capability
 * rather than a token attached to an otherwise trusted message.
 *
 * ## What preparation verifies, and what it deliberately does not do
 *
 * Preparation works against the CURRENTLY ACKNOWLEDGED adoption. It does not
 * build a source, adopt one, or wait for the renderer to acknowledge a snapshot
 * it would only have created for its own benefit — an adoption bumps the source
 * generation and document epoch, so a replay that forced one would invalidate
 * its own lease and then have to work around the invalidation. Nor does it need
 * to: the host reads any row of the current source directly (see
 * `harvest_source_bases`), so renderer page residency never limits which cells
 * it can materialize. The save path is the precedent — it admits against the
 * current adoption and never rebuilds.
 *
 * What that leaves is three independent classes of check, none of which
 * subsumes another:
 *
 *   1. **Agreement.** The host and renderer must be describing one document:
 *      `acknowledged_current()`, and the adoption must still own exactly the
 *      `source` and `core` the preparation captured.
 *   2. **Physical currency.** The acknowledged source must still be an accurate
 *      parse of the bytes on disk — the save path's stat, read, re-stat, digest
 *      and authority-revision sequence. The watcher may not yet have seen an
 *      external write. This proves nothing about any individual edit.
 *   3. **Compare-and-swap.** Every requested overlay must still equal durable
 *      pending-edit state and every highlight its `expected` value, checked
 *      again inside the commit's atomic update. This proves nothing about the
 *      file.
 *
 * The lease binds the adoption, source, core, source generation, receiver epoch,
 * source observation, acknowledged digest, file authority and edit-session
 * identity — but NOT `core.generation` (a transform can advance the view without
 * moving the source rows a replay addresses) and NOT the whole durable-state
 * revision, which is used only for the compare-and-swap itself: a replay that
 * switches to the action's sheet persists `activeSheetIndex`, and a lease
 * pinning the whole revision would be invalidated by its own focus change.
 */

import { is_plain_record } from './plain-record';
import { is_matching_rich_text, type CellHyperlink, type RichText } from './cell-content';
import { is_valid_hyperlink } from './pending-changes';
import {
    is_strict_wire_dirty_entry,
    make_dirty_entry,
    sanitized_wire_worksheet_target,
    CELL_HIGHLIGHT_COLORS,
    type CellHighlightColor,
    type CsvDirtyEntry,
    type WorksheetTarget,
} from './types';

/** Which way the action is being replayed. Mirrors the webview's own union. */
export type HistoryReplayDirection = 'undo' | 'redo';

/** How long an issued, unconsumed lease stays usable. */
export const HISTORY_REPLAY_LEASE_TTL_MS = 30_000;

/**
 * How long a settled replay's answer is kept after the fact.
 *
 * Long past the lease's own life on purpose: this is what a lost acknowledgement
 * is recovered from. The webview resends the identical commit, the host finds
 * the terminal record and re-posts it without touching the document again.
 */
export const HISTORY_REPLAY_TERMINAL_RETENTION_MS = 5 * 60_000;

// --- Overlay, on the wire ---

/**
 * `CellOverlayState` as it crosses the boundary.
 *
 * Declared here rather than imported from `src/webview/history-cell-state-model`
 * because the host must not depend on webview modules — but it is the same shape
 * arm for arm, and `history-replay-wire-model.ts` holds the round trip that
 * proves it.
 */
export interface WireHistoryValue {
    readonly text: string;
    readonly runs?: RichText;
}

export interface WireUntouchedValueDimension {
    readonly kind: 'untouched';
    readonly anchor: WireHistoryValue;
}

export interface WirePresentValueDimension {
    readonly kind: 'present';
    readonly value: WireHistoryValue;
    readonly base: WireHistoryValue;
    readonly basePending: boolean;
}

export interface WireUntouchedHyperlinkDimension {
    readonly kind: 'untouched';
}

export interface WirePresentHyperlinkDimension {
    readonly kind: 'present';
    readonly value: CellHyperlink | null;
    readonly base: CellHyperlink | null;
}

/**
 * The same three arms as `PresentCellOverlayState`: an entry with neither
 * dimension in the overlay is unrepresentable rather than merely undocumented,
 * because the save path would have nothing to do with it.
 */
export type WirePresentCellOverlayState =
    | {
        readonly kind: 'present';
        readonly value: WirePresentValueDimension;
        readonly hyperlink: WireUntouchedHyperlinkDimension;
    }
    | {
        readonly kind: 'present';
        readonly value: WireUntouchedValueDimension;
        readonly hyperlink: WirePresentHyperlinkDimension;
    }
    | {
        readonly kind: 'present';
        readonly value: WirePresentValueDimension;
        readonly hyperlink: WirePresentHyperlinkDimension;
    };

export type WireCellOverlayState =
    | { readonly kind: 'absent' }
    | WirePresentCellOverlayState;

// --- Correlation ---

export interface HistoryReplayCorrelation {
    /** One preparation attempt. */
    readonly requestId: string;
    /**
     * One local history entry's move. The entry itself never crosses the wire —
     * it holds owned action content the host has no use for — so this is how a
     * response finds the move it belongs to.
     */
    readonly replayId: string;
}

export interface HistoryReplayLeaseIdentity extends HistoryReplayCorrelation {
    readonly leaseId: string;
}

// --- Prepare ---

/**
 * One addressed cell. `ordinal` is dense and unique across the request: an
 * action may touch one cell twice (a paste overlapping its own source gives
 * A→B then B→C), and both deltas share the one ordinal, because the cell has
 * one persisted side and one starting overlay however many times it moves.
 */
export interface HistoryReplayCellInput {
    readonly ordinal: number;
    readonly worksheet: WorksheetTarget;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly overlay: WireCellOverlayState;
}

/**
 * One highlight transition, already adjusted for direction by the webview, so
 * the host can compare-and-swap it without deserializing a `HistoryAction`.
 */
export interface HistoryReplayHighlightInput {
    readonly ordinal: number;
    readonly worksheet: WorksheetTarget;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly expected: CellHighlightColor | null;
    readonly desired: CellHighlightColor | null;
}

/**
 * The region the replay lands in, on the action's first worksheet.
 *
 * Carried through the whole protocol although nothing in stage 5 reads it:
 * undo moves the cursor to what it changed and briefly flashes it, and the
 * response is the only place that knows where that is once sheets have been
 * resolved against the acknowledged workbook. Ends are inclusive.
 */
export interface HistoryReplayFocus {
    readonly worksheet: WorksheetTarget;
    readonly sourceRowStart: number;
    readonly sourceRowEnd: number;
    readonly sourceColumnStart: number;
    readonly sourceColumnEnd: number;
}

export interface PrepareHistoryReplayRequest extends HistoryReplayCorrelation {
    readonly direction: HistoryReplayDirection;
    readonly cells: readonly HistoryReplayCellInput[];
    readonly highlights: readonly HistoryReplayHighlightInput[];
    readonly focus: HistoryReplayFocus;
}

export interface HistoryReplayPreparedCell {
    readonly ordinal: number;
    readonly worksheet: WorksheetTarget;
    readonly resolvedSheetIndex: number;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    /** The request's overlay, validated and owned by the host. */
    readonly overlay: WireCellOverlayState;
    /**
     * The cell's content in the acknowledged source, whose bytes the host
     * verified still match the file before issuing the lease.
     */
    readonly persisted: WireHistoryValue;
    readonly persistedHyperlink: CellHyperlink | null;
}

export interface HistoryReplayPrepared extends HistoryReplayLeaseIdentity {
    readonly expiresAt: number;
    readonly sourceGeneration: number;
    readonly focusSheetIndex: number;
    readonly focus: HistoryReplayFocus;
    readonly cells: readonly HistoryReplayPreparedCell[];
}

export type HistoryReplayPrepareRefusalReason =
    | 'malformed'
    | 'busy'
    | 'unavailable'
    | 'document-changed'
    | 'edit-session-unavailable'
    | 'conflict'
    | 'expired';

export interface HistoryReplayPrepareRefused extends HistoryReplayCorrelation {
    readonly reason: HistoryReplayPrepareRefusalReason;
    readonly worksheet?: WorksheetTarget;
    readonly sourceRow?: number;
    readonly sourceColumn?: number;
}

// --- Commit ---

/** `null` removes the cell's pending-edit entry. */
export interface HistoryReplayCellWrite {
    readonly ordinal: number;
    readonly entry: CsvDirtyEntry | null;
}

export interface HistoryReplayHighlightWrite {
    readonly ordinal: number;
}

export interface CommitHistoryReplayRequest extends HistoryReplayLeaseIdentity {
    /**
     * The proposal's identity. A duplicate delivery of the same proposal is the
     * same mutation and answers from the ledger; a different proposal under the
     * same lease is a bug or an attack, and is refused rather than applied.
     */
    readonly mutationId: string;
    readonly cells: readonly HistoryReplayCellWrite[];
    readonly highlights: readonly HistoryReplayHighlightWrite[];
}

export interface HistoryReplayAcceptedCellWrite {
    readonly ordinal: number;
    readonly resolvedSheetIndex: number;
    readonly key: string;
    readonly entry: CsvDirtyEntry | null;
}

export interface HistoryReplayCommitted extends HistoryReplayLeaseIdentity {
    readonly mutationId: string;
    readonly stateRevision: number;
    readonly sourceGeneration: number;
    /**
     * A plain frozen array, never a `Uint32Array`: `readonly` on a typed array
     * is a claim the type system cannot keep — the elements stay writable — and
     * this crosses a boundary where the receiver must be able to trust it.
     */
    readonly sheetIndices: readonly number[];
    readonly cells: readonly HistoryReplayAcceptedCellWrite[];
    readonly focusSheetIndex: number;
    readonly focus: HistoryReplayFocus;
}

export type HistoryReplayCommitRefusalReason =
    | 'malformed'
    | 'expired'
    | 'already-consumed'
    | 'proposal-mismatch'
    | 'conflict'
    | 'document-changed'
    | 'unavailable';

export interface HistoryReplayCommitRefused extends HistoryReplayLeaseIdentity {
    readonly mutationId: string;
    readonly reason: HistoryReplayCommitRefusalReason;
    readonly worksheet?: WorksheetTarget;
    readonly sourceRow?: number;
    readonly sourceColumn?: number;
}

export interface AbandonHistoryReplayRequest extends HistoryReplayLeaseIdentity {
}

// --- Validation ---
//
// Everything below parses `unknown` and returns owned, frozen values. The
// static types above describe what a WELL-BEHAVED peer sends; they are not
// evidence about what arrived, so nothing here casts its input.

function is_source_index(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sanitized_wire_history_value(value: unknown): WireHistoryValue | undefined {
    if (!is_plain_record(value) || typeof value.text !== 'string') return undefined;
    if (value.runs === undefined) return Object.freeze({ text: value.text });
    // Runs must describe the text they accompany, the same smuggling boundary
    // `sanitized_dirty_entry` enforces — but rejected rather than dropped: a
    // history value with its styling silently removed is a different value, and
    // replaying it would rewrite formatting the user never touched.
    if (!is_matching_rich_text(value.runs, value.text)) return undefined;
    return Object.freeze({ text: value.text, runs: value.runs });
}

function sanitized_wire_nullable_hyperlink(
    value: unknown,
): { readonly link: CellHyperlink | null } | undefined {
    if (value === null) return Object.freeze({ link: null });
    if (!is_valid_hyperlink(value)) return undefined;
    return Object.freeze({ link: value });
}

function sanitized_wire_value_dimension(
    value: unknown,
): WirePresentValueDimension | WireUntouchedValueDimension | undefined {
    if (!is_plain_record(value)) return undefined;
    if (value.kind === 'untouched') {
        const anchor = sanitized_wire_history_value(value.anchor);
        return anchor === undefined
            ? undefined
            : Object.freeze({ kind: 'untouched' as const, anchor });
    }
    if (value.kind !== 'present') return undefined;
    if (typeof value.basePending !== 'boolean') return undefined;
    const present = sanitized_wire_history_value(value.value);
    const base = sanitized_wire_history_value(value.base);
    if (present === undefined || base === undefined) return undefined;
    return Object.freeze({
        kind: 'present' as const,
        value: present,
        base,
        basePending: value.basePending,
    });
}

function sanitized_wire_hyperlink_dimension(
    value: unknown,
): WirePresentHyperlinkDimension | WireUntouchedHyperlinkDimension | undefined {
    if (!is_plain_record(value)) return undefined;
    if (value.kind === 'untouched') return Object.freeze({ kind: 'untouched' as const });
    if (value.kind !== 'present') return undefined;
    const link = sanitized_wire_nullable_hyperlink(value.value);
    const base = sanitized_wire_nullable_hyperlink(value.base);
    if (link === undefined || base === undefined) return undefined;
    return Object.freeze({
        kind: 'present' as const,
        value: link.link,
        base: base.link,
    });
}

export function sanitized_wire_cell_overlay_state(
    value: unknown,
): WireCellOverlayState | undefined {
    if (!is_plain_record(value)) return undefined;
    if (value.kind === 'absent') return Object.freeze({ kind: 'absent' as const });
    if (value.kind !== 'present') return undefined;
    const dimension = sanitized_wire_value_dimension(value.value);
    const hyperlink = sanitized_wire_hyperlink_dimension(value.hyperlink);
    if (dimension === undefined || hyperlink === undefined) return undefined;
    // The unrepresentable fourth arm: a present overlay with neither dimension
    // in it is an entry the save path would have nothing to do with, so it is
    // rejected here rather than carried as a shape nothing downstream expects.
    if (dimension.kind === 'untouched' && hyperlink.kind === 'untouched') {
        return undefined;
    }
    if (dimension.kind === 'present' && hyperlink.kind === 'untouched') {
        return Object.freeze({ kind: 'present' as const, value: dimension, hyperlink });
    }
    if (dimension.kind === 'untouched' && hyperlink.kind === 'present') {
        return Object.freeze({ kind: 'present' as const, value: dimension, hyperlink });
    }
    if (dimension.kind === 'present' && hyperlink.kind === 'present') {
        return Object.freeze({ kind: 'present' as const, value: dimension, hyperlink });
    }
    return undefined;
}

function sanitized_wire_highlight_color(value: unknown): CellHighlightColor | null | undefined {
    if (value === null) return null;
    if (typeof value !== 'string') return undefined;
    for (const color of CELL_HIGHLIGHT_COLORS) {
        if (color === value) return color;
    }
    return undefined;
}

export function sanitized_wire_history_replay_focus(
    value: unknown,
): HistoryReplayFocus | undefined {
    if (!is_plain_record(value)) return undefined;
    const worksheet = sanitized_wire_worksheet_target(value.worksheet);
    if (!worksheet) return undefined;
    const { sourceRowStart, sourceRowEnd, sourceColumnStart, sourceColumnEnd } = value;
    if (
        !is_source_index(sourceRowStart)
        || !is_source_index(sourceRowEnd)
        || !is_source_index(sourceColumnStart)
        || !is_source_index(sourceColumnEnd)
        || sourceRowEnd < sourceRowStart
        || sourceColumnEnd < sourceColumnStart
    ) return undefined;
    return Object.freeze({
        worksheet,
        sourceRowStart,
        sourceRowEnd,
        sourceColumnStart,
        sourceColumnEnd,
    });
}

function sanitized_correlation(value: unknown): HistoryReplayCorrelation | undefined {
    if (
        !is_plain_record(value)
        || typeof value.requestId !== 'string'
        || typeof value.replayId !== 'string'
        || value.requestId.length === 0
        || value.replayId.length === 0
    ) return undefined;
    return Object.freeze({ requestId: value.requestId, replayId: value.replayId });
}

function sanitized_lease_identity(value: unknown): HistoryReplayLeaseIdentity | undefined {
    const correlation = sanitized_correlation(value);
    if (
        correlation === undefined
        || !is_plain_record(value)
        || typeof value.leaseId !== 'string'
        || value.leaseId.length === 0
    ) return undefined;
    return Object.freeze({ ...correlation, leaseId: value.leaseId });
}

/**
 * Walk a wire array of ordinal-bearing records, enforcing that the ordinals are
 * exactly `0..length-1` with no gaps and no repeats.
 *
 * Denseness is what lets a commit address cells by ordinal alone: a sparse or
 * duplicated set would leave the correspondence between the two messages
 * ambiguous, and the ambiguity would be resolved on the host, against the
 * document.
 */
function sanitized_ordinal_list<T extends { readonly ordinal: number }>(
    value: unknown,
    sanitize: (entry: Record<string, unknown>) => T | undefined,
): readonly T[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<number>();
    const out: T[] = [];
    for (const raw of value) {
        if (!is_plain_record(raw)) return undefined;
        const { ordinal } = raw;
        if (!is_source_index(ordinal) || ordinal >= value.length || seen.has(ordinal)) {
            return undefined;
        }
        const entry = sanitize(raw);
        if (entry === undefined) return undefined;
        seen.add(ordinal);
        out.push(entry);
    }
    return Object.freeze(out);
}

export function sanitized_prepare_history_replay_request(
    value: unknown,
): PrepareHistoryReplayRequest | undefined {
    const correlation = sanitized_correlation(value);
    if (correlation === undefined || !is_plain_record(value)) return undefined;
    if (value.direction !== 'undo' && value.direction !== 'redo') return undefined;
    const focus = sanitized_wire_history_replay_focus(value.focus);
    if (focus === undefined) return undefined;

    const cells = sanitized_ordinal_list<HistoryReplayCellInput>(value.cells, (raw) => {
        const worksheet = sanitized_wire_worksheet_target(raw.worksheet);
        const overlay = sanitized_wire_cell_overlay_state(raw.overlay);
        if (
            !worksheet
            || overlay === undefined
            || !is_source_index(raw.sourceRow)
            || !is_source_index(raw.sourceColumn)
            || !is_source_index(raw.ordinal)
        ) return undefined;
        return Object.freeze({
            ordinal: raw.ordinal,
            worksheet,
            sourceRow: raw.sourceRow,
            sourceColumn: raw.sourceColumn,
            overlay,
        });
    });
    if (cells === undefined || cells.length === 0) return undefined;

    const highlights = sanitized_ordinal_list<HistoryReplayHighlightInput>(
        value.highlights,
        (raw) => {
            const worksheet = sanitized_wire_worksheet_target(raw.worksheet);
            const expected = sanitized_wire_highlight_color(raw.expected);
            const desired = sanitized_wire_highlight_color(raw.desired);
            if (
                !worksheet
                || expected === undefined
                || desired === undefined
                || !is_source_index(raw.sourceRow)
                || !is_source_index(raw.sourceColumn)
                || !is_source_index(raw.ordinal)
            ) return undefined;
            return Object.freeze({
                ordinal: raw.ordinal,
                worksheet,
                sourceRow: raw.sourceRow,
                sourceColumn: raw.sourceColumn,
                expected,
                desired,
            });
        },
    );
    if (highlights === undefined) return undefined;

    return Object.freeze({
        ...correlation,
        direction: value.direction,
        cells,
        highlights,
        focus,
    });
}

export function sanitized_commit_history_replay_request(
    value: unknown,
): CommitHistoryReplayRequest | undefined {
    const identity = sanitized_lease_identity(value);
    if (
        identity === undefined
        || !is_plain_record(value)
        || typeof value.mutationId !== 'string'
        || value.mutationId.length === 0
    ) return undefined;

    const cells = sanitized_ordinal_list<HistoryReplayCellWrite>(value.cells, (raw) => {
        if (!is_source_index(raw.ordinal)) return undefined;
        if (raw.entry === null) {
            return Object.freeze({ ordinal: raw.ordinal, entry: null });
        }
        // The STRICT guard, not the save path's `sanitized_wire_dirty_entry`,
        // which drops a malformed run side and keeps the entry. That is the
        // right policy for a save — the plain projection is still the text the
        // user committed — but not for a replay: an undo that restores the
        // user's styled text with the styling quietly stripped is a wrong undo,
        // and refusing the whole replay leaves history where it was.
        if (!is_strict_wire_dirty_entry(raw.entry)) return undefined;
        // Copied through `make_dirty_entry` rather than retained: the guard
        // proves the shape, it does not make the caller's object ours.
        return Object.freeze({
            ordinal: raw.ordinal,
            entry: make_dirty_entry(
                raw.entry.value,
                raw.entry.base,
                raw.entry.valueRuns,
                raw.entry.baseRuns,
                raw.entry.link,
                raw.entry.baseLink,
            ),
        });
    });
    if (cells === undefined) return undefined;

    // Highlight writes name an ordinal and nothing else: what to write is
    // already in the prepared request's `desired`, which the host verified when
    // it issued the lease. Letting the commit restate it would be letting it
    // choose a colour preparation never checked.
    const highlights = sanitized_ordinal_list<HistoryReplayHighlightWrite>(
        value.highlights,
        (raw) => (is_source_index(raw.ordinal)
            ? Object.freeze({ ordinal: raw.ordinal })
            : undefined),
    );
    if (highlights === undefined) return undefined;

    return Object.freeze({ ...identity, mutationId: value.mutationId, cells, highlights });
}

export function sanitized_abandon_history_replay_request(
    value: unknown,
): AbandonHistoryReplayRequest | undefined {
    return sanitized_lease_identity(value);
}

/**
 * A stable fingerprint of a commit's proposal, for telling a duplicate delivery
 * from a different proposal wearing the same lease.
 *
 * Built from the sanitized request, so it fingerprints what the host accepted
 * rather than the bytes that arrived, and ordered by ordinal so two encodings of
 * one proposal agree.
 */
export function history_replay_proposal_digest(
    request: CommitHistoryReplayRequest,
): string {
    const cells = [...request.cells]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((write) => [
            write.ordinal,
            write.entry === null ? null : [
                write.entry.value,
                write.entry.base,
                write.entry.valueRuns ?? null,
                write.entry.baseRuns ?? null,
                write.entry.link ?? null,
                write.entry.baseLink ?? null,
            ],
        ]);
    const highlights = [...request.highlights]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((write) => write.ordinal);
    return JSON.stringify([request.mutationId, cells, highlights]);
}
