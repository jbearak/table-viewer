import type { DataSource, RowWindow } from './data-source/interface';
import { compute_transform, transformed_window } from './table-transform';
import {
    EMPTY_TRANSFORM,
    transform_schema_for_sheet,
    type HostMessage,
    type PerFileState,
    type SheetTransformState,
    type StoredPerFileState,
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

/** Panel-specific fields bundled into each `sheetMeta` send. The panels own
 *  state/config; the core owns meta + generation + the page cache. */
interface MetaEnvelope {
    state: StoredPerFileState;
    defaultTabOrientation: 'horizontal' | 'vertical';
    previewMode?: boolean;
    csvEditable?: boolean;
    csvEditingSupported?: boolean;
    projectionChange?: 'excelHeader';
    headerRequestId?: string;
    error?: string;
}

interface ReloadEnvelope {
    state?: PerFileState;
    csvEditable?: boolean;
    csvEditingSupported?: boolean;
    projectionChange?: 'excelHeader';
    headerRequestId?: string;
}

interface MetaRecoveryEnvelope {
    state: PerFileState;
    csvEditable?: boolean;
    csvEditingSupported?: boolean;
    headerRequestId: string;
    error?: string;
}

type SetTransformMessage = Extract<WebviewMessage, { type: 'setTransform' }>;
type TransformCommit = (
    message: SetTransformMessage,
    state: SheetTransformState,
) => Promise<void>;

const DEFAULT_MAX_CACHED_PAGES = 64;

/**
 * Protocol engine shared by the xlsx/xls custom editor and the CSV panel.
 *
 * Owns:
 *  - a monotonic `generation` counter (bumped on every reload) so the webview
 *    can drop row windows belonging to a superseded document version;
 *  - an LRU cache of already-served row windows keyed by sheet/start/count;
 *  - the `requestRows` -> `rowData` handler with a generation guard and
 *    boundary validation.
 *
 * It does NOT own watchers, save/conflict flow, or vscode config — those stay
 * in the format-specific panels, which call `send_meta`/`send_meta_reload` and
 * forward webview messages to `handle_message`.
 */
export class ViewerPanelCore {
    private _generation = 1;
    private readonly cache = new Map<string, RowWindow>();
    private readonly max_cached_pages: number;
    private readonly transform_indices = new Map<number, Uint32Array>();
    private readonly transform_states = new Map<number, SheetTransformState>();
    private readonly transform_sequences = new Map<number, number>();
    private readonly transforms_in_flight = new Set<number>();
    private source_epoch = 0;
    private _source_generation = 1;
    private disposed = false;
    private readonly on_transform_commit?: TransformCommit;

    constructor(
        private readonly panel: PanelLike,
        private source: DataSource,
        opts?: {
            maxCachedPages?: number;
            onTransformCommit?: TransformCommit;
        },
    ) {
        this.max_cached_pages = opts?.maxCachedPages ?? DEFAULT_MAX_CACHED_PAGES;
        this.on_transform_commit = opts?.onTransformCommit;
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

    /** Swap in a freshly-parsed source (reload) without sending a message. */
    set_source(source: DataSource): void {
        if (this.disposed) return;
        this.source = source;
        this.source_epoch += 1;
        this._source_generation += 1;
        this.transform_indices.clear();
        this.transform_states.clear();
        this.transform_sequences.clear();
        this.transforms_in_flight.clear();
        this.cache.clear();
    }

    /** Cancel asynchronous work before its source is closed or replaced. */
    cancel_pending(): void {
        this.source_epoch += 1;
        this.transform_sequences.clear();
        this.transforms_in_flight.clear();
    }

    /** Permanently stop work and suppress all later protocol messages. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancel_pending();
        this.transform_indices.clear();
        this.transform_states.clear();
        this.cache.clear();
    }

    /** Initial structure send. Generation is left as-is (a fresh panel starts
     *  at generation 1; subsequent reloads bump it via send_meta_reload). */
    async send_meta(envelope: MetaEnvelope): Promise<boolean> {
        if (this.disposed) return false;
        return this.post({
            type: 'sheetMeta',
            meta: this.source.meta(),
            state: envelope.state,
            defaultTabOrientation: envelope.defaultTabOrientation,
            previewMode: envelope.previewMode,
            csvEditable: envelope.csvEditable,
            csvEditingSupported: envelope.csvEditingSupported,
            projectionChange: envelope.projectionChange,
            headerRequestId: envelope.headerRequestId,
            error: envelope.error,
            truncationMessage: this.source.truncationMessage,
            generation: this._generation,
            sourceGeneration: this._source_generation,
        });
    }

    /** Full authoritative metadata recovery without changing core generations. */
    async send_meta_recovery(envelope: MetaRecoveryEnvelope): Promise<boolean> {
        if (this.disposed) return false;
        return this.post({
            type: 'metaReloadRecovery',
            meta: this.source.meta(),
            state: envelope.state,
            csvEditable: envelope.csvEditable,
            csvEditingSupported: envelope.csvEditingSupported,
            projectionChange: 'excelHeader',
            truncationMessage: this.source.truncationMessage,
            generation: this._generation,
            sourceGeneration: this._source_generation,
            headerRequestId: envelope.headerRequestId,
            error: envelope.error,
        });
    }

    /** Reload send: bump generation, drop cached windows, post metaReload. */
    async send_meta_reload(envelope?: ReloadEnvelope): Promise<boolean> {
        if (this.disposed) return false;
        this._generation += 1;
        this.cache.clear();
        return this.post({
            type: 'metaReload',
            meta: this.source.meta(),
            state: envelope?.state,
            csvEditable: envelope?.csvEditable,
            csvEditingSupported: envelope?.csvEditingSupported,
            projectionChange: envelope?.projectionChange,
            headerRequestId: envelope?.headerRequestId,
            truncationMessage: this.source.truncationMessage,
            generation: this._generation,
            sourceGeneration: this._source_generation,
        });
    }

    /** Entry point for webview->host messages the core is responsible for. */
    async handle_message(msg: WebviewMessage): Promise<void> {
        if (this.disposed) return;
        if (msg.type === 'requestRows') {
            await this.handle_row_request(msg);
        } else if (msg.type === 'setTransform') {
            await this.handle_set_transform(msg);
        }
    }

    private async handle_set_transform(
        msg: SetTransformMessage,
    ): Promise<void> {
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
            });
            return;
        }
        if (msg.sourceGeneration !== this._source_generation) {
            await this.post_transform_error(
                msg,
                sheet.rowCount,
                'The source changed before this sort/filter request arrived.',
            );
            return;
        }
        if (
            (msg.state.sort.length > 0 || msg.state.filters.length > 0)
            && msg.state.schema !== transform_schema_for_sheet(sheet)
        ) {
            await this.post_transform_error(
                msg,
                sheet.rowCount,
                'The saved sort/filter no longer matches this sheet.',
            );
            return;
        }

        const installed_state = this.transform_states.get(msg.sheetIndex);
        if (
            msg.intent === 'cancel'
            && installed_state
            && transform_states_equal(installed_state, msg.state)
        ) {
            const sequence = (this.transform_sequences.get(msg.sheetIndex) ?? 0) + 1;
            this.transform_sequences.set(msg.sheetIndex, sequence);
            const source_epoch = this.source_epoch;
            this.transforms_in_flight.add(msg.sheetIndex);
            const is_cancelled = () =>
                this.source_epoch !== source_epoch
                || this.transform_sequences.get(msg.sheetIndex) !== sequence;
            try {
                await this.on_transform_commit?.(msg, clone_transform(msg.state));
                if (is_cancelled()) return;
                await this.post({
                    type: 'transformApplied',
                    sheetIndex: msg.sheetIndex,
                    state: clone_transform(installed_state),
                    rowCount: this.transform_indices.get(msg.sheetIndex)?.length ?? sheet.rowCount,
                    requestId: msg.requestId,
                    generation: this._generation,
                    sourceGeneration: this._source_generation,
                    intent: msg.intent,
                });
            } catch (error) {
                if (is_cancelled()) return;
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
                });
            } finally {
                if (this.transform_sequences.get(msg.sheetIndex) === sequence) {
                    this.transforms_in_flight.delete(msg.sheetIndex);
                }
            }
            return;
        }

        const sequence = (this.transform_sequences.get(msg.sheetIndex) ?? 0) + 1;
        this.transform_sequences.set(msg.sheetIndex, sequence);
        const source_epoch = this.source_epoch;
        this.transforms_in_flight.add(msg.sheetIndex);
        const is_cancelled = () =>
            this.source_epoch !== source_epoch
            || this.transform_sequences.get(msg.sheetIndex) !== sequence;

        try {
            const result = await compute_transform(
                this.source,
                msg.sheetIndex,
                msg.state,
                is_cancelled,
            );
            if (is_cancelled()) return;

            // Transform preferences are host-owned. In particular, an explicit
            // Cancel must be durably recorded before its terminal acknowledgement
            // so close/reopen cannot resurrect the cancelled restore.
            await this.on_transform_commit?.(msg, clone_transform(msg.state));
            if (is_cancelled()) return;

            if (result.indices) {
                this.transform_indices.set(msg.sheetIndex, result.indices);
            } else {
                this.transform_indices.delete(msg.sheetIndex);
            }
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
            });
        } catch (error) {
            if (is_cancelled()) {
                return;
            }
            const previous = this.transform_states.get(msg.sheetIndex)
                ?? EMPTY_TRANSFORM;
            const previous_count = this.transform_indices.get(msg.sheetIndex)?.length
                ?? sheet.rowCount;
            await this.post({
                type: 'transformApplied',
                sheetIndex: msg.sheetIndex,
                state: clone_transform(previous),
                rowCount: previous_count,
                requestId: msg.requestId,
                generation: this._generation,
                sourceGeneration: this._source_generation,
                intent: msg.intent,
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            if (this.transform_sequences.get(msg.sheetIndex) === sequence) {
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
        });
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
                window = { startRow: start_row, rows: [] };
            }
            this.cache.set(key, window);
            this.evict_excess();
        }

        await this.post({
            type: 'rowData',
            sheetIndex: msg.sheetIndex,
            startRow: window.startRow,
            rows: window.rows,
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

    private post(message: HostMessage): Promise<boolean> {
        if (this.disposed) return Promise.resolve(false);
        return Promise.resolve(this.panel.webview.postMessage(message));
    }
}

function clone_transform(state: SheetTransformState): SheetTransformState {
    const clone: SheetTransformState = {
        sort: state.sort.map((key) => ({ ...key })),
        filters: state.filters.map((entry) => ({ ...entry })),
    };
    if (state.schema !== undefined) clone.schema = state.schema;
    return clone;
}

/**
 * Install a freshly-built source into a panel's core: close the previous source
 * (when it is being replaced) and either swap it into the existing core or create
 * one. Returns the core to assign back. Every panel (csv/preview/custom-editor)
 * shares this close + create-or-swap dance, so it lives here rather than being
 * re-implemented in each panel's `adopt`.
 */
export function adopt_source_into_core(
    core: ViewerPanelCore | undefined,
    panel: PanelLike,
    previous: DataSource | undefined,
    next: DataSource,
    opts?: { onTransformCommit?: TransformCommit },
): ViewerPanelCore {
    if (core) {
        core.cancel_pending();
        if (previous && previous !== next) previous.close();
        core.set_source(next);
        return core;
    }
    if (previous && previous !== next) previous.close();
    return new ViewerPanelCore(panel, next, opts);
}

function transform_states_equal(left: SheetTransformState, right: SheetTransformState): boolean {
    return left.schema === right.schema
        && left.sort.length === right.sort.length
        && left.sort.every((key, index) => (
            key.colIndex === right.sort[index].colIndex
            && key.direction === right.sort[index].direction
        ))
        && left.filters.length === right.filters.length
        && left.filters.every((entry, index) => {
            const candidate = right.filters[index];
            return entry.id === candidate.id
                && entry.colIndex === candidate.colIndex
                && entry.operator === candidate.operator
                && entry.value === candidate.value
                && entry.secondValue === candidate.secondValue
                && entry.caseSensitive === candidate.caseSensitive
                && entry.enabled === candidate.enabled;
        });
}
