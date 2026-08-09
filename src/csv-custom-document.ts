import { CsvDataSource } from './data-source/csv-source';
import {
    build_csv_source_with_delimiter,
    normalize_csv_max_rows,
} from './csv-source-builder';
import {
    CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES,
    CsvDocumentBackupError,
    create_csv_document_backup_budget,
    csv_document_backup_entry_size,
    decode_csv_document_backup_envelope,
    encode_csv_document_backup,
    type CsvDocumentBackupBudget,
    type CsvDocumentBackupLimits,
} from './csv-document-backup';
import {
    CsvSaveServiceError,
    csv_content_digest,
    prepare_csv_save_content,
    read_csv_target_stably,
    write_csv_target,
    type CsvCancellation,
    type CsvPostSaveRefresh,
    type CsvStableTarget,
    type CsvTargetBasis,
    type PreparedCsvContent,
    type WriteCsvTargetResult,
} from './csv-save-service';
import type { Disposable, FileSystemPort } from './host-ports';
import { get_delimiter } from './host-ports';
import {
    create_resource_identity,
    type ResourceIdentity,
    type ResourceUriLike,
} from './resource-identity';
import { serialize_csv_fields } from './serialize-csv';
import type { CsvDirtyEntry, CsvDirtyMap } from './types';

export interface CsvDocumentRefreshSubscription extends CsvPostSaveRefresh, Disposable {}

export type CsvDocumentRefreshFactory = (
    identity: ResourceIdentity,
    onExternalChange?: () => Promise<void>,
) => CsvDocumentRefreshSubscription;

export interface CsvCustomDocumentOptions {
    readonly resource: ResourceUriLike;
    readonly fs: FileSystemPort;
    readonly maxFileSizeBytes: number;
    readonly maxRows: number;
    readonly delimiter?: ',' | '\t';
    readonly refresh?: CsvDocumentRefreshSubscription;
    readonly refreshFactory?: CsvDocumentRefreshFactory;
    readonly backupLimits?: Omit<CsvDocumentBackupLimits, 'maxSourceBytes'>;
}

export interface RestoreCsvCustomDocumentOptions extends CsvCustomDocumentOptions {
    readonly backup: Uint8Array;
}

export interface CsvDocumentMetadata {
    readonly rowCount: number;
    readonly sourceRowCount: number;
    readonly columnCount: number;
    readonly truncationMessage?: string;
    readonly originalColumnCounts: readonly number[];
    readonly lineEnding: '\r\n' | '\r' | '\n';
    readonly headerLine?: string;
}

export type CsvDocumentConflictState =
    | { readonly type: 'none' }
    | { readonly type: 'externalChange' }
    | {
        readonly type: 'dirtyBases';
        readonly reason: 'baseMismatch' | 'rowsRemoved';
        readonly keys: readonly string[];
    }
    | { readonly type: 'truncated' }
    | {
        readonly type: 'writeFailure';
        readonly reason: 'writeFailed' | 'verificationFailed';
    };

export interface CsvDocumentRestorationState {
    readonly restoredFromBackup: boolean;
    readonly backupVersion?: 2;
    readonly sourceDigest?: string;
}

export type CsvNativeHistoryDirection = 'undo' | 'redo';

export type CsvNativeHistoryRequest = (
    direction: CsvNativeHistoryDirection,
) => void | Promise<void>;

export interface CsvDocumentEditEvent {
    readonly label: string;
    readonly key: string;
    readonly beforeValue: string;
    readonly afterValue: string;
    undo(): Promise<void>;
    redo(): Promise<void>;
}

export type CsvDocumentContentEvent =
    | {
        readonly type: 'cell';
        readonly revision: number;
        readonly sourceGeneration: number;
        readonly mutationEpoch: number;
        readonly viewId?: string;
        readonly key: string;
        readonly value: string;
        readonly dirtyEntry?: CsvDirtyEntry;
        readonly origin: 'input' | 'undo' | 'redo';
    }
    | {
        readonly type: 'sourceReplaced';
        readonly revision: number;
        readonly sourceGeneration: number;
        readonly mutationEpoch: number;
        readonly reason: 'save' | 'revert';
        readonly resource: ResourceUriLike;
    };

export interface CsvDocumentResyncEvent {
    readonly viewId: string;
    readonly viewMutationEpoch: number;
    readonly expectedRevision: number;
    readonly actualRevision: number;
    readonly sourceGeneration: number;
    readonly expectedMutationEpoch: number;
    readonly actualMutationEpoch: number;
}

export interface CsvDocumentConflictEvent {
    readonly state: CsvDocumentConflictState;
    readonly revision: number;
    readonly sourceGeneration: number;
    readonly mutationEpoch: number;
}

export type CsvDocumentMutationResult =
    | {
        readonly type: 'accepted';
        readonly revision: number;
        readonly sourceGeneration: number;
        readonly changed: boolean;
    }
    | {
        readonly type: 'resync';
        readonly revision: number;
        readonly sourceGeneration: number;
    };

export interface CsvDocumentAttachResult {
    readonly type: 'attached';
    readonly viewMutationEpoch: number;
}

export interface CsvDocumentResyncSnapshot {
    readonly resource: ResourceUriLike;
    readonly revision: number;
    readonly sourceGeneration: number;
    readonly mutationEpoch: number;
    readonly delimiter: ',' | '\t';
    readonly metadata: CsvDocumentMetadata;
    readonly dirtyEntries: CsvDirtyMap;
    readonly conflict: CsvDocumentConflictState;
}

export interface CsvDocumentViewResyncSnapshot extends CsvDocumentResyncSnapshot {
    readonly viewMutationEpoch: number;
}

/** A separately owned source for one viewer adoption plus its coherent document projection. */
export interface CsvDocumentViewerSnapshot extends CsvDocumentResyncSnapshot {
    readonly sourceDigest: string;
    readonly source: CsvDataSource;
}

export interface CsvDocumentSaveResult extends WriteCsvTargetResult {
    readonly revision: number;
    readonly sourceGeneration: number;
    readonly mutationEpoch: number;
}

interface GestureEdit {
    readonly key: string;
    readonly before: string;
    readonly after: string;
    readonly mutationEpoch: number;
}

interface ActiveGesture {
    readonly viewId: string;
    readonly key: string;
    readonly before: string;
    readonly edits: GestureEdit[];
}

interface CsvDocumentViewState {
    viewMutationEpoch: number;
}

interface NativeHistoryInterlockBase {
    readonly direction: CsvNativeHistoryDirection;
    observedEdit?: GestureEdit;
    callback?: Promise<void>;
    changed: boolean;
    failure?: { readonly error: unknown };
}

type NativeHistoryInterlock =
    | (NativeHistoryInterlockBase & {
        readonly kind: 'command';
    })
    | (NativeHistoryInterlockBase & {
        readonly kind: 'gestureUndo';
        readonly direction: 'undo';
        readonly purpose: 'cancellation' | 'netZeroReconciliation';
        readonly expectedEdit: GestureEdit;
    });

interface HostSettlementGate {
    historyTail: Promise<void>;
    acceptingHistory: boolean;
}

type Listener<T> = (event: T) => void;

class EventSource<T> {
    private readonly listeners = new Set<Listener<T>>();

    event(listener: Listener<T>): Disposable {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    emit(event: T): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch {
                // A host listener cannot roll back a document mutation already applied.
            }
        }
    }

    dispose(): void {
        this.listeners.clear();
    }
}

function is_cell_key(value: string): boolean {
    const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(value);
    return match !== null
        && Number.isSafeInteger(Number(match[1]))
        && Number.isSafeInteger(Number(match[2]));
}

function parse_cell_key(key: string): { readonly row: number; readonly column: number } {
    if (!is_cell_key(key)) throw new RangeError(`Invalid CSV cell key: ${key}`);
    const [row, column] = key.split(':').map(Number);
    return { row, column };
}

function same_conflict(
    left: CsvDocumentConflictState,
    right: CsvDocumentConflictState,
): boolean {
    if (left.type !== right.type) return false;
    if (left.type === 'dirtyBases' && right.type === 'dirtyBases') {
        return left.reason === right.reason
            && left.keys.length === right.keys.length
            && left.keys.every((key, index) => key === right.keys[index]);
    }
    if (left.type === 'writeFailure' && right.type === 'writeFailure') {
        return left.reason === right.reason;
    }
    return true;
}

function freeze_target_basis(basis: CsvTargetBasis): CsvTargetBasis {
    return Object.freeze({
        stat: Object.freeze({ size: basis.stat.size, mtime: basis.stat.mtime }),
        digest: basis.digest,
    });
}

function freeze_conflict(state: CsvDocumentConflictState): CsvDocumentConflictState {
    if (state.type === 'dirtyBases') {
        return Object.freeze({ ...state, keys: Object.freeze([...state.keys]) });
    }
    return Object.freeze({ ...state });
}

function close_source_best_effort(source: CsvDataSource): void {
    try {
        source.close();
    } catch {
        // A source that never transferred ownership cannot mask construction failure.
    }
}

function dispose_refresh_best_effort(
    refresh: CsvDocumentRefreshSubscription | undefined,
): void {
    try {
        refresh?.dispose();
    } catch {
        // Cleanup cannot mask the operation that failed first.
    }
}

function normalize_max_file_size_bytes(max_file_size_bytes: number): number {
    if (!Number.isSafeInteger(max_file_size_bytes) || max_file_size_bytes < 0) {
        throw new TypeError('maxFileSizeBytes must be a non-negative safe integer.');
    }
    return Math.min(
        max_file_size_bytes,
        CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES,
    );
}

class OpeningRefreshBridge {
    private document?: CsvCustomDocument;
    private accepting = true;
    private queued = false;

    readonly notify = async (): Promise<void> => {
        const document = this.document;
        if (document) {
            await document.notify_external_change();
            return;
        }
        if (this.accepting) this.queued = true;
    };

    bind(document: CsvCustomDocument): boolean {
        this.document = document;
        this.accepting = false;
        const queued = this.queued;
        this.queued = false;
        return queued;
    }

    fail(): void {
        this.accepting = false;
        this.queued = false;
        this.document = undefined;
    }
}

export class CsvCustomDocument {
    private identity_value: ResourceIdentity;
    private delimiter_value: ',' | '\t';
    private source_bytes_value: Uint8Array;
    private source_value: CsvDataSource;
    private target_basis_value: CsvTargetBasis;
    private source_generation_value = 1;
    private mutation_epoch_value = 1;
    private revision_value = 0;
    private readonly dirty = new Map<string, CsvDirtyEntry>();
    private backup_budget: CsvDocumentBackupBudget;
    private dirty_backup_bytes = 0;
    private readonly dirty_backup_entry_bytes = new Map<string, number>();
    private conflict_value: CsvDocumentConflictState = Object.freeze({ type: 'none' });
    private pending_external_target?: CsvStableTarget;
    private readonly views = new Map<string, CsvDocumentViewState>();
    private view_mutation_epoch_counter = 0;
    private pending_view_attachments = 0;
    private save_as_operation_reserved = false;
    private save_as_view_exclusions = 0;
    private readonly transient_refreshes = new Set<CsvDocumentRefreshSubscription>();
    private active_gesture?: ActiveGesture;
    private operation_tail: Promise<void> = Promise.resolve();
    private readonly host_settlement_gates: HostSettlementGate[] = [];
    private native_history_tail: Promise<void> = Promise.resolve();
    private native_history_interlock?: NativeHistoryInterlock;
    private native_history_may_reference_source = false;
    private disposal_requested = false;
    private disposed = false;
    private disposal?: Promise<void>;

    private readonly edit_events = new EventSource<CsvDocumentEditEvent>();
    private readonly content_events = new EventSource<CsvDocumentContentEvent>();
    private readonly resync_events = new EventSource<CsvDocumentResyncEvent>();
    private readonly conflict_events = new EventSource<CsvDocumentConflictEvent>();
    private readonly disposal_events = new EventSource<void>();

    private constructor(
        identity: ResourceIdentity,
        delimiter: ',' | '\t',
        source_bytes: Uint8Array,
        source: CsvDataSource,
        target_basis: CsvTargetBasis,
        private readonly fs: FileSystemPort,
        private readonly max_file_size_bytes: number,
        private readonly max_rows: number,
        private refresh_value: CsvDocumentRefreshSubscription | undefined,
        private readonly refresh_factory: CsvDocumentRefreshFactory | undefined,
        private readonly backup_limits: Omit<CsvDocumentBackupLimits, 'maxSourceBytes'>,
        dirty_entries: ReadonlyMap<string, CsvDirtyEntry> = new Map(),
        private readonly restoration: CsvDocumentRestorationState = Object.freeze({
            restoredFromBackup: false,
        }),
    ) {
        this.identity_value = identity;
        this.delimiter_value = delimiter;
        this.source_bytes_value = source_bytes;
        this.source_value = source;
        this.target_basis_value = freeze_target_basis(target_basis);
        this.backup_budget = create_csv_document_backup_budget({
            identity,
            delimiter,
            targetBasis: this.target_basis_value,
            sourceBytes: source_bytes,
            maxRows: max_rows,
            limits: {
                ...backup_limits,
                maxSourceBytes: max_file_size_bytes,
            },
        });
        if (dirty_entries.size > this.backup_budget.maxDirtyEntries) {
            throw new CsvDocumentBackupError(
                'countLimit',
                'CSV backup has too many dirty cells.',
            );
        }
        for (const [key, entry] of dirty_entries) {
            const frozen = Object.freeze({ value: entry.value, base: entry.base });
            const entry_bytes = csv_document_backup_entry_size(
                key,
                frozen,
                this.backup_budget,
            );
            this.dirty_backup_bytes += entry_bytes;
            if (
                !Number.isSafeInteger(this.dirty_backup_bytes)
                || this.dirty_backup_bytes > this.backup_budget.maxDirtySectionBytes
                || this.backup_budget.fixedBytes + this.dirty_backup_bytes
                    > this.backup_budget.maxBackupBytes
            ) {
                throw new CsvDocumentBackupError(
                    'sizeLimit',
                    'CSV backup exceeds its size limit.',
                );
            }
            this.dirty.set(key, frozen);
            this.dirty_backup_entry_bytes.set(key, entry_bytes);
        }
    }

    static async create(
        options: CsvCustomDocumentOptions,
        initial_data: Uint8Array,
    ): Promise<CsvCustomDocument> {
        const identity = create_resource_identity(options.resource);
        const delimiter = options.delimiter ?? get_delimiter(identity.filePath);
        const max_rows = normalize_csv_max_rows(options.maxRows);
        const max_file_size_bytes = normalize_max_file_size_bytes(
            options.maxFileSizeBytes,
        );
        if (initial_data.byteLength > max_file_size_bytes) {
            throw new CsvSaveServiceError(
                'tooLarge',
                `File exceeds the configured ${max_file_size_bytes}-byte limit.`,
            );
        }
        const bytes = initial_data.slice();
        const source = await build_csv_source_with_delimiter(
            bytes,
            delimiter,
            max_rows,
        );
        if (options.refresh && options.refreshFactory) {
            close_source_best_effort(source);
            throw new TypeError('Provide either refresh or refreshFactory, not both.');
        }
        let refresh: CsvDocumentRefreshSubscription | undefined;
        try {
            // Untitled/host-supplied initial data has no backing target to watch.
            // Retain refreshFactory for Save As destinations without subscribing the
            // synthetic source URI itself.
            refresh = options.refresh;
            return new CsvCustomDocument(
                identity,
                delimiter,
                bytes,
                source,
                {
                    stat: { size: bytes.byteLength, mtime: 0 },
                    digest: csv_content_digest(bytes),
                },
                options.fs,
                max_file_size_bytes,
                max_rows,
                refresh,
                options.refreshFactory,
                options.backupLimits ?? {},
            );
        } catch (error) {
            close_source_best_effort(source);
            dispose_refresh_best_effort(refresh);
            throw error;
        }
    }

    static async open(options: CsvCustomDocumentOptions): Promise<CsvCustomDocument> {
        const identity = create_resource_identity(options.resource);
        const delimiter = options.delimiter ?? get_delimiter(identity.filePath);
        const max_rows = normalize_csv_max_rows(options.maxRows);
        const max_file_size_bytes = normalize_max_file_size_bytes(
            options.maxFileSizeBytes,
        );
        if (options.refresh && options.refreshFactory) {
            throw new TypeError('Provide either refresh or refreshFactory, not both.');
        }
        const refresh_bridge = options.refreshFactory
            ? new OpeningRefreshBridge()
            : undefined;
        let refresh: CsvDocumentRefreshSubscription | undefined;
        let source: CsvDataSource | undefined;
        let document: CsvCustomDocument | undefined;
        try {
            // Observe before the first target read. A signal that arrives while the
            // source is being read or built is retained by refresh_bridge until the
            // document exists, and the final stable reconciliation below closes the
            // read/registration/construction gap even if the watcher only coalesces it.
            refresh = options.refresh ?? options.refreshFactory?.(
                identity,
                refresh_bridge?.notify,
            );
            const stable = await read_csv_target_stably(
                options.fs,
                identity.uri,
                max_file_size_bytes,
            );
            source = await build_csv_source_with_delimiter(
                stable.bytes,
                delimiter,
                max_rows,
            );
            document = new CsvCustomDocument(
                identity,
                delimiter,
                stable.bytes,
                source,
                { stat: stable.stat, digest: stable.digest },
                options.fs,
                max_file_size_bytes,
                max_rows,
                refresh,
                options.refreshFactory,
                options.backupLimits ?? {},
            );
            source = undefined;
            refresh_bridge?.bind(document);
            if (refresh) {
                try {
                    await document.notify_external_change();
                } catch {
                    // The document retains conflict evidence for a target that became
                    // unreadable during open. A successful final read adopts any newer
                    // bytes before the document is published.
                }
            }
            return document;
        } catch (error) {
            refresh_bridge?.fail();
            if (document) {
                try {
                    await document.dispose();
                } catch {
                    // Cleanup cannot mask the operation that failed first.
                }
            } else {
                if (source) close_source_best_effort(source);
                dispose_refresh_best_effort(refresh);
            }
            throw error;
        }
    }

    static async restore(
        options: RestoreCsvCustomDocumentOptions,
    ): Promise<CsvCustomDocument> {
        const identity = create_resource_identity(options.resource);
        const max_file_size_bytes = normalize_max_file_size_bytes(
            options.maxFileSizeBytes,
        );
        if (options.refresh && options.refreshFactory) {
            throw new TypeError('Provide either refresh or refreshFactory, not both.');
        }
        const decoded = decode_csv_document_backup_envelope(options.backup, identity, {
            ...options.backupLimits,
            maxSourceBytes: max_file_size_bytes,
        });
        let source: CsvDataSource | undefined = await build_csv_source_with_delimiter(
            decoded.sourceBytes,
            decoded.delimiter,
            decoded.recoveryLimits.maxRows,
        );
        const refresh_bridge = options.refreshFactory
            && identity.uri.scheme.toLowerCase() !== 'untitled'
            ? new OpeningRefreshBridge()
            : undefined;
        let refresh: CsvDocumentRefreshSubscription | undefined;
        let document: CsvCustomDocument | undefined;
        try {
            const restored_source = source;
            const sheet = restored_source.meta().sheets[0];
            if (restored_source.truncationMessage && decoded.dirtyCount > 0) {
                throw new CsvDocumentBackupError(
                    'malformed',
                    'CSV backup contains edits for a truncated source.',
                );
            }
            // Decode into the retained Map only after CSV construction. Shape and
            // source-base checks run before each insertion, so malformed backups
            // cannot amplify into a complete decoded overlay before rejection. Keep
            // only one source row cached to bound validation memory independently of
            // the dirty-entry count while retaining row-major recovery efficiency.
            let cached_row_index = -1;
            let cached_row: ReturnType<CsvDataSource['read_rows']>['rows'][number]
                | undefined;
            const dirty_entries = decoded.decodeDirtyEntries((key, entry) => {
                const { row, column } = parse_cell_key(key);
                if (
                    !sheet
                    || row >= sheet.sourceRowCount
                    || column >= sheet.columnCount
                ) {
                    throw new CsvDocumentBackupError(
                        'malformed',
                        `CSV backup dirty entry ${key} is outside the source shape.`,
                    );
                }
                if (cached_row_index !== row) {
                    cached_row_index = row;
                    cached_row = restored_source.read_rows(0, row, 1).rows[0];
                }
                const cell = cached_row?.[column];
                const observed_base = cell !== null && cell !== undefined
                    ? String(cell.raw ?? '')
                    : '';
                if (entry.base !== observed_base) {
                    throw new CsvDocumentBackupError(
                        'malformed',
                        `CSV backup dirty base for ${key} does not match its source.`,
                    );
                }
            });
            refresh = identity.uri.scheme.toLowerCase() === 'untitled'
                ? options.refresh
                : options.refresh ?? options.refreshFactory?.(
                    identity,
                    refresh_bridge?.notify,
                );
            document = new CsvCustomDocument(
                identity,
                decoded.delimiter,
                decoded.sourceBytes,
                restored_source,
                decoded.targetBasis,
                options.fs,
                decoded.recoveryLimits.maxSourceBytes,
                decoded.recoveryLimits.maxRows,
                refresh,
                options.refreshFactory,
                options.backupLimits ?? {},
                dirty_entries,
                Object.freeze({
                    restoredFromBackup: true,
                    backupVersion: decoded.version,
                    sourceDigest: decoded.sourceDigest,
                }),
            );
            source = undefined;
            refresh_bridge?.bind(document);
            if (identity.uri.scheme.toLowerCase() !== 'untitled') {
                try {
                    await document.notify_external_change();
                } catch {
                    // The restored document retains conflict evidence when the current
                    // target cannot be read, without making hot-exit recovery fail.
                }
            }
            return document;
        } catch (error) {
            refresh_bridge?.fail();
            if (document) {
                try {
                    await document.dispose();
                } catch {
                    // Cleanup cannot mask the operation that failed first.
                }
            } else {
                if (source) close_source_best_effort(source);
                dispose_refresh_best_effort(refresh);
            }
            throw error;
        }
    }

    get uri(): ResourceUriLike {
        return this.identity_value.uri;
    }

    get identity(): ResourceIdentity {
        return this.identity_value;
    }

    get delimiter(): ',' | '\t' {
        return this.delimiter_value;
    }

    get sourceGeneration(): number {
        return this.source_generation_value;
    }

    get mutationEpoch(): number {
        return this.mutation_epoch_value;
    }

    get revision(): number {
        return this.revision_value;
    }

    get dirtyCount(): number {
        return this.dirty.size;
    }

    get isDirty(): boolean {
        return this.dirty.size > 0;
    }

    get conflict(): CsvDocumentConflictState {
        return this.conflict_value;
    }

    get restorationState(): CsvDocumentRestorationState {
        return this.restoration;
    }

    get dataSource(): CsvDataSource {
        return this.source_value;
    }

    get targetBasis(): CsvTargetBasis {
        return this.target_basis_value;
    }

    get metadata(): CsvDocumentMetadata {
        const sheet = this.source_value.meta().sheets[0];
        return Object.freeze({
            rowCount: sheet?.rowCount ?? 0,
            sourceRowCount: sheet?.sourceRowCount ?? 0,
            columnCount: sheet?.columnCount ?? 0,
            ...(this.source_value.truncationMessage === undefined
                ? {}
                : { truncationMessage: this.source_value.truncationMessage }),
            originalColumnCounts: this.source_value.originalColumnCounts,
            lineEnding: this.source_value.lineEnding,
            ...(this.source_value.headerLine === undefined
                ? {}
                : { headerLine: this.source_value.headerLine }),
        });
    }

    on_did_change(listener: Listener<CsvDocumentEditEvent>): Disposable {
        return this.edit_events.event(listener);
    }

    on_did_change_content(listener: Listener<CsvDocumentContentEvent>): Disposable {
        return this.content_events.event(listener);
    }

    on_did_request_resync(listener: Listener<CsvDocumentResyncEvent>): Disposable {
        return this.resync_events.event(listener);
    }

    on_did_change_conflict(listener: Listener<CsvDocumentConflictEvent>): Disposable {
        return this.conflict_events.event(listener);
    }

    on_did_dispose(listener: Listener<void>): Disposable {
        return this.disposal_events.event(listener);
    }

    private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
        const result = this.operation_tail.then(operation);
        this.operation_tail = result.then(() => undefined, () => undefined);
        return result;
    }

    private admitted<T>(operation: () => Promise<T> | T): Promise<T> {
        if (this.disposal_requested) {
            return Promise.reject(new Error('CSV custom document is disposing.'));
        }
        return this.enqueue(operation);
    }

    private enqueue_settling_host_history<T>(
        operation: () => Promise<T>,
    ): Promise<T> | undefined {
        const settlement = this.host_settlement_gates.find((candidate) => (
            candidate.acceptingHistory
        ));
        if (!settlement) return undefined;
        if (this.disposal_requested) {
            return Promise.reject(new Error('CSV custom document is disposing.'));
        }
        // A direct VS Code callback can arrive after the lifecycle promise settles
        // but while ordinary renderer work is held behind its settlement gate. Give
        // that already-native transaction priority so a queued input cannot publish a
        // newer edit and then be overwritten by the older absolute Undo/Redo callback.
        const result = settlement.historyTail.then(operation);
        settlement.historyTail = result.then(() => undefined, () => undefined);
        return result;
    }

    private enqueue_native_history<T>(operation: () => Promise<T>): Promise<T> {
        if (this.disposal_requested) {
            return Promise.reject(new Error('CSV custom document is disposing.'));
        }
        const native_predecessor = this.native_history_tail;
        // Reserve the complete history transaction on the document queue now. Later
        // input, lifecycle, backup, snapshot, and disposal work cannot overtake the
        // host command while its exact CustomDocument callback re-enters below.
        const result = this.enqueue(async () => {
            await native_predecessor;
            return operation();
        });
        this.native_history_tail = result.then(() => undefined, () => undefined);
        return result;
    }

    private assert_not_disposed(): void {
        if (this.disposed) throw new Error('CSV custom document is disposed.');
    }

    private next_revision(): number {
        if (this.revision_value >= Number.MAX_SAFE_INTEGER) {
            throw new RangeError('CSV document revision exhausted.');
        }
        this.revision_value += 1;
        return this.revision_value;
    }

    private next_source_generation(): number {
        if (this.source_generation_value >= Number.MAX_SAFE_INTEGER) {
            throw new RangeError('CSV source generation exhausted.');
        }
        this.source_generation_value += 1;
        return this.source_generation_value;
    }

    private next_mutation_epoch(): number {
        if (this.mutation_epoch_value >= Number.MAX_SAFE_INTEGER) {
            throw new RangeError('CSV document mutation epoch exhausted.');
        }
        this.mutation_epoch_value += 1;
        return this.mutation_epoch_value;
    }

    private raw_source_value(key: string): string {
        const { row, column } = parse_cell_key(key);
        const sheet = this.source_value.meta().sheets[0];
        if (!sheet || row >= sheet.sourceRowCount) {
            throw new RangeError(`CSV source row ${row} does not exist.`);
        }
        if (column >= sheet.columnCount) {
            throw new RangeError(`CSV source column ${column} does not exist.`);
        }
        const cell = this.source_value.read_rows(0, row, 1).rows[0]?.[column];
        return cell !== null && cell !== undefined ? String(cell.raw ?? '') : '';
    }

    cell_value(key: string): string {
        this.assert_not_disposed();
        return this.dirty.get(key)?.value ?? this.raw_source_value(key);
    }

    dirty_entry(key: string): CsvDirtyEntry | undefined {
        this.assert_not_disposed();
        return this.dirty.get(key);
    }

    private close_gesture(): void {
        this.active_gesture = undefined;
    }

    private close_gesture_for_view(view_id: string): void {
        if (this.active_gesture?.viewId === view_id) this.close_gesture();
    }

    private create_backup_budget(
        bytes: Uint8Array,
        basis: CsvTargetBasis,
        identity: ResourceIdentity,
        delimiter: ',' | '\t',
    ): CsvDocumentBackupBudget {
        return create_csv_document_backup_budget({
            identity,
            delimiter,
            targetBasis: basis,
            sourceBytes: bytes,
            maxRows: this.max_rows,
            limits: {
                ...this.backup_limits,
                maxSourceBytes: this.max_file_size_bytes,
            },
        });
    }

    private measure_dirty_update(
        key: string,
        entry: CsvDirtyEntry | undefined,
    ): { readonly entryBytes: number; readonly dirtyBytes: number } {
        const previous_bytes = this.dirty_backup_entry_bytes.get(key) ?? 0;
        const had_entry = this.dirty.has(key);
        const next_count = this.dirty.size
            + (entry === undefined || had_entry ? 0 : 1)
            - (entry === undefined && had_entry ? 1 : 0);
        if (next_count > this.backup_budget.maxDirtyEntries) {
            throw new CsvDocumentBackupError(
                'countLimit',
                'CSV backup has too many dirty cells.',
            );
        }
        const entry_bytes = entry === undefined
            ? 0
            : csv_document_backup_entry_size(key, entry, this.backup_budget);
        const dirty_bytes = this.dirty_backup_bytes - previous_bytes + entry_bytes;
        if (
            !Number.isSafeInteger(dirty_bytes)
            || dirty_bytes < 0
            || dirty_bytes > this.backup_budget.maxDirtySectionBytes
            || this.backup_budget.fixedBytes + dirty_bytes
                > this.backup_budget.maxBackupBytes
        ) {
            throw new CsvDocumentBackupError(
                'sizeLimit',
                'CSV backup exceeds its size limit.',
            );
        }
        return { entryBytes: entry_bytes, dirtyBytes: dirty_bytes };
    }

    private set_absolute_value(
        key: string,
        value: string,
        origin: 'input' | 'undo' | 'redo',
        view_id?: string,
        advance_on_noop = false,
    ): boolean {
        const current = this.dirty.get(key)?.value ?? this.raw_source_value(key);
        if (current === value) {
            if (!advance_on_noop) return false;
            const dirty_entry = this.dirty.get(key);
            const revision = this.next_revision();
            this.content_events.emit(Object.freeze({
                type: 'cell' as const,
                revision,
                sourceGeneration: this.source_generation_value,
                mutationEpoch: this.mutation_epoch_value,
                ...(view_id === undefined ? {} : { viewId: view_id }),
                key,
                value,
                ...(dirty_entry === undefined ? {} : { dirtyEntry: dirty_entry }),
                origin,
            }));
            return false;
        }
        const base = this.raw_source_value(key);
        const dirty_entry = value === base
            ? undefined
            : Object.freeze({ value, base });
        const measured = this.measure_dirty_update(key, dirty_entry);
        if (dirty_entry === undefined) {
            this.dirty.delete(key);
            this.dirty_backup_entry_bytes.delete(key);
        } else {
            this.dirty.set(key, dirty_entry);
            this.dirty_backup_entry_bytes.set(key, measured.entryBytes);
        }
        this.dirty_backup_bytes = measured.dirtyBytes;
        const revision = this.next_revision();
        this.content_events.emit(Object.freeze({
            type: 'cell' as const,
            revision,
            sourceGeneration: this.source_generation_value,
                mutationEpoch: this.mutation_epoch_value,
            ...(view_id === undefined ? {} : { viewId: view_id }),
            key,
            value,
            ...(dirty_entry === undefined ? {} : { dirtyEntry: dirty_entry }),
            origin,
        }));
        return true;
    }

    private edit_event(edit: GestureEdit): CsvDocumentEditEvent {
        const document = this;
        return Object.freeze({
            label: 'Edit CSV cell',
            key: edit.key,
            beforeValue: edit.before,
            afterValue: edit.after,
            undo: () => document.apply_history_value(edit, 'undo'),
            redo: () => document.apply_history_value(edit, 'redo'),
        });
    }

    private async apply_history_value_now(
        edit: GestureEdit,
        direction: CsvNativeHistoryDirection,
    ): Promise<boolean> {
        this.assert_not_disposed();
        if (edit.mutationEpoch !== this.mutation_epoch_value) {
            throw new Error('CSV history callback belongs to a replaced source.');
        }
        this.close_gesture();
        const changed = this.set_absolute_value(
            edit.key,
            direction === 'undo' ? edit.before : edit.after,
            direction,
        );
        await this.reconcile_observed_target_if_clean();
        return changed;
    }

    private reject_interlocked_history_callback(
        interlock: NativeHistoryInterlock,
        error: unknown,
    ): Promise<void> {
        interlock.failure ??= { error };
        const rejected = Promise.reject(interlock.failure.error);
        void rejected.catch(() => undefined);
        return rejected;
    }

    private apply_interlocked_history_value(
        interlock: NativeHistoryInterlock,
        edit: GestureEdit,
        direction: CsvNativeHistoryDirection,
    ): Promise<void> {
        if (interlock.failure !== undefined) {
            return this.reject_interlocked_history_callback(
                interlock,
                interlock.failure.error,
            );
        }
        if (direction !== interlock.direction) {
            return this.reject_interlocked_history_callback(
                interlock,
                new Error('VS Code invoked the wrong CSV history callback direction.'),
            );
        }
        if (
            interlock.kind === 'gestureUndo'
            && edit !== interlock.expectedEdit
        ) {
            return this.reject_interlocked_history_callback(
                interlock,
                new Error(interlock.purpose === 'cancellation'
                    ? 'VS Code did not invoke the cancelled CSV gesture callback.'
                    : 'VS Code did not invoke the net-zero CSV gesture callback.'),
            );
        }
        if (interlock.observedEdit !== undefined) {
            return this.reject_interlocked_history_callback(
                interlock,
                new Error('VS Code invoked more than one CSV history callback.'),
            );
        }

        // This exact callback is the sole reentrant mutation permitted while the
        // native-history transaction occupies the ordinary document queue.
        interlock.observedEdit = edit;
        const callback = this.apply_history_value_now(edit, direction).then((changed) => {
            interlock.changed = changed;
        });
        void callback.catch(() => undefined);
        interlock.callback = callback;
        return callback;
    }

    private apply_history_value(
        edit: GestureEdit,
        direction: CsvNativeHistoryDirection,
    ): Promise<void> {
        const interlock = this.native_history_interlock;
        if (interlock) {
            return this.apply_interlocked_history_value(interlock, edit, direction);
        }
        const settling = this.enqueue_settling_host_history(async () => {
            await this.apply_history_value_now(edit, direction);
        });
        if (settling) return settling;
        return this.admitted(async () => {
            await this.apply_history_value_now(edit, direction);
        });
    }

    private async invoke_native_history(
        interlock: NativeHistoryInterlock,
        request: CsvNativeHistoryRequest,
    ): Promise<boolean> {
        if (this.native_history_interlock !== undefined) {
            throw new Error('A CSV native history command is already active.');
        }
        this.native_history_interlock = interlock;
        let host_failure: { readonly error: unknown } | undefined;
        try {
            try {
                await request(interlock.direction);
            } catch (error) {
                host_failure = { error };
            }
            if (interlock.callback) {
                try {
                    await interlock.callback;
                } catch (error) {
                    interlock.failure ??= { error };
                }
            }
            if (interlock.failure) throw interlock.failure.error;
            if (host_failure) throw host_failure.error;
            if (
                interlock.kind === 'gestureUndo'
                && interlock.callback === undefined
            ) {
                throw new Error(interlock.purpose === 'cancellation'
                    ? 'VS Code did not undo the cancelled CSV gesture.'
                    : 'VS Code did not undo the net-zero CSV gesture.');
            }
            return interlock.changed;
        } finally {
            if (this.native_history_interlock === interlock) {
                this.native_history_interlock = undefined;
            }
        }
    }

    private async undo_gesture_segments(
        gesture: ActiveGesture,
        purpose: 'cancellation' | 'netZeroReconciliation',
        request: CsvNativeHistoryRequest,
    ): Promise<void> {
        for (let index = gesture.edits.length - 1; index >= 0; index -= 1) {
            await this.invoke_native_history({
                kind: 'gestureUndo',
                direction: 'undo',
                purpose,
                expectedEdit: gesture.edits[index],
                changed: false,
            }, request);
        }
    }

    run_native_history_command(
        direction: CsvNativeHistoryDirection,
        request: CsvNativeHistoryRequest,
    ): Promise<void> {
        return this.enqueue_native_history(async () => {
            this.assert_not_disposed();
            this.close_gesture();
            await this.invoke_native_history({
                kind: 'command',
                direction,
                changed: false,
            }, request);
        });
    }

    private mutation_resync_result(): CsvDocumentMutationResult {
        return {
            type: 'resync',
            revision: this.revision_value,
            sourceGeneration: this.source_generation_value,
        };
    }

    private allocate_view_mutation_epoch(): number {
        const next = this.view_mutation_epoch_counter + 1;
        if (!Number.isSafeInteger(next)) {
            throw new Error('CSV document view mutation epoch space is exhausted.');
        }
        this.view_mutation_epoch_counter = next;
        return next;
    }

    private assert_view(view_id: string): CsvDocumentViewState {
        const view = this.views.get(view_id);
        if (!view) throw new Error(`CSV document view ${view_id} is not attached.`);
        return view;
    }

    private rotate_view_mutation_epoch(view_id: string): number {
        const view = this.assert_view(view_id);
        const next = this.allocate_view_mutation_epoch();
        view.viewMutationEpoch = next;
        return next;
    }

    private stale_result(
        view_id: string,
        expected_revision: number,
        expected_mutation_epoch: number,
        close_gesture: boolean,
    ): CsvDocumentMutationResult {
        const view_mutation_epoch = close_gesture
            ? this.rotate_view_mutation_epoch(view_id)
            : this.assert_view(view_id).viewMutationEpoch;
        if (close_gesture) this.close_gesture_for_view(view_id);
        const event = Object.freeze({
            viewId: view_id,
            viewMutationEpoch: view_mutation_epoch,
            expectedRevision: expected_revision,
            actualRevision: this.revision_value,
            sourceGeneration: this.source_generation_value,
            expectedMutationEpoch: expected_mutation_epoch,
            actualMutationEpoch: this.mutation_epoch_value,
        });
        this.resync_events.emit(event);
        return this.mutation_resync_result();
    }

    private validate_mutation_authority(input: {
        readonly viewId: string;
        readonly viewMutationEpoch: number;
        readonly revision: number;
        readonly mutationEpoch: number;
    }): CsvDocumentMutationResult | undefined {
        const view = this.assert_view(input.viewId);
        if (
            !Number.isSafeInteger(input.viewMutationEpoch)
            || input.viewMutationEpoch < 1
        ) {
            throw new RangeError(
                'CSV document view mutation epoch must be a positive safe integer.',
            );
        }
        if (input.viewMutationEpoch !== view.viewMutationEpoch) {
            return this.mutation_resync_result();
        }
        if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
            throw new RangeError('CSV document revision must be a non-negative safe integer.');
        }
        if (!Number.isSafeInteger(input.mutationEpoch) || input.mutationEpoch < 1) {
            throw new RangeError('CSV document mutation epoch must be a positive safe integer.');
        }
        if (input.mutationEpoch !== this.mutation_epoch_value) {
            return this.stale_result(
                input.viewId,
                input.revision,
                input.mutationEpoch,
                false,
            );
        }
        if (input.revision !== this.revision_value) {
            return this.stale_result(
                input.viewId,
                input.revision,
                input.mutationEpoch,
                true,
            );
        }
        return undefined;
    }

    private save_as_unavailable_error(): Error {
        return new Error(
            'Save As is unavailable while this CSV is open in multiple Table Viewer views. '
            + 'Close the other views and try again.',
        );
    }

    private reserve_save_as(): {
        readonly preflightError?: Error;
        releaseOperation(): void;
        releaseViewExclusion(): void;
    } {
        if (this.save_as_operation_reserved) {
            return {
                preflightError: new Error('Another Save As is already in progress for this CSV.'),
                releaseOperation() {},
                releaseViewExclusion() {},
            };
        }
        this.save_as_operation_reserved = true;
        this.save_as_view_exclusions += 1;
        let operation_released = false;
        let view_exclusion_released = false;
        return {
            ...(
                this.views.size + this.pending_view_attachments > 1
                    ? { preflightError: this.save_as_unavailable_error() }
                    : {}
            ),
            releaseOperation: () => {
                if (operation_released) return;
                operation_released = true;
                this.save_as_operation_reserved = false;
            },
            releaseViewExclusion: () => {
                if (view_exclusion_released) return;
                view_exclusion_released = true;
                this.save_as_view_exclusions -= 1;
            },
        };
    }

    async attach_view(view_id: string): Promise<CsvDocumentAttachResult> {
        if (view_id.length === 0) throw new TypeError('CSV document view id must not be empty.');
        if (this.save_as_view_exclusions > 0) throw this.save_as_unavailable_error();
        this.pending_view_attachments += 1;
        try {
            return await this.admitted(() => {
                this.assert_not_disposed();
                const current = this.views.get(view_id);
                if (current) {
                    return {
                        type: 'attached' as const,
                        viewMutationEpoch: current.viewMutationEpoch,
                    };
                }
                const viewMutationEpoch = this.allocate_view_mutation_epoch();
                this.views.set(view_id, { viewMutationEpoch });
                return { type: 'attached' as const, viewMutationEpoch };
            });
        } finally {
            this.pending_view_attachments -= 1;
        }
    }

    async detach_view(view_id: string): Promise<void> {
        return this.admitted(() => {
            this.assert_not_disposed();
            this.close_gesture_for_view(view_id);
            this.views.delete(view_id);
        });
    }

    async apply_cell_input(input: {
        readonly viewId: string;
        readonly viewMutationEpoch: number;
        readonly key: string;
        readonly value: string;
        readonly revision: number;
        readonly mutationEpoch: number;
    }): Promise<CsvDocumentMutationResult> {
        return this.admitted(async () => {
            this.assert_not_disposed();
            const stale = this.validate_mutation_authority(input);
            if (stale) return stale;
            if (this.source_value.truncationMessage) {
                throw new CsvSaveServiceError(
                    'truncated',
                    'The CSV was truncated while loading and cannot be edited safely.',
                );
            }
            this.raw_source_value(input.key);

            const active = this.active_gesture;
            const continues_active_gesture = active?.viewId === input.viewId
                && active.key === input.key;
            const before = this.dirty.get(input.key)?.value
                ?? this.raw_source_value(input.key);
            if (!continues_active_gesture && before === input.value) {
                this.set_absolute_value(
                    input.key,
                    input.value,
                    'input',
                    input.viewId,
                    true,
                );
                this.close_gesture();
                await this.reconcile_observed_target_if_clean();
                return {
                    type: 'accepted',
                    revision: this.revision_value,
                    sourceGeneration: this.source_generation_value,
                    changed: false,
                };
            }

            const changed = this.set_absolute_value(
                input.key,
                input.value,
                'input',
                input.viewId,
                true,
            );
            let gesture = active;
            if (!continues_active_gesture) {
                gesture = {
                    viewId: input.viewId,
                    key: input.key,
                    before,
                    edits: [],
                };
                this.active_gesture = gesture;
            }
            if (changed) {
                const edit = Object.freeze({
                    key: input.key,
                    before,
                    after: input.value,
                    mutationEpoch: this.mutation_epoch_value,
                });
                gesture!.edits.push(edit);
                // Every distinct content change publishes an immutable native segment.
                // This both preserves exact undo states and gives VS Code an observable
                // event for each Auto Save debounce reset. The logical gesture remains
                // open separately so Escape can unwind every segment as one interaction.
                this.native_history_may_reference_source = true;
                this.edit_events.emit(this.edit_event(edit));
            }
            await this.reconcile_observed_target_if_clean();
            return {
                type: 'accepted',
                revision: this.revision_value,
                sourceGeneration: this.source_generation_value,
                changed,
            };
        });
    }

    complete_gesture(
        input: {
            readonly viewId: string;
            readonly viewMutationEpoch: number;
            readonly revision: number;
            readonly mutationEpoch: number;
        },
        request?: CsvNativeHistoryRequest,
    ): Promise<CsvDocumentMutationResult> {
        return this.enqueue_native_history(async () => {
            this.assert_not_disposed();
            const stale = this.validate_mutation_authority(input);
            if (stale) return stale;
            const active = this.active_gesture;
            if (active?.viewId !== input.viewId) {
                return {
                    type: 'accepted',
                    revision: this.revision_value,
                    sourceGeneration: this.source_generation_value,
                    changed: false,
                };
            }

            this.close_gesture_for_view(input.viewId);
            if (
                active.edits.length > 0
                && this.cell_value(active.key) === active.before
            ) {
                if (!request) {
                    throw new Error(
                        'A native history request is required to reconcile a net-zero CSV gesture.',
                    );
                }
                await this.undo_gesture_segments(
                    active,
                    'netZeroReconciliation',
                    request,
                );
            }
            return {
                type: 'accepted',
                revision: this.revision_value,
                sourceGeneration: this.source_generation_value,
                changed: false,
            };
        });
    }

    /**
     * Cancel every exact native segment in the active logical gesture. The
     * segments remain redoable because CustomDocument edit events cannot be retracted.
     */
    cancel_gesture(
        input: {
            readonly viewId: string;
            readonly viewMutationEpoch: number;
            readonly revision: number;
            readonly mutationEpoch: number;
        },
        request: CsvNativeHistoryRequest,
    ): Promise<CsvDocumentMutationResult> {
        return this.enqueue_native_history(async () => {
            this.assert_not_disposed();
            const stale = this.validate_mutation_authority(input);
            if (stale) return stale;
            const active = this.active_gesture;
            if (active?.viewId !== input.viewId) {
                return {
                    type: 'accepted',
                    revision: this.revision_value,
                    sourceGeneration: this.source_generation_value,
                    changed: false,
                };
            }

            const value_before_cancellation = this.cell_value(active.key);
            this.close_gesture_for_view(input.viewId);
            await this.undo_gesture_segments(active, 'cancellation', request);
            return {
                type: 'accepted',
                revision: this.revision_value,
                sourceGeneration: this.source_generation_value,
                changed: value_before_cancellation !== active.before,
            };
        });
    }

    private set_conflict(state: CsvDocumentConflictState): void {
        const frozen = freeze_conflict(state);
        if (same_conflict(this.conflict_value, frozen)) return;
        this.conflict_value = frozen;
        this.conflict_events.emit(Object.freeze({
            state: frozen,
            revision: this.revision_value,
            sourceGeneration: this.source_generation_value,
                mutationEpoch: this.mutation_epoch_value,
        }));
    }

    private async reconcile_observed_target_if_clean(): Promise<void> {
        const stable = this.pending_external_target;
        if (!stable || this.dirty.size > 0) return;
        if (this.native_history_may_reference_source) {
            this.set_conflict({ type: 'externalChange' });
            return;
        }
        this.close_gesture();
        try {
            const source = await build_csv_source_with_delimiter(
                stable.bytes,
                this.delimiter_value,
                this.max_rows,
            );
            await this.adopt_source(
                stable.bytes,
                source,
                { stat: stable.stat, digest: stable.digest },
                this.identity_value,
                this.delimiter_value,
                'revert',
            );
        } catch {
            this.set_conflict({ type: 'externalChange' });
        }
    }

    private async record_external_target_after_save_conflict(): Promise<void> {
        let stable: CsvStableTarget;
        try {
            stable = await read_csv_target_stably(
                this.fs,
                this.identity_value.uri,
                this.max_file_size_bytes,
            );
        } catch {
            this.pending_external_target = undefined;
            this.set_conflict({ type: 'externalChange' });
            return;
        }
        if (stable.digest === this.target_basis_value.digest) {
            this.pending_external_target = undefined;
            this.set_conflict({ type: 'none' });
            return;
        }
        this.pending_external_target = stable;
        this.set_conflict({ type: 'externalChange' });
        await this.reconcile_observed_target_if_clean();
    }

    private record_save_error(error: unknown): void {
        if (!(error instanceof CsvSaveServiceError)) return;
        switch (error.code) {
            case 'externalChange':
                this.set_conflict({ type: 'externalChange' });
                break;
            case 'baseMismatch':
            case 'rowsRemoved':
                this.set_conflict({
                    type: 'dirtyBases',
                    reason: error.code,
                    keys: error.keys ?? [],
                });
                break;
            case 'truncated':
                this.set_conflict({ type: 'truncated' });
                break;
            case 'writeFailed':
            case 'verificationFailed':
                this.set_conflict({ type: 'writeFailure', reason: error.code });
                break;
            default:
                break;
        }
    }

    private async adopt_source(
        bytes: Uint8Array,
        source: CsvDataSource,
        basis: CsvTargetBasis,
        identity: ResourceIdentity,
        delimiter: ',' | '\t',
        reason: 'save' | 'revert',
    ): Promise<void> {
        const frozen_basis = freeze_target_basis(basis);
        let backup_budget: CsvDocumentBackupBudget;
        try {
            backup_budget = this.create_backup_budget(
                bytes,
                frozen_basis,
                identity,
                delimiter,
            );
        } catch (error) {
            close_source_best_effort(source);
            throw error;
        }
        const previous = this.source_value;
        this.source_bytes_value = bytes;
        this.source_value = source;
        this.target_basis_value = frozen_basis;
        this.pending_external_target = undefined;
        this.identity_value = identity;
        this.delimiter_value = delimiter;
        this.backup_budget = backup_budget;
        this.dirty.clear();
        this.dirty_backup_entry_bytes.clear();
        this.dirty_backup_bytes = 0;
        this.next_source_generation();
        if (reason === 'revert') this.next_mutation_epoch();
        // Revision stays stable across source adoption. Save also keeps the mutation
        // epoch so queued typing and native Redo can rebase onto the verified saved
        // source. Revert and clean external reload rotate it because positional keys
        // can now name semantically different cells even at the same revision.
        this.set_conflict({ type: 'none' });
        try {
            previous.close();
        } catch {
            // Ownership already transferred; a stale source cannot block adoption.
        }
        this.content_events.emit(Object.freeze({
            type: 'sourceReplaced' as const,
            revision: this.revision_value,
            sourceGeneration: this.source_generation_value,
                mutationEpoch: this.mutation_epoch_value,
            reason,
            resource: identity.uri,
        }));
    }

    private prepare_content(
        delimiter: ',' | '\t',
        destination: ResourceIdentity,
    ): PreparedCsvContent {
        const edits = new Map<string, string>();
        for (const [key, entry] of this.dirty) edits.set(key, entry.value);
        const header_line = delimiter !== this.delimiter_value
            && this.source_value.headerFields !== undefined
            ? serialize_csv_fields(this.source_value.headerFields, delimiter)
            : undefined;
        const result = prepare_csv_save_content({
            source: this.source_value,
            delimiter,
            edits,
            dirtyEntries: this.dirty,
            ...(header_line === undefined ? {} : { headerLine: header_line }),
        });
        if (result.type === 'rejected') {
            throw new CsvSaveServiceError(
                result.rejection.reason === 'rowsRemoved' ? 'rowsRemoved' : 'baseMismatch',
                result.rejection.reason === 'rowsRemoved'
                    ? 'Some edited rows no longer exist in the CSV source.'
                    : 'Some edited cells no longer match their source values.',
                { keys: result.rejection.keys },
            );
        }
        if (result.bytes.byteLength > this.max_file_size_bytes) {
            throw new CsvSaveServiceError(
                'tooLarge',
                `Saved CSV would exceed the configured ${this.max_file_size_bytes}-byte limit.`,
            );
        }
        // A successful save must remain hot-exit representable. Use the longest
        // finite JSON number spelling for mtime so the actual post-write basis
        // cannot make the clean envelope larger than this preflight.
        this.create_backup_budget(
            result.bytes,
            {
                stat: { size: result.bytes.byteLength, mtime: -Number.MAX_VALUE },
                digest: result.digest,
            },
            destination,
            delimiter,
        );
        return result;
    }

    private defer_following_operations_until_host_settles<T>(
        operation: Promise<T>,
        on_successful_host_settlement?: () => void,
        on_host_settled?: () => void,
    ): Promise<T> {
        let release_following!: () => void;
        let release_history!: () => void;
        let succeeded = false;
        const following_gate = new Promise<void>((resolve) => {
            release_following = resolve;
        });
        const history_boundary = new Promise<void>((resolve) => {
            release_history = resolve;
        });
        const settlement: HostSettlementGate = {
            historyTail: history_boundary,
            acceptingHistory: true,
        };
        this.host_settlement_gates.push(settlement);
        // Install the gate synchronously, before another renderer input can enqueue.
        this.operation_tail = this.operation_tail.then(
            () => following_gate,
            () => following_gate,
        );
        const tracked = operation.then((result) => {
            succeeded = true;
            return result;
        });
        return tracked.finally(() => {
            // VS Code must observe the lifecycle promise settling before a newer edit
            // event is emitted, or it can include that edit in the save/revert point.
            // A new event-loop turn is the deterministic boundary between those acts.
            setTimeout(() => {
                try {
                    if (succeeded) on_successful_host_settlement?.();
                } finally {
                    // Direct native callbacks accepted during settlement start at this
                    // boundary and drain before ordinary work already queued on the gate.
                    release_history();
                    void (async () => {
                        while (true) {
                            const history_tail = settlement.historyTail;
                            await history_tail;
                            if (history_tail !== settlement.historyTail) continue;
                            settlement.acceptingHistory = false;
                            const index = this.host_settlement_gates.indexOf(settlement);
                            if (index >= 0) this.host_settlement_gates.splice(index, 1);
                            release_following();
                            on_host_settled?.();
                            return;
                        }
                    })();
                }
            }, 0);
        });
    }

    save_for_host(cancellation?: CsvCancellation): Promise<CsvDocumentSaveResult> {
        return this.defer_following_operations_until_host_settles(this.save(cancellation));
    }

    private async save_current_resource(
        resource: ResourceUriLike,
        delimiter: ',' | '\t',
        cancellation?: CsvCancellation,
    ): Promise<CsvDocumentSaveResult> {
        this.close_gesture();
        let replacement: CsvDataSource | undefined;
        let adopted = false;
        try {
            const content = this.prepare_content(delimiter, this.identity_value);
            // Build the replacement before crossing the write boundary. Once
            // bytes are written, only target verification and synchronous
            // ownership transfer remain, even if cancellation arrives late.
            replacement = await build_csv_source_with_delimiter(
                content.bytes,
                delimiter,
                this.max_rows,
            );
            if (cancellation?.isCancellationRequested) {
                throw new CsvSaveServiceError('cancelled', 'CSV operation was cancelled.');
            }
            const result = await write_csv_target({
                fs: this.fs,
                resource,
                content,
                maxFileSizeBytes: this.max_file_size_bytes,
                expectedTarget: this.target_basis_value,
                cancellation,
                refresh: this.refresh_value,
            });
            await this.adopt_source(
                content.bytes,
                replacement,
                { stat: result.stat, digest: result.digest },
                this.identity_value,
                delimiter,
                'save',
            );
            adopted = true;
            return {
                ...result,
                revision: this.revision_value,
                sourceGeneration: this.source_generation_value,
                mutationEpoch: this.mutation_epoch_value,
            };
        } catch (error) {
            if (replacement && !adopted) close_source_best_effort(replacement);
            if (error instanceof CsvSaveServiceError && error.code === 'externalChange') {
                await this.record_external_target_after_save_conflict();
            } else {
                this.record_save_error(error);
            }
            throw error;
        }
    }

    async save(cancellation?: CsvCancellation): Promise<CsvDocumentSaveResult> {
        return this.admitted(async () => {
            this.assert_not_disposed();
            return this.save_current_resource(
                this.identity_value.uri,
                this.delimiter_value,
                cancellation,
            );
        });
    }

    save_as_for_host(
        resource: ResourceUriLike,
        options: { readonly delimiter?: ',' | '\t'; readonly cancellation?: CsvCancellation } = {},
    ): Promise<CsvDocumentSaveResult> {
        const reservation = this.reserve_save_as();
        const operation = this.save_as_operation(
            resource,
            options,
            reservation.preflightError,
        ).finally(reservation.releaseOperation);
        return this.defer_following_operations_until_host_settles(
            operation,
            undefined,
            reservation.releaseViewExclusion,
        );
    }

    async save_as(
        resource: ResourceUriLike,
        options: { readonly delimiter?: ',' | '\t'; readonly cancellation?: CsvCancellation } = {},
    ): Promise<CsvDocumentSaveResult> {
        const reservation = this.reserve_save_as();
        try {
            return await this.save_as_operation(resource, options, reservation.preflightError);
        } finally {
            reservation.releaseOperation();
            reservation.releaseViewExclusion();
        }
    }

    private save_as_operation(
        resource: ResourceUriLike,
        options: { readonly delimiter?: ',' | '\t'; readonly cancellation?: CsvCancellation },
        preflight_error?: Error,
    ): Promise<CsvDocumentSaveResult> {
        return this.admitted(async () => {
            this.assert_not_disposed();
            if (preflight_error) throw preflight_error;
            const identity = create_resource_identity(resource, this.identity_value.platform);
            const delimiter = options.delimiter ?? this.delimiter_value;
            const is_current_resource = identity.key === this.identity_value.key;
            if (is_current_resource) {
                return this.save_current_resource(
                    identity.uri,
                    delimiter,
                    options.cancellation,
                );
            }

            this.close_gesture();
            let destination_refresh: CsvDocumentRefreshSubscription | undefined;
            try {
                const content = this.prepare_content(delimiter, identity);
                destination_refresh = this.refresh_factory?.(identity);
                if (destination_refresh) this.transient_refreshes.add(destination_refresh);
                const result = await write_csv_target({
                    fs: this.fs,
                    resource: identity.uri,
                    content,
                    maxFileSizeBytes: this.max_file_size_bytes,
                    cancellation: options.cancellation,
                    refresh: destination_refresh,
                });
                if (destination_refresh) {
                    const dispose_destination_refresh = (): void => {
                        if (!this.transient_refreshes.delete(destination_refresh!)) return;
                        dispose_refresh_best_effort(destination_refresh);
                    };
                    const completion = result.postSaveCompletion;
                    if (completion) {
                        void completion.then(dispose_destination_refresh);
                    } else {
                        dispose_destination_refresh();
                    }
                }
                // VS Code opens the destination as a new custom document after
                // saveCustomDocumentAs. This original document remains bound to its
                // original URI, source, dirty overlay, and refresh subscription.
                return {
                    ...result,
                    revision: this.revision_value,
                    sourceGeneration: this.source_generation_value,
                    mutationEpoch: this.mutation_epoch_value,
                };
            } catch (error) {
                if (destination_refresh) {
                    this.transient_refreshes.delete(destination_refresh);
                    dispose_refresh_best_effort(destination_refresh);
                }
                this.record_save_error(error);
                throw error;
            }
        });
    }

    private async reload_from_target(cancellation?: CsvCancellation): Promise<void> {
        if (this.identity_value.uri.scheme.toLowerCase() === 'untitled') {
            if (cancellation?.isCancellationRequested) {
                throw new CsvSaveServiceError('cancelled', 'CSV operation was cancelled.');
            }
            const bytes = this.source_bytes_value.slice();
            const source = await build_csv_source_with_delimiter(
                bytes,
                this.delimiter_value,
                this.max_rows,
            );
            if (cancellation?.isCancellationRequested) {
                close_source_best_effort(source);
                throw new CsvSaveServiceError('cancelled', 'CSV operation was cancelled.');
            }
            await this.adopt_source(
                bytes,
                source,
                this.target_basis_value,
                this.identity_value,
                this.delimiter_value,
                'revert',
            );
            return;
        }
        const stable = await read_csv_target_stably(
            this.fs,
            this.identity_value.uri,
            this.max_file_size_bytes,
            cancellation,
        );
        const source = await build_csv_source_with_delimiter(
            stable.bytes,
            this.delimiter_value,
            this.max_rows,
        );
        if (cancellation?.isCancellationRequested) {
            close_source_best_effort(source);
            throw new CsvSaveServiceError('cancelled', 'CSV operation was cancelled.');
        }
        await this.adopt_source(
            stable.bytes,
            source,
            { stat: stable.stat, digest: stable.digest },
            this.identity_value,
            this.delimiter_value,
            'revert',
        );
    }

    revert_for_host(cancellation?: CsvCancellation): Promise<void> {
        return this.defer_following_operations_until_host_settles(
            this.revert(cancellation),
            () => {
                // The provider promise has settled and VS Code has had an event turn to
                // truncate native callbacks. Queued document work is still behind the
                // settlement gate until this reset completes.
                this.native_history_may_reference_source = false;
            },
        );
    }

    async revert(cancellation?: CsvCancellation): Promise<void> {
        return this.admitted(async () => {
            this.assert_not_disposed();
            this.close_gesture();
            await this.reload_from_target(cancellation);
        });
    }

    /**
     * Reconcile a watcher notification through the document queue. A fresh clean
     * document can adopt changed bytes immediately. Dirty documents, and clean documents
     * whose native callbacks may still reference this source epoch, retain stable evidence
     * until VS Code completes a Revert lifecycle.
     */
    async notify_external_change(): Promise<void> {
        return this.admitted(async () => {
            this.assert_not_disposed();
            try {
                const stable = await read_csv_target_stably(
                    this.fs,
                    this.identity_value.uri,
                    this.max_file_size_bytes,
                );
                if (stable.digest === this.target_basis_value.digest) {
                    this.pending_external_target = undefined;
                    if (this.conflict_value.type === 'externalChange') {
                        this.set_conflict({ type: 'none' });
                    }
                    return;
                }
                this.close_gesture();
                if (
                    this.dirty.size > 0
                    || this.native_history_may_reference_source
                ) {
                    this.pending_external_target = stable;
                    this.set_conflict({ type: 'externalChange' });
                    return;
                }
                this.pending_external_target = undefined;
                const source = await build_csv_source_with_delimiter(
                    stable.bytes,
                    this.delimiter_value,
                    this.max_rows,
                );
                await this.adopt_source(
                    stable.bytes,
                    source,
                    { stat: stable.stat, digest: stable.digest },
                    this.identity_value,
                    this.delimiter_value,
                    'revert',
                );
            } catch (error) {
                this.close_gesture();
                this.pending_external_target = undefined;
                this.set_conflict({ type: 'externalChange' });
                throw error;
            }
        });
    }

    async backup(): Promise<Uint8Array> {
        return this.admitted(() => {
            this.assert_not_disposed();
            // Native segments are immutable, so the hot-exit snapshot can freeze the
            // current overlay without ending the logical gesture. Later input emits a
            // fresh event (and therefore schedules another backup), while Escape can
            // still unwind both the pre-backup and post-backup segments exactly.
            return encode_csv_document_backup({
                identity: this.identity_value,
                delimiter: this.delimiter_value,
                targetBasis: this.target_basis_value,
                sourceBytes: this.source_bytes_value,
                dirtyEntries: this.dirty,
                maxRows: this.max_rows,
                limits: {
                    ...this.backup_limits,
                    maxSourceBytes: this.max_file_size_bytes,
                },
            });
        });
    }

    private resync_snapshot_value(): CsvDocumentResyncSnapshot {
        const dirty = Object.create(null) as Record<string, CsvDirtyEntry>;
        for (const [key, entry] of this.dirty) dirty[key] = entry;
        return Object.freeze({
            resource: this.identity_value.uri,
            revision: this.revision_value,
            sourceGeneration: this.source_generation_value,
            mutationEpoch: this.mutation_epoch_value,
            delimiter: this.delimiter_value,
            metadata: this.metadata,
            dirtyEntries: Object.freeze(dirty),
            conflict: this.conflict_value,
        });
    }

    async resync_view(
        view_id: string,
        mutation_epoch?: number,
        view_mutation_epoch?: number,
    ): Promise<CsvDocumentViewResyncSnapshot> {
        return this.admitted(() => {
            this.assert_not_disposed();
            let view = this.assert_view(view_id);
            if (
                mutation_epoch !== undefined
                && (!Number.isSafeInteger(mutation_epoch) || mutation_epoch < 1)
            ) {
                throw new RangeError('CSV document mutation epoch must be a positive safe integer.');
            }
            if (
                view_mutation_epoch !== undefined
                && (
                    !Number.isSafeInteger(view_mutation_epoch)
                    || view_mutation_epoch < 1
                )
            ) {
                throw new RangeError(
                    'CSV document view mutation epoch must be a positive safe integer.',
                );
            }
            if (
                view_mutation_epoch === undefined
                || view_mutation_epoch === view.viewMutationEpoch
            ) {
                view = {
                    viewMutationEpoch: this.rotate_view_mutation_epoch(view_id),
                };
                if (
                    mutation_epoch === undefined
                    || mutation_epoch === this.mutation_epoch_value
                ) {
                    this.close_gesture_for_view(view_id);
                }
            }
            return Object.freeze({
                ...this.resync_snapshot_value(),
                viewMutationEpoch: view.viewMutationEpoch,
            });
        });
    }

    async resync_snapshot(): Promise<CsvDocumentResyncSnapshot> {
        return this.admitted(() => {
            this.assert_not_disposed();
            return this.resync_snapshot_value();
        });
    }

    async viewer_snapshot(): Promise<CsvDocumentViewerSnapshot> {
        return this.admitted(async () => {
            this.assert_not_disposed();
            const source = await build_csv_source_with_delimiter(
                this.source_bytes_value,
                this.delimiter_value,
                this.max_rows,
            );
            try {
                const dirty = Object.create(null) as Record<string, CsvDirtyEntry>;
                for (const [key, entry] of this.dirty) dirty[key] = entry;
                return Object.freeze({
                    resource: this.identity_value.uri,
                    revision: this.revision_value,
                    sourceGeneration: this.source_generation_value,
                    mutationEpoch: this.mutation_epoch_value,
                    delimiter: this.delimiter_value,
                    metadata: this.metadata,
                    dirtyEntries: Object.freeze(dirty),
                    conflict: this.conflict_value,
                    sourceDigest: this.target_basis_value.digest,
                    source,
                });
            } catch (error) {
                close_source_best_effort(source);
                throw error;
            }
        });
    }

    async when_idle(): Promise<void> {
        for (;;) {
            const operation_tail = this.operation_tail;
            const native_history_tail = this.native_history_tail;
            const disposal = this.disposal;
            await Promise.allSettled([
                operation_tail,
                native_history_tail,
                ...(disposal ? [disposal] : []),
            ]);
            if (
                operation_tail === this.operation_tail
                && native_history_tail === this.native_history_tail
                && disposal === this.disposal
            ) return;
        }
    }

    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        this.disposal_requested = true;
        this.disposal = this.enqueue(() => {
            if (this.disposed) return;
            this.close_gesture();
            this.views.clear();
            try {
                this.source_value.close();
            } catch {
                // Disposal still fences the document when a source close misbehaves.
            }
            for (const refresh of this.transient_refreshes) {
                dispose_refresh_best_effort(refresh);
            }
            this.transient_refreshes.clear();
            try {
                this.refresh_value?.dispose();
            } catch {
                // Disposal is idempotent even when a host subscription misbehaves.
            }
            this.refresh_value = undefined;
            this.disposed = true;
            this.disposal_events.emit();
            this.edit_events.dispose();
            this.content_events.dispose();
            this.resync_events.dispose();
            this.conflict_events.dispose();
            this.disposal_events.dispose();
        });
        return this.disposal;
    }
}
