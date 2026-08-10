import { createHash } from 'crypto';
import { XlsxDataSource } from './data-source/xlsx-source';
import { XlsDataSource } from './data-source/xls-source';
import { CsvDataSource } from './data-source/csv-source';
import { ExcelHeaderDataSource } from './data-source/excel-header-source';
import type {
    DataSource,
    RenderedCell,
    WorkbookMeta,
} from './data-source/interface';
import {
    InvalidPersistedTransformError,
    TransformAdmissionLapsedError,
    ViewerPanelCore,
    adopt_source_into_core,
    clone_filter_entry,
    transform_states_equal,
    type PanelLike,
} from './panel-core';
import { PanelSession, type PanelAdoption } from './panel-session';
import {
    get_delimiter,
    type ConfigPort,
    type Disposable,
    type FileStat,
    type ViewerHost,
} from './host-ports';
import { create_resource_identity, type ResourceUriLike } from './resource-identity';
import { assert_safe_file_size, MAX_CSV_ROWS } from './spreadsheet-safety';
import { serialize_csv } from './serialize-csv';
import { validate_dirty_bases } from './csv-base-validation';
import type {
    AuthorityFileStateStore,
    FileStateSnapshot,
    FileStateWriteBasis,
} from './state';
import { compare_authority, same_authority } from './authority-order';
import {
    discard_authority,
    finalize_authority,
    stage_authority,
} from './state-authority';
import {
    normalize_host_state,
    plan_excel_candidate_state,
} from './excel-header-plan';
import {
    acquire_file_coordinator,
    type ExcelHeaderOperationReceipt,
    type FileAuthoritySnapshot,
    type FileRefreshEvent,
    type FileRefreshSubscriberResult,
    type PhysicalAuthorityCommitReceipt,
} from './file-coordinator';
import { reconcile_finalization } from './finalization-reconciliation';
import { SourceCandidate } from './source-candidate';
import {
    EMPTY_TRANSFORM,
    MAX_PERSISTED_HIDDEN_ROWS,
    MAX_PERSISTED_ROW_HEIGHTS,
    sanitize_excel_header_overrides,
    sheet_name_from_transform_schema,
    transform_has_entries,
    transform_is_active,
    transform_schema_for_sheet,
    type ActiveCsvSaveLifecycle,
    type CsvDirtyMap,
    type CsvSaveLifecycle,
    type CsvSaveOperation,
    type CsvSaveRejection,
    type HostMessage,
    type PerFileState,
    type SheetTransformState,
    type StoredPerFileState,
    type WebviewMessage,
} from './types';
import {
    normalize_sheet_state_array,
    sanitize_transform_state,
} from './webview/sheet-state';
import { sanitize_column_visibility_state } from './webview/column-projection';
// The host is now the only writer of durable heights, so the floor a resize is clamped
// against has to be applied here. Imported from the webview module that already owns it
// rather than restated: two copies of a minimum are two numbers that can drift, and the
// module is pure arithmetic with no DOM or Glide imports — the same reason
// `sanitize_transform_state` and `sanitize_column_visibility_state` above already cross
// this boundary.
import { clamp_row_height } from './webview/row-heights';
import {
    cell_highlight_states_equal,
    rebase_cell_highlight_digest,
    reconcile_physical_cell_highlights,
} from './cell-highlights';
import {
    apply_layout_state_patch,
    derive_layout_state_patch,
} from './layout-state-patch';
import {
    complete_normalized_per_file_state,
    normalize_workbook_snapshot_state,
    type NormalizedPerFileState,
    type WorkbookSnapshotIdentity,
} from './viewer-snapshot';

const SAVE_WINDOW = 10_000;

/** The host surface the controller needs: the core's `PanelLike` (postMessage)
 *  plus inbound messages. Both vscode.WebviewPanel and the unit-test mock panel
 *  satisfy it; html is set by the host before attaching. */
export interface ViewerHostPanel extends PanelLike {
    webview: PanelLike['webview'] & {
        onDidReceiveMessage(handler: (msg: WebviewMessage) => unknown): Disposable;
    };
}

export interface ViewerControllerScheduler {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface ViewerControllerOptions {
    readonly pendingEditFlushTimeoutMs?: number;
    readonly scheduler?: ViewerControllerScheduler;
}

export interface ViewerController extends Disposable {
    /** Refuse every new edit session before a shutdown/activation barrier begins. */
    stop_edit_admission(): void;
    /** Fence the current renderer and wait for its exact durable edit acknowledgement. */
    flush_pending_edits(): Promise<void>;
    /** Wait for all controller work admitted before the call to settle. */
    drain(): Promise<void>;
}

export interface ViewerProfile {
    /** Build a DataSource from freshly-read bytes. Throws are surfaced as errors. */
    build_source(
        raw: Uint8Array,
        file_path: string,
        state: PerFileState,
    ): Promise<DataSource>;
    /** Enables csvEditingSupported + saveCsv/pendingEdits/showSaveDialog handling. */
    readonly editing: boolean;
    /** Sets previewMode on the meta envelope (read-only synced preview). */
    previewMode?: boolean;
    /** Called after each (re)load adopts a source — preview refreshes its line map. */
    on_source_adopted?(source: DataSource): void;
    /** Handle a message the controller does not own (preview: visibleRowChanged).
     *  Return true if handled. */
    on_message?(msg: WebviewMessage): boolean | Promise<boolean>;
}

type CsvEditFilePhase =
    | { type: 'free' }
    | { type: 'claiming'; claim: symbol; token: symbol }
    | { type: 'owned'; token: symbol }
    | { type: 'releasing'; release: symbol; token: symbol }
    | { type: 'cleanupPending'; operation: symbol }
    | { type: 'uncertain'; operation: symbol };

type CsvEditStateSubscriber = (snapshot?: Readonly<FileStateSnapshot>) => void;

interface CsvEditFileState {
    attachments: number;
    phase: CsvEditFilePhase;
    /** Synchronously admitted transform work across every panel for this file. */
    readonly transformOperations: Set<symbol>;
    /** Panels whose current core has an active row transform installed. */
    readonly activeTransformPanels: Set<symbol>;
    /** Latest observed durable transform authority, ordered by file-state revision. */
    durableTransform: { revision: number; active: boolean };
    /** Failed operation retired by a session transition until its state is removed. */
    failedSaveTombstone?: CsvSaveOperation;
    failedSaveCleanup?: Promise<void>;
    /** State revisions at or below this boundary predate a completed edit clear. */
    clearedStateRevision?: number;
    recovery?: Promise<boolean>;
    readonly subscribers: Set<CsvEditStateSubscriber>;
}

// Edit ownership and post-write cleanup uncertainty are file-scoped. In
// particular, releasing one panel after a successful write must not allow a
// sibling panel to reclaim durable edits that have not yet been cleared.
const csv_edit_file_states = new Map<string, CsvEditFileState>();
let next_edit_session_host_epoch = 0;

function allocate_edit_session_id(file_key: string): string {
    next_edit_session_host_epoch += 1;
    return `${file_key}:host:${next_edit_session_host_epoch}`;
}

const RELOAD_RETRY_COUNT = 3;
const RELOAD_RETRY_MS = 50;
const READY_STATE_RETRY_COUNT = 3;
const READY_STATE_RETRY_MS = 50;
const READY_STATE_REBASE_COUNT = 16;
const EDIT_CLEANUP_RECOVERY_MS = 250;
const PENDING_EDIT_FLUSH_TIMEOUT_MS = 2_000;

/**
 * The one sentence a refused `setRowHeights` says, whichever bound it hit.
 *
 * There are two enforcement points and they cannot be merged — one counts the rows a
 * single request names, before `map_display_rows_to_source` allocates against them; the
 * other counts the map the file would end up holding, which only the durable state can
 * answer. But they are the same bound and the same disappointment, so they say the same
 * thing: a user who reached the limit by one select-all and a user who reached it by a
 * hundred small drags have the identical problem and the identical remedy.
 *
 * Names the number, on `MAX_HIGHLIGHTED_CELLS_PER_FILE`'s wording ("A file may contain
 * at most …"), because "too many" alone is a dead end — it tells the user they are over
 * a line without telling them where the line is, and there is no UI that shows them how
 * many custom heights the sheet already holds. Locale is pinned so the message is
 * stable in tests and in every host's log.
 */
const ROW_HEIGHT_LIMIT_WARNING =
    'Too many resized rows to persist: a sheet may keep at most '
    + `${MAX_PERSISTED_ROW_HEIGHTS.toLocaleString('en-US')} custom row heights.`;

function content_digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Log only a bounded machine code from host/storage failures. Native filesystem
 * errors commonly embed full paths in both `message` and `stack`; forwarding the
 * raw object would leak those paths (and potentially filenames) into extension
 * logs. The code is enough to distinguish expected failure classes without
 * retaining attacker-controlled text.
 */
function sanitized_error_code(error: unknown): string {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
        ? code
        : 'UNKNOWN';
}

function log_sanitized_failure(message: string, error: unknown): void {
    console.error(message, { code: sanitized_error_code(error) });
}

function is_file_not_found_error(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    return code === 'ENOENT' || code === 'FileNotFound';
}

type PhysicalAuthorityCommitResult =
    | { type: 'committed'; receipt: PhysicalAuthorityCommitReceipt }
    | { type: 'stale' }
    | { type: 'rejected' }
    | { type: 'advanced' };

interface PanelLoadRequest {
    readonly seq: number;
    readonly refreshEvent?: FileRefreshEvent;
}

interface CsvSaveHostOperation {
    readonly identity: CsvSaveOperation;
    phase: 'preparing' | 'accepted' | 'writing';
}

interface TransformAuthority {
    readonly authorityRevision: number;
    readonly receiverEpoch: number;
    readonly completion: Promise<void>;
    readonly resolveCompletion: () => void;
}

interface ReceiverRequest {
    readonly requestId: string;
    readonly receiverEpoch: number;
}

function same_snapshot_identity(
    left: WorkbookSnapshotIdentity,
    right: WorkbookSnapshotIdentity,
): boolean {
    return left.deliveryId === right.deliveryId
        && left.authority.fileId === right.authority.fileId
        && left.authority.revision === right.authority.revision
        && left.stateRevision === right.stateRevision
        && left.sourceBasis.physicalRevision === right.sourceBasis.physicalRevision
        && left.sourceBasis.projectionRevision === right.sourceBasis.projectionRevision;
}

function sheet_state_arrays_equal(
    left: readonly unknown[] | undefined,
    right: readonly unknown[] | undefined,
): boolean {
    const count = Math.max(left?.length ?? 0, right?.length ?? 0);
    for (let index = 0; index < count; index += 1) {
        if (JSON.stringify(left?.[index]) !== JSON.stringify(right?.[index])) {
            return false;
        }
    }
    return true;
}

function same_file_authority_basis(
    left: FileAuthoritySnapshot,
    right: FileAuthoritySnapshot,
): boolean {
    return left.fileKey === right.fileKey && same_authority(left, right);
}

function same_semantic_authority_basis(
    left: FileAuthoritySnapshot,
    right: FileAuthoritySnapshot,
): boolean {
    return left.fileKey === right.fileKey
        && left.authorityRevision === right.authorityRevision
        && left.physicalRevision === right.physicalRevision
        && left.projectionRevision === right.projectionRevision
        && left.physicalDigest === right.physicalDigest;
}

function excel_hidden_rows_for_source(
    sheets: readonly WorkbookMeta['sheets'][number][],
    transforms: PerFileState['transforms'],
): (number[] | undefined)[] {
    return sheets.map((sheet, index) => {
        const transform = transforms?.[index];
        if (sheet_name_from_transform_schema(transform?.schema) !== sheet.name) {
            return undefined;
        }
        return sanitize_transform_state(
            transform,
            sheet.columnCount,
            undefined,
            sheet.sourceRowCount,
        )?.hiddenRows;
    });
}

function excel_profile(): ViewerProfile {
    return {
        editing: false,
        async build_source(raw, file_path, state) {
            const physical = file_path.toLowerCase().endsWith('.xlsx')
                ? await XlsxDataSource.create(raw)
                : await XlsDataSource.create(Buffer.from(raw));
            const physical_sheets = physical.meta().sheets;
            return new ExcelHeaderDataSource(
                physical,
                sanitize_excel_header_overrides(state.excelFirstRowHeaders),
                excel_hidden_rows_for_source(physical_sheets, state.transforms),
            );
        },
    };
}

/** Build the editable CSV/TSV DataSource shared by the table and preview hosts.
 *  `csv_max_rows` comes from the host's ConfigPort; it is normalized to a
 *  finite non-negative integer and clamped to the hard safety cap either way,
 *  since CsvDataSource uses it as an array length. */
export function build_csv_source(
    raw: Uint8Array,
    file_path: string,
    csv_max_rows: number = MAX_CSV_ROWS,
): Promise<CsvDataSource> {
    const requested_max_rows = Number.isFinite(csv_max_rows)
        ? Math.floor(csv_max_rows)
        : MAX_CSV_ROWS;
    const max_rows = Math.max(0, Math.min(requested_max_rows, MAX_CSV_ROWS));
    // CSV/TSV files conventionally carry column names in their first row, so the
    // grid promotes it to the column header rather than showing letters.
    return CsvDataSource.create(raw, get_delimiter(file_path), max_rows, {
        firstRowIsHeader: true,
    });
}

export function csv_table_profile(config?: ConfigPort): ViewerProfile {
    return {
        editing: true,
        build_source: (raw, file_path) =>
            build_csv_source(raw, file_path, config?.csv_max_rows()),
    };
}

/** Profile for a path, by extension: csv/tsv → editable table; else Excel viewer. */
export function profile_for(file_path: string, config?: ConfigPort): ViewerProfile {
    const ext = file_path.toLowerCase();
    return ext.endsWith('.csv') || ext.endsWith('.tsv')
        ? csv_table_profile(config)
        : excel_profile();
}

/**
 * Wire a webview panel to a file: initial load on `ready`, live reload via a
 * directory watcher with a monotonic guard, paginated row serving (via the
 * core), and — for editing profiles — save/conflict/pending-edit handling.
 * Returns a Disposable that tears everything down. The host sets webview html
 * and options before calling this, and injects its port implementations via
 * `host` (the extension passes `vscode_viewer_host`).
 */
export function attach_viewer(
    panel: ViewerHostPanel,
    resource: ResourceUriLike | string,
    state_store: AuthorityFileStateStore,
    profile: ViewerProfile,
    host: ViewerHost,
    options: ViewerControllerOptions = {},
): ViewerController {
    const uri = create_resource_identity(resource).uri;
    const file_path = uri.fsPath;
    const scheduler: ViewerControllerScheduler = options.scheduler ?? {
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const pending_edit_flush_timeout_ms = Math.max(
        0,
        options.pendingEditFlushTimeoutMs ?? PENDING_EDIT_FLUSH_TIMEOUT_MS,
    );
    // VS Code may make panel.webview throw as soon as the panel is disposed.
    // Capture the live transport once; every later post is liveness-gated below.
    const webview = panel.webview;
    const disposables: Disposable[] = [];
    const durable_state_store = state_store;
    const file_coordinator = acquire_file_coordinator(uri, durable_state_store);
    const state_path = file_coordinator.statePath;
    const file_key = file_coordinator.authority().fileKey;
    let file_edit_state = profile.editing
        ? csv_edit_file_states.get(file_key)
        : undefined;
    if (profile.editing && !file_edit_state) {
        file_edit_state = {
            attachments: 0,
            phase: { type: 'free' },
            transformOperations: new Set(),
            activeTransformPanels: new Set(),
            durableTransform: { revision: -1, active: false },
            subscribers: new Set(),
        };
        csv_edit_file_states.set(file_key, file_edit_state);
    }
    if (file_edit_state) file_edit_state.attachments += 1;

    // Borrowed aliases are updated only at the same synchronous boundary as the
    // session adoption. PanelSession remains the sole source/core lifecycle owner.
    let core: ViewerPanelCore | undefined;
    let source: DataSource | undefined;
    let source_authority = file_coordinator.authority();
    const transform_authorities = new Map<
        Extract<WebviewMessage, { type: 'setTransform' }>,
        TransformAuthority
    >();
    const latest_transform_authority_by_sheet = new Map<number, TransformAuthority>();
    const transform_commit_barriers = new Set<TransformAuthority>();
    let load_seq = 0;
    let latest_refresh_event: FileRefreshEvent | undefined;
    let disposed = false;
    let active_save_operation: CsvSaveHostOperation | undefined;
    let active_save_drain: Promise<void> = Promise.resolve();
    let disposal_edit_release_drain: Promise<void> = Promise.resolve();
    // Save identities whose edits `persist_accepted_save` wrote into durable state.
    // A failed save only needs a tombstone if it got that far; see the write site in
    // `release_edit_session`. Weak so a retired operation's entry goes with it —
    // `save_lifecycle.operation` is the only strong reference either way.
    const persisted_save_identities = new WeakSet<CsvSaveOperation>();
    const pending_rehydration_rejections = new WeakMap<PanelAdoption, {
        readonly operation: CsvSaveOperation;
        readonly rejection: CsvSaveRejection;
    }>();
    let save_lifecycle: CsvSaveLifecycle = Object.freeze({
        revision: 0,
        state: 'idle',
    });
    let active_edit_session_request: ReceiverRequest | undefined;
    let edit_admission_closed = false;
    let active_edit_claim: symbol | undefined;
    let active_save_dialog_request: (ReceiverRequest & {
        readonly editSessionId: string;
    }) | undefined;
    let pending_edit_writes: Promise<void> = Promise.resolve();
    let pending_edit_sequence_session_id: string | undefined;
    let highest_pending_edit_sequence = 0;
    let highest_acknowledged_edit_sequence = 0;
    const pending_edit_admissions = new Set<symbol>();
    let renderer_ready = false;
    let renderer_protocol_epoch = 0;
    let next_pending_edit_flush_request = 0;
    const pending_edit_flush_waiters = new Map<string, {
        resolve: (result: { editSessionId?: string; sequence: number }) => void;
        reject: (error: Error) => void;
    }>();
    const pending_edit_ack_waiters = new Set<{
        editSessionId: string;
        sequence: number;
        resolve: () => void;
        reject: (error: Error) => void;
    }>();
    let active_edit_release: {
        readonly editSessionId: string;
        readonly release: symbol;
        readonly completion: Promise<void>;
    } | undefined;
    let layout_write_tail: Promise<void> = Promise.resolve();
    let layout_basis: {
        identity: WorkbookSnapshotIdentity;
        state: NormalizedPerFileState;
    } | undefined;
    let reload_retry_attempts = 0;
    let reload_retry_timer: ReturnType<typeof setTimeout> | undefined;
    let refresh_retry_wait: {
        timer: ReturnType<typeof setTimeout>;
        resolve: (proceed: boolean) => void;
    } | undefined;
    const ready_state_retry_waits = new Set<{
        timer: ReturnType<typeof setTimeout>;
        resolve: (proceed: boolean) => void;
    }>();
    const edit_cleanup_waiters = new Map<symbol, {
        timer: ReturnType<typeof setTimeout>;
        resolve: (recovered: boolean) => void;
    }>();
    let current_edit_cleanup_waiter: symbol | undefined;
    const edit_session_token = Symbol(file_key);
    const transform_panel_token = Symbol(file_key);
    let active_edit_session_id: string | undefined;
    const excel_header_subscriber_token = Symbol(file_key);
    const cell_highlight_subscriber_token = Symbol(file_key);
    const header_receipt_queue: ExcelHeaderOperationReceipt[] = [];
    let header_receipt_processing = false;
    let header_refresh_scheduled = false;
    const released_sources = new WeakSet<DataSource>();
    const released_cores = new WeakSet<ViewerPanelCore>();

    function reject_pending_edit_protocol(error: Error): void {
        for (const waiter of pending_edit_flush_waiters.values()) waiter.reject(error);
        pending_edit_flush_waiters.clear();
        for (const waiter of pending_edit_ack_waiters) waiter.reject(error);
        pending_edit_ack_waiters.clear();
    }

    function resolve_pending_edit_ack_waiters(): void {
        for (const waiter of pending_edit_ack_waiters) {
            if (
                pending_edit_sequence_session_id !== waiter.editSessionId
                || highest_acknowledged_edit_sequence < waiter.sequence
            ) continue;
            pending_edit_ack_waiters.delete(waiter);
            waiter.resolve();
        }
    }

    function wait_for_pending_edit_ack(edit_session_id: string, sequence: number): Promise<void> {
        if (
            pending_edit_sequence_session_id === edit_session_id
            && highest_acknowledged_edit_sequence >= sequence
        ) return Promise.resolve();
        if (disposed) return Promise.reject(new Error('Viewer controller is disposed.'));
        return new Promise<void>((resolve, reject) => {
            pending_edit_ack_waiters.add({
                editSessionId: edit_session_id,
                sequence,
                resolve,
                reject,
            });
        });
    }

    function post_to_receiver(
        message: HostMessage,
        receiver_epoch?: number,
    ): Promise<boolean> {
        if (
            disposed
            || (receiver_epoch !== undefined
                && receiver_epoch !== session.current_receiver_epoch)
        ) return Promise.resolve(false);
        try {
            return Promise.resolve(webview.postMessage(message)).catch(() => false);
        } catch {
            return Promise.resolve(false);
        }
    }

    const session = new PanelSession({
        postMessage: (message) => post_to_receiver(message),
        onNeedsResyncSource: () => { void refresh_panel_source(true); },
        onCurrentAdoptionAcknowledged: (adoption) => {
            if (disposed || session.current_adoption() !== adoption) return;
            const rehydration_rejection = pending_rehydration_rejections.get(adoption);
            pending_rehydration_rejections.delete(adoption);
            if (
                rehydration_rejection
                && edit_message_is_current(rehydration_rejection.operation.editSessionId)
            ) {
                const active = begin_save_lifecycle(rehydration_rejection.operation);
                const lifecycle = finish_save_lifecycle(active.operation, 'failed');
                void post_to_receiver({
                    type: 'saveResult',
                    success: false,
                    lifecycle,
                    rejection: rehydration_rejection.rejection,
                }, session.current_receiver_epoch);
                // This host-generated verdict did not lock or persist a save. Keep
                // the failed envelope only long enough to deliver the existing
                // rejection protocol; future snapshots must not treat its partial
                // validated map as save hydration authority.
                retire_save_lifecycle(
                    rehydration_rejection.operation.editSessionId,
                    'failed',
                );
            }
            const digest = adoption.source === 'commitReceipt'
                ? adoption.receipt.resultingBasis.physicalDigest
                : adoption.authority.physicalDigest;
            for (const [index, warning] of (adoption.warnings ?? []).entries()) {
                const basis = digest
                    ?? (adoption.source === 'commitReceipt'
                        ? adoption.receipt.resultingBasis.physicalRevision
                        : adoption.authority.physicalRevision);
                if (file_coordinator.mark_warning_seen(`${basis}:${index}:${warning}`)) {
                    host.ui.show_warning(warning);
                }
            }
        },
        onAdoptionReleased: (adoption) => {
            const current = session.current_adoption();
            let first_error: unknown;
            if (
                current?.resources.core !== adoption.resources.core
                && !released_cores.has(adoption.resources.core)
            ) {
                released_cores.add(adoption.resources.core);
                try {
                    adoption.resources.core.dispose();
                } catch (error) {
                    first_error = error;
                }
            }
            if (
                current?.resources.source !== adoption.resources.source
                && !released_sources.has(adoption.resources.source)
            ) {
                released_sources.add(adoption.resources.source);
                try {
                    adoption.resources.source.close();
                } catch (error) {
                    first_error ??= error;
                }
            }
            if (first_error !== undefined) throw first_error;
        },
    });

    const abort_setup = (error: unknown): never => {
        disposed = true;
        const cleanup = (action: () => void) => {
            try {
                action();
            } catch {
                // Preserve the setup failure while completing best-effort teardown.
            }
        };
        cleanup(() => {
            file_edit_state?.activeTransformPanels.delete(transform_panel_token);
        });
        cleanup(() => session.dispose());
        for (const disposable of [...disposables].reverse()) {
            cleanup(() => disposable.dispose());
        }
        cleanup(() => file_coordinator.dispose());
        if (file_edit_state) {
            file_edit_state.attachments = Math.max(0, file_edit_state.attachments - 1);
            delete_shared_edit_state_if_unused();
        }
        throw error;
    };

    try {
        disposables.push(host.config.on_font_change(() => {
            void post_to_receiver({
                type: 'fontChanged',
                fontFamily: host.config.font_family(),
                fontSize: host.config.font_size(),
            });
        }));
    } catch (error) {
        return abort_setup(error);
    }

    if (file_edit_state) {
        const edit_state_subscriber: CsvEditStateSubscriber = (snapshot) => {
            if (disposed) return;
            if (snapshot) update_session_state_material(snapshot, false);
            session.recapture_current_projection({ deliver: true });
        };
        file_edit_state.subscribers.add(edit_state_subscriber);
        disposables.push({
            dispose() {
                file_edit_state?.subscribers.delete(edit_state_subscriber);
            },
        });
    }

    // Subscribe before the panel can become ready. Coordinator events may build
    // and install a panel-local source pre-ready; PanelSession defers delivery.
    const refresh_subscription = (() => {
        try {
            return file_coordinator.subscribe_refresh(
                refresh_from_event,
                host.refreshWatcherFactory,
            );
        } catch (error) {
            return abort_setup(error);
        }
    })();
    disposables.push(refresh_subscription);

    function edit_phase(): CsvEditFilePhase {
        return file_edit_state?.phase ?? { type: 'free' };
    }

    function edit_cleanup_blocked(): boolean {
        const phase = edit_phase();
        return phase.type === 'cleanupPending' || phase.type === 'uncertain';
    }

    /**
     * A save in flight refuses transform work regardless of edit phase: the save
     * validated every edit's base against the natural source and is about to
     * write those bytes, so a permutation landing in between would be persisted
     * against a basis the save never saw.
     *
     * Both halves are checked because they answer different questions and no
     * single site owns both. `active_save_operation` is the host's own
     * preparing → accepted → writing reference, and outlives the terminal
     * lifecycle transition: after a successful write the lifecycle already reads
     * 'succeeded' while the operation stays live until `begin_edit_cleanup`
     * clears it. `save_lifecycle.state === 'active'` is the window the webview
     * has been told about, and is what a future path clearing the operation
     * before posting its terminal lifecycle would still expose. Today they
     * overlap almost exactly; the redundancy is deliberate, because a false
     * refusal is a momentary no-op while a false admit corrupts durable state.
     */
    function save_blocks_transform(): boolean {
        return active_save_operation !== undefined
            || save_lifecycle.state === 'active';
    }

    /**
     * Transform work is mid-flight across state I/O somewhere on this file:
     * `compute_transform` yields at cancellation checkpoints and publishes the
     * resulting rules through the shared state store, so anything that crosses
     * state I/O concurrently races the operation that is about to replace the row
     * basis. Genuine file-level concurrency.
     *
     * This is a *fact*, not a policy. It used to be consulted through one shared
     * predicate by four editing-side sites that turned out to be asking four
     * different questions — the conflation review round 6 spent three findings on
     * — so each site now names its own: `may_begin_editing`,
     * `may_retain_capability`, `may_reserve_claim` and `may_rehydrate_session`.
     * Two of those answers coincide today, one adds an owner escape, and one does
     * not consult this fact at all. Anything that reads this predicate directly is
     * therefore stating that concurrency is the whole of its question — which is
     * true of `handle_save`, the mirror of `save_blocks_transform()`.
     *
     * Deliberately *not* included: `activeTransformPanels` and
     * `durableTransform.active`, i.e. a transform that is merely **installed**.
     * That used to block editing because the dirty map was keyed by display row,
     * so typing under a permutation wrote the wrong source row. #110 made edits
     * source-keyed and retired that hazard: an installed sort or filter is now
     * just a view, and editing under one is safe precisely because the
     * permutation never recomputes during a live session — rows stay put.
     *
     * The mirror of this predicate is `save_blocks_transform()`: transforms
     * refuse during a save, saves and edit claims refuse during transform work.
     * Both directions read the same in-flight set, `transformOperations`.
     */
    function transform_work_in_flight(): boolean {
        return !!file_edit_state && file_edit_state.transformOperations.size > 0;
    }

    /**
     * May a panel holding no session *start* one?
     *
     * No while transform work is in flight. Starting a session is a new,
     * user-initiated request, and the operation in flight is about to publish a
     * different row basis through the same state store the grant reads and writes;
     * admitting across that hands the user an editor over rows being renumbered
     * underneath it. A transform merely *installed* is not a reason — edits are
     * source-keyed and an installed permutation never recomputes during a live
     * session, so entering edit mode under a sort moves nothing.
     *
     * The refusal is transient by construction, and the request is *dropped* rather
     * than queued: replaying an edit-mode entry a moment later would open an editor
     * over a view the user has since moved on from.
     */
    function may_begin_editing(): boolean {
        return !transform_work_in_flight();
    }

    /**
     * May this panel be told it still has the edit capability — `csvEditable`?
     *
     * The owner: yes, unconditionally. Rows deliberately stay put mid-edit, so a
     * sort the user installs in the very panel they are editing must not revoke the
     * capability and eject them from edit mode. This is exactly why the answer
     * cannot be `may_begin_editing()`: an existing session's capability has to
     * survive the same condition that refuses a fresh start.
     *
     * A non-owner: only from a free phase with no work in flight. `csvEditable` is
     * also the one signal a sibling's webview watches to retry a transform restore
     * that was refused while the owner held the session, so it has to go true again
     * the moment the session is released — holding it false for the lifetime of an
     * *installed* sort would strand that sibling's grid under a toolbar showing
     * rules it never received.
     */
    function may_retain_capability(): boolean {
        const phase = edit_phase();
        if (phase.type === 'owned' && phase.token === edit_session_token) return true;
        return !transform_work_in_flight() && phase.type === 'free';
    }

    // Teardown safety, not editing availability: `activeTransformPanels` is a
    // live registration on this shared record, so deleting the record while one
    // is present would drop it. Editing no longer consults it.
    function shared_edit_state_is_unused(): boolean {
        return !!file_edit_state
            && file_edit_state.attachments === 0
            && file_edit_state.phase.type === 'free'
            && file_edit_state.transformOperations.size === 0
            && file_edit_state.activeTransformPanels.size === 0
            && file_edit_state.failedSaveTombstone === undefined
            && file_edit_state.failedSaveCleanup === undefined
            && file_edit_state.recovery === undefined;
    }

    function delete_shared_edit_state_if_unused(): void {
        if (shared_edit_state_is_unused()) csv_edit_file_states.delete(file_key);
    }

    /**
     * The durable pending edits this panel last observed. Latched rather than read,
     * because `installed_view` builds its record synchronously and an install must
     * not gain a state read it did not need before.
     *
     * Staleness here is bounded rather than benign, and the distinction matters: this
     * can lag the live dirty map by the webview's persistence debounce, and an edit
     * typed *while a hiding transform computed* really is one of the hidden ones even
     * though it was on screen when it was typed. What makes the lag harmless is that
     * the answer is recomputed on every delivery rather than only at an install, and
     * the durable write that ends the lag triggers one — see
     * `PanelCore.snapshot_material` and `WorkbookSnapshot.hiddenEditedCellKeys`.
     */
    let durable_pending_edits: PerFileState['pendingEdits'];

    /**
     * The durable custom row heights this panel last observed, latched for the same
     * reason as `durable_pending_edits`: `installed_view` builds its record
     * synchronously, on paths (an install, a snapshot delivery) that must not acquire a
     * state read they did not need before.
     *
     * Staleness here is bounded by the write that ends it, and the bound is tighter than
     * the pending-edit one because there is no debounce in the way: the host is the only
     * writer of heights, every write goes through `update_file_state`, and that calls
     * `observe_durable_state` on the committed snapshot before it returns — so the latch
     * is fresh by the time the `setRowHeights` handler asks for a re-delivery.
     */
    let durable_row_heights_state: StoredPerFileState['rowHeights'];
    /**
     * Revision of the read `durable_row_heights_state` came from, so an older read
     * finishing late cannot replace a newer one. The pending-edit latch gets this from
     * `file_edit_state.durableTransform.revision`; heights are latched outside that
     * record — see below — so they carry their own.
     *
     * Also the core's memo key for the projection, which is the second reason it has to
     * be a real durable revision rather than a local counter: see
     * `DurableRowHeightsProvider`.
     *
     * The comparison itself is unfalsifiable today, in both directions — a mutation audit
     * removed the guard entirely and then tightened it from `>=` to `>`, and nothing
     * failed either way. Recorded rather than trimmed, and the two halves fail differently
     * if the ordering it assumes ever stops holding. Dropping the guard lets an older read
     * that resolves late overwrite a newer latch, which regresses the delivered projection
     * to heights the file no longer has. Tightening it to `>` refuses a *same*-revision
     * re-read, which is the ordinary case — `read_file_state` is not serialized, so several
     * callers legitimately observe one revision — and would leave the retention above
     * comparing against a map it never refreshed. `>=` is the pair of those: never go
     * backwards, always accept the newest read of the current revision.
     */
    let durable_row_heights_revision = -1;

    /**
     * `incoming`, but with each sheet's map replaced by the latched one it is equal to.
     *
     * Identity is the core's per-sheet memo key (`memoized_row_height_projection`), and
     * without this that key is defeated on every real read. The store structured-clones
     * state on read and on CAS commit, so a snapshot always brings *fresh* map objects,
     * even for sheets nothing touched: sorting sheet B would reproject sheet A, which is
     * the cost the per-sheet memo exists to remove. In tests backed by an object the
     * memo appeared to work, which is exactly the shape of bug that ships.
     *
     * Compared by content rather than assumed, and the comparison is the cheap half of
     * what it saves. It is O(entries) with an early exit on the key count, over maps
     * bounded by `MAX_PERSISTED_ROW_HEIGHTS` for anything this version wrote — and for a
     * pre-cap legacy map it is one pass to avoid a walk *plus* an allocation plus every
     * downstream reprojection for the rest of the file's life. The common case is that
     * nothing changed, which is the case it makes fastest.
     *
     * Correctness does not rest on this: a missed retention costs a recomputation, never
     * a wrong answer, since the memo verifies the mapping generation separately and a
     * fresh identity simply misses.
     */
    function retained_row_height_maps(
        previous: StoredPerFileState['rowHeights'],
        incoming: StoredPerFileState['rowHeights'],
    ): StoredPerFileState['rowHeights'] {
        if (!previous || !incoming || previous === incoming) return incoming;
        // Both shapes are latched un-normalized (see below), so both are handled here
        // rather than after the array conversion — the conversion happens per *read* in
        // `durable_row_heights` and shares the maps by reference, so retaining identity
        // at this level is what carries through it. Keyed alike either way: an array
        // indexes by sheet position, a `LegacyPerFileState` by sheet name, and a slot only
        // ever retains against the same key.
        const keys = Array.isArray(incoming)
            ? incoming.map((_entry, index) => index)
            : Object.keys(incoming);
        const read = (
            source: NonNullable<StoredPerFileState['rowHeights']>,
            key: string | number,
        ): Record<number, number> | undefined => (
            (source as Record<string | number, Record<number, number> | undefined>)[key]
        );
        let next: NonNullable<StoredPerFileState['rowHeights']> | undefined;
        for (const key of keys) {
            const before = read(previous, key);
            const after = read(incoming, key);
            if (before === after || before === undefined || after === undefined) continue;
            if (!row_height_maps_equal(before, after)) continue;
            next ??= Array.isArray(incoming) ? [...incoming] : { ...incoming };
            (next as Record<string | number, Record<number, number>>)[key] = before;
        }
        return next ?? incoming;
    }

    /** Whether two durable height maps hold the same entries. */
    function row_height_maps_equal(
        a: Record<number, number>,
        b: Record<number, number>,
    ): boolean {
        const a_keys = Object.keys(a);
        if (a_keys.length !== Object.keys(b).length) return false;
        for (const key of a_keys) {
            const left = (a as Record<string, number>)[key];
            if (left !== (b as Record<string, number>)[key]) return false;
            // `hasOwnProperty` is not needed beside that: a key absent from `b` reads as
            // `undefined`, which cannot equal a value `a` holds — the maps are numbers,
            // and a non-finite entry never reaches durable state (the write path rejects
            // it and the projection skips it).
        }
        return true;
    }

    /** Latched facts about durable state, refreshed on every read of it. */
    function observe_durable_state(snapshot: Readonly<FileStateSnapshot>): void {
        const state = snapshot.state as PerFileState;
        // Ahead of the edit-state guard below, deliberately. `file_edit_state` exists
        // only for editable files, i.e. CSV, and only once something has asked to edit
        // one; row heights are a property of every format. Latched after that guard,
        // Excel would observe heights exactly never, and the projection every delivery
        // carries would be permanently empty — custom heights would silently stop
        // working on the format that has the most rows to resize.
        //
        // Latched *un-normalized*, and normalized in `durable_row_heights` below rather
        // than here. `PerFileState.rowHeights` is an array indexed by sheet, but a
        // `LegacyPerFileState` on disk holds the same data keyed by sheet *name*, and
        // turning one into the other needs the sheet names — which this function has no
        // reliable access to. It runs on every durable read, including reads that happen
        // before a source is adopted and reads taken across an adoption, so any sheet
        // names it reached for could be the wrong workbook's or absent entirely. Deferring
        // costs nothing: the conversion is O(sheets) and does not touch the height maps.
        if (snapshot.revision >= durable_row_heights_revision) {
            durable_row_heights_revision = snapshot.revision;
            durable_row_heights_state = retained_row_height_maps(
                durable_row_heights_state,
                (snapshot.state as StoredPerFileState).rowHeights,
            );
        }
        if (
            !file_edit_state
            || snapshot.revision < file_edit_state.durableTransform.revision
        ) return;
        file_edit_state.durableTransform = {
            revision: snapshot.revision,
            active: state.transforms?.some(transform_is_active) ?? false,
        };
        durable_pending_edits = state.pendingEdits;
    }

    /**
     * Keys of the durable pending edits the *current* session owns, which is what
     * `hiddenEditedCellKeys` is drawn from. Scoped through
     * `pending_edits_for_current_session` so a retired save's or another session's
     * tombstoned entries — durably present but not this session's to show — cannot
     * be counted as work the user is holding.
     *
     * No sheet qualification, because there is none to give: `pendingEdits` is
     * file-scoped, and CSV — the one editable format — has exactly one sheet.
     */
    function durable_pending_edit_keys(): readonly string[] {
        const scoped = pending_edits_for_current_session(durable_pending_edits);
        return scoped ? Object.keys(scoped) : [];
    }

    /**
     * The durable per-sheet custom row heights, keyed by canonical source row, for the
     * core's display-keyed projection to re-key.
     *
     * Unscoped and unfiltered, unlike `durable_pending_edit_keys`. Heights are not
     * session-owned work: there is no claim over them, no tombstoning, and no other
     * panel whose heights these might be — every panel on this file shows the same
     * heights, which is the point of persisting them. So there is nothing to narrow and
     * the latch is the answer.
     *
     * Normalized here, on the way out, because this is the first point at which the sheet
     * names are known to be the right ones: the core passes its own source's names, so the
     * array returned is indexed by the same sheet indices the core is about to project.
     * The normalization matters and is not cosmetic — a `LegacyPerFileState` keeps this map
     * keyed by sheet *name*, and handing that through unconverted makes every index lookup
     * `undefined`, i.e. every height a user persisted under an older version silently
     * disappears on open. Silently and *durably-looking*: an unchanged state is not
     * necessarily rewritten, so nothing later restores what the first read failed to see.
     *
     * `normalize_sheet_state_array` rather than the whole-state normalizers
     * (`normalize_host_state`, `complete_normalized_per_file_state`) because this runs on
     * the core's memo-key path. Those sanitize transforms, column visibility and the whole
     * pending-edit map, which is work this question does not need. The array conversion is
     * O(sheets) and shares the height maps by reference rather than copying them, so it is
     * cheap even for the unbounded legacy maps the memo exists to cope with.
     */
    function durable_row_heights(sheet_names: readonly string[]): {
        readonly revision: number;
        readonly heights: readonly (Record<number, number> | undefined)[];
    } {
        return {
            revision: durable_row_heights_revision,
            heights: normalize_sheet_state_array<Record<number, number>>(
                durable_row_heights_state,
                [...sheet_names],
            ),
        };
    }

    function sync_active_transform_panel(): void {
        if (!file_edit_state) return;
        if (core?.has_active_transform) {
            file_edit_state.activeTransformPanels.add(transform_panel_token);
        } else {
            file_edit_state.activeTransformPanels.delete(transform_panel_token);
        }
    }

    type TransformAdmission =
        | { readonly operation: symbol }
        | { readonly refusal: string };

    /**
     * Which edit phases admit transform work, and why the rest do not. The
     * trailing `never` assignment is what makes adding a phase to
     * `CsvEditFilePhase` a compile error here rather than a silent admit: this
     * project does not set `noImplicitReturns`, so a bare `switch` with no
     * `default` would let a new phase fall through and return `undefined` —
     * which means "admit". The unreachable branch still refuses, so even a
     * compile run that someone forces through cannot admit under an unknown
     * phase.
     *
     * `owned` admits only the panel holding the session. A sibling's sort would
     * recompute the permutation and publish it to durable state, moving the
     * owner's rows out from under them mid-edit — the exact thing stable-rows
     * editing exists to prevent. The owner's own request is different in kind:
     * the user, in the panel they are editing, changing their own view. Rows do
     * not move for edits already made, because an installed transform never
     * recomputes during a live session.
     */
    function admit_transform_for_phase(phase: CsvEditFilePhase): string | undefined {
        switch (phase.type) {
            case 'free':
                return undefined;
            case 'owned':
                // The owning panel only; see above.
                return phase.token === edit_session_token
                    ? undefined
                    : 'Another panel is editing this file.';
            case 'claiming':
                // A claim is mid-flight across state I/O. Admitting here lets a
                // transform overtake the very reservation `reserve_edit_claim`
                // exists to serialize.
                return 'Finishing edit-session work; try again in a moment.';
            case 'releasing':
                // `release_edit_session` is still awaiting `pending_edit_writes`;
                // durable pending edits may yet be written.
                return 'Finishing edit-session work; try again in a moment.';
            case 'cleanupPending':
                // A post-write state clear is in flight and
                // `clearedStateRevision` is not yet recorded, so a transform
                // write would race the CAS clear.
                return 'Finishing edit-session work; try again in a moment.';
            case 'uncertain':
                // Durable pending-edit state may or may not exist. Never admit
                // under unknown durable state.
                return 'Finishing edit-session work; try again in a moment.';
        }
        const exhaustive: never = phase;
        void exhaustive;
        console.error('Unhandled CSV edit phase in transform admission');
        return 'Finishing edit-session work; try again in a moment.';
    }

    function begin_transform_admission(): TransformAdmission {
        // No shared edit state means no edit session can exist for this file, so
        // there is nothing to serialize against.
        if (!file_edit_state) return { operation: Symbol(file_key) };
        if (save_blocks_transform()) {
            return {
                refusal: 'Wait for the save to finish before sorting, filtering, or hiding rows.',
            };
        }
        const refusal = admit_transform_for_phase(file_edit_state.phase);
        if (refusal !== undefined) return { refusal };
        const operation = Symbol(file_key);
        file_edit_state.transformOperations.add(operation);
        return { operation };
    }

    function finish_transform_admission(operation: symbol): void {
        if (!file_edit_state) return;
        sync_active_transform_panel();
        file_edit_state.transformOperations.delete(operation);
        delete_shared_edit_state_if_unused();
    }

    /**
     * The admission question, asked again at the commit boundary. Admission at
     * entry is not enough, because the phase can change under an operation that is
     * already in flight: `may_rehydrate_session()` answers yes unconditionally — a
     * reopened panel holding durable pending edits gets its session back, because
     * refusing to represent existing user work is data loss — so the phase can go
     * from `free` to `owned` by *another* panel while a transform computes.
     * Persisting then would put new rules into durable state, the reopened owner's
     * restore effect would install them, and the rows would move under a live edit
     * session: exactly what admitting transforms only from the owning panel exists
     * to prevent.
     *
     * The currency guard cannot see this. Receiver epoch, source authority and
     * generation say nothing about the edit phase, so a transform whose panel and
     * source never moved is perfectly "current" while its admission has lapsed.
     * Round 6's finding 13 had the same shape — a gate that knew only one direction
     * of a race — and asking one predicate at both ends of the operation is what
     * stops that recurring: `admit_transform_for_phase` cannot drift from itself.
     *
     * What the requesting panel gives up is a view preference. Declining the write
     * makes the commit fail, and `panel-core` answers a failed commit with a refusal
     * rather than an install — so the requester keeps the view it already had and
     * nothing about it diverges from durable state. Better than persisting, and
     * better than installing locally: the user re-asks for the sort once the other
     * panel is done. That is the right trade — a view preference asked for twice is
     * recoverable, rows moving under an editor is not.
     *
     * Silent when there is no shared edit record, exactly as
     * `begin_transform_admission` is: no record means no session can exist on this
     * file — a non-editing profile never builds one — so there is nothing to
     * serialize against.
     */
    function transform_commit_admission_refusal(): string | undefined {
        if (!file_edit_state) return undefined;
        return admit_transform_for_phase(file_edit_state.phase);
    }

    function projected_save_lifecycle(): CsvSaveLifecycle {
        return save_lifecycle;
    }

    function begin_save_lifecycle(
        operation: CsvSaveOperation,
    ): ActiveCsvSaveLifecycle {
        const lifecycle = Object.freeze<ActiveCsvSaveLifecycle>({
            revision: save_lifecycle.revision + 1,
            state: 'active',
            operation,
        });
        save_lifecycle = lifecycle;
        recapture_edit_capabilities();
        return lifecycle;
    }

    function finish_save_lifecycle(
        operation: CsvSaveOperation,
        state: 'failed',
    ): Extract<CsvSaveLifecycle, { state: 'failed' }>;
    function finish_save_lifecycle(
        operation: CsvSaveOperation,
        state: 'succeeded',
    ): Extract<CsvSaveLifecycle, { state: 'succeeded' }>;
    function finish_save_lifecycle(
        operation: CsvSaveOperation,
        state: 'failed' | 'succeeded',
    ): Extract<CsvSaveLifecycle, { state: 'failed' | 'succeeded' }> {
        const lifecycle = Object.freeze({
            revision: save_lifecycle.revision + 1,
            state,
            operation,
        });
        save_lifecycle = lifecycle;
        recapture_edit_capabilities();
        return lifecycle;
    }

    function retire_save_lifecycle(
        edit_session_id?: string,
        terminal_state?: 'failed' | 'succeeded',
    ): boolean {
        if (save_lifecycle.state === 'idle' || save_lifecycle.state === 'active') {
            return false;
        }
        if (
            terminal_state !== undefined
            && save_lifecycle.state !== terminal_state
        ) return false;
        if (
            edit_session_id !== undefined
            && save_lifecycle.operation.editSessionId !== edit_session_id
        ) return false;
        save_lifecycle = Object.freeze({
            revision: save_lifecycle.revision + 1,
            state: 'idle',
        });
        recapture_edit_capabilities();
        return true;
    }

    function notify_edit_state(snapshot?: Readonly<FileStateSnapshot>): void {
        if (!file_edit_state) return;
        for (const subscriber of [...file_edit_state.subscribers]) {
            try {
                subscriber(snapshot);
            } catch (error) {
                log_sanitized_failure('Failed to update CSV edit availability', error);
            }
        }
    }

    function owns_edit_session(): boolean {
        const phase = edit_phase();
        return phase.type === 'owned' && phase.token === edit_session_token;
    }

    function save_operation_is_current(operation: CsvSaveHostOperation): boolean {
        return active_save_operation === operation
            && edit_message_is_current(operation.identity.editSessionId);
    }

    function recapture_edit_capabilities(deliver = false): void {
        session.recapture_current_projection({ deliver });
    }

    /**
     * May a claim be reserved ahead of the state I/O a grant needs?
     *
     * No while transform work is in flight. The reservation exists precisely to
     * serialize against work that crosses state I/O — it pins the phase across
     * `read_file_state()` so a sibling transform cannot overtake it — so taking one
     * while such work is *already* in flight would be entering that race from the
     * losing side, with a transform poised to publish a new basis under the read
     * the reservation is protecting.
     *
     * The same answer as `may_begin_editing()` today, and deliberately its own
     * function rather than a call to it: that one is about a user's request, this
     * one about a window across I/O, and they are not required to agree forever. A
     * reservation refused here is simply not taken; nothing is held for a retry.
     *
     * It also cannot currently *observe* a refusal, and that is worth knowing before
     * anyone tries to test it: `reserve_edit_claim` has one caller, which evaluates
     * `may_begin_editing()` synchronously a few statements earlier with no await
     * between, so this can only differ from that answer once some future caller —
     * or an await inserted into that gap — makes the two evaluations separable in
     * time. Kept for the same reason `save_blocks_transform()` keeps its overlapping
     * halves: a false refusal here is a momentary no-op, while a reservation taken
     * into an in-flight window is a race over durable state.
     */
    function may_reserve_claim(): boolean {
        return !transform_work_in_flight();
    }

    function reserve_edit_claim(): symbol | undefined {
        // Every phase check below is unchanged — those are the claim serialization,
        // not the transform-shaped question this site asks.
        if (!file_edit_state || !may_reserve_claim()) return undefined;
        const phase = file_edit_state.phase;
        if (phase.type === 'owned' && phase.token === edit_session_token) {
            return undefined;
        }
        if (phase.type !== 'free') return undefined;
        const claim = Symbol(file_key);
        file_edit_state.phase = {
            type: 'claiming',
            claim,
            token: edit_session_token,
        };
        active_edit_claim = claim;
        notify_edit_state();
        return claim;
    }

    function cancel_edit_claim(claim: symbol | undefined): void {
        if (!file_edit_state || claim === undefined) return;
        const phase = file_edit_state.phase;
        if (phase.type !== 'claiming' || phase.claim !== claim) return;
        if (active_edit_claim === claim) active_edit_claim = undefined;
        file_edit_state.phase = { type: 'free' };
        notify_edit_state();
        delete_shared_edit_state_if_unused();
    }

    /**
     * May a reopened panel reclaim a session that exists only in durable state?
     *
     * Yes, whenever durable `pendingEdits` exist — which is why this function
     * consults nothing at all. A reopened panel holding durable edits is not
     * *starting* anything: the session already exists in durable state, and the
     * only live question is whether the running system can represent it. Refusing
     * to represent existing user work is data loss, not policy. That is round 6's
     * worst finding — the reclaim was refused on a transform, so
     * `project_state_for_panel` stripped the edits and the viewer opened looking
     * clean over work the user could neither see nor recover.
     *
     * Why "yes" is safe here when `may_begin_editing()` says no to the same
     * condition. Computed row permutations are deliberately never persisted (see
     * the `transforms` field in types.ts: "Computed row permutations are
     * deliberately never persisted"), so a close leaves only the *rules* behind.
     * The permutation the user was looking at is gone by construction, which means
     * the "rows must not move under an editor" guarantee cannot bind across a
     * close/reopen — there is no prior order left to preserve, so recomputation
     * here is not something we are in a position to decline. What the user gets
     * back is an order over *saved* values with their dirty overlay drawn on top:
     * the same stale-view semantics the banner already explains for a live session,
     * and safe to key edits into because edits are source-keyed and therefore valid
     * under any permutation.
     *
     * This answer stops at the transform-shaped question. The phase checks in
     * `try_claim_edit_session` are untouched and still decide the rest: a session
     * another panel owns, is releasing, or is cleaning up after is not ours to
     * take, and no amount of durable work makes it ours.
     */
    function may_rehydrate_session(): boolean {
        return true;
    }

    function try_claim_edit_session(
        notify = true,
        claim?: symbol,
    ): boolean {
        // The transform-shaped question at this site is `may_rehydrate_session()`,
        // and its answer is unconditional — see there for why declining would be
        // data loss. Both callers that need a concurrency refusal already have one:
        // `requestEditSession` re-evaluates `may_begin_editing()` after its read,
        // and `reserve_edit_claim` asked `may_reserve_claim()` before it.
        if (!file_edit_state || !may_rehydrate_session()) return false;
        const phase = file_edit_state.phase;
        if (phase.type === 'owned') {
            if (phase.token !== edit_session_token) return false;
            active_edit_session_id ??= allocate_edit_session_id(file_key);
            return true;
        }
        if (
            phase.type === 'claiming'
            && claim !== undefined
            && phase.claim === claim
            && phase.token === edit_session_token
        ) {
            if (active_edit_claim === claim) active_edit_claim = undefined;
            active_edit_session_id = allocate_edit_session_id(file_key);
            file_edit_state.phase = { type: 'owned', token: edit_session_token };
            if (notify) notify_edit_state();
            return true;
        }
        if (phase.type !== 'free' || claim !== undefined) return false;
        retire_save_lifecycle(undefined);
        active_edit_session_id = allocate_edit_session_id(file_key);
        file_edit_state.phase = { type: 'owned', token: edit_session_token };
        if (notify) notify_edit_state();
        return true;
    }

    function release_edit_session(
        edit_session_id = active_edit_session_id,
    ): Promise<void> {
        if (!edit_session_id || !file_edit_state) return Promise.resolve();
        if (
            active_edit_release
            && active_edit_release.editSessionId === edit_session_id
        ) return active_edit_release.completion;
        if (!edit_message_is_current(edit_session_id)) return Promise.resolve();

        const save_operation = active_save_operation;
        if (
            save_operation
            && save_operation.identity.editSessionId === edit_session_id
        ) {
            if (save_operation.phase === 'writing') return Promise.resolve();
            active_save_operation = undefined;
            const lifecycle = finish_save_lifecycle(save_operation.identity, 'failed');
            if (!disposed) {
                void post_to_receiver({
                    type: 'saveResult',
                    success: false,
                    lifecycle,
                });
            }
        }
        if (
            save_lifecycle.state === 'failed'
            && save_lifecycle.operation.editSessionId === edit_session_id
        ) {
            // Only a save that got as far as `persist_accepted_save` leaves anything
            // for the tombstone to undo. The early rejections — base mismatch,
            // removed rows, serialize failure, "still refreshing" — return before
            // `active_save_operation` is even assigned, so the only pending edits on
            // disk are the ones the *user's own* posts made durable. A tombstone
            // there would have `ensure_failed_save_cleanup` strip them by value,
            // silently discarding work the user still has open in the grid: hit Save
            // on an externally-changed file, read the "try again" warning, close the
            // tab, and the edit is gone.
            if (persisted_save_identities.has(save_lifecycle.operation)) {
                file_edit_state.failedSaveTombstone = save_lifecycle.operation;
            }
            retire_save_lifecycle(edit_session_id, 'failed');
        }

        // Fence later messages synchronously, but retain the exact session/token
        // authority needed by every pending-edit write admitted before this boundary.
        const release = Symbol(file_key);
        file_edit_state.phase = {
            type: 'releasing',
            release,
            token: edit_session_token,
        };
        notify_edit_state();
        const admitted_writes = pending_edit_writes;
        const completion = (async () => {
            try {
                await admitted_writes;
            } catch (error) {
                log_sanitized_failure('Failed to settle admitted CSV edits before release', error);
            } finally {
                if (
                    file_edit_state?.phase.type === 'releasing'
                    && file_edit_state.phase.release === release
                    && active_edit_session_id === edit_session_id
                ) {
                    active_edit_session_id = undefined;
                    file_edit_state.phase = { type: 'free' };
                    notify_edit_state();
                    void ensure_failed_save_cleanup();
                    delete_shared_edit_state_if_unused();
                }
                if (active_edit_release?.release === release) {
                    active_edit_release = undefined;
                }
            }
        })();
        active_edit_release = { editSessionId: edit_session_id, release, completion };
        return completion;
    }

    function begin_edit_cleanup(
        edit_session_id: string,
        save_operation?: CsvSaveHostOperation,
    ): symbol | undefined {
        if (
            !file_edit_state
            || !edit_message_is_current(edit_session_id)
            || (save_operation !== undefined && (
                active_save_operation !== save_operation
                || save_operation.phase !== 'writing'
            ))
        ) return undefined;
        if (save_operation === undefined && active_save_operation) return undefined;
        const operation = Symbol(file_key);
        active_save_operation = undefined;
        active_edit_session_id = undefined;
        file_edit_state.phase = { type: 'cleanupPending', operation };
        recapture_edit_capabilities();
        return operation;
    }

    function finish_edit_cleanup(
        operation: symbol,
        success: boolean,
        cleared_snapshot?: Readonly<FileStateSnapshot>,
    ): void {
        if (!file_edit_state) return;
        const phase = file_edit_state.phase;
        if (
            (phase.type !== 'cleanupPending' && phase.type !== 'uncertain')
            || phase.operation !== operation
        ) return;
        file_edit_state.phase = success
            ? { type: 'free' }
            : { type: 'uncertain', operation };
        if (success && cleared_snapshot !== undefined) {
            observe_durable_state(cleared_snapshot);
            file_edit_state.clearedStateRevision = Math.max(
                file_edit_state.clearedStateRevision ?? -1,
                cleared_snapshot.revision,
            );
            retire_save_lifecycle(undefined, 'succeeded');
        }
        notify_edit_state(cleared_snapshot);
        if (success) delete_shared_edit_state_if_unused();
    }

    function strip_operation_owned_pending_edits(
        pending_edits: PerFileState['pendingEdits'],
        operation: CsvSaveOperation,
    ): PerFileState['pendingEdits'] {
        if (!pending_edits) return undefined;
        const retained = Object.fromEntries(
            Object.entries(pending_edits).filter(([key, pending]) => {
                const owned = operation.dirtyEdits[key];
                if (!owned) return true;
                return typeof pending === 'string'
                    ? pending !== owned.value
                    : pending.value !== owned.value || pending.base !== owned.base;
            }),
        );
        return Object.keys(retained).length > 0 ? retained : undefined;
    }

    /**
     * True when `pending_edits` is nothing more than `operation`'s own entries,
     * unchanged and complete — the webview echoing a failed operation's map back
     * rather than the user moving on from it.
     *
     * `strip_operation_owned_pending_edits` returns `undefined` for two situations
     * that mean opposite things here: a map with nothing left after its owned
     * entries are removed (an echo), and a map that was empty or absent to begin
     * with (a discard — the user moving on *more* decisively than by replacing the
     * map). Comparing key counts separates them, and covers the partial case too:
     * a post missing one of the operation's keys dropped that edit deliberately.
     */
    function post_echoes_operation(
        pending_edits: PerFileState['pendingEdits'],
        operation: CsvSaveOperation,
    ): boolean {
        const owned = Object.keys(operation.dirtyEdits).length;
        if (owned === 0 || !pending_edits) return false;
        if (Object.keys(pending_edits).length !== owned) return false;
        return strip_operation_owned_pending_edits(pending_edits, operation) === undefined;
    }

    function pending_edits_for_current_session(
        pending_edits: PerFileState['pendingEdits'],
    ): PerFileState['pendingEdits'] {
        let projected = pending_edits;
        if (save_lifecycle.state !== 'idle') {
            if (
                save_lifecycle.state !== 'succeeded'
                && save_lifecycle.operation.editSessionId === active_edit_session_id
            ) return projected;
            projected = strip_operation_owned_pending_edits(
                projected,
                save_lifecycle.operation,
            );
        }
        const tombstone = file_edit_state?.failedSaveTombstone;
        if (tombstone && tombstone.editSessionId !== active_edit_session_id) {
            projected = strip_operation_owned_pending_edits(projected, tombstone);
        }
        return projected;
    }

    function ensure_failed_save_cleanup(): Promise<void> {
        if (!file_edit_state?.failedSaveTombstone) return Promise.resolve();
        if (file_edit_state.failedSaveCleanup) return file_edit_state.failedSaveCleanup;
        const operation = file_edit_state.failedSaveTombstone;
        let cleanup!: Promise<void>;
        cleanup = (async () => {
            try {
                const committed = await update_file_state((current) => {
                    const pending_edits = strip_operation_owned_pending_edits(
                        current.pendingEdits,
                        operation,
                    );
                    if (pending_edits === current.pendingEdits) return current;
                    if (pending_edits) return { ...current, pendingEdits: pending_edits };
                    const { pendingEdits: _drop, ...rest } = current;
                    return rest;
                }, undefined, undefined, null);
                if (file_edit_state?.failedSaveTombstone === operation) {
                    file_edit_state.failedSaveTombstone = undefined;
                }
                if (committed) notify_edit_state(committed);
            } catch (error) {
                log_sanitized_failure('Failed to clear retired CSV save state', error);
            } finally {
                if (file_edit_state?.failedSaveCleanup === cleanup) {
                    file_edit_state.failedSaveCleanup = undefined;
                    delete_shared_edit_state_if_unused();
                }
            }
        })();
        file_edit_state.failedSaveCleanup = cleanup;
        return cleanup;
    }

    /**
     * Project durable state for this panel without mutating shared authority.
     *
     * Being a *projection* is the point, and the one way it can quietly stop being
     * one is by dropping `pendingEdits`. Round 6's worst finding arrived through
     * exactly that shape: a reclaim refused upstream, and this function discarding
     * durable user work as an incidental fallthrough — the viewer opened looking
     * clean over edits the user could not see. The claim relaxation fixed that
     * cause; this structure is so the next one cannot hide. The discard is a named
     * branch with a stated reason, and there is only ever one legitimate reason:
     * the session those edits belong to is not this panel's to represent.
     */
    function project_state_for_panel(
        snapshot: Readonly<FileStateSnapshot>,
        allow_claim = false,
    ): FileStateSnapshot {
        observe_durable_state(snapshot);
        const state = snapshot.state as PerFileState;
        if (!state.pendingEdits) {
            return { revision: snapshot.revision, state };
        }
        // `edit_cleanup_blocked()` below is defence in depth and honestly cannot be
        // observed on its own: `begin_edit_cleanup` clears `active_edit_session_id`,
        // so `owns_edit_session()` is already false under both cleanup phases, and
        // `try_claim_edit_session` already refuses any phase that is not `free`.
        // Probing for a mutation that isolates it found none — every way of letting
        // the claim through those phases breaks the cleanup-recovery machinery
        // wholesale. Kept on the precedent `may_reserve_claim` sets rather than
        // removed, because the term states the projection's own reason for
        // withholding instead of borrowing the claim's.
        //
        // Not live work: a read older than a clear this panel already completed
        // still carries edits the clear removed.
        const predates_completed_clear = file_edit_state?.clearedStateRevision !== undefined
            && snapshot.revision <= file_edit_state.clearedStateRevision;
        // `may_rehydrate_session()` is asked here by name, not left implicit inside
        // the claim, because this is the site where its answer decides whether
        // durable user work reaches the panel at all.
        const represents_session = !predates_completed_clear
            && !edit_cleanup_blocked()
            && profile.editing
            && (
                owns_edit_session()
                || (
                    allow_claim
                    && may_rehydrate_session()
                    && try_claim_edit_session(false)
                )
            );
        if (represents_session) {
            const pending_edits = pending_edits_for_current_session(state.pendingEdits);
            if (pending_edits === state.pendingEdits) {
                return { revision: snapshot.revision, state };
            }
            if (pending_edits) {
                return {
                    revision: snapshot.revision,
                    state: { ...state, pendingEdits: pending_edits },
                };
            }
            const { pendingEdits: _drop, ...rest } = state;
            return { revision: snapshot.revision, state: rest };
        }
        // The session belongs to another panel: it owns the phase, is releasing it,
        // or is clearing state behind it, so these edits are its work to show and
        // not ours to duplicate. (Or this panel was not asked to claim, or cannot
        // edit at all, or the snapshot predates a completed clear.)
        //
        // Everything else is silent loss of unsaved user work, so assert rather than
        // hope: reaching here from a free phase with a claim permitted means
        // `try_claim_edit_session` refused a session nobody holds, which
        // `may_rehydrate_session()` is written to make impossible.
        if (
            allow_claim
            && profile.editing
            && !!file_edit_state
            && !predates_completed_clear
            && edit_phase().type === 'free'
        ) {
            console.error('Dropped durable CSV pending edits with no panel holding the session');
        }
        const { pendingEdits: _drop, ...rest } = state;
        return { revision: snapshot.revision, state: rest };
    }

    function validate_restored_pending_edits(
        src: DataSource,
        pending_edits: NonNullable<PerFileState['pendingEdits']>,
    ): { dirtyEdits: CsvDirtyMap; rejection: CsvSaveRejection } | undefined {
        const dirty_edits: CsvDirtyMap = Object.fromEntries(
            Object.entries(pending_edits).filter((entry): entry is [string, {
                value: string;
                base: string;
            }] => typeof entry[1] !== 'string'),
        );
        if (Object.keys(dirty_edits).length === 0) return undefined;

        const source_row_count = src.meta().sheets[0].sourceRowCount;
        const wanted_columns = new Map<number, number[]>();
        for (const key of Object.keys(dirty_edits)) {
            const [source_row, col] = key.split(':').map(Number);
            if (
                !Number.isInteger(source_row)
                || !Number.isInteger(col)
                || source_row < 0
                || col < 0
                || source_row >= source_row_count
            ) continue;
            const columns = wanted_columns.get(source_row);
            if (columns) columns.push(col);
            else wanted_columns.set(source_row, [col]);
        }

        const observed_bases = new Map<string, string>();
        const wanted_rows = [...wanted_columns.keys()].sort((left, right) => left - right);
        for (let index = 0; index < wanted_rows.length;) {
            const run_start = wanted_rows[index];
            let end = run_start;
            while (wanted_rows[index + 1] === end + 1) {
                end += 1;
                index += 1;
            }
            for (let start = run_start; start <= end; start += SAVE_WINDOW) {
                const count = Math.min(SAVE_WINDOW, end - start + 1);
                const window = src.read_rows(0, start, count);
                for (const [offset, row] of window.rows.entries()) {
                    const source_row = window.startRow + offset;
                    for (const col of wanted_columns.get(source_row) ?? []) {
                        const cell = row[col];
                        if (cell !== undefined) {
                            observed_bases.set(
                                `${source_row}:${col}`,
                                cell === null ? '' : String(cell.raw ?? ''),
                            );
                        }
                    }
                }
            }
            index += 1;
        }

        const validation = validate_dirty_bases(
            dirty_edits,
            source_row_count,
            (source_row, col) => observed_bases.get(`${source_row}:${col}`),
        );
        if (validation.type === 'valid') return undefined;
        return {
            dirtyEdits: dirty_edits,
            rejection: validation.type === 'removedRows'
                ? { reason: 'rowsRemoved', keys: validation.keys }
                : { reason: 'baseMismatch', keys: validation.keys },
        };
    }

    function update_session_state_material(
        snapshot: Readonly<FileStateSnapshot>,
        allow_claim = false,
    ): boolean {
        observe_durable_state(snapshot);
        return session.update_state_snapshot(project_state_for_panel(snapshot, allow_claim));
    }

    async function refresh_session_state_material(
        allow_claim = false,
    ): Promise<FileStateSnapshot> {
        const snapshot = await read_file_state();
        update_session_state_material(snapshot, allow_claim);
        return snapshot;
    }

    async function read_file_state(touch = true): Promise<FileStateSnapshot> {
        await file_coordinator.state_ready();
        const snapshot = await state_store.read(state_path);
        observe_durable_state(snapshot);
        if (touch) await state_store.touch(state_path);
        return snapshot;
    }

    async function update_file_state(
        updater: (current: PerFileState) => PerFileState,
        sheet_names = source?.meta().sheets.map((sheet) => sheet.name) ?? [],
        validate?: () => boolean,
        write_basis: FileStateWriteBasis | null = {
            expectedAuthorityRevision: source_authority.authorityRevision,
        },
    ): Promise<FileStateSnapshot | undefined> {
        let snapshot = await read_file_state(false);
        for (;;) {
            if (validate && !validate()) return undefined;
            const current = normalize_host_state(snapshot.state, sheet_names);
            const next = updater(current);
            if (next === current) return undefined;
            const result = await state_store.compare_and_set(
                state_path,
                snapshot.revision,
                next,
                validate,
                write_basis ?? undefined,
            );
            if (result.type === 'committed') {
                observe_durable_state(result.snapshot);
                if (!disposed) update_session_state_material(result.snapshot);
                return result.snapshot;
            }
            file_coordinator.observe_state_authority(result.authority);
            if (write_basis && (
                result.authority.authorityRevision !== write_basis.expectedAuthorityRevision
                || (
                    write_basis.expectedPhysicalRevision !== undefined
                    && result.authority.physicalRevision
                        !== write_basis.expectedPhysicalRevision
                )
                || (
                    write_basis.expectedProjectionRevision !== undefined
                    && result.authority.projectionRevision
                        !== write_basis.expectedProjectionRevision
                )
            )) return undefined;
            if (validate && !validate()) return undefined;
            snapshot = result.snapshot;
        }
    }

    type StateChangedMessage = Extract<WebviewMessage, { type: 'stateChanged' }>;

    function layout_write_is_current(
        message: StateChangedMessage,
        expected_authority: number,
    ): boolean {
        const acknowledged_identity = session.acknowledged_identity();
        return !disposed
            && core !== undefined
            && file_coordinator.state_write_is_current(expected_authority)
            && source_authority.authorityRevision === expected_authority
            && message.snapshotIdentity.authority.revision === expected_authority
            && message.sourceGeneration === core.source_generation
            && acknowledged_identity !== undefined
            && same_snapshot_identity(message.snapshotIdentity, acknowledged_identity);
    }

    /**
     * Serialize one durable layout write behind every earlier one. Generic in the
     * operation's result so a caller that needs the committed snapshot back — the
     * `setRowHeights` handler, which has to deliver explicitly afterwards — can be on the
     * same tail as `persist_layout_state`, which needs nothing back.
     */
    function enqueue_layout_write<T>(operation: () => Promise<T>): Promise<T> {
        const write = layout_write_tail.catch(() => {}).then(operation);
        layout_write_tail = write.then(() => {}, () => {});
        return write;
    }

    async function persist_layout_state(
        message: StateChangedMessage,
        expected_authority: number,
    ): Promise<void> {
        if (!layout_write_is_current(message, expected_authority) || !source) return;
        const write_basis: FileStateWriteBasis = {
            expectedAuthorityRevision: expected_authority,
            expectedPhysicalRevision: source_authority.physicalRevision,
            expectedProjectionRevision: source_authority.projectionRevision,
        };
        const sheet_names = source.meta().sheets.map((sheet) => sheet.name);
        if (
            !layout_basis
            || !same_snapshot_identity(layout_basis.identity, message.snapshotIdentity)
        ) {
            const acknowledged_state = session.acknowledged_state_snapshot(
                message.snapshotIdentity,
            );
            if (!acknowledged_state) return;
            layout_basis = {
                identity: structuredClone(message.snapshotIdentity),
                state: complete_normalized_per_file_state(
                    acknowledged_state,
                    sheet_names,
                ),
            };
        }
        const basis = layout_basis;
        const incoming = complete_normalized_per_file_state(message.state, sheet_names);
        const patch = derive_layout_state_patch(basis.state, incoming);
        const next_basis = complete_normalized_per_file_state(
            apply_layout_state_patch(basis.state, patch),
            sheet_names,
        );
        let reconciled = false;
        await update_file_state((current) => {
            if (!layout_write_is_current(message, expected_authority)) return current;
            reconciled = true;
            const sheets = source?.meta().sheets;
            if (!sheets) return current;
            const current_transforms = current.transforms;
            const current_visibility = current.columnVisibility;
            const transforms = sheets.map((sheet, index) =>
                sanitize_transform_state(
                    current_transforms?.[index],
                    sheet.columnCount,
                    transform_schema_for_sheet(sheet),
                    sheet.sourceRowCount,
                ));
            const column_visibility = sheets.map((sheet, index) =>
                sanitize_column_visibility_state(
                    current_visibility?.[index],
                    sheet.columnCount,
                    transform_schema_for_sheet(sheet),
                ));
            const transforms_changed = !sheet_state_arrays_equal(
                transforms,
                current_transforms,
            );
            const visibility_changed = !sheet_state_arrays_equal(
                column_visibility,
                current_visibility,
            );
            const host_state = transforms_changed || visibility_changed
                ? {
                    ...current,
                    ...(transforms_changed ? { transforms } : {}),
                    ...(visibility_changed
                        ? { columnVisibility: column_visibility }
                        : {}),
                }
                : current;
            return apply_layout_state_patch(host_state, patch);
        }, sheet_names, () => layout_write_is_current(message, expected_authority), write_basis);
        if (
            reconciled
            && layout_basis === basis
            && layout_write_is_current(message, expected_authority)
        ) {
            basis.state = next_basis;
        }
    }

    type EditStateWriteResult =
        | { type: 'committed'; snapshot: FileStateSnapshot }
        | { type: 'unchanged'; snapshot: FileStateSnapshot }
        | { type: 'aborted' };

    async function update_edit_session_state(
        edit_session_id: string,
        admission: symbol,
        updater: (current: PerFileState) => PerFileState,
    ): Promise<EditStateWriteResult> {
        const is_current = () => {
            if (
                active_edit_session_id !== edit_session_id
                || !pending_edit_admissions.has(admission)
            ) return false;
            const phase = edit_phase();
            return (phase.type === 'owned' || phase.type === 'releasing')
                && phase.token === edit_session_token;
        };
        const expected_authority_revision = source_authority.authorityRevision;
        let snapshot = await read_file_state(false);
        for (;;) {
            if (!is_current()) return { type: 'aborted' };
            const current = normalize_host_state(
                snapshot.state,
                source?.meta().sheets.map((sheet) => sheet.name) ?? [],
            );
            const next = updater(current);
            if (next === current) {
                if (!disposed) update_session_state_material(snapshot);
                return { type: 'unchanged', snapshot };
            }
            const result = await state_store.compare_and_set(
                state_path,
                snapshot.revision,
                next,
                is_current,
                { expectedAuthorityRevision: expected_authority_revision },
            );
            if (result.type === 'committed') {
                observe_durable_state(result.snapshot);
                if (!disposed && is_current()) update_session_state_material(result.snapshot);
                return { type: 'committed', snapshot: result.snapshot };
            }
            file_coordinator.observe_state_authority(result.authority);
            if (
                result.authority.authorityRevision !== expected_authority_revision
                || !is_current()
            ) return { type: 'aborted' };
            snapshot = result.snapshot;
        }
    }

    function transform_authority_is_current(
        message: Extract<WebviewMessage, { type: 'setTransform' }>,
        authority: TransformAuthority,
    ): boolean {
        return !disposed
            && session.current_receiver_epoch === authority.receiverEpoch
            && transform_authorities.get(message) === authority
            && latest_transform_authority_by_sheet.get(message.sheetIndex) === authority
            && file_coordinator.state_write_is_current(authority.authorityRevision)
            && source_authority.authorityRevision === authority.authorityRevision
            && message.sourceGeneration === core?.source_generation;
    }

    async function reconcile_transform_terminal(
        message: Extract<WebviewMessage, { type: 'setTransform' }>,
        authority: TransformAuthority,
    ): Promise<void> {
        for (let attempt = 0; attempt < READY_STATE_REBASE_COUNT; attempt += 1) {
            if (!transform_authority_is_current(message, authority)) return;
            const reconciliation_core = core;
            const reconciliation_adoption = session.current_adoption();
            if (!reconciliation_core || !reconciliation_adoption) return;
            const source_generation = reconciliation_core.source_generation;
            const snapshot = await read_file_state(false);
            if (!transform_authority_is_current(message, authority)) return;
            const sheets = reconciliation_core.snapshot_material().core.meta.sheets;
            const durable = normalize_host_state(
                snapshot.state,
                sheets.map((sheet) => sheet.name),
            );
            const transforms = sheets.map((sheet, index) => sanitize_transform_state(
                durable.transforms?.[index],
                sheet.columnCount,
                transform_schema_for_sheet(sheet),
                sheet.sourceRowCount,
            ));
            const prepared = await reconciliation_core.prepare_transform_reconciliation(
                transforms,
                () => !transform_authority_is_current(message, authority)
                    || core !== reconciliation_core
                    || session.current_adoption() !== reconciliation_adoption
                    || reconciliation_core.source_generation !== source_generation,
            );
            if (!prepared) return;
            const confirmed = await read_file_state(false);
            if (!transform_authority_is_current(message, authority)) return;
            if (confirmed.revision !== snapshot.revision) continue;
            if (
                core !== reconciliation_core
                || session.current_adoption() !== reconciliation_adoption
                || reconciliation_core.source_generation !== source_generation
            ) continue;
            update_session_state_material(confirmed, false);
            const generation = reconciliation_core.generation;
            if (!reconciliation_core.commit_transform_reconciliation(prepared)) continue;
            sync_active_transform_panel();
            if (reconciliation_core.generation !== generation) {
                session.recapture_current_projection({ deliver: true });
            }
            return;
        }
        console.error('Failed to reconcile durable table transforms after a terminal operation');
    }

    /**
     * Remove one unusable saved transform without granting an old restore
     * authority over a newer writer. A CAS conflict is re-read and either
     * retried for the same invalid candidate or adopted as the winner.
     */
    /** Durable outcome used to distinguish owned repair from a concurrent winner. */
    type InvalidTransformCleanupResult = 'committed' | 'superseded' | 'failed';

    async function cleanup_invalid_persisted_transform(
        error: InvalidPersistedTransformError,
        is_current: () => boolean,
    ): Promise<InvalidTransformCleanupResult> {
        const write_basis: FileStateWriteBasis = {
            expectedAuthorityRevision: source_authority.authorityRevision,
            expectedPhysicalRevision: source_authority.physicalRevision,
            expectedProjectionRevision: source_authority.projectionRevision,
        };
        for (let attempt = 0; attempt < READY_STATE_REBASE_COUNT; attempt += 1) {
            if (!is_current()) return 'failed';
            const cleanup_core = core;
            if (!cleanup_core) return 'failed';
            const sheets = cleanup_core.snapshot_material().core.meta.sheets;
            const sheet = sheets[error.sheetIndex];
            if (!sheet) return 'failed';
            const snapshot = await read_file_state(false);
            if (!is_current() || core !== cleanup_core) return 'failed';
            const current = normalize_host_state(
                snapshot.state,
                sheets.map((candidate) => candidate.name),
            );
            const current_transform = sanitize_transform_state(
                current.transforms?.[error.sheetIndex],
                sheet.columnCount,
                transform_schema_for_sheet(sheet),
                sheet.sourceRowCount,
            );
            if (!current_transform
                || !transform_states_equal(current_transform, error.invalidState)) {
                if (!disposed && is_current() && core === cleanup_core) {
                    update_session_state_material(snapshot, false);
                }
                return 'superseded';
            }

            const transforms = [...(current.transforms ?? [])];
            transforms[error.sheetIndex] = transform_has_entries(error.retainedState)
                ? {
                    ...error.retainedState,
                    sort: error.retainedState.sort.map((key) => ({ ...key })),
                    filters: error.retainedState.filters.map(clone_filter_entry),
                    ...(error.retainedState.hiddenRows
                        ? { hiddenRows: [...error.retainedState.hiddenRows] }
                        : {}),
                }
                : undefined;
            const result = await state_store.compare_and_set(
                state_path,
                snapshot.revision,
                { ...current, transforms },
                is_current,
                write_basis,
            );
            if (result.type === 'committed') {
                observe_durable_state(result.snapshot);
                if (!disposed && is_current()) {
                    update_session_state_material(result.snapshot, false);
                }
                return 'committed';
            }
            file_coordinator.observe_state_authority(result.authority);
            observe_durable_state(result.snapshot);
            if (
                result.authority.authorityRevision !== write_basis.expectedAuthorityRevision
                || result.authority.physicalRevision !== write_basis.expectedPhysicalRevision
                || result.authority.projectionRevision
                    !== write_basis.expectedProjectionRevision
            ) return 'failed';
            if (!disposed && is_current() && core === cleanup_core) {
                update_session_state_material(result.snapshot, false);
            }
        }
        return 'failed';
    }

    /** Recover an explicit restore only while its receiver and source authority remain current. */
    async function cleanup_invalid_restore(
        message: Extract<WebviewMessage, { type: 'setTransform' }>,
        error: InvalidPersistedTransformError,
        receiver_epoch: number,
    ): Promise<boolean> {
        const authority = transform_authorities.get(message);
        if (
            message.intent !== 'restore'
            || !authority
            || authority.receiverEpoch !== receiver_epoch
        ) return false;
        const is_current = () => authority.receiverEpoch === receiver_epoch
            && transform_authority_is_current(message, authority);
        try {
            return (await cleanup_invalid_persisted_transform(error, is_current))
                !== 'failed';
        } catch (cleanup_error) {
            log_sanitized_failure('Failed to clear an invalid saved table transform', cleanup_error);
            return false;
        }
    }

    async function persist_transform_commit(
        message: Extract<WebviewMessage, { type: 'setTransform' }>,
        state: SheetTransformState,
        receiver_epoch: number,
    ): Promise<void> {
        // Restores merely recompute host-owned preferences. Only explicit user
        // actions can replace those preferences, and the core awaits this write
        // before posting its terminal acknowledgement.
        if (message.intent === 'restore') return;
        const authority = transform_authorities.get(message);
        if (!authority || authority.receiverEpoch !== receiver_epoch) return;
        // Currency *and* admission. The admission term is folded in here rather than
        // written out in the mutator so that all three places this closure is consulted
        // get it: the pre-read check, the mutator below, and the `validate` the CAS
        // itself calls. See `transform_commit_admission_refusal` for why re-asking is
        // the fix; the mutator alone is not enough, because the phase can flip between
        // the mutator running and the CAS being reached.
        //
        // Be precise about what the `validate` evaluation does and does not close, since
        // an earlier version of this comment claimed it closed the CAS window outright.
        // It does not: `compare_and_set` in state.ts calls `validate` and *then* awaits
        // the medium's durable write, so this closure's last evaluation is still before
        // the bytes land. Nothing here can observe a phase that flips inside that gap.
        //
        // What closes the gap is the store, not another check. Every operation
        // `create_authority_store` exposes runs on one queue per medium and the durable
        // write happens inside the queued operation, so no panel can read durable state
        // while this write is in flight; and every free → owned transition is
        // synchronously downstream of such a read (`read_file_state` →
        // `project_state_for_panel` → `try_claim_edit_session`, no await in between —
        // the paths that are *not*, `requestEditSession` and `reserve_edit_claim`,
        // refuse on `transform_work_in_flight()` instead). So the phase flips either
        // before `validate`, where this closure refuses, or after the write landed,
        // where the session simply begins over rules that were already durable. That is
        // a dependency on the store's serialization, and it is pinned by
        // 'rehydrates over a transform whose durable write is still in flight, never
        // under it' rather than left to be rediscovered.
        const transform_is_current_before_commit = () =>
            authority.receiverEpoch === receiver_epoch
            && transform_authority_is_current(message, authority)
            && transform_commit_admission_refusal() === undefined;
        const write_basis: FileStateWriteBasis = {
            expectedAuthorityRevision: authority.authorityRevision,
            expectedPhysicalRevision: source_authority.physicalRevision,
            expectedProjectionRevision: source_authority.projectionRevision,
        };
        transform_commit_barriers.add(authority);
        const committed = await update_file_state((current) => {
            const sheet = source?.meta().sheets[message.sheetIndex];
            if (
                !transform_is_current_before_commit()
                || !sheet
                || (transform_has_entries(state)
                    && state.schema !== transform_schema_for_sheet(sheet))
            ) {
                return current;
            }
            const transforms = [...(current.transforms ?? [])];
            transforms[message.sheetIndex] = transform_has_entries(state)
                ? {
                    ...state,
                    sort: state.sort.map((key) => ({ ...key })),
                    filters: state.filters.map(clone_filter_entry),
                    ...(state.hiddenRows ? { hiddenRows: [...state.hiddenRows] } : {}),
                }
                : undefined;
            return { ...current, transforms };
        }, undefined, transform_is_current_before_commit, write_basis);
        if (!committed) {
            // Name the real reason when it is the admission that lapsed: "the source
            // changed" would be a lie, and the phases that refuse here all end on
            // their own, so the user's next attempt is the one that works. Its own
            // error type and not just its own message, because `panel-core` has to
            // answer the two cases differently — transient here, terminal below — and
            // discriminating on message text is not a discrimination.
            const refusal = transform_commit_admission_refusal();
            if (refusal !== undefined) {
                throw new TransformAdmissionLapsedError(refusal);
            }
            throw new Error('The source changed before this table view could be saved.');
        }
    }

    function same_refresh_event(
        left: FileRefreshEvent | undefined,
        right: FileRefreshEvent | undefined,
    ): boolean {
        return left === undefined
            ? right === undefined
            : right !== undefined
                && left.refreshRevision === right.refreshRevision
                && left.episode === right.episode;
    }

    function load_is_current(
        seq: number,
        refresh_event?: FileRefreshEvent,
    ): boolean {
        return !disposed
            && seq === load_seq
            && (refresh_event === undefined
                || same_refresh_event(refresh_event, latest_refresh_event));
    }

    function supersede_panel_load(): number {
        reset_reload_retry();
        cancel_refresh_retry_wait();
        return ++load_seq;
    }

    async function build_source(): Promise<SourceCandidate> {
        const state = (await read_file_state()).state as PerFileState;
        const stat = await host.fs.stat(uri);
        const max_mib = host.config.max_file_size_mib();
        assert_safe_file_size(stat.size, max_mib);
        const raw = await host.fs.read_file(uri);
        assert_safe_file_size(raw.byteLength, max_mib);
        const observation = {
            fingerprint: `${stat.mtime}:${stat.size}`,
            digest: content_digest(raw),
        };
        return new SourceCandidate(
            await profile.build_source(raw, file_path, state),
            observation,
        );
    }

    async function built_source_is_current(
        seq: number,
        candidate: SourceCandidate,
        refresh_event?: FileRefreshEvent,
    ): Promise<boolean> {
        if (!load_is_current(seq, refresh_event)) return false;
        const { fingerprint, digest } = candidate.observation;
        const stat = await host.fs.stat(uri);
        if (
            !load_is_current(seq, refresh_event)
            || `${stat.mtime}:${stat.size}` !== fingerprint
        ) {
            return false;
        }
        const raw = await host.fs.read_file(uri);
        const verified_stat = await host.fs.stat(uri);
        return load_is_current(seq, refresh_event)
            && `${verified_stat.mtime}:${verified_stat.size}` === fingerprint
            && content_digest(raw) === digest;
    }

    async function commit_physical_candidate(
        candidate: SourceCandidate,
        seq: number,
        expected_authority_revision: number,
        already_verified = false,
        refresh_event?: FileRefreshEvent,
    ): Promise<PhysicalAuthorityCommitResult> {
        if (
            !already_verified
            && !await built_source_is_current(seq, candidate, refresh_event)
        ) return { type: 'stale' };
        const { digest } = candidate.observation;
        const started = file_coordinator.begin_physical(
            expected_authority_revision,
            digest,
        );
        if (started.type === 'rejected') return { type: 'rejected' };
        const { token } = started;
        const ds = candidate.borrow();
        const planning_input = ds instanceof ExcelHeaderDataSource
            ? ds.planning_input()
            : undefined;
        try {
            for (;;) {
                if (
                    !load_is_current(seq, refresh_event)
                    || !file_coordinator.operation_is_current(token)
                ) return { type: 'stale' };
                const state_snapshot = await read_file_state(false);
                const candidate_meta = ds.meta();
                const normalized = normalize_host_state(
                    state_snapshot.state,
                    candidate_meta.sheets.map((sheet) => sheet.name),
                );
                const plan = planning_input
                    ? plan_excel_candidate_state(normalized, planning_input)
                    : undefined;
                const planned_state = plan?.state ?? normalized;
                const next_highlights = reconcile_physical_cell_highlights(
                    planned_state.cellHighlights,
                    digest,
                );
                const highlight_state_changed = !cell_highlight_states_equal(
                    planned_state.cellHighlights,
                    next_highlights,
                );
                const next_state = plan?.changed || highlight_state_changed
                    ? { ...planned_state, cellHighlights: next_highlights }
                    : undefined;
                const staged = await stage_authority(
                    durable_state_store,
                    state_path,
                    {
                        id: token.id,
                        kind: 'physical',
                        ordinal: token.ordinal,
                        expectedStateRevision: state_snapshot.revision,
                        expectedCommitSequence: file_coordinator.authority().commitSequence,
                        nextState: next_state,
                        physicalDigest: digest,
                    },
                );
                if (staged.type === 'conflict') {
                    const current_authority = file_coordinator.authority();
                    const relation = compare_authority(staged.authority, current_authority);
                    if (relation === 'equal') continue;
                    if (relation === 'dominates') {
                        const observation_turn = await file_coordinator.request_commit_turn(token);
                        if (observation_turn.type === 'granted') {
                            if (same_authority(
                                file_coordinator.authority(),
                                current_authority,
                            )) {
                                file_coordinator.observe_advanced_authority(
                                    token,
                                    observation_turn.turn,
                                    staged.authority,
                                );
                            } else {
                                file_coordinator.release_commit_turn(observation_turn.turn);
                            }
                        }
                        return { type: 'advanced' };
                    }
                    return { type: 'rejected' };
                }
                const requested = await file_coordinator.request_commit_turn(token);
                if (requested.type === 'rejected') return { type: 'rejected' };
                const finalizationBasis = file_coordinator.authority();
                const descriptor = {
                    transactionId: token.id,
                    kind: 'physical' as const,
                    basis: finalizationBasis,
                    expectedStateRevision: state_snapshot.revision,
                    previousState: state_snapshot.state,
                    nextState: next_state,
                    physicalDigest: digest,
                };
                file_coordinator.start_finalization(requested.turn);
                let finalized: Awaited<ReturnType<typeof finalize_authority>>;
                try {
                    finalized = await finalize_authority(
                        durable_state_store,
                        state_path,
                        token.id,
                    );
                } catch (error) {
                    let reconciled;
                    try {
                        reconciled = await reconcile_finalization(
                            durable_state_store,
                            state_path,
                            descriptor,
                        );
                    } catch {
                        file_coordinator.release_commit_turn(requested.turn);
                        throw error;
                    }
                    if (reconciled.type === 'committed') {
                        return {
                            type: 'committed',
                            receipt: file_coordinator.finalize_authority_commit(
                                token,
                                requested.turn,
                                reconciled,
                                finalizationBasis,
                            ),
                        };
                    }
                    if (reconciled.type === 'advanced') {
                        const relation = compare_authority(
                            reconciled.authority,
                            file_coordinator.authority(),
                        );
                        if (relation === 'dominates') {
                            file_coordinator.observe_advanced_authority(
                                token,
                                requested.turn,
                                reconciled.authority,
                            );
                            return { type: 'advanced' };
                        }
                        file_coordinator.release_commit_turn(requested.turn);
                        return { type: 'rejected' };
                    }
                    file_coordinator.release_commit_turn(requested.turn);
                    void discard_authority(durable_state_store, state_path, token.id);
                    throw error;
                }
                if (finalized.type === 'conflict') {
                    const relation = compare_authority(
                        finalized.authority,
                        finalizationBasis,
                    );
                    if (relation === 'dominates') {
                        file_coordinator.observe_advanced_authority(
                            token,
                            requested.turn,
                            finalized.authority,
                        );
                        return { type: 'advanced' };
                    }
                    file_coordinator.release_commit_turn(requested.turn);
                    if (relation === 'equal') continue;
                    return { type: 'rejected' };
                }
                let inspected;
                try {
                    inspected = await durable_state_store.inspect_authority_transaction(
                        state_path,
                        token.id,
                    );
                } catch {
                    file_coordinator.observe_advanced_authority(
                        token,
                        requested.turn,
                        finalized.authority,
                    );
                    return { type: 'advanced' };
                }
                const inspected_relation = compare_authority(
                    inspected.authority,
                    finalized.authority,
                );
                if (inspected_relation === 'dominates') {
                    file_coordinator.observe_advanced_authority(
                        token,
                        requested.turn,
                        inspected.authority,
                    );
                    return { type: 'advanced' };
                }
                if (inspected_relation !== 'equal') {
                    file_coordinator.observe_advanced_authority(
                        token,
                        requested.turn,
                        finalized.authority,
                    );
                    return { type: 'advanced' };
                }
                return {
                    type: 'committed',
                    receipt: file_coordinator.finalize_authority_commit(
                        token,
                        requested.turn,
                        finalized,
                        finalizationBasis,
                    ),
                };
            }
        } finally {
            file_coordinator.cancel(token);
            void discard_authority(durable_state_store, state_path, token.id);
        }
    }

    function adopt_committed_candidate(
        candidate: SourceCandidate,
        committed: Extract<PhysicalAuthorityCommitResult, { type: 'committed' }>,
        seq: number,
        reason: 'ready' | 'fileReload' | 'recovery' | 'save' = 'fileReload',
        projected_state?: FileStateSnapshot,
        refresh_event?: FileRefreshEvent,
    ): DataSource | undefined {
        // A durable commit can finish after a newer panel-local load starts. Keep
        // ownership with the candidate unless this exact load is still current at
        // the synchronous installation boundary.
        if (!load_is_current(seq, refresh_event)) return undefined;
        const inspected = candidate.borrow();
        if (inspected instanceof ExcelHeaderDataSource) {
            const committed_state = normalize_host_state(
                committed.receipt.stateSnapshot.state,
                inspected.meta().sheets.map((sheet) => sheet.name),
            );
            inspected.replace_overrides(sanitize_excel_header_overrides(
                committed_state.excelFirstRowHeaders,
            ));
            inspected.replace_hidden_rows(
                excel_hidden_rows_for_source(
                    inspected.meta().sheets,
                    committed_state.transforms,
                ),
            );
        }
        let adopted: DataSource | undefined;
        const transferred = candidate.transfer_to((next, confirm_transfer) => {
            if (!load_is_current(seq, refresh_event)) return;
            const result = adopt_source_into_core(
                core,
                panel,
                undefined,
                next,
                {
                    onTransformCommit: persist_transform_commit,
                    onInvalidRestore: cleanup_invalid_restore,
                    durablePendingEditKeys: durable_pending_edit_keys,
                    durableRowHeights: durable_row_heights,
                },
                (installed) => {
                    installed.begin_receiver_epoch(session.current_receiver_epoch);
                    const material = installed.snapshot_material();
                    const owned_before_projection = owns_edit_session();
                    const adoption_state = project_state_for_panel(
                        projected_state ?? committed.receipt.stateSnapshot,
                        true,
                    );
                    const adoption: PanelAdoption = {
                        source: 'commitReceipt',
                        canonicalFileId: file_key,
                        resources: { source: next, core: installed },
                        receipt: committed.receipt,
                        core: material.core,
                        diagnostics: material.diagnostics,
                        warnings: Object.freeze([...(next.warnings ?? [])]),
                        reason,
                        project: () => ({
                            configuration: {
                                defaultTabOrientation: host.config.default_tab_orientation(),
                                previewMode: profile.previewMode === true,
                            },
                            capabilities: {
                                csvEditingSupported: profile.editing,
                                csvEditable: profile.editing
                                    && may_retain_capability()
                                    && !next.truncationMessage,
                                csvSaveLifecycle: projected_save_lifecycle(),
                                ...(owns_edit_session() && active_edit_session_id
                                    ? { csvEditSessionId: active_edit_session_id }
                                    : {}),
                            },
                            stateSnapshot: adoption_state,
                        }),
                    };
                    const restored_pending_edits = (
                        adoption_state.state as PerFileState
                    ).pendingEdits;
                    if (
                        !owned_before_projection
                        && owns_edit_session()
                        && active_edit_session_id
                        && restored_pending_edits
                    ) {
                        try {
                            // DataSource reads are synchronous by contract. Validate against
                            // this exact source during installation, with SAVE_WINDOW bounding
                            // each read; delivery of any verdict still waits for acknowledgement.
                            const validation = validate_restored_pending_edits(
                                next,
                                restored_pending_edits,
                            );
                            if (validation) {
                                const operation = clone_save_operation({
                                    editSessionId: active_edit_session_id,
                                    saveRequestId: `rehydration:${seq}`,
                                    edits: Object.fromEntries(Object.entries(
                                        validation.dirtyEdits,
                                    ).map(([key, entry]) => [key, entry.value])),
                                    dirtyEdits: validation.dirtyEdits,
                                });
                                pending_rehydration_rejections.set(adoption, {
                                    operation,
                                    rejection: validation.rejection,
                                });
                            }
                        } catch (error) {
                            log_sanitized_failure(
                                'Failed to validate restored CSV edit bases',
                                error,
                            );
                        }
                    }
                    core = installed;
                    source = next;
                    source_authority = committed.receipt.resultingBasis;
                    sync_active_transform_panel();
                    session.replace_adoption(adoption, () => {
                        confirm_transfer();
                        adopted = next;
                    });
                },
            );
            if (result.type === 'refused') return;
        });
        if (!transferred || !adopted || disposed) return undefined;
        profile.on_source_adopted?.(adopted);
        return adopted;
    }

    function schedule_header_refresh(): void {
        if (disposed || header_refresh_scheduled) return;
        header_refresh_scheduled = true;
        queueMicrotask(() => {
            if (disposed) {
                header_refresh_scheduled = false;
                return;
            }
            void refresh_panel_source(true).finally(() => {
                header_refresh_scheduled = false;
            });
        });
    }

    function process_excel_header_receipts(): void {
        if (disposed || header_receipt_processing) return;
        header_receipt_processing = true;
        try {
            header_receipt_queue.sort((left, right) => (
                left.operationOrdinal - right.operationOrdinal
            ));
            while (header_receipt_queue.length > 0 && !disposed) {
                const receipt = header_receipt_queue.shift()!;
                const is_origin = receipt.originToken === excel_header_subscriber_token;
                try {
                    if (same_file_authority_basis(
                        source_authority,
                        receipt.resultingBasis,
                    )) {
                        if (is_origin) {
                            session.retain_command_result({
                                type: 'excelFirstRowHeader',
                                requestId: receipt.requestId,
                                outcome: 'applied',
                            });
                        }
                        continue;
                    }
                    if (
                        compare_authority(receipt.resultingBasis, source_authority)
                            === 'dominated'
                    ) {
                        if (is_origin) {
                            session.retain_command_result({
                                type: 'excelFirstRowHeader',
                                requestId: receipt.requestId,
                                outcome: 'recovered',
                                error: 'A newer workbook projection was already active.',
                            });
                        }
                        continue;
                    }
                    const exact_basis = same_file_authority_basis(
                        source_authority,
                        receipt.previousBasis,
                    ) || (
                        same_semantic_authority_basis(
                            source_authority,
                            receipt.previousBasis,
                        )
                        && compare_authority(
                            receipt.previousBasis,
                            source_authority,
                        ) === 'dominates'
                    );
                    const current_adoption = session.current_adoption();
                    if (
                        exact_basis
                        && core
                        && source instanceof ExcelHeaderDataSource
                        && current_adoption?.resources.source === source
                        && current_adoption.resources.core === core
                    ) {
                        const receipt_state = normalize_host_state(
                            receipt.stateSnapshot.state,
                            source.meta().sheets.map((sheet) => sheet.name),
                        );
                        source.set_hidden_rows(
                            receipt.sheetName,
                            excel_hidden_rows_for_source(
                                source.meta().sheets,
                                receipt_state.transforms,
                            )[receipt.sheetIndex],
                        );
                        if (!source.set_override(receipt.sheetName, receipt.override)) {
                            throw new Error('The selected worksheet no longer exists.');
                        }
                        const projection_adoption = adopt_source_into_core(
                            core,
                            panel,
                            source,
                            source,
                        );
                        if (projection_adoption.type !== 'refused') {
                            core = projection_adoption.core;
                            source_authority = receipt.resultingBasis;
                            if (is_origin) {
                                session.retain_command_result({
                                    type: 'excelFirstRowHeader',
                                    requestId: receipt.requestId,
                                    outcome: 'applied',
                                }, { deliver: false });
                            }
                            const material = core.snapshot_material();
                            session.replace_adoption({
                                source: 'commitReceipt',
                                canonicalFileId: file_key,
                                resources: { source, core },
                                receipt,
                                core: material.core,
                                diagnostics: material.diagnostics,
                                warnings: Object.freeze([...(source.warnings ?? [])]),
                                reason: 'excelHeader',
                                project: () => ({
                                    configuration: {
                                        defaultTabOrientation: host.config.default_tab_orientation(),
                                        previewMode: profile.previewMode === true,
                                    },
                                    capabilities: {
                                        csvEditingSupported: profile.editing,
                                        csvEditable: profile.editing
                                            && may_retain_capability()
                                            && !source!.truncationMessage,
                                        csvSaveLifecycle: projected_save_lifecycle(),
                                        ...(owns_edit_session() && active_edit_session_id
                                            ? { csvEditSessionId: active_edit_session_id }
                                            : {}),
                                    },
                                    stateSnapshot: project_state_for_panel(
                                        receipt.stateSnapshot,
                                        true,
                                    ),
                                }),
                            });
                            continue;
                        }
                    }
                    if (is_origin) {
                        session.retain_command_result({
                            type: 'excelFirstRowHeader',
                            requestId: receipt.requestId,
                            outcome: 'recovered',
                            error: 'The header setting was saved after rebuilding the workbook view.',
                        }, { deliver: false });
                    }
                    schedule_header_refresh();
                } catch (error) {
                    log_sanitized_failure('Failed to apply an Excel header receipt', error);
                    if (is_origin) {
                        session.retain_command_result({
                            type: 'excelFirstRowHeader',
                            requestId: receipt.requestId,
                            outcome: 'recovered',
                            error: 'The header setting was saved after rebuilding the workbook view.',
                        }, { deliver: false });
                    }
                    schedule_header_refresh();
                }
            }
        } finally {
            header_receipt_processing = false;
            if (header_receipt_queue.length > 0 && !disposed) {
                queueMicrotask(process_excel_header_receipts);
            }
        }
    }

    function enqueue_excel_header_receipt(receipt: ExcelHeaderOperationReceipt): void {
        if (disposed) return;
        header_receipt_queue.push(receipt);
        queueMicrotask(process_excel_header_receipts);
    }

    try {
        disposables.push(file_coordinator.subscribe_excel_headers(
            enqueue_excel_header_receipt,
        ));
        disposables.push(file_coordinator.subscribe_cell_highlights((receipt) => {
            if (disposed) return;
            const relation = compare_authority(receipt.authority, source_authority);
            if (relation === 'dominated') return;
            const source_coordinates_are_compatible = relation === 'equal' || (
                receipt.authority.physicalDigest === source_authority.physicalDigest
                && receipt.authority.projectionRevision
                    === source_authority.projectionRevision
            );
            if (!source_coordinates_are_compatible || !source || !core) {
                void refresh_panel_source(true, 'recovery');
                return;
            }
            const highlights = normalize_workbook_snapshot_state(
                receipt.stateSnapshot.state,
                source.meta(),
                receipt.authority.physicalDigest ?? null,
            ).cellHighlights;
            update_session_state_material(receipt.stateSnapshot, false);
            void post_to_receiver({
                type: 'cellHighlightsChanged',
                ...(receipt.scope.type === 'selection'
                    ? { sheetIndex: receipt.scope.sheetIndex }
                    : {}),
                ...(receipt.originToken === cell_highlight_subscriber_token
                    ? { requestId: receipt.requestId }
                    : {}),
                stateRevision: receipt.stateSnapshot.revision,
                physicalRevision: receipt.authority.physicalRevision,
                state: highlights,
                sourceGeneration: core.source_generation,
            });
        }));
    } catch (error) {
        return abort_setup(error);
    }

    // CSV pending-edit persistence deliberately remains on FileStateStore's CAS
    // queue in this phase. Edit-session ownership is separate from file authority;
    // physical/projection/layout writes use the coordinator serialization above.
    async function clear_pending_edits(): Promise<FileStateSnapshot> {
        const committed = await update_file_state((current) => {
            if (!current.pendingEdits) return current;
            const { pendingEdits: _drop, ...rest } = current;
            return rest;
        }, undefined, undefined, null);
        return committed ?? refresh_session_state_material(false);
    }

    function recover_uncertain_edit_cleanup(): Promise<boolean> {
        if (!file_edit_state) return Promise.resolve(false);
        const phase = file_edit_state.phase;
        if (phase.type !== 'uncertain') {
            return Promise.resolve(phase.type === 'free');
        }
        if (!file_edit_state.recovery) {
            const operation = phase.operation;
            const recovery = (async () => {
                try {
                    const snapshot = await clear_pending_edits();
                    // Recovery only restores file availability. A live request waiter
                    // must subsequently win the ordinary free -> owned transition.
                    finish_edit_cleanup(operation, true, snapshot);
                    if (!disposed) update_session_state_material(snapshot, false);
                    return true;
                } catch (error) {
                    log_sanitized_failure('Failed to recover CSV pending-edit cleanup', error);
                    return false;
                }
            })();
            file_edit_state.recovery = recovery;
            void recovery.finally(() => {
                if (file_edit_state?.recovery === recovery) {
                    file_edit_state.recovery = undefined;
                    delete_shared_edit_state_if_unused();
                }
            });
        }
        return file_edit_state.recovery;
    }

    function wait_for_edit_cleanup_recovery(waiter: symbol): Promise<boolean> {
        const recovery = recover_uncertain_edit_cleanup();
        return new Promise((resolve) => {
            const settle = (recovered: boolean) => {
                const current = edit_cleanup_waiters.get(waiter);
                if (!current) return;
                clearTimeout(current.timer);
                edit_cleanup_waiters.delete(waiter);
                resolve(recovered);
            };
            const timer = setTimeout(
                () => settle(false),
                EDIT_CLEANUP_RECOVERY_MS,
            );
            edit_cleanup_waiters.set(waiter, { timer, resolve: settle });
            void recovery.then((recovered) => settle(
                recovered && !disposed && edit_cleanup_waiters.has(waiter),
            ));
        });
    }

    function cancel_edit_cleanup_waiter(waiter: symbol): void {
        edit_cleanup_waiters.get(waiter)?.resolve(false);
    }

    function cancel_edit_cleanup_waiters(): void {
        for (const pending of [...edit_cleanup_waiters.values()]) {
            pending.resolve(false);
        }
        current_edit_cleanup_waiter = undefined;
    }

    function cancel_refresh_retry_wait(): void {
        if (!refresh_retry_wait) return;
        const wait = refresh_retry_wait;
        refresh_retry_wait = undefined;
        clearTimeout(wait.timer);
        wait.resolve(false);
    }

    function wait_for_refresh_retry(request: PanelLoadRequest): Promise<boolean> {
        if (!load_is_current(request.seq, request.refreshEvent)) {
            return Promise.resolve(false);
        }
        cancel_refresh_retry_wait();
        return new Promise((resolve) => {
            const wait = {
                timer: undefined as unknown as ReturnType<typeof setTimeout>,
                resolve,
            };
            wait.timer = setTimeout(() => {
                if (refresh_retry_wait === wait) refresh_retry_wait = undefined;
                resolve(load_is_current(request.seq, request.refreshEvent));
            }, RELOAD_RETRY_MS);
            refresh_retry_wait = wait;
        });
    }

    function inactive_refresh_result(): FileRefreshSubscriberResult {
        return disposed ? { type: 'disposed' } : { type: 'superseded' };
    }

    function report_refresh_failure(
        error: unknown,
        initial: boolean,
        post_save = false,
    ): void {
        if (initial) {
            host.ui.show_error(
                error instanceof Error ? error.message : String(error));
            return;
        }
        log_sanitized_failure('Failed to reload table viewer data', error);
        const message = is_file_not_found_error(error)
            ? 'The file was deleted or moved, so Table Viewer could not reload it.'
            : `Failed to reload: ${error instanceof Error ? error.message : String(error)}`;
        if (post_save) {
            host.ui.show_warning(
                `The file was saved, but Table Viewer could not refresh the table view. ${message}`);
        } else {
            host.ui.show_error(message);
        }
    }

    async function run_physical_refresh(
        request: PanelLoadRequest,
        force: boolean,
        reason: 'ready' | 'fileReload' | 'recovery',
        initial = false,
    ): Promise<FileRefreshSubscriberResult> {
        let attempts = 0;
        let last_error: unknown = new Error('The file changed while it was being refreshed.');
        for (;;) {
            if (!load_is_current(request.seq, request.refreshEvent)) {
                return inactive_refresh_result();
            }
            let candidate: SourceCandidate | undefined;
            try {
                const expected_authority = file_coordinator.authority().authorityRevision;
                candidate = await build_source();
                if (!load_is_current(request.seq, request.refreshEvent)) {
                    return inactive_refresh_result();
                }
                if (!await built_source_is_current(
                    request.seq,
                    candidate,
                    request.refreshEvent,
                )) {
                    if (!load_is_current(request.seq, request.refreshEvent)) {
                        return inactive_refresh_result();
                    }
                    last_error = new Error('The file changed while it was being refreshed.');
                } else if (
                    !force
                    && candidate.observation.digest
                        === session.acknowledged_physical_digest()
                ) {
                    const deduplicated = await commit_physical_candidate(
                        candidate,
                        request.seq,
                        expected_authority,
                        true,
                        request.refreshEvent,
                    );
                    if (!load_is_current(request.seq, request.refreshEvent)) {
                        return inactive_refresh_result();
                    }
                    if (deduplicated.type === 'committed') {
                        source_authority = deduplicated.receipt.resultingBasis;
                        update_session_state_material(
                            deduplicated.receipt.stateSnapshot,
                            true,
                        );
                        return { type: 'completed' };
                    }
                    last_error = new Error('The file authority changed while it was refreshed.');
                } else {
                    const committed = await commit_physical_candidate(
                        candidate,
                        request.seq,
                        expected_authority,
                        true,
                        request.refreshEvent,
                    );
                    if (!load_is_current(request.seq, request.refreshEvent)) {
                        return inactive_refresh_result();
                    }
                    if (committed.type === 'committed') {
                        const adopted = adopt_committed_candidate(
                            candidate,
                            committed,
                            request.seq,
                            reason,
                            profile.editing ? await read_file_state() : undefined,
                            request.refreshEvent,
                        );
                        if (!load_is_current(request.seq, request.refreshEvent)) {
                            return inactive_refresh_result();
                        }
                        if (adopted) return { type: 'completed' };
                    }
                    last_error = new Error('The file authority changed while it was refreshed.');
                }
            } catch (error) {
                if (!load_is_current(request.seq, request.refreshEvent)) {
                    return inactive_refresh_result();
                }
                last_error = error;
            } finally {
                candidate?.dispose();
            }
            if (attempts >= RELOAD_RETRY_COUNT) {
                if (!load_is_current(request.seq, request.refreshEvent)) {
                    return inactive_refresh_result();
                }
                report_refresh_failure(
                    last_error,
                    initial,
                    request.refreshEvent?.reason === 'postSave',
                );
                return { type: 'failed', error: last_error };
            }
            attempts += 1;
            if (!await wait_for_refresh_retry(request)) {
                return inactive_refresh_result();
            }
        }
    }

    async function run_local_refresh_attempt(
        request: PanelLoadRequest,
        force: boolean,
        reason: 'ready' | 'fileReload' | 'recovery',
        initial: boolean,
    ): Promise<boolean> {
        if (!load_is_current(request.seq)) return false;
        let candidate: SourceCandidate | undefined;
        try {
            const expected_authority = file_coordinator.authority().authorityRevision;
            candidate = await build_source();
            if (!await built_source_is_current(request.seq, candidate)) {
                if (
                    !schedule_local_refresh_retry(request, force, reason, initial)
                    && load_is_current(request.seq)
                ) {
                    report_refresh_failure(
                        new Error('The file changed while it was being refreshed.'),
                        initial,
                    );
                }
                return false;
            }
            if (
                !force
                && candidate.observation.digest
                    === session.acknowledged_physical_digest()
            ) {
                const deduplicated = await commit_physical_candidate(
                    candidate, request.seq, expected_authority, true,
                );
                if (deduplicated.type === 'committed' && load_is_current(request.seq)) {
                    source_authority = deduplicated.receipt.resultingBasis;
                    update_session_state_material(deduplicated.receipt.stateSnapshot, true);
                    reset_reload_retry();
                    return true;
                }
                if (
                    !schedule_local_refresh_retry(request, force, reason, initial)
                    && load_is_current(request.seq)
                ) {
                    report_refresh_failure(
                        new Error('The file authority changed while it was refreshed.'),
                        initial,
                    );
                }
                return false;
            }
            const committed = await commit_physical_candidate(
                candidate, request.seq, expected_authority, true,
            );
            if (committed.type !== 'committed') {
                if (
                    !schedule_local_refresh_retry(request, force, reason, initial)
                    && load_is_current(request.seq)
                ) {
                    report_refresh_failure(
                        new Error('The file authority changed while it was refreshed.'),
                        initial,
                    );
                }
                return false;
            }
            const adopted = adopt_committed_candidate(
                candidate,
                committed,
                request.seq,
                reason,
                profile.editing ? await read_file_state() : undefined,
            );
            if (!adopted) return false;
            reset_reload_retry();
            return true;
        } catch (error) {
            if (!load_is_current(request.seq)) return false;
            if (!schedule_local_refresh_retry(request, force, reason, initial)) {
                report_refresh_failure(error, initial);
            }
            return false;
        } finally {
            candidate?.dispose();
        }
    }

    function refresh_panel_source(
        force: boolean,
        reason: 'ready' | 'fileReload' | 'recovery' = force ? 'recovery' : 'fileReload',
        initial = false,
    ): Promise<boolean> {
        if (disposed) return Promise.resolve(false);
        const request = { seq: supersede_panel_load() };
        return run_local_refresh_attempt(request, force, reason, initial);
    }

    function refresh_from_event(
        event: FileRefreshEvent,
    ): Promise<FileRefreshSubscriberResult> {
        if (disposed) return Promise.resolve({ type: 'disposed' });
        latest_refresh_event = event;
        session.wake_delivery();
        const request = {
            seq: supersede_panel_load(),
            refreshEvent: event,
        };
        const projection_recovery = event.reason === 'projectionRecovery';
        return run_physical_refresh(
            request,
            projection_recovery,
            projection_recovery ? 'recovery' : 'fileReload',
        );
    }

    async function send_initial_data(): Promise<void> {
        await refresh_panel_source(true, 'ready', true);
    }

    function reset_reload_retry(): void {
        reload_retry_attempts = 0;
        if (reload_retry_timer !== undefined) {
            clearTimeout(reload_retry_timer);
            reload_retry_timer = undefined;
        }
    }

    function schedule_local_refresh_retry(
        request: PanelLoadRequest,
        force: boolean,
        reason: 'ready' | 'fileReload' | 'recovery',
        initial: boolean,
    ): boolean {
        if (
            !load_is_current(request.seq)
            || reload_retry_attempts >= RELOAD_RETRY_COUNT
        ) {
            return false;
        }
        reload_retry_attempts += 1;
        if (reload_retry_timer !== undefined) clearTimeout(reload_retry_timer);
        reload_retry_timer = setTimeout(() => {
            reload_retry_timer = undefined;
            if (load_is_current(request.seq)) {
                void run_local_refresh_attempt(request, force, reason, initial);
            }
        }, RELOAD_RETRY_MS);
        return true;
    }

    function wait_for_ready_state_retry(ms: number): Promise<boolean> {
        if (disposed) return Promise.resolve(false);
        return new Promise((resolve) => {
            const wait = {
                timer: undefined as unknown as ReturnType<typeof setTimeout>,
                resolve,
            };
            wait.timer = setTimeout(() => {
                ready_state_retry_waits.delete(wait);
                resolve(true);
            }, ms);
            ready_state_retry_waits.add(wait);
        });
    }

    function cancel_ready_state_retry_waits(): void {
        for (const wait of [...ready_state_retry_waits]) {
            clearTimeout(wait.timer);
            ready_state_retry_waits.delete(wait);
            wait.resolve(false);
        }
    }

    async function read_state_for_ready_epoch(
        receiver_epoch: number,
    ): Promise<FileStateSnapshot | undefined> {
        for (let attempt = 0; attempt <= READY_STATE_RETRY_COUNT; attempt += 1) {
            if (
                disposed
                || !session.ready_epoch_is_current(receiver_epoch)
            ) return undefined;
            try {
                return await read_file_state();
            } catch (error) {
                if (
                    disposed
                    || !session.ready_epoch_is_current(receiver_epoch)
                ) return undefined;
                if (attempt === READY_STATE_RETRY_COUNT) {
                    log_sanitized_failure(
                        'Failed to refresh table viewer state before ready; using retained state',
                        error,
                    );
                    return undefined;
                }
                const proceed = await wait_for_ready_state_retry(
                    READY_STATE_RETRY_MS * (2 ** attempt),
                );
                if (
                    !proceed
                    || disposed
                    || !session.ready_epoch_is_current(receiver_epoch)
                ) return undefined;
            }
        }
        return undefined;
    }

    function edit_message_is_current(edit_session_id: string | undefined): boolean {
        return owns_edit_session()
            && active_edit_session_id !== undefined
            && edit_session_id === active_edit_session_id;
    }

    function receiver_request_is_current(request: ReceiverRequest): boolean {
        return !disposed
            && request.receiverEpoch === session.current_receiver_epoch;
    }

    // A save/cleanup promise can outlive its panel: writing saves stay pinned to
    // completion after disposal so durable edit state is cleared correctly. Their
    // user-facing notifications, however, must be gated on liveness — popping a
    // warning or error for an editor the user already closed is a spurious effect.
    function show_owner_warning(message: string): void {
        if (disposed) return;
        host.ui.show_warning(message);
    }
    function show_owner_error(message: string): void {
        if (disposed) return;
        host.ui.show_error(message);
    }

    function finish_save_failure(
        operation: CsvSaveHostOperation,
        warning?: string,
        error?: unknown,
    ): void {
        if (!save_operation_is_current(operation)) return;
        active_save_operation = undefined;
        const lifecycle = finish_save_lifecycle(operation.identity, 'failed');
        if (warning) show_owner_warning(warning);
        if (error !== undefined) {
            show_owner_error(
                `Failed to save: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        void post_to_receiver({
            type: 'saveResult',
            success: false,
            lifecycle,
        });
    }

    function clone_save_operation(input: CsvSaveOperation): CsvSaveOperation {
        const dirty_edits = Object.fromEntries(
            Object.entries(input.dirtyEdits).map(([key, entry]) => [
                key,
                Object.freeze({ value: entry.value, base: entry.base }),
            ]),
        );
        return Object.freeze({
            editSessionId: input.editSessionId,
            saveRequestId: input.saveRequestId,
            edits: Object.freeze({ ...input.edits }),
            dirtyEdits: Object.freeze(dirty_edits),
        });
    }

    async function persist_accepted_save(operation: CsvSaveHostOperation): Promise<void> {
        // Recorded *before* the CAS, because `release_edit_session` reads this set
        // while the CAS is still in flight. `compare_and_set` validates currency and
        // then awaits the medium's durable write — a real filesystem write on a
        // disk-backed memento. A release landing in that window writes its tombstone
        // decision right then, so an add that waits for the CAS to return is already
        // too late: the edits reach disk, the tombstone is skipped, and they survive
        // into the next session. That is the leak this gate exists to close, and the
        // surviving edit is the folded live-editor value the user never posted.
        persisted_save_identities.add(operation.identity);
        const committed = await update_file_state((current) => ({
            ...current,
            pendingEdits: Object.fromEntries(
                Object.entries(operation.identity.dirtyEdits).map(([key, entry]) => [
                    key,
                    { value: entry.value, base: entry.base },
                ]),
            ),
        }), undefined, () => save_operation_is_current(operation));
        if (!committed || !save_operation_is_current(operation)) {
            throw new Error('The save operation changed before its edits were accepted.');
        }
        notify_edit_state(committed);
    }

    async function handle_save(input: CsvSaveOperation): Promise<void> {
        const receiver_epoch = session.current_receiver_epoch;
        const identity = clone_save_operation(input);
        if (active_save_operation) return;
        if (!edit_message_is_current(identity.editSessionId)) {
            const active = begin_save_lifecycle(identity);
            const lifecycle = finish_save_lifecycle(active.operation, 'failed');
            void post_to_receiver({
                type: 'saveResult',
                success: false,
                lifecycle,
            }, receiver_epoch);
            return;
        }

        const current_adoption = session.current_adoption();
        const expected_digest = session.acknowledged_physical_digest();
        const src = source;
        const expected_authority = source_authority.authorityRevision;
        // `transform_work_in_flight()` is the other half of the exclusion
        // `save_blocks_transform()` states: transforms refuse during a save, and
        // saves refuse during transform work. Same in-flight set on both sides.
        // Without it the owner could start a slow sort and save immediately;
        // `compute_transform` yields at its cancellation checkpoints, so the save
        // would refresh and replace the source first, cancelling the transform,
        // and the webview would clear its request on the row-basis change with no
        // ack — the requested sort silently lost. Refusing rather than waiting
        // matches this gate's existing shape: the save reports a failed lifecycle
        // the webview already knows how to restore from, and transform work is
        // short, so a retry costs the user one keystroke.
        if (
            edit_cleanup_blocked()
            || transform_work_in_flight()
            || !profile.editing
            || !src
            || !!src.truncationMessage
            || expected_digest === undefined
            || !session.acknowledged_current()
            || current_adoption?.resources.source !== src
            || current_adoption.resources.core !== core
            || expected_authority !== file_coordinator.authority().authorityRevision
        ) {
            const active = begin_save_lifecycle(identity);
            const lifecycle = finish_save_lifecycle(active.operation, 'failed');
            show_owner_warning(
                transform_work_in_flight()
                    ? 'Wait for sorting and filtering to finish, then save again.'
                    : 'The table view is still refreshing. Please try saving again.',
            );
            void post_to_receiver({ type: 'saveResult', success: false, lifecycle });
            return;
        }

        // Raw text of exactly the cells the dirty map names, harvested from the
        // serialization walk below so the source is traversed once. Keys are
        // source-keyed, like the dirty map itself.
        const observed_bases = new Map<string, string>();
        const wanted_columns = new Map<number, number[]>();
        for (const key of Object.keys(identity.dirtyEdits)) {
            const [source_row, col] = key.split(':').map(Number);
            const columns = wanted_columns.get(source_row);
            if (columns) columns.push(col);
            else wanted_columns.set(source_row, [col]);
        }

        const wants_bases = wanted_columns.size > 0;

        let content: string;
        try {
            const row_count = src.meta().sheets[0].rowCount;
            function* row_windows(): Generator<(RenderedCell | null)[]> {
                let absolute_row = 0;
                for (let start = 0; start < row_count; start += SAVE_WINDOW) {
                    const { rows } = src!.read_rows(0, start, SAVE_WINDOW);
                    for (const row of rows) {
                        // `wants_bases` short-circuits the per-row Map probe. The
                        // walk visits every row of the file (1M+ is a real case) but
                        // the map is empty whenever there is nothing to harvest, so
                        // without this a save with no dirty edits pays a million
                        // lookups on an empty Map for no possible hit.
                        const columns = wants_bases
                            ? wanted_columns.get(absolute_row)
                            : undefined;
                        if (columns) {
                            for (const col of columns) {
                                // A column past this row's field count is left
                                // unrecorded, so the reader below reports
                                // `undefined` and validate_dirty_bases coalesces it
                                // to '' — matching the webview's get_cell_raw,
                                // where a loaded blank cell is ''.
                                const cell = row[col];
                                if (cell === undefined) continue;
                                observed_bases.set(
                                    `${absolute_row}:${col}`,
                                    cell === null ? '' : String(cell.raw ?? ''),
                                );
                            }
                        }
                        absolute_row++;
                        yield row;
                    }
                }
            }
            content = serialize_csv(
                row_windows(),
                get_delimiter(file_path),
                identity.edits,
                src.originalColumnCounts,
                src.lineEnding,
                src.headerLine,
            );
        } catch (error) {
            const active = begin_save_lifecycle(identity);
            const lifecycle = finish_save_lifecycle(active.operation, 'failed');
            show_owner_error(
                `Failed to save: ${error instanceof Error ? error.message : String(error)}`,
            );
            void post_to_receiver({ type: 'saveResult', success: false, lifecycle });
            return;
        }

        // Validate every edit's base against the raw source before a single byte
        // is written. This is NOT redundant with the TOCTOU digest check further
        // down, which stays exactly where it is: that one asks "did the file change
        // since the snapshot we acknowledged?", comparing bytes against the
        // acknowledged digest. This asks the different question "was this edit's
        // base ever true?", which is also false for an edit created *before* an
        // acknowledged refresh — a case the digest check reports as clean because
        // the file matches the snapshot we did acknowledge. Neither subsumes the
        // other.
        //
        // The webview cannot answer this alone: its conflict detection is
        // residency-gated (see csv-base-validation.ts's header), so a filtered,
        // evicted, or shrunk-away row is never flagged there.
        const validation = validate_dirty_bases(
            identity.dirtyEdits,
            src.meta().sheets[0].sourceRowCount,
            (source_row, col) => observed_bases.get(`${source_row}:${col}`),
        );
        if (validation.type !== 'valid') {
            // Same shape as the sibling early-returns above: a begin/finish pair so
            // the webview sees a terminal 'failed' lifecycle for this exact
            // operation and restores the precise dirty map it submitted.
            const active = begin_save_lifecycle(identity);
            const lifecycle = finish_save_lifecycle(active.operation, 'failed');
            const rejection: CsvSaveRejection = validation.type === 'removedRows'
                ? { reason: 'rowsRemoved', keys: validation.keys }
                : { reason: 'baseMismatch', keys: validation.keys };
            // Warning, not error, matching the digest-check path: an externally
            // changed file is an expected condition the user resolves, not a
            // failure of ours.
            show_owner_warning(
                rejection.reason === 'rowsRemoved'
                    ? 'File shrank externally. Some edited rows no longer exist, so the save was cancelled.'
                    : 'File was modified externally. Some edits no longer match the file, so the save was cancelled.',
            );
            void post_to_receiver({
                type: 'saveResult',
                success: false,
                lifecycle,
                rejection,
            });
            return;
        }

        const operation: CsvSaveHostOperation = {
            identity,
            phase: 'preparing',
        };
        active_save_operation = operation;
        const active_lifecycle = begin_save_lifecycle(identity);
        void post_to_receiver({
            type: 'saveOperationStarted',
            lifecycle: active_lifecycle,
        }, receiver_epoch);

        const saved_bytes = new TextEncoder().encode(content);
        const saved_digest = content_digest(saved_bytes);
        let post_save_reservation: { cancel(): void } | undefined;
        try {
            await pending_edit_writes.catch(() => {});
            if (!save_operation_is_current(operation)) return;
            await persist_accepted_save(operation);
            operation.phase = 'accepted';

            const current_stat = await host.fs.stat(uri);
            if (!save_operation_is_current(operation)) return;
            const max_mib = host.config.max_file_size_mib();
            assert_safe_file_size(current_stat.size, max_mib);

            const current_raw = await host.fs.read_file(uri);
            if (!save_operation_is_current(operation)) return;
            assert_safe_file_size(current_raw.byteLength, max_mib);

            const verified_stat = await host.fs.stat(uri);
            if (!save_operation_is_current(operation)) return;
            const snapshot_changed = current_stat.mtime !== verified_stat.mtime
                || current_stat.size !== verified_stat.size;

            // Shared refusal path: both the full verification below and the final
            // pre-write re-stat must report a conflict identically, so a detected
            // race never surfaces as a generic "Failed to save" error.
            const refuse_as_external_change = async (): Promise<void> => {
                show_owner_warning(
                    'File was modified externally. Please review the changes and try again.',
                );
                if (!disposed) await refresh_panel_source(true, 'recovery');
                if (!save_operation_is_current(operation)) return;
                finish_save_failure(operation);
            };

            if (
                snapshot_changed
                || content_digest(current_raw) !== expected_digest
                || source_authority.authorityRevision !== expected_authority
                || expected_authority !== file_coordinator.authority().authorityRevision
            ) {
                await refuse_as_external_change();
                return;
            }

            // Narrow (but do not close) the pre-check/pre-write TOCTOU.
            //
            // The verification above has a synchronous sha256 over the whole file as
            // its last expensive step, so on a large CSV the gap between
            // `verified_stat` and the write was dominated by that hash — hundreds of
            // milliseconds in which an external write was silently overwritten. This
            // final cheap stat moves the observation to the last possible moment:
            // there is deliberately no `await` between it and `write_file`, so we no
            // longer carry a self-inflicted hashing delay inside the gap.
            //
            // What this does NOT close, and cannot:
            //  - A write landing between this stat and `write_file` is still lost.
            //    The gap is now the filesystem's own plus the event-loop turn that
            //    resumes this continuation — small, but not zero. Detection here is
            //    best-effort narrowing, not mutual exclusion; only an advisory lock
            //    or an OS-level compare-and-swap would close it, and
            //    `FileSystemPort` exposes no handle to build either on.
            //  - A same-size write within the same coarse mtime tick is invisible
            //    to any {size, mtime} comparison. Such an edit is caught only by
            //    the digest check above, and only if it lands before the read.
            //
            // Triage note: on attribute-caching network filesystems (NFS/SMB) this
            // stat can land after cache expiry when the two earlier stats were served
            // from cache, so it may reveal a server-side change they hid. Refusing is
            // correct there — that save used to clobber silently — but it is a new
            // refusal on a path that previously appeared to succeed.
            let final_stat: FileStat;
            try {
                final_stat = await host.fs.stat(uri);
            } catch (error) {
                // A file that cannot be stat'ed right before the write is a race,
                // not a save bug: refuse rather than clobbering blind. The user
                // sees the external-change warning, so log the real cause to keep
                // a genuine filesystem fault (EACCES, EBUSY, quota) diagnosable.
                log_sanitized_failure('Pre-write stat failed before saving', error);
                // Check currency first, matching the mismatch path below: a save
                // already superseded during the stat must not emit a warning.
                if (!save_operation_is_current(operation)) return;
                await refuse_as_external_change();
                return;
            }
            if (!save_operation_is_current(operation)) return;
            if (
                final_stat.mtime !== verified_stat.mtime
                || final_stat.size !== verified_stat.size
            ) {
                await refuse_as_external_change();
                return;
            }

            post_save_reservation = refresh_subscription.reserve_post_save();
            operation.phase = 'writing';
            // Once this call starts, release/discard/disposal cannot transfer the
            // edit epoch until durable completion and cleanup ownership transfer.
            await host.fs.write_file(uri, saved_bytes);

            // The watcher is reserved across this write and CAS so the state
            // rebase commits against the same save authority.
            // update_file_state reports a no-op updater as undefined. That can
            // mean either a byte-identical save or a concurrent writer that
            // already satisfied the rebase, so recover the latest snapshot.
            let rebase_was_noop = false;
            const rebase_is_current = () => save_operation_is_current(operation)
                && source_authority.authorityRevision === expected_authority
                && file_coordinator.state_write_is_current(expected_authority);
            let rebased = await update_file_state((current) => {
                if (!save_operation_is_current(operation)) return current;
                const highlights = rebase_cell_highlight_digest(
                    current.cellHighlights,
                    saved_digest,
                );
                if (cell_highlight_states_equal(current.cellHighlights, highlights)) {
                    rebase_was_noop = true;
                    return current;
                }
                return { ...current, cellHighlights: highlights };
            }, undefined, rebase_is_current, {
                expectedAuthorityRevision: expected_authority,
                expectedPhysicalRevision: source_authority.physicalRevision,
            });
            if (!rebased && rebase_was_noop && rebase_is_current()) {
                const current = await read_file_state(false);
                rebased = rebase_is_current() ? current : undefined;
            }
            if (!rebased || !save_operation_is_current(operation)) {
                throw new Error(
                    'The file was written, but its highlight state could not be rebased safely.',
                );
            }
            update_session_state_material(rebased, false);
        } catch (error) {
            if (active_save_operation !== operation) return;
            active_save_operation = undefined;
            post_save_reservation?.cancel();
            const lifecycle = finish_save_lifecycle(identity, 'failed');
            if (disposed) {
                await release_edit_session(identity.editSessionId);
                delete_shared_edit_state_if_unused();
                return;
            }
            show_owner_error(
                `Failed to save: ${error instanceof Error ? error.message : String(error)}`,
            );
            void post_to_receiver({
                type: 'saveResult',
                success: false,
                lifecycle,
            });
            return;
        }

        // writeFile completed: atomically prevent every attachment from claiming
        // or projecting edits until the durable pending-state clear finishes.
        const succeeded_lifecycle = finish_save_lifecycle(identity, 'succeeded');
        let cleanup_operation = begin_edit_cleanup(identity.editSessionId, operation);
        if (!cleanup_operation) {
            cleanup_operation = Symbol(file_key);
            active_save_operation = undefined;
            active_edit_session_id = undefined;
            if (file_edit_state) {
                file_edit_state.phase = {
                    type: 'cleanupPending',
                    operation: cleanup_operation,
                };
            }
            console.error('CSV save lost edit ownership after writeFile');
        }

        void post_to_receiver({
            type: 'saveResult',
            success: true,
            lifecycle: succeeded_lifecycle,
        });
        void post_to_receiver({
            type: 'editSessionRevoked',
            reason: 'saved',
            lifecycle: succeeded_lifecycle,
        });
        notify_edit_state();

        void refresh_subscription.request('postSave').catch((error) => {
            if (disposed) return;
            log_sanitized_failure('Post-save refresh request failed (file was written)', error);
            show_owner_warning(
                'The file was saved, but Table Viewer could not refresh the table view.',
            );
        });

        void clear_pending_edits().then((snapshot) => {
            finish_edit_cleanup(cleanup_operation, true, snapshot);
            if (!disposed) update_session_state_material(snapshot, false);
        }).catch((error) => {
            finish_edit_cleanup(cleanup_operation, false);
            if (disposed) return;
            log_sanitized_failure('CSV save succeeded but pending-edit cleanup failed', error);
            show_owner_warning(
                'The file was saved, but Table Viewer could not clear its saved edit state. Editing remains disabled for this file.',
            );
        });
    }

    async function handle_transform_message(
        message: Extract<WebviewMessage, { type: 'setTransform' }>,
    ): Promise<void> {
        // Synchronized CSV preview relies on display rows retaining their
        // natural source-row order so visibleRowChanged can index the
        // source-line map directly. Treat previewMode as a host-side
        // trust boundary: a stale or injected webview message must not
        // reach transform admission, the core, or durable state.
        if (profile.previewMode === true) return;
        const transform_sheet = source?.meta().sheets[message.sheetIndex];
        if (transform_sheet) {
            if (
                transform_has_entries(message.state)
                && message.state.schema !== transform_schema_for_sheet(transform_sheet)
            ) {
                await core?.handle_message(message);
                return;
            }
            message = {
                ...message,
                state: sanitize_transform_state(
                    message.state,
                    transform_sheet.columnCount,
                    transform_schema_for_sheet(transform_sheet),
                    transform_sheet.sourceRowCount,
                ) ?? EMPTY_TRANSFORM,
            };
        }
        const active_header = transform_sheet?.excelFirstRowHeader;
        const protected_source_rows = active_header?.mode === 'on'
            ? active_header.sourceRow ?? transform_sheet?.sourceRowCount ?? 0
            : 0;
        // Native XLS/XLSX sources use physical row positions as canonical IDs.
        const requested_hidden_rows = new Set(message.state.hiddenRows ?? []);
        if (
            active_header?.mode === 'on'
            && active_header.sourceRow !== undefined
            && requested_hidden_rows.has(active_header.sourceRow)
        ) {
            await core?.reject_transform(
                message,
                'The active header row cannot be hidden.',
                'terminal',
            );
            return;
        }
        if (protected_source_rows > 0) {
            for (let row = 0; row < protected_source_rows; row += 1) {
                if (requested_hidden_rows.has(row)) continue;
                await core?.reject_transform(
                    message,
                    'Use Unhide all to restore rows above the active header.',
                    'terminal',
                );
                return;
            }
        }
        const transform_admission: TransformAdmission = profile.editing
            ? begin_transform_admission()
            : { operation: Symbol(file_key) };
        if ('refusal' in transform_admission) {
            // Transient: the admission matrix refuses on an edit-session phase or a
            // save in flight, both of which end on their own. The webview keeps its
            // requested transform and retries instead of adopting the unchanged echo.
            await core?.reject_transform(
                message,
                transform_admission.refusal,
                'transient',
            );
            return;
        }
        let resolve_completion!: () => void;
        const completion = new Promise<void>((resolve) => {
            resolve_completion = resolve;
        });
        const transform_authority: TransformAuthority = {
            authorityRevision: source_authority.authorityRevision,
            receiverEpoch: session.current_receiver_epoch,
            completion,
            resolveCompletion: resolve_completion,
        };
        transform_authorities.set(message, transform_authority);
        latest_transform_authority_by_sheet.set(
            message.sheetIndex,
            transform_authority,
        );
        try {
            await core?.handle_message(message);
            try {
                await reconcile_transform_terminal(message, transform_authority);
            } catch (error) {
                log_sanitized_failure(
                    'Failed to reconcile durable table transforms after a terminal operation',
                    error,
                );
            }
        } finally {
            if (transform_authorities.get(message) === transform_authority) {
                transform_authorities.delete(message);
            }
            if (
                latest_transform_authority_by_sheet.get(message.sheetIndex)
                === transform_authority
            ) latest_transform_authority_by_sheet.delete(message.sheetIndex);
            transform_commit_barriers.delete(transform_authority);
            transform_authority.resolveCompletion();
            if (profile.editing) {
                finish_transform_admission(transform_admission.operation);
            }
        }
    }

    try {
        disposables.push(webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
        if (disposed) return;
        if (
            msg.type !== 'ready'
            && msg.type !== 'snapshotApplied'
            && msg.type !== 'showWarning'
        ) {
            session.wake_delivery();
        }
        switch (msg.type) {
            case 'ready': {
                if (renderer_ready) {
                    reject_pending_edit_protocol(new Error(
                        'Viewer renderer reloaded before the pending-edit flush completed.',
                    ));
                }
                renderer_ready = true;
                renderer_protocol_epoch += 1;
                const begun = session.begin_ready();
                // This must happen before the first await: an older receiver's
                // compute or CAS continuation cannot overtake the new snapshot.
                core?.begin_receiver_epoch(begun.receiverEpoch);
                active_edit_session_request = undefined;
                cancel_edit_claim(active_edit_claim);
                active_save_dialog_request = undefined;
                pending_edit_sequence_session_id = undefined;
                highest_pending_edit_sequence = 0;
                highest_acknowledged_edit_sequence = 0;
                // The inbound ready message guarantees the receiver is installed;
                // replay without delaying the existing ready-state concurrency.
                void post_to_receiver({
                    type: 'fontChanged',
                    fontFamily: host.config.font_family(),
                    fontSize: host.config.font_size(),
                }, begun.receiverEpoch);
                let needs_initial_source = false;
                try {
                    const older_commit_barriers = [...transform_commit_barriers]
                        .filter((barrier) => barrier.receiverEpoch < begun.receiverEpoch)
                        .map((barrier) => barrier.completion);
                    if (older_commit_barriers.length > 0) {
                        await Promise.allSettled(older_commit_barriers);
                    }
                    let ready_rebases = 0;
                    const ready_cleaned_transform_sheets = new Set<number>();
                    while (
                        begun.hasSource
                        && !disposed
                        && session.ready_epoch_is_current(begun.receiverEpoch)
                        && ready_rebases < READY_STATE_REBASE_COUNT
                    ) {
                        ready_rebases += 1;
                        const ready_adoption = session.current_adoption();
                        const ready_core = core;
                        const ready_source_generation = ready_core?.source_generation;
                        if (!ready_adoption || !ready_core) break;
                        const state_snapshot = await read_state_for_ready_epoch(
                            begun.receiverEpoch,
                        );
                        if (!state_snapshot) break;
                        if (
                            disposed
                            || !session.ready_epoch_is_current(begun.receiverEpoch)
                        ) break;
                        if (
                            session.current_adoption() !== ready_adoption
                            || core !== ready_core
                            || ready_core.source_generation !== ready_source_generation
                        ) continue;

                        const transform_admission: TransformAdmission = profile.editing
                            ? begin_transform_admission()
                            : { operation: Symbol(file_key) };
                        if ('refusal' in transform_admission) {
                            // Every still-refusing phase reaches here — a sibling's
                            // session, a claim, a release, cleanup, or uncertainty —
                            // and keeps the installed view natural. Ready must still
                            // cross a serialized revision barrier before publishing
                            // its state material.
                            const confirmed = await read_state_for_ready_epoch(
                                begun.receiverEpoch,
                            );
                            if (!confirmed) break;
                            if (
                                disposed
                                || !session.ready_epoch_is_current(begun.receiverEpoch)
                                || session.current_adoption() !== ready_adoption
                                || core !== ready_core
                                || ready_core.source_generation !== ready_source_generation
                            ) continue;
                            if (confirmed.revision !== state_snapshot.revision) continue;
                            update_session_state_material(confirmed, false);
                            break;
                        }
                        let reconciled = false;
                        try {
                            const sheets = ready_core.snapshot_material().core.meta.sheets;
                            const durable = normalize_host_state(
                                state_snapshot.state,
                                sheets.map((sheet) => sheet.name),
                            );
                            const transforms = sheets.map((sheet, index) => (
                                sanitize_transform_state(
                                    durable.transforms?.[index],
                                    sheet.columnCount,
                                    transform_schema_for_sheet(sheet),
                                    sheet.sourceRowCount,
                                )
                            ));
                            const prepared = await ready_core.prepare_transform_reconciliation(
                                transforms,
                                () => disposed
                                    || core !== ready_core
                                    || session.current_adoption() !== ready_adoption
                                    || !session.ready_epoch_is_current(
                                        begun.receiverEpoch,
                                    ),
                            );
                            if (!prepared) continue;
                            const confirmed = await read_state_for_ready_epoch(
                                begun.receiverEpoch,
                            );
                            if (!confirmed) break;
                            if (confirmed.revision !== state_snapshot.revision) continue;
                            if (
                                file_edit_state
                                && file_edit_state.durableTransform.revision
                                    > confirmed.revision
                            ) continue;
                            if (
                                disposed
                                || !session.ready_epoch_is_current(begun.receiverEpoch)
                                || session.current_adoption() !== ready_adoption
                                || core !== ready_core
                                || ready_core.source_generation !== ready_source_generation
                            ) continue;
                            if (!update_session_state_material(confirmed, false)) continue;
                            reconciled = ready_core.commit_transform_reconciliation(prepared);
                        } catch (error) {
                            if (error instanceof InvalidPersistedTransformError) {
                                const cleanup_is_current = () => !disposed
                                    && session.ready_epoch_is_current(begun.receiverEpoch)
                                    && session.current_adoption() === ready_adoption
                                    && core === ready_core
                                    && ready_core.source_generation
                                        === ready_source_generation
                                    && file_coordinator.state_write_is_current(
                                        source_authority.authorityRevision,
                                    );
                                let cleanup_result: InvalidTransformCleanupResult = 'failed';
                                try {
                                    cleanup_result = await cleanup_invalid_persisted_transform(
                                        error,
                                        cleanup_is_current,
                                    );
                                } catch (cleanup_error) {
                                    log_sanitized_failure(
                                        'Failed to clear an invalid saved table transform',
                                        cleanup_error,
                                    );
                                }
                                // Re-read and prepare the committed state (or a
                                // concurrent winner); never publish this attempt's
                                // stale durable material after recovery.
                                if (cleanup_result !== 'failed') {
                                    if (cleanup_result === 'committed') {
                                        // Repairing one independently invalid sheet
                                        // is forward progress, not external state
                                        // churn. Credit each sheet once; repeated
                                        // reintroduction on one sheet must remain
                                        // bounded by the normal rebase budget.
                                        if (!ready_cleaned_transform_sheets.has(
                                            error.sheetIndex,
                                        )) {
                                            ready_cleaned_transform_sheets.add(
                                                error.sheetIndex,
                                            );
                                            ready_rebases -= 1;
                                        }
                                    }
                                    continue;
                                }
                            }
                            log_sanitized_failure(
                                'Failed to reconcile table transforms before ready; using retained view',
                                error,
                            );
                            let confirmed: FileStateSnapshot | undefined;
                            try {
                                confirmed = await read_state_for_ready_epoch(
                                    begun.receiverEpoch,
                                );
                            } catch (confirmation_error) {
                                log_sanitized_failure(
                                    'Failed to confirm table state after ready reconciliation error',
                                    confirmation_error,
                                );
                                continue;
                            }
                            if (!confirmed) break;
                            if (confirmed.revision !== state_snapshot.revision) continue;
                            if (
                                disposed
                                || !session.ready_epoch_is_current(begun.receiverEpoch)
                                || session.current_adoption() !== ready_adoption
                                || core !== ready_core
                                || ready_core.source_generation !== ready_source_generation
                            ) continue;
                            update_session_state_material(confirmed, false);
                            break;
                        } finally {
                            if (profile.editing) {
                                finish_transform_admission(transform_admission.operation);
                            }
                        }
                        if (!reconciled) continue;
                        update_session_state_material(state_snapshot, true);
                        break;
                    }
                    if (
                        ready_rebases >= READY_STATE_REBASE_COUNT
                        && !disposed
                        && session.ready_epoch_is_current(begun.receiverEpoch)
                    ) {
                        try {
                            const latest = await read_state_for_ready_epoch(
                                begun.receiverEpoch,
                            );
                            const confirmed = latest
                                ? await read_state_for_ready_epoch(begun.receiverEpoch)
                                : undefined;
                            if (
                                latest
                                && confirmed
                                && latest.revision === confirmed.revision
                                && !disposed
                                && session.ready_epoch_is_current(begun.receiverEpoch)
                            ) update_session_state_material(confirmed, false);
                        } catch (error) {
                            log_sanitized_failure(
                                'Failed to confirm the latest table state after ready rebases',
                                error,
                            );
                        }
                        console.error(
                            'Table viewer state kept changing during ready; using retained state',
                        );
                    }
                } finally {
                    const ready = session.complete_ready(begun.receiverEpoch);
                    needs_initial_source = ready.type === 'needsInitialSource';
                }
                if (needs_initial_source) await send_initial_data();
                return;
            }
            case 'snapshotApplied':
                session.handle_snapshot_applied(msg.identity, msg.disposition);
                return;
            case 'stateChanged': {
                const expected_authority = source_authority.authorityRevision;
                const message = structuredClone(msg);
                await enqueue_layout_write(
                    () => persist_layout_state(message, expected_authority),
                );
                return;
            }
            case 'setExcelFirstRowHeader': {
                const fail = (error: string) => {
                    session.retain_command_result({
                        type: 'excelFirstRowHeader',
                        requestId: msg.requestId,
                        outcome: 'rejected',
                        error,
                    });
                };
                if (
                    disposed
                    || !(source instanceof ExcelHeaderDataSource)
                    || !core
                ) {
                    fail('First-row headers are only available for Excel worksheets.');
                    return;
                }
                if (
                    !session.acknowledged_current()
                    || source_authority.authorityRevision
                        !== file_coordinator.authority().authorityRevision
                    || msg.generation !== core.generation
                    || msg.sourceGeneration !== core.source_generation
                ) {
                    fail('The worksheet changed before the header request arrived.');
                    return;
                }
                const sheet = source.meta().sheets[msg.sheetIndex];
                if (!sheet || sheet.name !== msg.sheetName) {
                    fail('The selected worksheet no longer matches this request.');
                    return;
                }
                source.set_hidden_rows(
                    msg.sheetName,
                    core.transform_state(msg.sheetIndex).hiddenRows,
                );
                const header = source.meta().sheets[msg.sheetIndex]
                    ?.excelFirstRowHeader;
                if (!header) {
                    fail('First-row headers are only available for Excel worksheets.');
                    return;
                }
                if (
                    msg.unhideAll === true
                    && (
                        msg.enabled
                        || header.mode !== 'on'
                        || header.sourceRow === 0
                    )
                ) {
                    fail('The requested row restoration does not match the active header.');
                    return;
                }
                let header_source_row: number | undefined;
                let target_planning_input: ReturnType<
                    ExcelHeaderDataSource['planning_input_for_header_source']
                >;
                if (msg.headerRow !== undefined) {
                    if (
                        !msg.enabled
                        || msg.unhideAll === true
                        || !Number.isInteger(msg.headerRow)
                        || msg.headerRow < 0
                    ) {
                        fail('The requested header row is invalid.');
                        return;
                    }
                    const installed_transform = core.transform_state(msg.sheetIndex);
                    if (
                        installed_transform.sort.length > 0
                        || installed_transform.filters.some((filter) => filter.enabled)
                    ) {
                        fail('Clear sorting and filtering before choosing a header row.');
                        return;
                    }
                    try {
                        header_source_row = core.map_display_rows_to_source(
                            msg.sheetIndex,
                            [{ start: msg.headerRow, end: msg.headerRow }],
                        )[0];
                    } catch {
                        fail('The selected row is no longer available.');
                        return;
                    }
                    if (header_source_row === undefined) {
                        fail('The selected row is no longer available.');
                        return;
                    }
                    if (header_source_row > MAX_PERSISTED_HIDDEN_ROWS) {
                        fail('Too many rows precede the selected header row.');
                        return;
                    }
                    target_planning_input = source.planning_input_for_header_source(
                        msg.sheetName,
                        header_source_row,
                    );
                    if (!target_planning_input) {
                        fail('The selected row is no longer available.');
                        return;
                    }
                }
                if (msg.enabled && !header.available) {
                    fail('This worksheet has no first row to use as column names.');
                    return;
                }

                const command_source = source;
                const expected_physical_revision = source_authority.physicalRevision;
                const expected_physical_digest = source_authority.physicalDigest;
                const result = await file_coordinator.commit_excel_header({
                    requestId: msg.requestId,
                    sheetIndex: msg.sheetIndex,
                    sheetName: msg.sheetName,
                    override: msg.enabled ? 'on' : 'off',
                    originToken: excel_header_subscriber_token,
                    expectedPhysicalRevision: expected_physical_revision,
                    expectedPhysicalDigest: expected_physical_digest,
                    planningInput: command_source.planning_input(),
                    clearHiddenRows: msg.unhideAll === true,
                    headerSourceRow: header_source_row,
                    targetPlanningInput: target_planning_input,
                    stateStore: durable_state_store,
                });
                if (result.type === 'indeterminate' && !disposed) {
                    session.retain_command_result({
                        type: 'excelFirstRowHeader',
                        requestId: msg.requestId,
                        outcome: 'recovered',
                        error: result.error,
                    });
                } else if (result.type === 'rejected' && !disposed) {
                    fail(result.error);
                    if (
                        result.error
                            === 'The selected worksheet no longer matches this request.'
                    ) schedule_header_refresh();
                }
                return;
            }
            case 'applyCellHighlights':
            case 'clearAllCellHighlights': {
                const message = structuredClone(msg);
                const receiver_epoch = session.current_receiver_epoch;
                const command_core = core;
                const command_source = source;
                const expected_authority = source_authority.authorityRevision;
                const expected_physical_revision = source_authority.physicalRevision;
                const expected_projection_revision = source_authority.projectionRevision;
                const expected_physical_digest = source_authority.physicalDigest;
                const command_is_current = () => {
                    const acknowledged = session.acknowledged_identity();
                    return !disposed
                        && profile.previewMode !== true
                        && command_core !== undefined
                        && command_source !== undefined
                        && core === command_core
                        && source === command_source
                        && session.current_receiver_epoch === receiver_epoch
                        && acknowledged !== undefined
                        && same_snapshot_identity(message.snapshotIdentity, acknowledged)
                        && message.generation === command_core.generation
                        && message.sourceGeneration === command_core.source_generation
                        && message.snapshotIdentity.authority.revision === expected_authority
                        && message.snapshotIdentity.sourceBasis.physicalRevision
                            === expected_physical_revision
                        && source_authority.authorityRevision === expected_authority
                        && source_authority.physicalRevision === expected_physical_revision
                        && (
                            message.type === 'clearAllCellHighlights'
                            || source_authority.projectionRevision
                                === expected_projection_revision
                        )
                        && source_authority.physicalDigest === expected_physical_digest
                        && file_coordinator.state_write_is_current(expected_authority);
                };
                const reject_highlight_command = async (error: string) => {
                    let state = undefined;
                    let state_revision = message.snapshotIdentity.stateRevision;
                    const current_authority = file_coordinator.authority();
                    const current_source = source ?? command_source;
                    if (current_source && current_authority.physicalDigest) {
                        try {
                            const current = await read_file_state(false);
                            state_revision = current.revision;
                            state = normalize_workbook_snapshot_state(
                                current.state,
                                current_source.meta(),
                                current_authority.physicalDigest,
                            ).cellHighlights;
                        } catch {
                            // Return the latest known authority envelope when the
                            // current durable state cannot be inspected safely.
                        }
                    }
                    if (disposed || session.current_receiver_epoch !== receiver_epoch) return;
                    void post_to_receiver({
                        type: 'cellHighlightsChanged',
                        ...(message.type === 'applyCellHighlights'
                            ? { sheetIndex: message.sheetIndex }
                            : {}),
                        requestId: message.requestId,
                        stateRevision: state_revision,
                        physicalRevision: current_authority.physicalRevision,
                        state,
                        sourceGeneration: core?.source_generation
                            ?? command_core?.source_generation
                            ?? message.sourceGeneration,
                        error,
                    }, receiver_epoch);
                };
                if (
                    !command_source
                    || !command_core
                    || !expected_physical_digest
                    || !command_is_current()
                ) {
                    await reject_highlight_command(
                        profile.previewMode === true
                            ? 'Cell highlights cannot be changed from a preview.'
                            : 'The workbook changed before the highlight request arrived.',
                    );
                    return;
                }
                const common = {
                    requestId: message.requestId,
                    originToken: cell_highlight_subscriber_token,
                    expectedAuthorityRevision: expected_authority,
                    expectedPhysicalRevision: expected_physical_revision,
                    expectedPhysicalDigest: expected_physical_digest,
                    meta: command_source.meta(),
                    stateStore: durable_state_store,
                    isCurrent: command_is_current,
                };
                const result = message.type === 'applyCellHighlights'
                    ? await file_coordinator.apply_cell_highlights({
                        ...common,
                        expectedProjectionRevision: expected_projection_revision,
                        sheetIndex: message.sheetIndex,
                        sheetName: message.sheetName,
                        selection: message.selection,
                        mutation: message.mutation,
                        mapDisplayRowsToSource: (sheet_index, display_rows) =>
                            command_core.map_display_rows_to_source(sheet_index, display_rows),
                        displayRowForSource: (sheet_index, source_row) =>
                            command_core.display_row_for_source(sheet_index, source_row),
                    })
                    : await file_coordinator.clear_all_cell_highlights(common);
                if (result.type === 'rejected') {
                    await reject_highlight_command(result.error);
                }
                return;
            }
            case 'setColumnVisibility': {
                const message = structuredClone(msg);
                const receiver_epoch = session.current_receiver_epoch;
                const expected_authority = source_authority.authorityRevision;
                const expected_physical_revision = source_authority.physicalRevision;
                const expected_projection_revision = source_authority.projectionRevision;
                const visibility_is_current = () => {
                    const acknowledged = session.acknowledged_identity();
                    return !disposed
                        && session.current_receiver_epoch === receiver_epoch
                        && acknowledged !== undefined
                        && same_snapshot_identity(message.snapshotIdentity, acknowledged)
                        && file_coordinator.state_write_is_current(expected_authority)
                        && source_authority.authorityRevision === expected_authority
                        && message.snapshotIdentity.authority.revision === expected_authority
                        && message.sourceGeneration === core?.source_generation;
                };
                const committed = await update_file_state((current) => {
                    if (!visibility_is_current() || !source || !core) return current;
                    const sheet = source.meta().sheets[message.sheetIndex];
                    if (!sheet || sheet.name !== message.sheetName) return current;
                    const columnVisibility = [...(current.columnVisibility ?? [])];
                    columnVisibility[message.sheetIndex] = sanitize_column_visibility_state(
                        message.state,
                        sheet.columnCount,
                        transform_schema_for_sheet(sheet),
                    );
                    return { ...current, columnVisibility };
                }, undefined, visibility_is_current, {
                    expectedAuthorityRevision: expected_authority,
                    expectedPhysicalRevision: expected_physical_revision,
                    expectedProjectionRevision: expected_projection_revision,
                });
                if (committed && visibility_is_current()) {
                    session.update_state_snapshot(
                        project_state_for_panel(committed),
                        { deliver: true },
                    );
                }
                return;
            }
            case 'requestEditSession': {
                if (edit_admission_closed) {
                    void post_to_receiver({
                        type: 'editSessionResult',
                        requestId: msg.requestId,
                        granted: false,
                    });
                    return;
                }
                cancel_edit_claim(active_edit_claim);
                const request: ReceiverRequest = {
                    requestId: msg.requestId,
                    receiverEpoch: session.current_receiver_epoch,
                };
                active_edit_session_request = request;
                const request_is_current = () => (
                    !edit_admission_closed
                    && active_edit_session_request === request
                    && receiver_request_is_current(request)
                );
                const recovery_waiter = edit_phase().type === 'uncertain'
                    ? Symbol(file_key)
                    : undefined;
                if (recovery_waiter && current_edit_cleanup_waiter) {
                    cancel_edit_cleanup_waiter(current_edit_cleanup_waiter);
                }
                if (recovery_waiter) current_edit_cleanup_waiter = recovery_waiter;
                const recovered = recovery_waiter
                    ? await wait_for_edit_cleanup_recovery(recovery_waiter)
                    : true;
                const recovery_authorized = !recovery_waiter
                    || (
                        recovered
                        && current_edit_cleanup_waiter === recovery_waiter
                    );
                if (current_edit_cleanup_waiter === recovery_waiter) {
                    current_edit_cleanup_waiter = undefined;
                }
                if (!request_is_current()) return;
                let phase = edit_phase();
                let cleanup_blocked = phase.type === 'cleanupPending'
                    || phase.type === 'uncertain';
                const already_owned = phase.type === 'owned'
                    && phase.token === edit_session_token;
                let can_edit = recovery_authorized
                    && profile.editing
                    && !cleanup_blocked
                    && active_save_operation === undefined
                    && !!source
                    && !source.truncationMessage
                    && may_begin_editing();
                const denied_by_owner = can_edit
                    && ((phase.type === 'owned' && phase.token !== edit_session_token)
                        || phase.type === 'claiming');
                const claim = can_edit && !denied_by_owner && !already_owned
                    ? reserve_edit_claim()
                    : undefined;
                const reserved_or_owned = already_owned || claim !== undefined;
                let edit_state: FileStateSnapshot | undefined;
                try {
                    if (can_edit && reserved_or_owned) {
                        await ensure_failed_save_cleanup();
                    }
                    edit_state = can_edit && reserved_or_owned
                        ? await read_file_state()
                        : undefined;
                } catch (error) {
                    cancel_edit_claim(claim);
                    log_sanitized_failure('Failed to read CSV edit-session state', error);
                    if (!request_is_current()) return;
                    active_edit_session_request = undefined;
                    void post_to_receiver({
                        type: 'editSessionResult',
                        requestId: request.requestId,
                        granted: false,
                    }, request.receiverEpoch);
                    return;
                }
                if (!request_is_current()) {
                    cancel_edit_claim(claim);
                    return;
                }
                phase = edit_phase();
                cleanup_blocked = phase.type === 'cleanupPending'
                    || phase.type === 'uncertain';
                can_edit = recovery_authorized
                    && profile.editing
                    && !cleanup_blocked
                    && active_save_operation === undefined
                    && !!source
                    && !source.truncationMessage
                    // Re-asked after the state read, because the window this
                    // question is about is exactly the one the read just crossed.
                    && may_begin_editing();
                const owner_still_available = already_owned
                    ? phase.type === 'owned' && phase.token === edit_session_token
                    : phase.type === 'claiming' && phase.claim === claim;
                const granted = can_edit
                    && owner_still_available
                    && try_claim_edit_session(true, claim);
                if (!granted) cancel_edit_claim(claim);
                if (granted && !already_owned) {
                    // Renderer edit sequences are scoped to one durable edit session.
                    // A newly acquired session starts from one even when it reuses the
                    // same receiver epoch after a save/release cycle.
                    highest_pending_edit_sequence = 0;
                    highest_acknowledged_edit_sequence = 0;
                }
                if (edit_state) update_session_state_material(edit_state);
                // The reason half of the same question `can_edit` asked: an installed
                // sort or filter is not a denial, because editing under one is
                // supported and the rows stay exactly where they are. Only work in
                // flight refuses, and it refuses transiently.
                const denied_by_transform = profile.editing
                    && !!source
                    && !source.truncationMessage
                    && !may_begin_editing();
                const pendingEdits = granted
                    ? pending_edits_for_current_session(
                        (edit_state?.state as PerFileState | undefined)?.pendingEdits,
                    )
                    : undefined;
                if (!request_is_current()) return;
                active_edit_session_request = undefined;
                void post_to_receiver({
                    type: 'editSessionResult',
                    requestId: request.requestId,
                    granted,
                    ...(granted && active_edit_session_id
                        ? { editSessionId: active_edit_session_id }
                        : {}),
                    ...(pendingEdits ? { pendingEdits } : {}),
                }, request.receiverEpoch);
                if (cleanup_blocked) {
                    show_owner_warning(
                        'Editing is temporarily unavailable while saved edit state is being cleared.');
                } else if (denied_by_owner) {
                    show_owner_warning(
                        'This file is already being edited in another Table Viewer tab.');
                } else if (denied_by_transform) {
                    show_owner_warning(
                        'Wait for sorting and filtering to finish before entering edit mode.');
                }
                return;
            }
            case 'hideRows': {
                const installed = core?.transform_state(msg.sheetIndex) ?? EMPTY_TRANSFORM;
                const synthesize = (state: SheetTransformState): Extract<
                    WebviewMessage,
                    { type: 'setTransform' }
                > => ({
                    type: 'setTransform',
                    sheetIndex: msg.sheetIndex,
                    state,
                    requestId: msg.requestId,
                    generation: msg.generation,
                    sourceGeneration: msg.sourceGeneration,
                    intent: 'user',
                });
                // Every refusal below is a validation one — preview mode, a stale
                // generation, an out-of-range sheet, an unmappable row, too many
                // hidden rows — so none of them is worth asking again. The admission
                // matrix's transient refusals are reached through
                // `handle_transform_message`, not here.
                const reject = async (error: string) => {
                    await core?.reject_transform(
                        synthesize(installed),
                        error,
                        'terminal',
                    );
                };
                if (profile.previewMode === true) {
                    await reject('Row hiding is unavailable in preview mode.');
                    return;
                }
                if (!core) return;
                if (msg.generation !== core.generation) {
                    await reject('The view changed before this table view request arrived.');
                    return;
                }
                if (msg.sourceGeneration !== core.source_generation) {
                    await reject('The source changed before this table view request arrived.');
                    return;
                }
                const sheet = source?.meta().sheets[msg.sheetIndex];
                if (!sheet) {
                    await reject(`Sheet index ${msg.sheetIndex} is out of range.`);
                    return;
                }
                let mapped: Uint32Array;
                try {
                    mapped = core.map_display_rows_to_source(
                        msg.sheetIndex,
                        msg.displayRows,
                    );
                } catch (error) {
                    await reject(error instanceof Error ? error.message : String(error));
                    return;
                }
                const hidden_rows = [...new Set([
                    ...(installed.hiddenRows ?? []),
                    ...mapped,
                ])].sort((a, b) => a - b);
                if (hidden_rows.length > MAX_PERSISTED_HIDDEN_ROWS) {
                    await reject('Too many hidden rows to persist.');
                    return;
                }
                await handle_transform_message(synthesize({
                    ...installed,
                    hiddenRows: hidden_rows,
                    schema: transform_schema_for_sheet(sheet),
                }));
                return;
            }
            /**
             * Durably record one height for every row of a completed resize.
             *
             * The write is `setColumnVisibility`'s shape — a currency predicate re-asked
             * across every await, `update_file_state`, then an *explicit* delivery,
             * because `update_file_state`'s own `update_session_state_material` does not
             * deliver and the display-keyed projection the webview renders from is
             * recomputed only when something is delivered. The display→source mapping and
             * the generation pair guarding it are `hideRows`'s, because the request names
             * rows in a coordinate space only one specific permutation defines.
             *
             * Currency is the generation pair *plus the authority half* of
             * `layout_write_is_current`, and deliberately not that predicate whole. The
             * line between the two is which side of the protocol the fact belongs to.
             *
             * The half that is taken — `file_coordinator.state_write_is_current` and
             * `source_authority.authorityRevision` still equalling the revision read when
             * the message arrived — is a pair of *host-side* facts about whether this write
             * still targets the same file revision. Asking them costs nothing and refuses
             * nothing legitimate, and they are load-bearing because the generation pair
             * alone does not cover the gap they close: during a physical refresh the file
             * authority advances before the new source is adopted, and the editable
             * profile's `read_file_state()` await widens that window, so the old core's
             * `generation`/`sourceGeneration` can both still match a request that was
             * mapped through the *old* source. Writing that request lands a height on a row
             * of the new file revision the user never touched — a silent
             * mis-attribution, which is worse than losing the resize.
             *
             * The half that is *not* taken is `msg.snapshotIdentity` and the acknowledged
             * identity it is compared against. That is a fact the webview echoes back, and
             * gating on it means dropping requests because a delivery happened to be in
             * flight. `stateChanged` can afford that because a dropped one loses nothing —
             * `state_ref` still holds the value and the next debounced persist resends it.
             * The webview no longer holds durable heights, so here a drop is the resize
             * gone for good. Hence the asymmetry: host-side authority facts yes, echoed
             * snapshot identity no.
             *
             * Serialized through `enqueue_layout_write` so it cannot interleave with
             * `persist_layout_state`. Both write the same durable document through
             * read-modify-write CAS loops, and while `rowHeights` is no longer a layout
             * patch leaf, the two still touch peer leaves of one object; running them on
             * one tail is how `columnWidths` and `scrollPosition` already avoid trading
             * CAS retries with each other.
             *
             * The stale-generation rejections are silent, and that is a decision. There is
             * no refusal message and deliberately no deferred replay — replaying a resize
             * against a moved view resizes whatever rows now sit at those display
             * positions. Nor is a message needed: the delivery that moved the generation
             * is what makes the webview's generation differ from the one it posted, so the
             * optimistic overlay tagged with that generation is discarded and the row
             * visibly springs back. The user's next drag is the retry. "Stale" is scoped to
             * the sheet the request names, not to the core-wide generation — see
             * `mapping_generation` in the predicate below — and the webview's overlay
             * lifecycle is scoped the same way, so the two halves agree about which
             * requests die.
             *
             * No preview-mode refusal, unlike `hideRows` directly above, and the difference
             * is not an oversight. `hideRows` is a *view transform*: it changes which rows
             * the view contains, which is a claim about the document that a read-only
             * preview has no business making. A row height changes nothing about row
             * identity or membership — it is layout, in the same class as `columnWidths` and
             * `scrollPosition`, which preview already persists today because
             * `persist_layout_state` has no preview guard. Refusing here would have made
             * this PR the first thing to stop layout persisting in preview, and it would
             * have done it *silently*: the webview still mounts the resize overlay in
             * preview and still paints the new height optimistically, so the row would have
             * looked resized until the next delivery quietly reverted it.
             */
            case 'setRowHeights': {
                const message = structuredClone(msg);
                const receiver_epoch = session.current_receiver_epoch;
                const expected_authority = source_authority.authorityRevision;
                const expected_physical_revision = source_authority.physicalRevision;
                const expected_projection_revision = source_authority.projectionRevision;
                const resize_is_current = () => !disposed
                    && session.current_receiver_epoch === receiver_epoch
                    // A *range* on the generation rather than equality, and the only
                    // predicate in this file that asks it that way. The generation is
                    // core-wide but a permutation is per sheet, so equality refuses
                    // requests that were always safe: a saved transform restoring on a
                    // background sheet, or a long sort the user started before switching
                    // tabs, bumps the shared generation and silently springs back a resize
                    // on the sheet they are actually looking at — whose display->source
                    // mapping never moved. `core.mapping_generation` is the fact that
                    // tells the two apart, and it is host-side, so this needs nothing new
                    // on the wire: the webview keeps posting the one global generation it
                    // holds.
                    //
                    // Both bounds are load-bearing. The lower one is the real refusal — a
                    // generation older than *this sheet's* mapping generation names
                    // display rows in an arrangement this sheet has left, and honouring it
                    // would resize whatever rows now sit at those positions, which is also
                    // why a refusal is dropped rather than replayed. The upper one refuses
                    // a generation the core has never issued; unreachable from an honest
                    // webview, but it is the term that keeps "at least the sheet's
                    // mapping" from degenerating into "any number at all" for a sheet that
                    // has never been permuted, whose mapping generation is the floor.
                    //
                    // This only ever *accepts* a request that was already safe. Nothing is
                    // queued and nothing is retried: every request that gets through is
                    // executed against a mapping provably identical to the one the webview
                    // composed it against.
                    && core !== undefined
                    && message.generation >= core.mapping_generation(message.sheetIndex)
                    && message.generation <= core.generation
                    && message.sourceGeneration === core.source_generation
                    // `state_write_is_current` is the term that actually catches the
                    // refresh window; probing found it sufficient on its own, because the
                    // coordinator's authority advances first and monotonically. The
                    // `source_authority` comparison beside it is unfalsifiable here for
                    // that same reason — it is read *from* `source_authority` above, and
                    // anything that advances that has already advanced the coordinator
                    // past `expected_authority`. Kept because it is half of the pair every
                    // other durable write in this file asks (`layout_write_is_current`,
                    // `setColumnVisibility`), and a predicate that agrees with its
                    // neighbours is worth more than one term less.
                    && file_coordinator.state_write_is_current(expected_authority)
                    && source_authority.authorityRevision === expected_authority;
                if (!core || !source || !resize_is_current()) return;
                if (!source.meta().sheets[message.sheetIndex]) return;
                if (!Number.isFinite(message.height)) return;
                // Clamped before anything durable is touched, so no arithmetic slip in
                // the webview can persist a zero- or negative-height row — a row the
                // user would then have no visible edge left to drag back.
                const height = clamp_row_height(message.height);
                // Counted from the intervals *before* mapping, which is the only place it
                // can usefully be counted: `map_display_rows_to_source` allocates two
                // `Uint32Array`s the size of the request, so a select-all on a
                // ten-million-row sheet has already cost 80MB by the time a post-mapping
                // check could look at it.
                let requested_rows = 0;
                for (const interval of message.rows) {
                    if (
                        !Number.isInteger(interval.start)
                        || !Number.isInteger(interval.end)
                        || interval.end < interval.start
                    ) return;
                    requested_rows += interval.end - interval.start + 1;
                }
                // Only reachable from an empty `rows` array — every interval that gets
                // past the validation above contributes at least one row. Unfalsifiable
                // through the webview, which never posts one (`grid-shell` falls back to
                // the single dragged row and `app` counts before posting), so it is a
                // guard against a malformed message rather than against a caller. Kept on
                // that basis: without it the write proceeds to `update_file_state`, finds
                // nothing to change, and takes the no-op-success path — which delivers,
                // so a message naming no rows would cost a state read and a snapshot
                // round-trip per occurrence.
                if (requested_rows === 0) return;
                if (requested_rows > MAX_PERSISTED_ROW_HEIGHTS) {
                    show_owner_warning(ROW_HEIGHT_LIMIT_WARNING);
                    return;
                }
                let mapped: Uint32Array;
                try {
                    mapped = core.map_display_rows_to_source(
                        message.sheetIndex,
                        message.rows,
                    );
                } catch {
                    // `map_display_rows_to_source` throws for an interval outside the
                    // installed view. On a current generation that is a malformed request
                    // rather than a stale one, and there is nothing to write either way.
                    return;
                }
                // Set by the updater when the accumulated map would pass the bound, and
                // read after the write settles. The warning cannot be raised from inside
                // the updater: `update_file_state` re-runs it once per losing CAS, so a
                // warning there would pop once per retry. A flag is idempotent, and the
                // updater's own return value cannot carry the reason — refusing and
                // writing nothing both surface as `undefined`.
                let refused_at_bound = false;
                /**
                 * Set by the updater when every mapped row already holds the requested
                 * height. That is a *successful* resize that writes nothing, and it still
                 * has to be acknowledged, because the webview has already painted an
                 * optimistic layer for it and only drops a layer once a delivered
                 * projection agrees with it (`row_height_layers_for_delivery`). Left
                 * unanswered the layer sits over the projection for the rest of the
                 * generation, and the case where that matters is not cosmetic: this panel
                 * can hold a *stale* projection — a sibling's write moves the durable map
                 * with no generation bump — so "the value is already durable" is exactly
                 * the request a user makes when they drag a row back to the size another
                 * panel just set. A later delivery carrying a different height would then
                 * be masked by the disagreeing layer, hiding authoritative state.
                 *
                 * Distinguished from the two refusals rather than lumped with them, and
                 * neither of those may be acknowledged: over the bound the write was
                 * rejected and the layer *should* stand until the generation moves (see
                 * `row_height_layers_for_delivery` on that residue), and a stale
                 * generation is answered by the delivery that moved it, which is what
                 * discards the whole overlay. Only a no-op success gets a delivery.
                 *
                 * Both flags are reset at the top of each updater run, and that reset is
                 * unfalsifiable today — said so rather than dressed up as a fix. It is
                 * there because `update_file_state` re-runs the updater once per losing
                 * CAS, so a retry could in general reach a different verdict than the run
                 * before it. It cannot as written: every run that sets either flag returns
                 * `current` unchanged, which makes `update_file_state` return immediately,
                 * so only the *last* run can have set anything. Probed by deleting the
                 * reset, and nothing failed, exactly as that argument predicts. Kept on the
                 * precedent `may_reserve_claim` and `resize_is_current`'s authority term set
                 * in this file: the reset is what makes the flags mean "the verdict of the
                 * write" rather than "the verdict of some attempt at it", and a refusal that
                 * later did want a retry would otherwise leave a stale warning or a spurious
                 * acknowledgement behind it.
                 */
                let unchanged_at_current_height = false;
                /*
                 * `resize_is_current` is consulted four times on the way to a durable
                 * write — once before the first await, then inside the layout-write tail,
                 * inside the CAS updater, and as `update_file_state`'s own validate hook —
                 * and a mutation audit found that *no single one* of them can be deleted
                 * and caught by a test. Recorded rather than trimmed, because the reason
                 * is not that they are unnecessary.
                 *
                 * They are ordered in time, not in logic: each covers a distinct await the
                 * request has to survive, and the interleaving that reaches one reaches
                 * every later one too. So a test that opens a window anywhere is answered
                 * by whichever check comes next, and any one of them alone is enough *at
                 * that window* — which makes them individually unfalsifiable and jointly
                 * load-bearing. Deleting all three post-await checks together does fail
                 * ('abandons a resize whose sheet is permuted while its durable read is in
                 * flight'), which is the assertion that pins the set.
                 *
                 * Kept as four because the windows they cover are not interchangeable in
                 * production even though they are in any one test: the CAS check is the
                 * only one re-evaluated per losing retry, and the validate hook is the only
                 * one inside the store's own commit. What they prevent is not a wasted
                 * write but a display-keyed request mapped through a permutation it never
                 * saw — a height painted on rows the user did not drag.
                 */
                const committed = await enqueue_layout_write(async () => {
                    if (!resize_is_current()) return undefined;
                    const written = await update_file_state((current) => {
                        if (!resize_is_current()) return current;
                        refused_at_bound = false;
                        unchanged_at_current_height = false;
                        const rowHeights = [...(current.rowHeights ?? [])];
                        const existing = rowHeights[message.sheetIndex];
                        const next = { ...(existing ?? {}) };
                        let changed = false;
                        for (const source_row of mapped) {
                            if (next[source_row] === height) continue;
                            next[source_row] = height;
                            changed = true;
                        }
                        // A drag ending on the height the rows already have writes
                        // nothing, so `update_file_state` returns undefined — but it is a
                        // success, and it is answered below with the freshly read
                        // projection rather than with silence. See
                        // `unchanged_at_current_height`. Worth being explicit about: a
                        // resize reports its final size, and reporting an unchanged one is
                        // the ordinary outcome of a click that moves a pixel and comes back.
                        if (!changed) {
                            unchanged_at_current_height = true;
                            return current;
                        }
                        // The accumulated map, not this request: the cap is on what the
                        // file ends up holding, so a hundred small resizes cannot walk
                        // past a bound one large one would have been refused at.
                        // All-or-nothing rather than partial, because a sheet resized up
                        // to an arbitrary row and default below it reads as corruption.
                        //
                        // And not silent. This is the path a user reaches by a hundred
                        // small resizes rather than one large one: nothing about the
                        // gesture was unreasonable, the webview cannot predict the
                        // refusal because it never sees the durable map, and without the
                        // warning below the row simply fails to keep its new height with
                        // no explanation anywhere.
                        //
                        // A *growth* check rather than a level check, and that is the
                        // difference between a bound and a trap. Releases before this bound
                        // existed could persist a select-all map, so a file on disk may
                        // already hold far more than the cap; a level check would then
                        // refuse every resize on that file forever, including one that only
                        // changes the height of a row the map already names. The user has no
                        // way out either — the webview never sees the durable map, so
                        // nothing tells them to delete entries, and there is no UI to delete
                        // them with. Refusing only writes that push the entry *count* higher
                        // still stops any over-cap map from being created or grown, which is
                        // all the bound was ever for. `next` only ever adds keys to
                        // `existing`, so "grew" and "changed count" are the same question.
                        const next_count = Object.keys(next).length;
                        if (
                            next_count > MAX_PERSISTED_ROW_HEIGHTS
                            && next_count > Object.keys(existing ?? {}).length
                        ) {
                            refused_at_bound = true;
                            return current;
                        }
                        rowHeights[message.sheetIndex] = next;
                        return { ...current, rowHeights };
                    }, undefined, resize_is_current, {
                        expectedAuthorityRevision: expected_authority,
                        expectedPhysicalRevision: expected_physical_revision,
                        expectedProjectionRevision: expected_projection_revision,
                    });
                    if (written || !unchanged_at_current_height) return written;
                    // The acknowledgement for a no-op success. Read on the same serialized
                    // tail as the write it stands in for, so the state it answers with
                    // cannot predate a `persist_layout_state` queued behind it, and read
                    // rather than reusing the updater's `current` because that is a
                    // normalized `PerFileState` with no revision — `update_state_snapshot`
                    // needs the revision to refuse an older read replacing a newer one.
                    // The read also refreshes the durable-height latch, which is what
                    // makes the delivered projection the *fresh* one rather than the stale
                    // one this panel may have been holding.
                    return resize_is_current() ? await read_file_state(false) : undefined;
                });
                if (refused_at_bound) show_owner_warning(ROW_HEIGHT_LIMIT_WARNING);
                if (committed && resize_is_current()) {
                    // Queued as its own step on the layout tail rather than delivered
                    // straight from here, and that is a correctness requirement rather
                    // than tidiness.
                    //
                    // Delivering clears the session's acknowledged identity, and
                    // `layout_write_is_current` refuses any `stateChanged` whose identity
                    // no longer matches. A layout change the user makes while this resize
                    // is in flight — a column resize, a tab switch — arrives as exactly
                    // such a message and is already queued behind the write above. Left
                    // here, the delivery ran first and invalidated it: the queued write
                    // was refused and the snapshot then reinstalled the pre-change layout
                    // in the webview, so the second action vanished with nothing to notice
                    // it by. Not a refusal the user could retry past, either, since the
                    // webview had already been told its change did not happen.
                    //
                    // On the tail, those writes run first and are acknowledged normally,
                    // and the delivery that clears the identity is the last thing to
                    // happen. State is re-read at that point rather than reusing
                    // `committed`, which by then may predate them.
                    await enqueue_layout_write(async () => {
                        if (!resize_is_current()) return;
                        const fresh = await read_file_state(false);
                        if (!fresh || !resize_is_current()) return;
                        session.update_state_snapshot(
                            project_state_for_panel(fresh),
                            { deliver: true },
                        );
                    });
                }
                return;
            }
            case 'setTransform': {
                await handle_transform_message(msg);
                return;
            }
            case 'releaseEditSession':
                if (profile.editing && edit_message_is_current(msg.editSessionId)) {
                    active_save_dialog_request = undefined;
                    await release_edit_session(msg.editSessionId);
                    if (!disposed) await refresh_session_state_material(false);
                }
                return;
            case 'discardEditSession':
                if (profile.editing && edit_message_is_current(msg.editSessionId)) {
                    const writing = active_save_operation?.phase === 'writing'
                        && active_save_operation.identity.editSessionId === msg.editSessionId;
                    if (writing) return;
                    active_save_dialog_request = undefined;
                    const operation = begin_edit_cleanup(msg.editSessionId);
                    if (!operation) return;
                    notify_edit_state();
                    try {
                        const snapshot = await clear_pending_edits();
                        finish_edit_cleanup(operation, true, snapshot);
                        if (!disposed) update_session_state_material(snapshot, false);
                    } catch (error) {
                        finish_edit_cleanup(operation, false);
                        log_sanitized_failure('Failed to clear discarded CSV edits', error);
                        show_owner_warning(
                            'Table Viewer could not clear the discarded edit state. Editing remains disabled for this file.');
                    }
                }
                return;
            case 'showWarning':
                host.ui.show_warning(msg.message);
                return;
            case 'saveCsv':
                if (profile.editing) {
                    const save = handle_save(msg.operation);
                    active_save_drain = save;
                    try {
                        await save;
                    } finally {
                        if (active_save_drain === save) {
                            active_save_drain = Promise.resolve();
                        }
                    }
                }
                return;
            case 'pendingEditsChanged': {
                if (!profile.editing || active_save_operation) return;
                if (!edit_message_is_current(msg.editSessionId)) return;
                if (pending_edit_sequence_session_id !== msg.editSessionId) {
                    pending_edit_sequence_session_id = msg.editSessionId;
                    highest_pending_edit_sequence = 0;
                    highest_acknowledged_edit_sequence = 0;
                }
                // Older in-process tests and pre-upgrade renderers may omit the
                // sequence. Admit those through the same serialized legacy path while
                // every current renderer supplies an explicit webview-monotonic value.
                const sequence = Number.isSafeInteger(msg.sequence) && msg.sequence > 0
                    ? msg.sequence
                    : highest_pending_edit_sequence + 1;
                if (sequence <= highest_pending_edit_sequence) {
                    if (sequence <= highest_acknowledged_edit_sequence) {
                        await post_to_receiver({
                            type: 'pendingEditsAcknowledged',
                            editSessionId: msg.editSessionId,
                            sequence,
                        });
                    }
                    return;
                }
                highest_pending_edit_sequence = sequence;
                const receiver_epoch = session.current_receiver_epoch;
                const edit_session_id = msg.editSessionId;
                const edits = msg.edits ? structuredClone(msg.edits) : null;
                const admission = Symbol(edit_session_id);
                pending_edit_admissions.add(admission);
                const write = pending_edit_writes.catch(() => {}).then(async () => {
                    const result = edits
                        ? await update_edit_session_state(
                            edit_session_id,
                            admission,
                            (current) => ({ ...current, pendingEdits: edits }),
                        )
                        : await update_edit_session_state(
                            edit_session_id,
                            admission,
                            (current) => {
                                if (!current.pendingEdits) return current;
                                const { pendingEdits: _drop, ...rest } = current;
                                return rest;
                            },
                        );
                    if (result.type !== 'aborted') {
                        // A post used to be taken as proof the user moved on from a
                        // failed save, retiring its lifecycle and dropping the
                        // tombstone unconditionally. But the webview can echo the
                        // failed operation's *own* map back: `request_save` folds an
                        // open live editor into the operation before the mutation
                        // boundary closes, so that map was never posted and no
                        // webview-side dedupe can recognise the echo — the ordinary
                        // "type in a cell and hit save without pressing Enter" flow.
                        // Dropping the tombstone there satisfies
                        // `shared_edit_state_is_unused()` with the cleanup obligation
                        // unmet, so `ensure_failed_save_cleanup` never runs and the
                        // edits `persist_accepted_save` made durable *before* the
                        // failed disk write survive into the next edit session.
                        //
                        // So compare values, not just identity: a post supersedes a
                        // failed operation unless it is that operation's own map
                        // echoed back. A genuinely newer edit retires the lifecycle;
                        // so does an *emptying* post, which is the user discarding —
                        // moving on more decisively than by replacing the map. Only a
                        // complete, unchanged echo leaves the tombstone standing, so
                        // this asks `post_echoes_operation` rather than merely whether
                        // anything unowned remains (an empty map retains nothing, and
                        // treating that as "not superseding" would let the tombstone
                        // strip a value the user discarded and then retyped).
                        const committed = result.snapshot.state as PerFileState;
                        const supersedes = (operation: CsvSaveOperation) => (
                            !post_echoes_operation(committed.pendingEdits, operation)
                        );
                        const tombstone = file_edit_state?.failedSaveTombstone;
                        if (
                            file_edit_state
                            && tombstone
                            && (
                                // The echo hazard is same-session only, and asking
                                // `supersedes` outside that session was silent loss of
                                // unsaved work. A later session starts from a
                                // projection with the tombstoned entries already
                                // stripped, and neither `resolve_csv_save_hydration`
                                // nor the grant path will hand it a failed operation it
                                // does not own — so it has nothing to echo, and a post
                                // that happens to carry the failed operation's exact
                                // values was typed. Left asking `supersedes`, retyping
                                // the value the failed save had — "Save failed, close
                                // the tab, reopen, type it again" — put the user's own
                                // work back inside a strip that then took it out of the
                                // grid on the next projection.
                                //
                                // Dropping the tombstone here also discharges the
                                // cleanup obligation honestly rather than abandoning
                                // it: a post *replaces* the durable map, so nothing the
                                // failed save persisted and the user did not post is
                                // still there for `ensure_failed_save_cleanup` to
                                // remove.
                                tombstone.editSessionId !== edit_session_id
                                || supersedes(tombstone)
                            )
                        ) {
                            file_edit_state.failedSaveTombstone = undefined;
                        }
                        if (
                            save_lifecycle.state === 'failed'
                            && (
                                save_lifecycle.operation.editSessionId !== edit_session_id
                                || supersedes(save_lifecycle.operation)
                            )
                        ) {
                            retire_save_lifecycle(undefined, 'failed');
                        }
                        notify_edit_state(result.snapshot);
                        delete_shared_edit_state_if_unused();
                        highest_acknowledged_edit_sequence = Math.max(
                            highest_acknowledged_edit_sequence,
                            sequence,
                        );
                        await post_to_receiver({
                            type: 'pendingEditsAcknowledged',
                            editSessionId: msg.editSessionId,
                            sequence,
                        }, receiver_epoch);
                        resolve_pending_edit_ack_waiters();
                    }
                }).finally(() => {
                    pending_edit_admissions.delete(admission);
                });
                pending_edit_writes = write;
                await write;
                return;
            }
            case 'pendingEditsFlush': {
                const waiter = pending_edit_flush_waiters.get(msg.requestId);
                if (!waiter || !Number.isSafeInteger(msg.highestProducedSequence)) return;
                if (msg.highestProducedSequence < 0) return;
                pending_edit_flush_waiters.delete(msg.requestId);
                waiter.resolve({
                    editSessionId: msg.editSessionId,
                    sequence: msg.highestProducedSequence,
                });
                return;
            }
            case 'showSaveDialog': {
                if (!profile.editing || !edit_message_is_current(msg.editSessionId)) return;
                const request = {
                    requestId: msg.requestId,
                    receiverEpoch: session.current_receiver_epoch,
                    editSessionId: msg.editSessionId,
                } as const;
                active_save_dialog_request = request;
                const choice = await host.ui.show_save_discard_dialog();
                if (
                    active_save_dialog_request !== request
                    || !receiver_request_is_current(request)
                    || !edit_message_is_current(request.editSessionId)
                ) return;
                active_save_dialog_request = undefined;
                void post_to_receiver({
                    type: 'saveDialogResult',
                    requestId: request.requestId,
                    editSessionId: request.editSessionId,
                    choice,
                }, request.receiverEpoch);
                return;
            }
            default:
                if (
                    msg.type === 'visibleRowChanged'
                    && !session.acknowledged_current()
                ) return;
                if (profile.on_message && await profile.on_message(msg)) return;
                await core?.handle_message(msg);
        }
        }));
    } catch (error) {
        return abort_setup(error);
    }

    function stop_edit_admission(): void {
        if (edit_admission_closed) return;
        edit_admission_closed = true;
        active_edit_session_request = undefined;
        cancel_edit_claim(active_edit_claim);
    }

    async function flush_pending_edits(): Promise<void> {
        stop_edit_admission();
        if (!profile.editing || !renderer_ready) {
            await drain_controller();
            return;
        }

        const protocol_epoch = renderer_protocol_epoch;
        const request_id = `vscode-close:${++next_pending_edit_flush_request}`;
        const handshake = (async () => {
            const response = new Promise<{ editSessionId?: string; sequence: number }>(
                (resolve, reject) => {
                    pending_edit_flush_waiters.set(request_id, { resolve, reject });
                },
            );
            if (!await post_to_receiver({
                type: 'requestPendingEditsFlush',
                requestId: request_id,
            })) {
                const error = new Error('Viewer renderer is unavailable for pending-edit flush.');
                pending_edit_flush_waiters.delete(request_id);
                reject_pending_edit_protocol(error);
                throw error;
            }

            const flushed = await response;
            await drain_controller();
            if (renderer_protocol_epoch !== protocol_epoch) {
                throw new Error('Viewer renderer reloaded during the pending-edit flush.');
            }
            if (flushed.sequence > 0) {
                if (!flushed.editSessionId) {
                    throw new Error('Viewer renderer reported edits without an edit session.');
                }
                await wait_for_pending_edit_ack(flushed.editSessionId, flushed.sequence);
            }
            // Work admitted by the flush and acknowledgement delivery is downstream
            // of the first drain, so close only after a second stable drain.
            await drain_controller();
        })();

        let timeout_handle: unknown = undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timeout_handle = scheduler.setTimeout(() => {
                const error = new Error(
                    'Viewer renderer did not complete the pending-edit flush in time.',
                );
                pending_edit_flush_waiters.delete(request_id);
                reject_pending_edit_protocol(error);
                reject(error);
            }, pending_edit_flush_timeout_ms);
        });
        try {
            await Promise.race([handshake, timeout]);
        } finally {
            scheduler.clearTimeout(timeout_handle);
        }
    }

    async function drain_controller(): Promise<void> {
        for (;;) {
            const edit_tail = pending_edit_writes;
            const save_tail = active_save_drain;
            const disposal_release_tail = disposal_edit_release_drain;
            const layout_tail = layout_write_tail;
            const transform_tails = [...transform_commit_barriers]
                .map((barrier) => barrier.completion);
            await Promise.all([
                edit_tail,
                save_tail,
                disposal_release_tail,
                layout_tail,
                ...transform_tails,
            ]);
            if (
                edit_tail === pending_edit_writes
                && save_tail === active_save_drain
                && disposal_release_tail === disposal_edit_release_drain
                && layout_tail === layout_write_tail
                && transform_commit_barriers.size === 0
            ) return;
        }
    }

    return {
        stop_edit_admission,
        flush_pending_edits,
        drain: drain_controller,
        dispose() {
            if (disposed) return;
            disposed = true;
            renderer_ready = false;
            reject_pending_edit_protocol(new Error(
                'Viewer controller was disposed before the pending-edit flush completed.',
            ));
            load_seq++;
            reset_reload_retry();
            cancel_refresh_retry_wait();
            cancel_ready_state_retry_waits();
            cancel_edit_cleanup_waiters();
            active_edit_session_request = undefined;
            active_save_dialog_request = undefined;
            header_receipt_queue.length = 0;
            let first_error: unknown;
            const cleanup = (action: () => void) => {
                try {
                    action();
                } catch (error) {
                    first_error ??= error;
                }
            };
            cleanup(() => cancel_edit_claim(active_edit_claim));
            disposal_edit_release_drain = pending_edit_writes
                .catch(() => {})
                .then(async () => { await release_edit_session(); });
            cleanup(() => {
                file_edit_state?.activeTransformPanels.delete(transform_panel_token);
            });
            cleanup(() => session.dispose());
            core = undefined;
            source = undefined;
            for (const d of disposables) cleanup(() => d.dispose());
            cleanup(() => file_coordinator.dispose());
            if (file_edit_state) {
                file_edit_state.attachments = Math.max(0, file_edit_state.attachments - 1);
                delete_shared_edit_state_if_unused();
            }
            if (first_error !== undefined) throw first_error;
        },
    };
}
