import type { DataSource } from './data-source/interface';
import {
    projected_row_for_source,
    read_source_row_indices,
} from './data-source/interface';
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

    constructor(
        private readonly panel: PanelLike,
        private source: DataSource,
        opts?: {
            maxCachedPages?: number;
            maxCachedTransformCells?: number;
            onTransformCommit?: TransformCommit;
            onInvalidRestore?: InvalidRestoreCleanup;
        },
    ) {
        this.max_cached_pages = opts?.maxCachedPages ?? DEFAULT_MAX_CACHED_PAGES;
        this.transform_column_cache = new TransformColumnLruCache(
            opts?.maxCachedTransformCells ?? DEFAULT_MAX_CACHED_TRANSFORM_CELLS,
        );
        this.on_transform_commit = opts?.onTransformCommit;
        this.on_invalid_restore = opts?.onInvalidRestore;
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

    private async handle_set_transform(
        msg: SetTransformMessage,
    ): Promise<void> {
        const receiver_epoch = this.receiver_epoch;
        const sheet = this.source.meta().sheets[msg.sheetIndex];
        if (!sheet) {
            await this.post({
                type: 'transformApplied',
                sheetIndex: msg.sheetIndex,
                state: this.transform_states.get(msg.sheetIndex) ?? EMPTY_TRANSFORM,
                rowCount: 0,
                requestId: msg.requestId,
                generation: this._generation,
                sourceGeneration: this._source_generation,
                intent: msg.intent,
                error: `Sheet index ${msg.sheetIndex} is out of range.`,
            }, receiver_epoch);
            return;
        }
        if (msg.sourceGeneration !== this._source_generation) {
            await this.post_transform_error(
                msg,
                sheet.rowCount,
                'The source changed before this table view request arrived.',
                receiver_epoch,
            );
            return;
        }
        if (
            transform_has_entries(msg.state)
            && msg.state.schema !== transform_schema_for_sheet(sheet)
        ) {
            await this.post_transform_error(
                msg,
                sheet.rowCount,
                'The saved table view no longer matches this sheet.',
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
            await this.post({
                type: 'transformApplied',
                sheetIndex: msg.sheetIndex,
                state: clone_transform(installed_state),
                rowCount: this.transform_indices.get(msg.sheetIndex)?.length
                    ?? sheet.rowCount,
                requestId: msg.requestId,
                generation: this._generation,
                sourceGeneration: this._source_generation,
                intent: msg.intent,
            }, receiver_epoch);
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
                await this.post({
                    type: 'transformApplied',
                    sheetIndex: msg.sheetIndex,
                    state: clone_transform(installed_state),
                    rowCount: this.transform_indices.get(msg.sheetIndex)?.length ?? sheet.rowCount,
                    requestId: msg.requestId,
                    generation: this._generation,
                    sourceGeneration: this._source_generation,
                    intent: msg.intent,
                }, receiver_epoch);
            } catch (error) {
                if (!source_request_is_current()) return;
                await this.post({
                    type: 'transformApplied',
                    sheetIndex: msg.sheetIndex,
                    state: clone_transform(installed_state),
                    rowCount: this.transform_indices.get(msg.sheetIndex)?.length ?? sheet.rowCount,
                    requestId: msg.requestId,
                    generation: this._generation,
                    sourceGeneration: this._source_generation,
                    intent: msg.intent,
                    error: error instanceof Error ? error.message : String(error),
                }, receiver_epoch);
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
            await this.post({
                type: 'transformApplied',
                sheetIndex: msg.sheetIndex,
                state: clone_transform(msg.state),
                rowCount: result.rowCount,
                requestId: msg.requestId,
                generation: this._generation,
                sourceGeneration: this._source_generation,
                intent: msg.intent,
            }, receiver_epoch);
        } catch (error) {
            if (
                !source_request_is_current()
                || (msg.intent === 'restore' && !receiver_is_current())
            ) {
                return;
            }
            const previous = this.transform_states.get(msg.sheetIndex)
                ?? EMPTY_TRANSFORM;
            const previous_count = this.transform_indices.get(msg.sheetIndex)?.length
                ?? sheet.rowCount;
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
            await this.post({
                type: 'transformApplied',
                sheetIndex: msg.sheetIndex,
                state: clone_transform(previous),
                rowCount: previous_count,
                requestId: msg.requestId,
                generation: this._generation,
                sourceGeneration: this._source_generation,
                intent: msg.intent,
                ...(recovered
                    ? {}
                    : { error: error instanceof Error ? error.message : String(error) }),
            }, receiver_epoch);
        } finally {
            if (this.transform_operations.get(msg.sheetIndex) === operation_token) {
                this.transforms_in_flight.delete(msg.sheetIndex);
            }
        }
    }

    reject_transform(
        msg: SetTransformMessage,
        error: string,
    ): Promise<boolean> {
        const natural_count =
            this.source.meta().sheets[msg.sheetIndex]?.rowCount ?? 0;
        return this.post_transform_error(msg, natural_count, error);
    }

    private post_transform_error(
        msg: SetTransformMessage,
        natural_row_count: number,
        error: string,
        receiver_epoch = this.receiver_epoch,
    ): Promise<boolean> {
        const previous = this.transform_states.get(msg.sheetIndex)
            ?? EMPTY_TRANSFORM;
        return this.post({
            type: 'transformApplied',
            sheetIndex: msg.sheetIndex,
            state: clone_transform(previous),
            rowCount: this.transform_indices.get(msg.sheetIndex)?.length
                ?? natural_row_count,
            requestId: msg.requestId,
            generation: this._generation,
            sourceGeneration: this._source_generation,
            intent: msg.intent,
            error,
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
