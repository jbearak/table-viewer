import type { DataSource, SheetMeta } from './data-source/interface';
import {
    projected_row_for_source,
    read_source_row_indices,
} from './data-source/interface';
import { parse_cell_highlight_key } from './cell-highlights';
import { CompareDataSource } from './diff-compare/compare-session';
import { clamp_row_height } from './webview/row-heights';
import { deep_clone_and_freeze } from './immutable';
import { compute_column_histogram, type ColumnHistogram } from './histograms';
import type {
    ColumnAnalysis,
    ColumnAnalysisCache,
    ColumnIdentityRequirement,
} from './column-analysis';
import {
    compute_transform,
    InvalidNumericFilterOperandError,
    transformed_window,
    type TransformedRowWindow,
} from './table-transform';
import type {
    WorkbookSnapshotCoreMaterial,
    WorkbookSnapshotDiagnostics,
} from './viewer-snapshot';
import {
    EMPTY_TRANSFORM,
    transform_has_entries,
    transform_is_active,
    transform_schema_for_sheet,
    type DisplayRowInterval,
    type FilterEntry,
    type HostMessage,
    type SheetTransformState,
    type SheetViewRecord,
    type WebviewMessage,
} from './types';

/**
 * Minimal structural view of the parts of vscode.WebviewPanel that the core
 * uses. Declared locally (rather than importing `vscode`) so the core stays a
 * pure module — unit-testable with a fake panel and no extension host.
 */
export interface PanelLike {
    webview: {
        postMessage(message: unknown): PromiseLike<boolean> | boolean;
    };
}

type SetTransformMessage = Extract<WebviewMessage, { type: 'setTransform' }>;
type TransformCommit = (
    message: SetTransformMessage,
    state: SheetTransformState,
    receiverEpoch: number,
) => Promise<void>;

/** Typed reconciliation failure for one persisted transform and its retained view. */
export class InvalidPersistedTransformError extends Error {
    constructor(
        readonly sheetIndex: number,
        readonly invalidState: SheetTransformState,
        readonly retainedState: SheetTransformState,
        readonly operandError: InvalidNumericFilterOperandError,
    ) {
        super(operandError.message, { cause: operandError });
        this.name = 'InvalidPersistedTransformError';
    }
}

/**
 * The commit-time admission re-ask refused: the edit phase moved under a transform
 * that was already in flight. Its own type rather than a message string because the
 * two ways `onTransformCommit` can fail want opposite answers — every phase that
 * refuses here ends on its own, so this is transient and the request is worth
 * asking again, while a genuine persistence failure is terminal. Discriminating on
 * the type is the same shape `InvalidPersistedTransformError` already uses, and it
 * is what keeps the catch blocks from having to read message text.
 */
export class TransformAdmissionLapsedError extends Error {
    constructor(readonly refusal: string) {
        super(refusal);
        this.name = 'TransformAdmissionLapsedError';
    }
}

/**
 * Whether a refusal clears on its own. Named rather than boolean, and required at
 * every refusal site: the previous `transient = false` default meant a site that
 * simply forgot to say became terminal, which is how an admission lapse — a phase
 * that ends by itself — came to be delivered as "stop asking".
 */
export type TransformRefusalDisposition = 'transient' | 'terminal';

/**
 * Gives the host authority layer a chance to durably recover a failed restore.
 * `true` means the invalid candidate was replaced or superseded by a newer winner.
 */
type InvalidRestoreCleanup = (
    message: SetTransformMessage,
    error: InvalidPersistedTransformError,
    receiverEpoch: number,
) => Promise<boolean>;

/**
 * Reads the durable per-sheet custom row heights, keyed by canonical source row, out of
 * the authority layer for the core to re-key into display space.
 *
 * Three things about the shape are deliberate.
 *
 * `sheet_names` is asked for rather than assumed because the durable map may still be on
 * disk in its legacy *name*-keyed form, and only the caller that owns the projection
 * knows which sheets, in which order, those names have to line up with. The core passes
 * its own `source.meta()` names, so the array that comes back is indexed by the same
 * sheet indices the core projects — a controller-side guess could disagree with the
 * core's source for a delivery during adoption.
 *
 * `revision` and `heights` come back from one call because the memo below keys on the
 * revision and must be certain it names the very read the heights came from. Two getters
 * could be sampled either side of a durable write and cache a projection under the wrong
 * revision, which is the one way a memo here becomes a correctness bug rather than a
 * performance one.
 *
 * `revision` is the durable state revision, not a private counter, because that is what
 * every writer already advances: `setRowHeights`, a sibling panel's write and an
 * excel-header plan edit all land as a new state revision, and none of them bumps a view
 * generation.
 */
type DurableRowHeightsProvider = (sheet_names: readonly string[]) => {
    readonly revision: number;
    readonly heights: readonly (Record<number, number> | undefined)[];
};

type RowWindowServed = (
    msg: Extract<WebviewMessage, { type: 'requestRows' }>,
    window: Pick<TransformedRowWindow, 'startRow' | 'sourceRows'>,
    receiver_epoch: number,
) => void | Promise<void>;

type TransformOperationToken = number;
let next_transform_operation_token = 0;

function allocate_transform_operation_token(): TransformOperationToken {
    next_transform_operation_token += 1;
    return next_transform_operation_token;
}

const DEFAULT_MAX_CACHED_PAGES = 64;
const DEFAULT_MAX_CACHED_ROW_CELLS = 1_000_000;
const DEFAULT_MAX_CACHED_ROW_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CACHED_TRANSFORM_CELLS = 1_000_000;
const DEFAULT_MAX_CACHED_TRANSFORM_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CACHED_HISTOGRAM_BYTES = 16 * 1024 * 1024;
const CACHE_ARRAY_OVERHEAD_BYTES = 64;
const CACHE_OBJECT_OVERHEAD_BYTES = 64;
const CACHE_REFERENCE_BYTES = 8;

class ColumnAnalysisLruCache implements ColumnAnalysisCache {
    private readonly entries = new Map<string, ColumnAnalysis>();
    private retained_cells = 0;
    private retained_bytes = 0;

    constructor(
        private readonly max_cells: number,
        private readonly max_bytes: number,
    ) {}

    get(
        sheet_index: number,
        column_index: number,
        identity_requirement: ColumnIdentityRequirement,
    ): ColumnAnalysis | undefined {
        const key = `${sheet_index}:${column_index}`;
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (
            identity_requirement === 'complete'
            && !entry.filterIdentityComplete
        ) return entry;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry;
    }

    set(
        sheet_index: number,
        column_index: number,
        analysis: ColumnAnalysis,
    ): void {
        const key = `${sheet_index}:${column_index}`;
        const previous = this.entries.get(key);
        if (previous !== undefined) {
            if (
                previous.filterIdentityComplete
                || !analysis.filterIdentityComplete
            ) {
                this.entries.delete(key);
                this.entries.set(key, previous);
                return;
            }
        }
        if (
            analysis.retainedSlots > this.max_cells
            || analysis.estimatedBytes > this.max_bytes
            || this.max_cells <= 0
            || this.max_bytes <= 0
        ) return;

        if (previous !== undefined) {
            this.retained_cells -= previous.retainedSlots;
            this.retained_bytes -= previous.estimatedBytes;
            this.entries.delete(key);
        }
        while (
            (
                this.retained_cells + analysis.retainedSlots > this.max_cells
                || this.retained_bytes + analysis.estimatedBytes > this.max_bytes
            )
            && this.entries.size > 0
        ) {
            const oldest_key = this.entries.keys().next().value as string;
            const oldest = this.entries.get(oldest_key)!;
            this.entries.delete(oldest_key);
            this.retained_cells -= oldest.retainedSlots;
            this.retained_bytes -= oldest.estimatedBytes;
        }
        this.entries.set(key, analysis);
        this.retained_cells += analysis.retainedSlots;
        this.retained_bytes += analysis.estimatedBytes;
    }

    clear(): void {
        this.entries.clear();
        this.retained_cells = 0;
        this.retained_bytes = 0;
    }
}

function retained_string_bytes(value: string | undefined): number {
    return value === undefined
        ? 0
        : CACHE_OBJECT_OVERHEAD_BYTES + value.length * 2;
}

function histogram_result_bytes(histogram: ColumnHistogram): number {
    let bytes = CACHE_OBJECT_OVERHEAD_BYTES
        + CACHE_ARRAY_OVERHEAD_BYTES
        + histogram.bins.length * CACHE_REFERENCE_BYTES
        + CACHE_ARRAY_OVERHEAD_BYTES
        + histogram.distinctValues.length * CACHE_REFERENCE_BYTES;
    bytes += histogram.bins.length * CACHE_OBJECT_OVERHEAD_BYTES;
    for (const option of histogram.distinctValues) {
        bytes += CACHE_OBJECT_OVERHEAD_BYTES;
        bytes += retained_string_bytes(option.value ?? undefined);
        bytes += retained_string_bytes(option.rawValue);
        bytes += retained_string_bytes(option.label);
    }
    return bytes;
}

class HistogramLruCache {
    private readonly entries = new Map<string, {
        readonly histogram: ColumnHistogram;
        readonly bytes: number;
    }>();
    private retained_bytes = 0;

    constructor(private readonly max_bytes: number) {}

    get(key: string): ColumnHistogram | undefined {
        const entry = this.entries.get(key);
        if (entry === undefined) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.histogram;
    }

    set(key: string, histogram: ColumnHistogram): void {
        const bytes = histogram_result_bytes(histogram);
        if (bytes > this.max_bytes || this.max_bytes <= 0) return;
        const previous = this.entries.get(key);
        if (previous !== undefined) {
            this.retained_bytes -= previous.bytes;
            this.entries.delete(key);
        }
        while (
            this.retained_bytes + bytes > this.max_bytes
            && this.entries.size > 0
        ) {
            const oldest_key = this.entries.keys().next().value as string;
            const oldest = this.entries.get(oldest_key)!;
            this.entries.delete(oldest_key);
            this.retained_bytes -= oldest.bytes;
        }
        this.entries.set(key, { histogram, bytes });
        this.retained_bytes += bytes;
    }

    clear(): void {
        this.entries.clear();
        this.retained_bytes = 0;
    }
}

export interface ViewerPanelSnapshotMaterial {
    readonly core: WorkbookSnapshotCoreMaterial;
    readonly diagnostics: WorkbookSnapshotDiagnostics;
}

export type AdoptSourceResult =
    | { type: 'adopted' }
    | { type: 'refused' };

interface PreparedTransformChange {
    readonly sheetIndex: number;
    readonly state: SheetTransformState;
    readonly indices?: Uint32Array;
}

export interface PreparedTransformReconciliation {
    readonly sourceEpoch: number;
    readonly receiverEpoch: number;
    readonly generation: number;
    readonly changes: readonly PreparedTransformChange[];
}

/**
 * Protocol engine shared by the xlsx/xls custom editor and the CSV panel.
 *
 * Owns:
 *  - monotonic view/source generations advanced by logical adoption, with view
 *    generation also advancing after a successfully installed transform;
 *  - an LRU cache of already-served row windows keyed by sheet/start/count;
 *  - the `requestRows` -> `rowData` handler with a generation guard and
 *    boundary validation.
 *
 * It does NOT own metadata delivery, watchers, save/conflict flow, or vscode
 * config. PanelSession owns snapshots; controllers forward row/transform
 * messages to `handle_message`.
 */
export class ViewerPanelCore {
    private _generation = 1;
    private readonly cache = new Map<string, {
        readonly window: TransformedRowWindow;
        readonly cells: number;
        readonly bytes: number;
    }>();
    private cached_row_cells = 0;
    private cached_row_bytes = 0;
    private readonly max_cached_pages: number;
    private readonly column_analysis_cache: ColumnAnalysisLruCache;
    private readonly transform_indices = new Map<number, Uint32Array>();
    /** Projected source-row -> display-row, built lazily for transformed views. */
    private readonly inverse_transform_indices = new Map<number, Int32Array>();
    /**
     * Per sheet, the value `_generation` took when *that sheet's* display->source
     * mapping last moved. See `mapping_generation` for why this exists at all; the
     * pair of them is written by every writer of `transform_indices` that names a
     * sheet, so that the two maps can never disagree about when a sheet moved.
     */
    private readonly sheet_mapping_generations = new Map<number, number>();
    /**
     * The floor `mapping_generation` reports for a sheet that has never had a
     * mapping installed — reset by `adopt_source`, which invalidates every sheet's
     * mapping at once and therefore cannot be recorded per sheet.
     */
    private mapping_generation_floor = 1;
    private readonly transform_states = new Map<number, SheetTransformState>();
    private readonly transform_operations = new Map<number, TransformOperationToken>();
    private readonly transforms_in_flight = new Map<number, TransformOperationToken>();
    private readonly histogram_cache: HistogramLruCache;
    private readonly histogram_operations = new Map<string, TransformOperationToken>();
    private source_epoch = 0;
    private receiver_epoch = 0;
    private _source_generation = 1;
    private disposed = false;
    private readonly on_transform_commit?: TransformCommit;
    private readonly on_invalid_restore?: InvalidRestoreCleanup;
    private readonly durable_pending_edit_keys?: (sheet_index: number) => readonly string[];
    private readonly durable_row_heights?: DurableRowHeightsProvider;
    private readonly on_row_window_served?: RowWindowServed;
    /**
     * The last computed display-keyed projection, with the facts it is a function of.
     * See `row_height_projection_by_sheet` for why each is needed and why a memo is
     * needed at all.
     *
     * `by_sheet` is the assembled answer, cached for its own reference identity —
     * `snapshot_material` shares it, so rebuilding an identical array on every delivery
     * would defeat the sharing. `per_sheet` is what makes the rebuild cheap when it does
     * happen: each entry carries the *sheet's own* mapping generation beside the durable
     * revision, so a sheet whose neither fact moved is reused rather than recomputed.
     */
    private row_height_projection_memo?: {
        readonly generation: number;
        readonly revision: number;
        readonly by_sheet: readonly (Readonly<Record<number, number>> | undefined)[];
    };

    /**
     * One entry per sheet index, each keyed by the pair that sheet's projection actually
     * depends on. Kept across the events that invalidate `row_height_projection_memo`,
     * which is the entire point: see `row_height_projection_by_sheet`.
     */
    private readonly row_height_projection_per_sheet = new Map<number, {
        readonly mapping_generation: number;
        readonly source: Record<number, number> | undefined;
        readonly projection: Readonly<Record<number, number>> | undefined;
    }>();

    constructor(
        private readonly panel: PanelLike,
        private source: DataSource,
        opts?: {
            maxCachedPages?: number;
            maxCachedTransformCells?: number;
            maxCachedTransformBytes?: number;
            maxCachedHistogramBytes?: number;
            onTransformCommit?: TransformCommit;
            onInvalidRestore?: InvalidRestoreCleanup;
            /**
             * Canonical `"sourceRow:sourceColumn"` keys of the durable pending edits
             * the current edit session owns *on the named sheet*. The core owns view
             * membership and the authority layer owns the dirty map, so
             * `hiddenEditedCellKeys` needs both; absent (any caller with no edit
             * sessions) it is always empty.
             *
             * Sheet-qualified because editing is worksheet-scoped: each sheet has its
             * own dirty map, and the caller asks about one sheet's row permutation.
             * A file-scoped provider would test one sheet's edit keys against
             * another's permutation and report edits hidden that are not.
             */
            durablePendingEditKeys?: (sheet_index: number) => readonly string[];
            /**
             * The durable per-sheet custom row heights, keyed by canonical source row.
             * Same division of labour as `durablePendingEditKeys` and the same reason
             * for the injection: the core owns the projection and the permutation, the
             * authority layer owns durable state, and `rowHeights` needs both. Absent
             * (a test core, or any caller with no durable state to read) every
             * projection is empty, which renders as "no row has a custom height" —
             * the correct answer for a file that has none.
             */
            durableRowHeights?: DurableRowHeightsProvider;
            /**
             * Observe each row window only after `rowData` successfully posts to
             * the receiver that requested it. The window is resolved (clamped and
             * transform-projected), and the epoch is the one accepted with the
             * request, so an augmenting sidecar cannot migrate across receivers.
             */
            onRowWindowServed?: RowWindowServed;
        },
    ) {
        this.max_cached_pages = opts?.maxCachedPages ?? DEFAULT_MAX_CACHED_PAGES;
        this.column_analysis_cache = new ColumnAnalysisLruCache(
            opts?.maxCachedTransformCells ?? DEFAULT_MAX_CACHED_TRANSFORM_CELLS,
            opts?.maxCachedTransformBytes ?? DEFAULT_MAX_CACHED_TRANSFORM_BYTES,
        );
        this.histogram_cache = new HistogramLruCache(
            opts?.maxCachedHistogramBytes ?? DEFAULT_MAX_CACHED_HISTOGRAM_BYTES,
        );
        this.on_transform_commit = opts?.onTransformCommit;
        this.on_invalid_restore = opts?.onInvalidRestore;
        this.durable_pending_edit_keys = opts?.durablePendingEditKeys;
        this.durable_row_heights = opts?.durableRowHeights;
        this.on_row_window_served = opts?.onRowWindowServed;
    }

    get generation(): number {
        return this._generation;
    }

    get source_generation(): number {
        return this._source_generation;
    }

    get has_transform_work(): boolean {
        return this.transforms_in_flight.size > 0
            || this.transform_indices.size > 0;
    }

    get has_active_transform(): boolean {
        return [...this.transform_states.values()].some(transform_is_active);
    }

    transform_state(sheet_index: number): SheetTransformState {
        return clone_transform(
            this.transform_states.get(sheet_index) ?? EMPTY_TRANSFORM,
        );
    }

    /**
     * The installed transform, preserving absence after a source adoption.
     *
     * `transform_state` deliberately projects absence as the natural empty view for
     * callers that only need row behaviour. Header planning needs the distinction:
     * after an Excel projection adopts the source, saved transforms have not yet been
     * restored, and treating that transient absence as an installed empty transform
     * would erase a manual header candidate derived from durable hidden rows.
     */
    installed_transform_state(sheet_index: number): SheetTransformState | undefined {
        const state = this.transform_states.get(sheet_index);
        return state === undefined ? undefined : clone_transform(state);
    }

    /**
     * The core generation at which this sheet's display->source mapping last moved.
     *
     * `generation` is core-wide but a permutation is per sheet: `handle_set_transform`
     * and `commit_transform_reconciliation` write `transform_indices` for one sheet and
     * bump one shared counter, so an install on sheet B moves the generation without
     * moving a single display row on sheet A. Anything validating a *display-keyed*
     * request against the bare generation therefore refuses requests that were always
     * safe — a saved transform restoring on a background sheet, or a long sort the user
     * started before switching tabs, silently kills a resize on the sheet they are
     * looking at, whose mapping never moved. This is the fact that lets such a request
     * be accepted rather than queued: `msg.generation >= mapping_generation(sheet)`
     * means "posted no earlier than the arrangement this sheet still has", which is
     * exactly what a display row naming the intended source row requires.
     *
     * The *request* side needs nothing on the wire for this: the webview keeps posting the
     * one global generation it holds, and the host answers with a fact it alone has. The
     * *rendering* side turned out to need the same fact delivered, because the webview is
     * making the identical judgement about a display-keyed value of its own — see
     * `mapping_generations_by_sheet`, which serialises exactly this function.
     *
     * Not a substitute for the `sourceGeneration` term beside it. Adoption replaces the
     * rows themselves, so it invalidates every sheet at once and no per-sheet fact can
     * license anything across it; `adopt_source` moves the floor for that reason.
     */
    mapping_generation(sheet_index: number): number {
        return this.sheet_mapping_generations.get(sheet_index)
            ?? this.mapping_generation_floor;
    }

    /**
     * `mapping_generation` for every sheet the current source has, positionally matching
     * `meta.sheets` — the delivered form of the fact above.
     *
     * ## Why the webview needs it
     *
     * The webview holds a display-keyed optimistic row-height overlay tagged with the
     * generation its display rows were read off, and it has to decide, on every delivery,
     * whether those keys still name the rows they named. Judged against the bare
     * `generation` it gets the same wrong answer the host used to give: a terminal
     * transform reconciliation for sheet B — a sibling sort finishing in the background —
     * bumps the core-wide generation while `commit_transform_reconciliation` touches only
     * B's `transform_indices`, so sheet A's overlay is thrown away though not one of its
     * display rows moved. Meanwhile the host, asking the scoped question, has *accepted*
     * A's queued write. The row springs back and then silently reappears when that write
     * is delivered. The two sides must ask one question, and this is it.
     *
     * ## Why not infer it from `sourceGeneration`
     *
     * The tempting local heuristic is "discard only when `sourceGeneration` also moved".
     * It is unsafe, and not marginally: a snapshot with an unchanged source generation and
     * a bumped view generation means *some* sheet's permutation moved, and the webview
     * cannot tell which. Keeping sheet A's overlay under that rule paints the old display
     * keys over the new arrangement whenever A is the sheet that moved — a wrong height on
     * a wrong row, not a cosmetic lag. The whole point is that the sheet identity is
     * information only the host has, so the host has to send it.
     *
     * ## Why sending it is not the stale copy `SheetViewRecord` forbids
     *
     * Because nothing retains it. It is read once, in the same handler that receives it,
     * and reduced immediately to a keep-or-discard verdict; no state holds the numbers
     * afterwards. That is the `transformInstalled.rules` precedent — a fact read once and
     * never held travels beside the record rather than on it — and it is why this is
     * sampled in `snapshot_material` beside `generation`, not carried on the projected
     * capabilities, which are sampled only when something re-projects them.
     *
     * ## Consistency with the host's own predicate
     *
     * Every entry is produced by calling `mapping_generation` itself, deliberately, rather
     * than by reading `sheet_mapping_generations` and merging the floor here. The map is
     * sparse and falls back to `mapping_generation_floor`, so a second implementation is a
     * second chance to disagree with the predicate the host validates writes against — and
     * a disagreement is precisely the failure this exists to remove. Bounded to the sheets
     * the current source has, so a stale entry for a sheet a shrunken workbook no longer
     * holds cannot be published; the webview treats a missing entry as "discard", which is
     * the safe direction for an overlay on a sheet that is gone.
     */
    private mapping_generations_by_sheet(): readonly number[] {
        return this.source.meta().sheets.map(
            (_sheet, sheet_index) => this.mapping_generation(sheet_index),
        );
    }

    /** Map inclusive installed display-row intervals to canonical source rows. */
    map_display_rows_to_source(
        sheet_index: number,
        intervals: readonly DisplayRowInterval[],
    ): Uint32Array {
        const sheet = this.source.meta().sheets[sheet_index];
        if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
        const indices = this.transform_indices.get(sheet_index);
        const display_count = indices?.length ?? sheet.rowCount;
        let mapped_count = 0;
        for (const interval of intervals) {
            if (
                !Number.isInteger(interval.start)
                || !Number.isInteger(interval.end)
                || interval.start < 0
                || interval.end < interval.start
                || interval.end >= display_count
            ) {
                throw new RangeError(
                    `display row interval ${interval.start}-${interval.end} out of range (${display_count} rows)`,
                );
            }
            mapped_count += interval.end - interval.start + 1;
        }

        const projected_rows = new Uint32Array(mapped_count);
        let position = 0;
        for (const interval of intervals) {
            for (let display_row = interval.start; display_row <= interval.end; display_row++) {
                projected_rows[position++] = indices ? indices[display_row] : display_row;
            }
        }
        return read_source_row_indices(this.source, sheet_index, projected_rows);
    }

    /** Map a canonical source row into the installed display view. */
    display_row_for_source(
        sheet_index: number,
        source_row: number,
    ): number | undefined {
        const sheet = this.source.meta().sheets[sheet_index];
        if (
            !sheet
            || !Number.isInteger(source_row)
            || source_row < 0
            || source_row >= sheet.sourceRowCount
        ) return undefined;
        const projected_row = projected_row_for_source(
            this.source,
            sheet_index,
            source_row,
        );
        if (projected_row === undefined) return undefined;
        const indices = this.transform_indices.get(sheet_index);
        if (!indices) return projected_row;

        let inverse = this.inverse_transform_indices.get(sheet_index);
        if (!inverse) {
            inverse = new Int32Array(sheet.rowCount);
            inverse.fill(-1);
            for (let display_row = 0; display_row < indices.length; display_row++) {
                inverse[indices[display_row]] = display_row;
            }
            this.inverse_transform_indices.set(sheet_index, inverse);
        }
        const display_row = inverse[projected_row];
        return display_row >= 0 ? display_row : undefined;
    }

    /**
     * Invalidate unfinished work owned by an older webview receiver without
     * disturbing transforms that were already installed for the current source.
     */
    begin_receiver_epoch(receiver_epoch: number): void {
        if (this.disposed || this.receiver_epoch === receiver_epoch) return;
        this.receiver_epoch = receiver_epoch;
    }

    /**
     * Adopt a new physical source or logical projection without posting metadata.
     * Object identity is deliberately irrelevant: an in-place Excel projection is
     * still a new source/view generation. A disposed core refuses ownership.
     */
    adopt_source(source: DataSource): AdoptSourceResult {
        if (this.disposed) return { type: 'refused' };
        this.source = source;
        this.source_epoch += 1;
        this._generation += 1;
        this._source_generation += 1;
        this.transform_indices.clear();
        this.inverse_transform_indices.clear();
        // Every sheet's mapping moved, so no sheet keeps a per-sheet exemption and the
        // floor rises to the generation this adoption just installed. Written as a floor
        // rather than as an entry per sheet because a new source can have a different
        // sheet *count*, so there is no set of indices to enumerate — and a leftover
        // entry for a sheet this source does not have would license a display-keyed
        // request against rows that no longer exist.
        this.sheet_mapping_generations.clear();
        this.mapping_generation_floor = this._generation;
        this.transform_states.clear();
        this.transform_operations.clear();
        this.transforms_in_flight.clear();
        this.histogram_cache.clear();
        this.histogram_operations.clear();
        this.column_analysis_cache.clear();
        this.clear_row_cache();
        // Unfalsifiable, and said so rather than dressed up as a fix: the `_generation`
        // bump above already makes the memo's key miss, so no test can tell this line from
        // its absence — probed by deleting it, and nothing failed. Kept on the precedent
        // `may_reserve_claim` and `edit_cleanup_blocked` set in `viewer-controller`,
        // because a new source can also change the *sheet count*, and a cache entry that
        // outlives the source it was projected against is what a later narrowing of the
        // memo key would get wrong silently. Dropped beside every other per-source cache
        // so it is invalidated by the same reflex.
        this.row_height_projection_memo = undefined;
        // That narrowing now exists, and the per-sheet cache is dropped with it — also
        // unfalsifiable, and for a reason worth writing down rather than repeating the
        // line above, because the narrowing is exactly the change that could have made it
        // load-bearing and did not. Its entries are keyed by sheet index and by the
        // sheet's `mapping_generation`, so the question is whether an adopted source can
        // land a *different* workbook's sheet at an index whose cached mapping generation
        // still matches. It cannot: the floor two lines up is set to `_generation` *after*
        // the bump, so every sheet now reports a mapping generation strictly greater than
        // any this cache could hold, and every entry misses. Probed by deleting this line,
        // and nothing failed, exactly as that argument predicts. Kept because the argument
        // rests on the bump and the floor staying in this order, which nothing else here
        // enforces, and because a stale entry would be a height painted on another
        // workbook's row — the one failure this projection exists to prevent.
        this.row_height_projection_per_sheet.clear();
        return { type: 'adopted' };
    }

    /** Cancel asynchronous work before disposal. Adoption cancels atomically. */
    private cancel_pending(): void {
        this.source_epoch += 1;
        this.transform_operations.clear();
        this.transforms_in_flight.clear();
        this.histogram_operations.clear();
    }

    /** Clone and freeze all source-owned material needed by a future snapshot. */
    snapshot_material(): ViewerPanelSnapshotMaterial {
        // Sampled in the same statement as everything below, which is what the adjacency
        // arguments on the two fields require; it is only lifted out of the literal so it
        // can bypass `deep_clone_and_freeze`. It is already deeply frozen at its source
        // (`compute_row_height_projection`), so sharing it lets no mutable object escape,
        // and it is the one field where the copy is not free: a pre-cap legacy map can hold
        // hundreds of thousands of entries and this runs on every delivery. See
        // `row_height_projection_by_sheet` for the residual per-delivery cost.
        const rowHeightProjection = this.row_height_projection_by_sheet();
        const cloned = deep_clone_and_freeze({
            core: {
                generation: this._generation,
                sourceGeneration: this._source_generation,
                meta: this.source.meta(),
                // Sampled here, beside the generation, and that adjacency is the
                // whole point: PanelSession builds every delivery from one
                // `snapshot_material()` call, so the keys and the generation the
                // webview tests its held record against were read at the same
                // instant. A generation still equal to the record's is proof the
                // permutation has not moved, so it is proof these keys were computed
                // against the very view that record describes. Carried on the
                // projected capabilities instead they would be sampled at a
                // different moment and could name another permutation's rows.
                hiddenEditedCellKeys: this.hidden_edited_cell_keys_by_sheet(),
                // Third value sampled in this same statement, and the adjacency
                // argument above is not merely reused here but *needed* here: this
                // array is what lets the webview ask, of the generation beside it,
                // "did *this sheet's* rows move?". Read a moment later it could
                // answer about a different permutation than `generation` names, and
                // then it would license keeping a display-keyed overlay across the
                // very install that invalidated it. See `mapping_generations_by_sheet`
                // for why the host has to send it at all.
                mappingGenerations: this.mapping_generations_by_sheet(),
            },
            diagnostics: {
                truncationMessage: this.source.truncationMessage ?? null,
            },
        });
        return Object.freeze({
            // Immediately beside the keys above because it needs the identical
            // argument and nothing weaker. Both are display-space answers about one
            // specific permutation, so both are safe only if read in the same instant
            // as the generation that identifies it. The consequence of getting it
            // wrong differs, though, and the height projection's is worse: stale
            // hidden keys over-report unsaved work the user can actually see, while a
            // projection read against another permutation renders every custom height
            // on a different row, silently and durably-looking.
            core: Object.freeze({ ...cloned.core, rowHeightProjection }),
            diagnostics: cloned.diagnostics,
        });
    }

    /** Permanently stop work and suppress all later protocol messages. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancel_pending();
        // The fourth writer of `transform_indices`, and the one that deliberately leaves
        // `sheet_mapping_generations` alone. Clearing it here would *lower* every sheet
        // back to the floor, which is the weaker answer, not the stronger one; and it buys
        // nothing, because every predicate that reads a mapping generation is guarded by
        // `disposed` first — `handle_message` returns immediately and the controller's
        // `resize_is_current` opens with `!disposed`. Held as a Map of small numbers, so
        // there is no memory here for the other clears' reason to apply to.
        this.transform_indices.clear();
        this.inverse_transform_indices.clear();
        this.transform_states.clear();
        this.histogram_cache.clear();
        this.column_analysis_cache.clear();
        this.clear_row_cache();
        this.row_height_projection_memo = undefined;
        // Dropped here for the memory rather than for correctness — unlike the small
        // numbers above, these entries retain a projection per sheet, and a pre-cap legacy
        // map makes that the largest thing this core holds.
        this.row_height_projection_per_sheet.clear();
    }

    /** Entry point for webview->host messages the core is responsible for. */
    async handle_message(msg: WebviewMessage): Promise<void> {
        if (this.disposed) return;
        if (msg.type === 'requestRows') {
            await this.handle_row_request(msg);
        } else if (msg.type === 'setTransform') {
            await this.handle_set_transform(msg);
        } else if (msg.type === 'requestFilterHistogram') {
            await this.handle_histogram_request(msg);
        } else if (msg.type === 'cancelFilterHistogram') {
            this.histogram_operations.delete(msg.requestId);
        }
    }

    private async handle_histogram_request(
        msg: Extract<WebviewMessage, { type: 'requestFilterHistogram' }>,
    ): Promise<void> {
        const receiver_epoch = this.receiver_epoch;
        const sheets = this.source.meta().sheets;
        const sheet_index_is_valid = Number.isInteger(msg.sheetIndex)
            && msg.sheetIndex >= 0
            && msg.sheetIndex < sheets.length;
        const sheet = sheet_index_is_valid ? sheets[msg.sheetIndex] : undefined;
        const invalid = msg.generation !== this._generation
            ? 'The view changed before this histogram request arrived.'
            : msg.sourceGeneration !== this._source_generation
            ? 'The source changed before this histogram request arrived.'
            : !sheet
            ? `Sheet index ${msg.sheetIndex} is out of range.`
            : !Number.isInteger(msg.columnIndex)
                || msg.columnIndex < 0
                || msg.columnIndex >= sheet.columnCount
            ? `Column index ${msg.columnIndex} is out of range.`
            : undefined;
        if (invalid) {
            await this.post({
                type: 'filterHistogram',
                sheetIndex: msg.sheetIndex,
                columnIndex: msg.columnIndex,
                bins: [],
                columnKind: 'unknown',
                distinctValues: [],
                distinctValuesExceeded: false,
                requestId: msg.requestId,
                generation: msg.generation,
                sourceGeneration: msg.sourceGeneration,
                error: invalid,
            }, receiver_epoch);
            return;
        }

        const source_epoch = this.source_epoch;
        const operation_token = allocate_transform_operation_token();
        this.histogram_operations.set(msg.requestId, operation_token);
        const is_cancelled = () => this.disposed
            || this.source_epoch !== source_epoch
            || this.receiver_epoch !== receiver_epoch
            || this.histogram_operations.get(msg.requestId) !== operation_token;
        const cache_key = `${this._source_generation}:${msg.sheetIndex}:${msg.columnIndex}`;
        try {
            const cached = this.histogram_cache.get(cache_key);
            const histogram = cached ?? await compute_column_histogram(
                this.source,
                msg.sheetIndex,
                msg.columnIndex,
                is_cancelled,
                this.column_analysis_cache,
            );
            if (is_cancelled()) return;
            if (!cached) this.histogram_cache.set(cache_key, histogram);
            await this.post({
                type: 'filterHistogram',
                sheetIndex: msg.sheetIndex,
                columnIndex: msg.columnIndex,
                bins: histogram.bins,
                columnKind: histogram.columnKind,
                defaultCategorical: histogram.defaultCategorical,
                distinctValues: histogram.distinctValues,
                distinctValuesExceeded: histogram.distinctValuesExceeded,
                requestId: msg.requestId,
                generation: msg.generation,
                sourceGeneration: msg.sourceGeneration,
            }, receiver_epoch);
        } catch (error) {
            if (is_cancelled()) return;
            await this.post({
                type: 'filterHistogram',
                sheetIndex: msg.sheetIndex,
                columnIndex: msg.columnIndex,
                bins: [],
                columnKind: 'unknown',
                distinctValues: [],
                distinctValuesExceeded: false,
                requestId: msg.requestId,
                generation: msg.generation,
                sourceGeneration: msg.sourceGeneration,
                error: error instanceof Error ? error.message : String(error),
            }, receiver_epoch);
        } finally {
            if (this.histogram_operations.get(msg.requestId) === operation_token) {
                this.histogram_operations.delete(msg.requestId);
            }
        }
    }

    /**
     * The grid rows an `onlyChangedRows` transform keeps, or undefined when the
     * request does not ask for one. Only a compare source can answer this, which
     * is why the transform takes it as an argument rather than deriving it.
     */
    private changed_grid_rows(
        sheet_index: number,
        state: SheetTransformState,
    ): readonly number[] | undefined {
        if (!state.onlyChangedRows) return undefined;
        const source = this.source;
        return source instanceof CompareDataSource
            ? source.changed_grid_rows(sheet_index)
            : undefined;
    }

    /** Prepare host-owned transform state without changing the installed view. */
    async prepare_transform_reconciliation(
        states: readonly (SheetTransformState | undefined)[],
        is_cancelled: () => boolean,
    ): Promise<PreparedTransformReconciliation | undefined> {
        const source_epoch = this.source_epoch;
        const receiver_epoch = this.receiver_epoch;
        const generation = this._generation;
        const sheets = this.source.meta().sheets;
        const changes: PreparedTransformChange[] = [];
        for (let sheet_index = 0; sheet_index < sheets.length; sheet_index += 1) {
            if (this.disposed || this.source_epoch !== source_epoch || is_cancelled()) {
                return undefined;
            }
            const state = states[sheet_index] ?? EMPTY_TRANSFORM;
            const installed = this.transform_states.get(sheet_index) ?? EMPTY_TRANSFORM;
            if (transform_states_equal(installed, state)) continue;
            let result;
            try {
                result = await compute_transform(
                    this.source,
                    sheet_index,
                    state,
                    () => this.disposed
                        || this.source_epoch !== source_epoch
                        || this.receiver_epoch !== receiver_epoch
                        || is_cancelled(),
                    undefined,
                    this.column_analysis_cache,
                    this.changed_grid_rows(sheet_index, state),
                );
            } catch (error) {
                if (
                    error instanceof Error
                    && error.name === 'AbortError'
                    && (
                        this.disposed
                        || this.source_epoch !== source_epoch
                        || this.receiver_epoch !== receiver_epoch
                        || is_cancelled()
                    )
                ) return undefined;
                if (error instanceof InvalidNumericFilterOperandError) {
                    throw new InvalidPersistedTransformError(
                        sheet_index,
                        clone_transform(state),
                        clone_transform(installed),
                        error,
                    );
                }
                throw error;
            }
            if (
                this.disposed
                || this.source_epoch !== source_epoch
                || this.receiver_epoch !== receiver_epoch
                || is_cancelled()
            ) return undefined;
            changes.push({
                sheetIndex: sheet_index,
                state: clone_transform(state),
                ...(result.indices ? { indices: result.indices } : {}),
            });
        }
        return {
            sourceEpoch: source_epoch,
            receiverEpoch: receiver_epoch,
            generation,
            changes,
        };
    }

    /** Install a prepared reconciliation only while its full core basis is stable. */
    commit_transform_reconciliation(
        prepared: PreparedTransformReconciliation,
    ): boolean {
        if (
            this.disposed
            || this.source_epoch !== prepared.sourceEpoch
            || this.receiver_epoch !== prepared.receiverEpoch
            || this._generation !== prepared.generation
        ) return false;
        for (const change of prepared.changes) {
            const mapping_moved = mapping_change_moves_rows(
                this.transform_indices.get(change.sheetIndex),
                change.indices,
            );
            if (change.indices) {
                this.transform_indices.set(change.sheetIndex, change.indices);
            } else {
                this.transform_indices.delete(change.sheetIndex);
            }
            this.inverse_transform_indices.delete(change.sheetIndex);
            this.transform_states.set(change.sheetIndex, clone_transform(change.state));
            this._generation += 1;
            // Recorded after the bump, so the sheet's mapping generation is the one a
            // webview told about this reconciliation would hold — a request quoting it is
            // current for this sheet, and one quoting anything earlier is not. Inside the
            // loop rather than after it because a reconciliation can carry changes for
            // several sheets and bumps once per change: a sheet reconciled first must not
            // inherit the generation of a sheet reconciled after it, or its own stale
            // requests would be accepted.
            //
            // Conditional for the reason given at the other writer of this map, in the
            // `setTransform` install path: a change that leaves the sheet unpermuted on
            // both sides moves no display row, and invalidating one would refuse a resize
            // that is still perfectly current.
            if (mapping_moved) {
                this.sheet_mapping_generations.set(change.sheetIndex, this._generation);
            }
        }
        if (prepared.changes.length > 0) this.clear_row_cache();
        return true;
    }

    /** Reconcile directly for callers that already own a stable external basis. */
    async reconcile_transforms(
        states: readonly (SheetTransformState | undefined)[],
        is_cancelled: () => boolean,
    ): Promise<boolean> {
        const prepared = await this.prepare_transform_reconciliation(
            states,
            is_cancelled,
        );
        return prepared !== undefined
            && this.commit_transform_reconciliation(prepared);
    }

    /**
     * Which of the session's durable pending-edit cells sit in rows this view does
     * not contain — see `SheetViewRecord.hiddenEditedCellKeys` for why this is the
     * only place membership is answerable, and why the answer is keys rather than a
     * count the webview would have no way to correct.
     *
     * Two independent ways a key's row can be absent, and only one of them is about
     * the rules. An enabled filter or an explicit `hiddenRows` drops rows from the
     * permutation, which `indices.length < sheet.rowCount` detects for free. But a
     * key can also name a row the *source* no longer has — an external shrink, the
     * `rowsRemoved` case — and that is true of a permutation that dropped nothing at
     * all, a bare sort included. There used to be a short-circuit here for "no rule
     * excludes rows" and for "the filter matched everything", and both were wrong for
     * exactly that second reason: a filter can match every surviving row while an
     * edited row it was never asked about has vanished from the file. Deliberately
     * covered rather than left to the save-time conflict banner, because that banner
     * only speaks once the user presses Save, and this notice exists to say what is
     * out of sight *before* then — which is also why the copy says the view does not
     * *show* the row rather than that it hides it.
     *
     * So the scan is skipped only when there are no keys to scan. What the length test
     * still buys is the *cost*: when the permutation kept every row, membership in the
     * view reduces to membership in the projection, and `projected_row_for_source`
     * answers that per key without materializing the O(rows) inverse that
     * `display_row_for_source` would. When rows really were dropped there is no
     * shortcut, and `display_row_for_source` reuses the inverse cached beside the
     * indices it inverts: the install that produced those indices has just
     * invalidated the old inverse, so the first lookup costs O(rows) at a moment that
     * was already O(rows), and every lookup after it is O(1).
     *
     * Deliberately reads the *durable* map rather than the live one, which can lag it
     * by the webview's persistence debounce. Over-reporting from that lag — an entry
     * the user has already discarded but whose removal has not been persisted yet — is
     * removed by the webview's intersection against its live dirty map.
     * Under-reporting from it is not benign and is not tolerated either: an edit typed
     * *while* a hiding transform computed was in no durable map when the install read
     * one, and the install then excluded its row, so the "just typed, hence visible"
     * argument does not hold across an install. That direction is answered by
     * recomputing this on every delivery — see `snapshot_material` — rather than only
     * at an install.
     */
    private hidden_edited_cell_keys(
        sheet_index: number,
        sheet: SheetMeta,
        indices: Uint32Array | undefined,
    ): readonly string[] {
        if (!indices || !this.durable_pending_edit_keys) return [];
        const keys = this.durable_pending_edit_keys(sheet_index);
        if (keys.length === 0) return [];
        // Whether the permutation itself left rows out. `rules` is not consulted:
        // whatever an enabled filter or a `hiddenRows` list asked for, what a row's
        // presence actually turns on is whether the indices kept it, and a rule that
        // excluded nothing is indistinguishable from no rule at all.
        const drops_rows = indices.length !== sheet.rowCount;
        const hidden: string[] = [];
        // Several cells in one row ask the same question, and the answer is per row.
        const row_is_present = new Map<number, boolean>();
        for (const key of keys) {
            // Pending edits and cell highlights share one canonical key format, so
            // this is the same parse, refusing the same malformed keys.
            const parsed = parse_cell_highlight_key(key);
            if (!parsed) continue;
            let present = row_is_present.get(parsed.sourceRow);
            if (present === undefined) {
                present = drops_rows
                    ? this.display_row_for_source(sheet_index, parsed.sourceRow)
                        !== undefined
                    // Every kept row is somewhere in the view, so all that is left to
                    // ask is whether the source still projects the row at all — the
                    // cheap half of what `display_row_for_source` does, without the
                    // Int32Array(rows) inverse it would build to answer the other half.
                    //
                    // Cost only, and deliberately so: the two branches must agree
                    // wherever both are defined, and when the permutation kept every
                    // row they do, which is why no test can tell them apart. Probed
                    // both ways: forcing `drops_rows` true fails nothing, forcing it
                    // false fails every filter and hidden-row case in the suite. So the
                    // equivalence is real, and the cheap arm buys an allocation this
                    // question never needed.
                    : projected_row_for_source(
                        this.source,
                        sheet_index,
                        parsed.sourceRow,
                    ) !== undefined;
                row_is_present.set(parsed.sourceRow, present);
            }
            // The key as given rather than rebuilt from the parse. The two coincide
            // today — the parse accepts only canonical keys, so there is nothing to
            // normalize — but the webview matches these against its own dirty map by
            // string, and rebuilding would put that agreement at the mercy of a
            // future relaxation of the parse.
            if (!present) hidden.push(key);
        }
        return hidden;
    }

    /**
     * The durable custom row heights for one sheet, re-keyed into the display space of
     * the view this core holds right now. See `PerFileState.rowHeights` for why the host
     * is the only place this can be computed and why it must travel with the view it
     * describes.
     *
     * Iterates the *overrides*, not the rows, and that is the load-bearing choice: the
     * durable map is sparse and typically holds a handful of entries, while the sheet
     * can hold millions of rows. So the cost is O(overrides) lookups, each O(1) against
     * the inverse index `display_row_for_source` caches beside the permutation it
     * inverts — never O(rows). Walking rows instead would make every delivery on a
     * large sheet linear in the row count for a map that is usually empty.
     *
     * A source row with no display row is dropped rather than recorded anywhere: it has
     * been filtered out, explicitly hidden, or consumed as an Excel promoted header,
     * and there is no display number that would name it. Nothing is lost — the durable
     * map keeps the entry under its source row and the next view containing that row
     * projects it again. This is the whole reason durable heights are source-keyed.
     *
     * Malformed keys are skipped in the same spirit as the pending-edit scan: a
     * non-canonical numeric key names no source row, and `display_row_for_source`
     * refusing it is the check.
     */
    private compute_row_height_projection(
        sheet_index: number,
        overrides: Record<number, number> | undefined,
    ): Readonly<Record<number, number>> | undefined {
        if (!overrides) return undefined;
        let projection: Record<number, number> | undefined;
        for (const [key, height] of Object.entries(overrides)) {
            const source_row = Number(key);
            // `String(source_row) === key` rejects '01', '1.0', '1e0' and ' 1' — the
            // same canonicality test `layout-state-patch.ts` applies to these maps,
            // kept in step so a key the patcher would never have written cannot be
            // honoured here either.
            if (!Number.isSafeInteger(source_row) || String(source_row) !== key) continue;
            if (!Number.isFinite(height)) continue;
            const display_row = this.display_row_for_source(sheet_index, source_row);
            if (display_row === undefined) continue;
            projection ??= {};
            // Clamped on the way out, not merely on the way in. Every *write* path
            // clamps already (`setRowHeights` before it persists, the webview before it
            // paints optimistically), so nothing this version can persist needs this —
            // but the durable map is not something this version wrote. Releases before
            // the bound existed persisted whatever arithmetic produced, and a state file
            // is editable on disk besides, so a map already there can hold a negative, a
            // zero, or a value large enough to make Glide's total-scroll-height sum
            // meaningless.
            //
            // The webview cannot defend itself here: it renders the projection through
            // `resolved_row_height`, which returns an override verbatim, and it has no
            // clamp on that path by design — the optimistic overlay is reconciled against
            // the projection *by value*, so a webview-side clamp would silently disagree
            // with the height the host holds and leave a layer no delivery can ever
            // retire. Clamping at the single point that produces the projection keeps one
            // authority for the value, which is the same reason `clamp_row_height` is one
            // function shared by both sides.
            //
            // Worth being concrete about the floor: a row persisted at zero or a negative
            // height renders with no grabbable edge, so the user cannot drag it back and
            // has no UI that would let them delete the entry — an unrecoverable state
            // reachable from a file, which is exactly what `MIN_ROW_HEIGHT_PX` exists to
            // prevent. The durable entry is deliberately left alone rather than rewritten:
            // this is a read path, a silent durable write from a read is its own hazard,
            // and the next resize of that row persists a clamped value anyway.
            projection[display_row] = clamp_row_height(height);
        }
        // `undefined` rather than `{}` when nothing projected, which is the answer for
        // every sheet nobody has resized — the common case, and one worth not paying
        // per-sheet-per-delivery structured-clone cost for. It also distinguishes "no
        // heights" from "heights that all fell outside this view", though no reader needs
        // that distinction today.
        //
        // Frozen because the memo below hands the identical object to every reader until
        // its key changes, and both readers publish it *by reference*: `snapshot_material`
        // lifts it out of `deep_clone_and_freeze`, and `transform_installed_ack` posts the
        // object itself. A caller that mutated what it got back would be editing the
        // cache, and the mutation would then show up on unrelated later deliveries. The
        // freeze is what makes sharing it safe rather than merely cheap.
        return projection && Object.freeze(projection);
    }

    /**
     * The same answer for every sheet, positionally, so a delivery can carry it without
     * knowing which sheet the user is looking at — see
     * `WorkbookSnapshot.rowHeightProjection`.
     *
     * Per delivery rather than per install, and unlike `hiddenEditedCellKeys` that is not
     * about a lag in observing durable state but about there being no single event to
     * hang it on: the permutation half moves at an install, the durable half moves on a
     * `setRowHeights`, a sibling write, or an excel-header plan edit. Nothing installs on
     * the second kind and nothing delivers on the first, so both carriers exist and each
     * covers what the other cannot.
     *
     * Memoized, and the memo is about *pre-existing* data rather than about this
     * projection being expensive. It is O(overrides), which is a handful of entries for
     * any map this version could have written — `MAX_PERSISTED_ROW_HEIGHTS` bounds it.
     * But releases before that bound existed could persist a select-all map, so a file on
     * disk may already hold millions of entries, and a bound applied only to new writes
     * does nothing about a per-delivery walk over what is already there. Recomputing that
     * on every scroll-triggered delivery is the cost the memo removes; without it the
     * bound is a bound on nothing.
     *
     * The memo is only worth having if the delivery path stops copying what it returns, so
     * it does: `snapshot_material` shares this frozen value by reference, and
     * `build_workbook_snapshot` passes it through untouched. What remains per delivery for
     * a pathological pre-cap legacy map is exactly *one* structured clone — the
     * `postMessage` to the webview, which no host-side change can avoid. That is **below**
     * the pre-PR baseline rather than merely level with it: before this PR the same map
     * crossed the bridge as `state.rowHeights` on every delivery, and that field is no
     * longer sent at all (see `NormalizedPerFileState`). One copy replaces one copy, and
     * the walk that produced it is now memoized.
     *
     * The key is exactly the pair the answer is a function of. `generation` covers the
     * permutation half — every install and every `adopt_source` bumps it, and those are
     * the only things that move a source row to a different display row. The durable state
     * `revision` covers the height half, since every writer of the map lands as a new
     * revision and none of them bumps a generation. Neither alone is sufficient, which is
     * why the earlier "recompute always" was the safe shape to start from.
     */
    private row_height_projection_by_sheet(): readonly (
        Readonly<Record<number, number>> | undefined
    )[] {
        const sheets = this.source.meta().sheets;
        // No provider means no durable state to read at all (a test core, or a caller
        // with none), so every projection is empty forever. Keyed at revision -1, which
        // no real state revision can equal, so this cannot be confused with a real read.
        const durable = this.durable_row_heights?.(sheets.map((sheet) => sheet.name))
            ?? { revision: -1, heights: [] };
        const memo = this.row_height_projection_memo;
        if (
            memo
            && memo.generation === this._generation
            && memo.revision === durable.revision
        ) return memo.by_sheet;
        const by_sheet = Object.freeze(sheets.map((_sheet, sheet_index) => (
            this.memoized_row_height_projection(
                sheet_index,
                durable.heights[sheet_index],
            )
        )));
        this.row_height_projection_memo = {
            generation: this._generation,
            revision: durable.revision,
            by_sheet,
        };
        return by_sheet;
    }

    /**
     * One sheet's projection, recomputed only when a fact *that sheet's* answer depends
     * on has moved.
     *
     * The outer memo above is keyed core-wide, and that is too coarse for the one input
     * size this design has to stay honest about. A pre-cap legacy map can hold millions
     * of entries, and the outer key moves on events that cannot have changed this sheet's
     * answer: `_generation` rises when *any* sheet installs or clears a transform, and
     * `revision` rises on *any* durable write to the file — a column resize, a scroll
     * position, a sibling sheet's heights. Sorting sheet B would then synchronously walk
     * and reallocate sheet A's million-entry projection, on the acknowledgement path,
     * having changed nothing about it.
     *
     * The per-sheet key is the same pair narrowed to this sheet. `mapping_generation` is
     * the permutation half — it is by construction the generation at which this sheet's
     * display→source mapping last moved, so a core-wide bump that left this sheet alone
     * does not move it. The durable half is narrowed by *identity* rather than by number:
     * `revision` is file-wide with no per-sheet counterpart, but the height map handed in
     * is shared by reference all the way from the latch (`durable_row_heights` normalizes
     * into an array without copying the maps), so an unchanged `source` is the proof that
     * this sheet's durable heights did not move even though some other field did.
     *
     * The revision is deliberately *not* compared beside the identity, and that is the
     * narrowing that does the work rather than an omission: comparing it too would rebuild
     * every sheet on any file-wide write, which is exactly the cost this exists to remove.
     * Identity is the stronger fact of the two here — the maps are immutable durable state
     * republished as a new object by every writer, so equal identity means equal content,
     * while equal revision would only mean nobody wrote anything at all.
     *
     * Both halves are required and neither implies the other: heights change under a fixed
     * permutation on every resize, and the permutation changes under fixed heights on
     * every install.
     */
    private memoized_row_height_projection(
        sheet_index: number,
        source: Record<number, number> | undefined,
    ): Readonly<Record<number, number>> | undefined {
        const mapping_generation = this.mapping_generation(sheet_index);
        const cached = this.row_height_projection_per_sheet.get(sheet_index);
        if (
            cached
            && cached.mapping_generation === mapping_generation
            && cached.source === source
        ) return cached.projection;
        const projection = this.compute_row_height_projection(sheet_index, source);
        this.row_height_projection_per_sheet.set(sheet_index, {
            mapping_generation,
            source,
            projection,
        });
        return projection;
    }

    /** One sheet's entry of the memoized projection. */
    private row_height_projection(
        sheet_index: number,
    ): Readonly<Record<number, number>> | undefined {
        return this.row_height_projection_by_sheet()[sheet_index];
    }

    /**
     * The same answer for every sheet, positionally, so a delivery can carry it
     * without knowing which sheet the user is looking at.
     *
     * This is the *additive* half of keeping the notice honest, and it needs a
     * per-delivery answer rather than a per-install one. Membership changes only at an
     * install, but the durable map this reads changes on its own — and an edit typed
     * while a hiding transform was still computing reaches the durable map only
     * *after* the install that excluded its row, so no install will ever name it. The
     * webview's intersection against its live dirty map cannot add it back; that
     * subtracts. Recomputing here, on the delivery `pendingEditsChanged` already
     * triggers, is what adds it.
     */
    private hidden_edited_cell_keys_by_sheet(): readonly (readonly string[])[] {
        return this.source.meta().sheets.map((sheet, sheet_index) => (
            this.hidden_edited_cell_keys(
                sheet_index,
                sheet,
                this.transform_indices.get(sheet_index),
            )
        ));
    }

    /**
     * Describe the view this core holds for a sheet *right now*. Every install
     * acknowledgement is built from this after the mutation, so the record and the
     * core cannot disagree about what was installed.
     *
     * Which arm of `SheetViewRecord` is decided by whether an index permutation is
     * held, and that is the whole reason the two row-describing fields are unwritable
     * on the other one: with no permutation there are no rules describing these rows
     * and no row the view fails to show, so there is nothing here to fabricate and
     * nothing a retaining webview can later misread. See the type's doc.
     *
     * Deliberately carries no row-height projection. It would be a fact about these rows
     * by its keys, but it is a join with durable state that moves on its own, so a
     * retained record would hold a copy going stale on an unchanged basis — the field
     * class the record's shape exists to exclude. It rides `transformInstalled` beside
     * this record instead, exactly as `rules` does.
     */
    private installed_view(sheet_index: number, sheet: SheetMeta): SheetViewRecord {
        const basis = {
            generation: this._generation,
            sourceGeneration: this._source_generation,
            schema: transform_schema_for_sheet(sheet),
        };
        const indices = this.transform_indices.get(sheet_index);
        if (!indices) return { basis, permuted: false, rowCount: sheet.rowCount };
        return {
            basis,
            permuted: true,
            // The fallback is unreachable rather than defensive: indices and state are
            // written in the same statement pair, and indices are only ever written for
            // a state `compute_transform` found active. EMPTY_TRANSFORM rather than a
            // cast so the unreachable case stays a value the readers can handle.
            rules: clone_transform(
                this.transform_states.get(sheet_index) ?? EMPTY_TRANSFORM,
            ),
            rowCount: indices.length,
            // Every install arm builds its record here, including the two no-op
            // equal-state acks, so none of them can answer this with a stale set.
            hiddenEditedCellKeys: this.hidden_edited_cell_keys(
                sheet_index,
                sheet,
                indices,
            ),
        };
    }

    /**
     * The install acknowledgement for a sheet, in one place so the view and the rules
     * beside it are read from this core in the same tick and cannot disagree.
     *
     * The rules ride the message rather than the record because they are the host's
     * durable intent for the sheet, not a fact about the rows the view contains — see
     * `HostMessage`'s `transformInstalled` arm. `rowHeights` rides it for a related but
     * distinct reason: it *is* keyed in this view's display space, but it is a join with
     * durable state that moves independently, so a record retained across a same-basis
     * refresh would hold a projection that has since gone stale. A message is read once.
     *
     * Both are read from this core in the same tick as the view, which is what makes the
     * three of them consistent: the display keys in `rowHeights` are the display keys of
     * the permutation `view` describes, because there was no await between reading them.
     */
    private transform_installed_ack(
        msg: SetTransformMessage,
        sheet: SheetMeta,
    ): Extract<HostMessage, { type: 'transformInstalled' }> {
        const rules = this.transform_states.get(msg.sheetIndex);
        return {
            type: 'transformInstalled',
            sheetIndex: msg.sheetIndex,
            requestId: msg.requestId,
            intent: msg.intent,
            view: this.installed_view(msg.sheetIndex, sheet),
            rules: transform_has_entries(rules)
                ? clone_transform(rules!)
                : undefined,
            // `{}` rather than `undefined` when nothing projects, unlike the snapshot
            // field. A snapshot's per-sheet array is one entry per sheet on every
            // delivery, so "absent" is worth distinguishing there; this is one value on
            // one message about one sheet, and the reader has to install *something* as
            // the sheet's projection, so an always-present map is one branch fewer at the
            // only site that consumes it.
            rowHeights: this.row_height_projection(msg.sheetIndex) ?? {},
            mappingGeneration: this.mapping_generation(msg.sheetIndex),
        };
    }

    private async handle_set_transform(
        msg: SetTransformMessage,
    ): Promise<void> {
        const receiver_epoch = this.receiver_epoch;
        const sheet = this.source.meta().sheets[msg.sheetIndex];
        if (!sheet) {
            await this.post_transform_refusal(
                msg,
                `Sheet index ${msg.sheetIndex} is out of range.`,
                'terminal',
                receiver_epoch,
            );
            return;
        }
        if (msg.sourceGeneration !== this._source_generation) {
            await this.post_transform_refusal(
                msg,
                'The source changed before this table view request arrived.',
                'terminal',
                receiver_epoch,
            );
            return;
        }
        if (
            transform_has_entries(msg.state)
            && msg.state.schema !== transform_schema_for_sheet(sheet)
        ) {
            await this.post_transform_refusal(
                msg,
                'The saved table view no longer matches this sheet.',
                'terminal',
                receiver_epoch,
            );
            return;
        }

        const installed_state = this.transform_states.get(msg.sheetIndex);
        if (
            msg.intent === 'restore'
            && installed_state
            && transform_states_equal(installed_state, msg.state)
        ) {
            // A no-op ack, and truthfully an install: the view the record describes
            // is the one already in place, on an unmoved generation.
            await this.post(
                this.transform_installed_ack(msg, sheet),
                receiver_epoch,
            );
            return;
        }
        if (
            msg.intent === 'cancel'
            && installed_state
            && transform_states_equal(installed_state, msg.state)
        ) {
            const operation_token = allocate_transform_operation_token();
            this.transform_operations.set(msg.sheetIndex, operation_token);
            const source_epoch = this.source_epoch;
            this.transforms_in_flight.set(msg.sheetIndex, operation_token);
            const source_request_is_current = () =>
                this.source_epoch !== source_epoch
                    ? false
                    : this.transform_operations.get(msg.sheetIndex) === operation_token;
            const receiver_is_current = () => this.receiver_epoch === receiver_epoch;
            try {
                if (!source_request_is_current() || !receiver_is_current()) return;
                await this.on_transform_commit?.(
                    msg,
                    clone_transform(msg.state),
                    receiver_epoch,
                );
                if (!source_request_is_current()) return;
                await this.post(
                    this.transform_installed_ack(msg, sheet),
                    receiver_epoch,
                );
            } catch (error) {
                if (!source_request_is_current()) return;
                // Two failures, opposite answers. A lapsed commit admission means an
                // edit phase moved under this request and will move back, so asking
                // again is precisely what fixes it. Any other persistence failure
                // changed nothing and will change nothing by being repeated.
                await this.post_transform_refusal(
                    msg,
                    error instanceof Error ? error.message : String(error),
                    error instanceof TransformAdmissionLapsedError
                        ? 'transient'
                        : 'terminal',
                    receiver_epoch,
                );
            } finally {
                if (this.transform_operations.get(msg.sheetIndex) === operation_token) {
                    this.transforms_in_flight.delete(msg.sheetIndex);
                }
            }
            return;
        }

        const operation_token = allocate_transform_operation_token();
        this.transform_operations.set(msg.sheetIndex, operation_token);
        const source_epoch = this.source_epoch;
        this.transforms_in_flight.set(msg.sheetIndex, operation_token);
        const source_request_is_current = () => this.source_epoch === source_epoch
            && this.transform_operations.get(msg.sheetIndex) === operation_token;
        const receiver_is_current = () => this.receiver_epoch === receiver_epoch;
        const compute_is_cancelled = () =>
            !source_request_is_current() || !receiver_is_current();

        try {
            const result = await compute_transform(
                this.source,
                msg.sheetIndex,
                msg.state,
                compute_is_cancelled,
                undefined,
                this.column_analysis_cache,
                this.changed_grid_rows(msg.sheetIndex, msg.state),
            );
            if (compute_is_cancelled()) return;

            // Transform preferences are host-owned. In particular, an explicit
            // Cancel must be durably recorded before its terminal acknowledgement
            // so close/reopen cannot resurrect the cancelled restore.
            await this.on_transform_commit?.(
                msg,
                clone_transform(msg.state),
                receiver_epoch,
            );
            if (
                !source_request_is_current()
                || (msg.intent === 'restore' && !receiver_is_current())
            ) return;

            const mapping_moved = mapping_change_moves_rows(
                this.transform_indices.get(msg.sheetIndex),
                result.indices,
            );
            if (result.indices) {
                this.transform_indices.set(msg.sheetIndex, result.indices);
            } else {
                this.transform_indices.delete(msg.sheetIndex);
            }
            this.inverse_transform_indices.delete(msg.sheetIndex);
            this.transform_states.set(msg.sheetIndex, clone_transform(msg.state));
            this._generation += 1;
            // This sheet's mapping moved and no other sheet's did; see
            // `mapping_generation`. Recorded after the bump so it names the generation the
            // ack below carries, which is the earliest generation a display-keyed request
            // for this sheet may quote from now on.
            //
            // Conditional because the core-wide generation and the per-sheet mapping
            // generation answer different questions. Installing a transform that produces
            // no permutation over a sheet that had none — a filter added but left disabled,
            // say — changes the *rules* and so must bump `_generation`, but display row `r`
            // is still source row `r`. Bumping here too would refuse an in-flight resize
            // whose display rows are still exactly right, and the webview, told the mapping
            // moved, would discard the optimistic layer with it: the row springs back and
            // nothing was ever wrong with it.
            if (mapping_moved) {
                this.sheet_mapping_generations.set(msg.sheetIndex, this._generation);
            }
            this.clear_row_cache();
            // Built after the mutation above, so the record's basis carries the
            // bumped generation and its rules/rowCount/permuted come from what was
            // actually installed rather than from what was asked for.
            await this.post(
                this.transform_installed_ack(msg, sheet),
                receiver_epoch,
            );
        } catch (error) {
            if (
                !source_request_is_current()
                || (msg.intent === 'restore' && !receiver_is_current())
            ) {
                return;
            }
            const previous = this.transform_states.get(msg.sheetIndex)
                ?? EMPTY_TRANSFORM;
            const persisted_error = error instanceof InvalidNumericFilterOperandError
                ? new InvalidPersistedTransformError(
                    msg.sheetIndex,
                    clone_transform(msg.state),
                    clone_transform(previous),
                    error,
                )
                : undefined;
            let recovered = false;
            if (msg.intent === 'restore' && persisted_error && this.on_invalid_restore) {
                try {
                    recovered = await this.on_invalid_restore(
                        msg,
                        persisted_error,
                        receiver_epoch,
                    );
                } catch {
                    // The original typed validation failure remains the useful
                    // user-facing result; the controller logs persistence errors.
                }
            }
            if (
                !source_request_is_current()
                || (msg.intent === 'restore' && !receiver_is_current())
            ) return;
            if (recovered) {
                // The controller dropped the invalid saved transform durably, so
                // there is nothing left to warn about: the view that stands is the
                // one already installed, and saying so as an install is what stops
                // the restore effect asking for the dropped rules again.
                await this.post(
                    this.transform_installed_ack(msg, sheet),
                    receiver_epoch,
                );
            } else {
                // As in the equal-state arm above: a lapsed commit admission is a
                // phase that ends on its own, so the request stays retriable, while a
                // validation or persistence failure is terminal and repeating it only
                // fails again.
                await this.post_transform_refusal(
                    msg,
                    error instanceof Error ? error.message : String(error),
                    error instanceof TransformAdmissionLapsedError
                        ? 'transient'
                        : 'terminal',
                    receiver_epoch,
                );
            }
        } finally {
            if (this.transform_operations.get(msg.sheetIndex) === operation_token) {
                this.transforms_in_flight.delete(msg.sheetIndex);
            }
        }
    }

    /**
     * `'transient'` says the refusal will clear on its own and the request is worth
     * retrying; `'terminal'` is a validation refusal, which the webview answers by
     * keeping the view it already has and not asking again. The caller must say
     * which — see `TransformRefusalDisposition`.
     */
    reject_transform(
        msg: SetTransformMessage,
        error: string,
        disposition: TransformRefusalDisposition,
    ): Promise<boolean> {
        return this.post_transform_refusal(
            msg,
            error,
            disposition,
            this.receiver_epoch,
        );
    }

    /**
     * Nothing changed, so nothing about the view is sent. The refusal deliberately
     * cannot describe a state, a generation or a row count — a refusal that could
     * would be adopted as one, which is the bug class this split removes.
     *
     * `disposition` sits ahead of `receiver_epoch` so it can be required: the choice
     * between "ask again" and "give up" is never a sensible default.
     */
    private post_transform_refusal(
        msg: SetTransformMessage,
        reason: string,
        disposition: TransformRefusalDisposition,
        receiver_epoch = this.receiver_epoch,
    ): Promise<boolean> {
        return this.post({
            type: 'transformRefused',
            sheetIndex: msg.sheetIndex,
            requestId: msg.requestId,
            intent: msg.intent,
            reason,
            terminal: disposition === 'terminal',
        }, receiver_epoch);
    }

    private async handle_row_request(
        msg: Extract<WebviewMessage, { type: 'requestRows' }>,
    ): Promise<void> {
        // Generation guard: silently drop requests for a superseded version.
        if (msg.generation !== this._generation) return;
        const receiver_epoch = this.receiver_epoch;

        // Boundary validation: clamp a negative startRow to 0. (CSV clamps
        // internally; xlsx/xls pass through to the store — validate here so the
        // contract is uniform regardless of source.)
        const start_row = Math.max(0, msg.startRow);

        const key = `${msg.sheetIndex}:${start_row}:${msg.count}`;
        const cached = this.cache.get(key);
        let window: TransformedRowWindow;
        if (cached !== undefined) {
            window = cached.window;
            // LRU touch: re-insert to mark most-recently-used.
            this.cache.delete(key);
            this.cache.set(key, cached);
        } else {
            try {
                window = transformed_window(
                    this.source,
                    msg.sheetIndex,
                    start_row,
                    msg.count,
                    this.transform_indices.get(msg.sheetIndex),
                );
            } catch {
                // A source can throw (e.g. RangeError for an out-of-range
                // sheetIndex). Answer with an empty window instead of leaving the
                // webview's request unresolved. The error is deterministic for a
                // given key, so caching the empty result is safe.
                window = { startRow: start_row, rows: [], sourceRows: [] };
            }
            const weight = this.row_window_weight(window);
            this.cache.set(key, { window, ...weight });
            this.cached_row_cells += weight.cells;
            this.cached_row_bytes += weight.bytes;
            this.evict_excess();
        }

        const posted = await this.post({
            type: 'rowData',
            sheetIndex: msg.sheetIndex,
            startRow: window.startRow,
            rows: window.rows,
            sourceRows: window.sourceRows,
            requestId: msg.requestId,
            generation: this._generation,
        }, receiver_epoch);
        if (!posted || this.disposed || this.receiver_epoch !== receiver_epoch) return;
        await this.on_row_window_served?.(msg, {
            startRow: window.startRow,
            sourceRows: window.sourceRows,
        }, receiver_epoch);
    }

    private row_window_weight(window: TransformedRowWindow): {
        cells: number;
        bytes: number;
    } {
        const cells = window.rows.reduce((total, row) => total + row.length, 0);
        const bytes = window.rows.reduce(
            (row_total, row) => row_total + row.reduce((cell_total, cell) => {
                if (cell === null) return cell_total + 8;
                const raw_length = String(cell.raw ?? '').length;
                return cell_total + 64 + 2 * (raw_length + cell.formatted.length);
            }, 0),
            0,
        );
        return { cells, bytes };
    }

    private clear_row_cache(): void {
        this.cache.clear();
        this.cached_row_cells = 0;
        this.cached_row_bytes = 0;
    }

    private evict_excess(): void {
        while (
            this.cache.size > this.max_cached_pages
            || this.cached_row_cells > DEFAULT_MAX_CACHED_ROW_CELLS
            || this.cached_row_bytes > DEFAULT_MAX_CACHED_ROW_BYTES
        ) {
            // Map preserves insertion order; the first key is least-recently-used.
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            const entry = this.cache.get(oldest)!;
            this.cached_row_cells -= entry.cells;
            this.cached_row_bytes -= entry.bytes;
            this.cache.delete(oldest);
        }
    }

    private post(message: HostMessage, receiver_epoch?: number): Promise<boolean> {
        if (
            this.disposed
            || (receiver_epoch !== undefined && receiver_epoch !== this.receiver_epoch)
        ) return Promise.resolve(false);
        return Promise.resolve(this.panel.webview.postMessage(message));
    }
}

/**
 * Whether replacing a sheet's permutation with `next` moves any display row.
 *
 * The only case answered `false` is absent → absent: with no permutation on either side
 * display row `r` is source row `r` before and after, so every display-keyed thing —
 * a queued resize, a row-height overlay — still names the row it meant. Anything else is
 * reported as moved. Two identical index arrays would also leave rows in place, but they
 * are not compared: the check would be O(rows) on a path that runs per install, and the
 * cost of a false "moved" is one discarded overlay while the cost of a false "unmoved" is
 * a height silently landing on the wrong row.
 */
function mapping_change_moves_rows(
    previous: Uint32Array | undefined,
    next: Uint32Array | undefined,
): boolean {
    return previous !== undefined || next !== undefined;
}

function clone_transform(state: SheetTransformState): SheetTransformState {
    const clone: SheetTransformState = {
        sort: state.sort.map((key) => ({ ...key })),
        filters: state.filters.map(clone_filter_entry),
    };
    if (state.hiddenRows) clone.hiddenRows = [...state.hiddenRows];
    if (state.onlyChangedRows) clone.onlyChangedRows = true;
    if (state.schema !== undefined) clone.schema = state.schema;
    return clone;
}

export function clone_filter_entry(entry: FilterEntry): FilterEntry {
    return entry.excludedValues
        ? { ...entry, excludedValues: [...entry.excludedValues] }
        : { ...entry };
}

/**
 * Adopt a freshly-built source or same-object logical projection into a panel's
 * core: close a distinct previous source after installation, or create the initial
 * core at generation/sourceGeneration 1. Every panel (csv/preview/custom-editor)
 * shares this close + create-or-swap dance, so it lives here rather than being
 * re-implemented in each panel's `adopt`. Installation is explicit: a disposed
 * core refuses the source, and the previous source closes only after the new
 * source is installed and `on_installed` has transferred controller ownership.
 */
export type AdoptSourceIntoCoreResult =
    | { type: 'adopted'; core: ViewerPanelCore }
    | { type: 'refused' };

export function adopt_source_into_core(
    core: ViewerPanelCore | undefined,
    panel: PanelLike,
    previous: DataSource | undefined,
    next: DataSource,
    opts?: {
        onTransformCommit?: TransformCommit;
        onInvalidRestore?: InvalidRestoreCleanup;
        durablePendingEditKeys?: (sheet_index: number) => readonly string[];
        durableRowHeights?: DurableRowHeightsProvider;
        onRowWindowServed?: RowWindowServed;
    },
    on_installed?: (installed: ViewerPanelCore) => void,
): AdoptSourceIntoCoreResult {
    let installed: ViewerPanelCore;
    if (core) {
        if (core.adopt_source(next).type === 'refused') return { type: 'refused' };
        installed = core;
    } else {
        installed = new ViewerPanelCore(panel, next, opts);
    }
    on_installed?.(installed);
    if (previous && previous !== next) previous.close();
    return { type: 'adopted', core: installed };
}

/** Compare transform descriptors by their ordered semantic fields. */
export function transform_states_equal(
    left: SheetTransformState,
    right: SheetTransformState,
): boolean {
    if (
        left.sort.length === 0
        && left.filters.length === 0
        && (left.hiddenRows?.length ?? 0) === 0
        && left.onlyChangedRows !== true
        && right.sort.length === 0
        && right.filters.length === 0
        && (right.hiddenRows?.length ?? 0) === 0
        && right.onlyChangedRows !== true
    ) return true;
    return left.schema === right.schema
        && (left.onlyChangedRows === true) === (right.onlyChangedRows === true)
        && left.sort.length === right.sort.length
        && left.sort.every((key, index) => (
            key.colIndex === right.sort[index].colIndex
            && key.direction === right.sort[index].direction
        ))
        && array_values_equal(left.hiddenRows, right.hiddenRows)
        && left.filters.length === right.filters.length
        && left.filters.every((entry, index) => {
            const candidate = right.filters[index];
            return entry.id === candidate.id
                && entry.colIndex === candidate.colIndex
                && entry.operator === candidate.operator
                && entry.value === candidate.value
                && entry.secondValue === candidate.secondValue
                && excluded_values_equal(entry.excludedValues, candidate.excludedValues)
                && entry.caseSensitive === candidate.caseSensitive
                && entry.enabled === candidate.enabled;
        });
}

function array_values_equal(
    left: readonly number[] | undefined,
    right: readonly number[] | undefined,
): boolean {
    if ((left?.length ?? 0) === 0 && (right?.length ?? 0) === 0) return true;
    return !!left && !!right
        && left.length === right.length
        && left.every((value, index) => value === right[index]);
}

function excluded_values_equal(
    left: readonly (string | null)[] | undefined,
    right: readonly (string | null)[] | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}
