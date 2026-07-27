import type { DataSource, SheetMeta } from './data-source/interface';
import {
    projected_row_for_source,
    read_source_row_indices,
} from './data-source/interface';
import { parse_cell_highlight_key } from './cell-highlights';
import { deep_clone_and_freeze } from './immutable';
import { compute_column_histogram, type ColumnHistogram } from './histograms';
import {
    compute_transform,
    InvalidNumericFilterOperandError,
    transformed_window,
    type CachedTransformColumn,
    type TransformColumnCache,
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
        postMessage(message: unknown): Thenable<boolean> | Promise<boolean> | boolean;
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

type TransformOperationToken = number;
let next_transform_operation_token = 0;

function allocate_transform_operation_token(): TransformOperationToken {
    next_transform_operation_token += 1;
    return next_transform_operation_token;
}

const DEFAULT_MAX_CACHED_PAGES = 64;
const DEFAULT_MAX_CACHED_TRANSFORM_CELLS = 1_000_000;

class TransformColumnLruCache implements TransformColumnCache {
    private readonly entries = new Map<string, CachedTransformColumn>();
    private retained_cells = 0;

    constructor(private readonly max_cells: number) {}

    get(sheet_index: number, column_index: number): CachedTransformColumn | undefined {
        const key = `${sheet_index}:${column_index}`;
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry;
    }

    set(
        sheet_index: number,
        column_index: number,
        column: CachedTransformColumn,
    ): void {
        const cells = column.values.length;
        if (cells > this.max_cells || this.max_cells <= 0) return;
        const key = `${sheet_index}:${column_index}`;
        const previous = this.entries.get(key);
        if (previous) {
            this.retained_cells -= previous.values.length;
            this.entries.delete(key);
        }
        while (
            this.retained_cells + cells > this.max_cells
            && this.entries.size > 0
        ) {
            const oldest_key = this.entries.keys().next().value as string;
            const oldest = this.entries.get(oldest_key)!;
            this.entries.delete(oldest_key);
            this.retained_cells -= oldest.values.length;
        }
        this.entries.set(key, column);
        this.retained_cells += cells;
    }

    clear(): void {
        this.entries.clear();
        this.retained_cells = 0;
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
    private readonly cache = new Map<string, TransformedRowWindow>();
    private readonly max_cached_pages: number;
    private readonly transform_column_cache: TransformColumnLruCache;
    private readonly transform_indices = new Map<number, Uint32Array>();
    /** Projected source-row -> display-row, built lazily for transformed views. */
    private readonly inverse_transform_indices = new Map<number, Int32Array>();
    private readonly transform_states = new Map<number, SheetTransformState>();
    private readonly transform_operations = new Map<number, TransformOperationToken>();
    private readonly transforms_in_flight = new Map<number, TransformOperationToken>();
    private readonly histogram_cache = new Map<string, ColumnHistogram>();
    private readonly histogram_operations = new Map<string, TransformOperationToken>();
    private source_epoch = 0;
    private receiver_epoch = 0;
    private _source_generation = 1;
    private disposed = false;
    private readonly on_transform_commit?: TransformCommit;
    private readonly on_invalid_restore?: InvalidRestoreCleanup;
    private readonly durable_pending_edit_keys?: () => readonly string[];
    private readonly durable_row_heights?: () => readonly (
        Record<number, number> | undefined
    )[];

    constructor(
        private readonly panel: PanelLike,
        private source: DataSource,
        opts?: {
            maxCachedPages?: number;
            maxCachedTransformCells?: number;
            onTransformCommit?: TransformCommit;
            onInvalidRestore?: InvalidRestoreCleanup;
            /**
             * Canonical `"sourceRow:sourceColumn"` keys of the durable pending edits
             * the current edit session owns. The core owns view membership and the
             * authority layer owns the dirty map, so `hiddenEditedCellKeys` needs
             * both; absent (Excel, or any caller with no edit sessions) it is always
             * empty.
             */
            durablePendingEditKeys?: () => readonly string[];
            /**
             * The durable per-sheet custom row heights, keyed by canonical source row.
             * Same division of labour as `durablePendingEditKeys` and the same reason
             * for the injection: the core owns the projection and the permutation, the
             * authority layer owns durable state, and `rowHeights` needs both. Absent
             * (a test core, or any caller with no durable state to read) every
             * projection is empty, which renders as "no row has a custom height" —
             * the correct answer for a file that has none.
             */
            durableRowHeights?: () => readonly (Record<number, number> | undefined)[];
        },
    ) {
        this.max_cached_pages = opts?.maxCachedPages ?? DEFAULT_MAX_CACHED_PAGES;
        this.transform_column_cache = new TransformColumnLruCache(
            opts?.maxCachedTransformCells ?? DEFAULT_MAX_CACHED_TRANSFORM_CELLS,
        );
        this.on_transform_commit = opts?.onTransformCommit;
        this.on_invalid_restore = opts?.onInvalidRestore;
        this.durable_pending_edit_keys = opts?.durablePendingEditKeys;
        this.durable_row_heights = opts?.durableRowHeights;
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
        this.transform_states.clear();
        this.transform_operations.clear();
        this.transforms_in_flight.clear();
        this.histogram_cache.clear();
        this.histogram_operations.clear();
        this.transform_column_cache.clear();
        this.cache.clear();
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
        return deep_clone_and_freeze({
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
                // Immediately beside the keys above because it needs the identical
                // argument and nothing weaker. Both are display-space answers about one
                // specific permutation, so both are safe only if read in the same instant
                // as the generation that identifies it. The consequence of getting it
                // wrong differs, though, and the height projection's is worse: stale
                // hidden keys over-report unsaved work the user can actually see, while a
                // projection read against another permutation renders every custom height
                // on a different row, silently and durably-looking.
                rowHeightProjection: this.row_height_projection_by_sheet(),
            },
            diagnostics: {
                truncationMessage: this.source.truncationMessage ?? null,
            },
        });
    }

    /** Permanently stop work and suppress all later protocol messages. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancel_pending();
        this.transform_indices.clear();
        this.inverse_transform_indices.clear();
        this.transform_states.clear();
        this.histogram_cache.clear();
        this.transform_column_cache.clear();
        this.cache.clear();
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
            );
            if (is_cancelled()) return;
            if (!cached) this.histogram_cache.set(cache_key, histogram);
            await this.post({
                type: 'filterHistogram',
                sheetIndex: msg.sheetIndex,
                columnIndex: msg.columnIndex,
                bins: histogram.bins,
                columnKind: histogram.columnKind,
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
                    this.transform_column_cache,
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
            if (change.indices) {
                this.transform_indices.set(change.sheetIndex, change.indices);
            } else {
                this.transform_indices.delete(change.sheetIndex);
            }
            this.inverse_transform_indices.delete(change.sheetIndex);
            this.transform_states.set(change.sheetIndex, clone_transform(change.state));
            this._generation += 1;
        }
        if (prepared.changes.length > 0) this.cache.clear();
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
        const keys = this.durable_pending_edit_keys();
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
    /**
     * The durable custom row heights for a sheet, re-keyed into the display space of
     * the view this core holds right now. See `SheetViewRecord.rowHeights` for why the
     * host is the only place this can be computed and why it must travel with the view
     * it describes.
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
    private row_height_projection(
        sheet_index: number,
    ): Record<number, number> | undefined {
        const overrides = this.durable_row_heights?.()[sheet_index];
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
            projection[display_row] = height;
        }
        // `undefined` rather than `{}` when nothing projected, which is the answer for
        // every sheet nobody has resized — the common case, and one worth not paying
        // per-sheet-per-delivery structured-clone cost for. It also distinguishes "no
        // heights" from "heights that all fell outside this view", though no reader needs
        // that distinction today.
        return projection;
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
     */
    private row_height_projection_by_sheet(): readonly (
        Record<number, number> | undefined
    )[] {
        return this.source.meta().sheets.map((_sheet, sheet_index) => (
            this.row_height_projection(sheet_index)
        ));
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
                this.transform_column_cache,
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

            if (result.indices) {
                this.transform_indices.set(msg.sheetIndex, result.indices);
            } else {
                this.transform_indices.delete(msg.sheetIndex);
            }
            this.inverse_transform_indices.delete(msg.sheetIndex);
            this.transform_states.set(msg.sheetIndex, clone_transform(msg.state));
            this._generation += 1;
            this.cache.clear();
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

        // Boundary validation: clamp a negative startRow to 0. (CSV clamps
        // internally; xlsx/xls pass through to the store — validate here so the
        // contract is uniform regardless of source.)
        const start_row = Math.max(0, msg.startRow);

        const key = `${msg.sheetIndex}:${start_row}:${msg.count}`;
        let window = this.cache.get(key);
        if (window !== undefined) {
            // LRU touch: re-insert to mark most-recently-used.
            this.cache.delete(key);
            this.cache.set(key, window);
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
            this.cache.set(key, window);
            this.evict_excess();
        }

        await this.post({
            type: 'rowData',
            sheetIndex: msg.sheetIndex,
            startRow: window.startRow,
            rows: window.rows,
            sourceRows: window.sourceRows,
            requestId: msg.requestId,
            generation: this._generation,
        });
    }

    private evict_excess(): void {
        while (this.cache.size > this.max_cached_pages) {
            // Map preserves insertion order; the first key is least-recently-used.
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
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

function clone_transform(state: SheetTransformState): SheetTransformState {
    const clone: SheetTransformState = {
        sort: state.sort.map((key) => ({ ...key })),
        filters: state.filters.map(clone_filter_entry),
    };
    if (state.hiddenRows) clone.hiddenRows = [...state.hiddenRows];
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
        durablePendingEditKeys?: () => readonly string[];
        durableRowHeights?: () => readonly (Record<number, number> | undefined)[];
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
        && right.sort.length === 0
        && right.filters.length === 0
        && (right.hiddenRows?.length ?? 0) === 0
    ) return true;
    return left.schema === right.schema
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
